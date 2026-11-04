/**
 * 记忆自愈服务的实现：**巡检只读 + 修复必须二次确认**。
 *
 * 全部上游依赖都是**取值函数**（`() => ctx.get(...)`）：晚装载能自愈，早卸载立刻反映。
 *
 * 一条贯穿全文件的纪律：**任何上游缺席都不抛错**。
 * 自愈是「把库整理干净」的能力，它崩了不该让对话链受任何影响（§13.4 第 1 问）。
 */

import {
  countsOf,
  danglingPinsOf,
  duplicateGroupsOf,
  emptySummariesOf,
  pinOverflowOf,
  resurfaceGhostsOf,
  settleFindings,
  tombstoneLeaksOf,
  zeroStrengthOf,
} from './checks.js'
import {
  FINDING_SPECS,
  HealError,
  MAX_PINS,
  MAX_SCAN_ROWS,
} from './types.js'
import type {
  AuditLike,
  ClockLike,
  DedupeLike,
  Finding,
  FindingSpec,
  HealStats,
  HealUnavailableReason,
  HealthReport,
  LogLike,
  MemoryCoreLike,
  MemoryHealService,
  MemoryRecordLike,
  RepairItem,
  RepairOutcome,
  RepairPlan,
} from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。全部是取值函数：任何一项随时可能变成 `undefined`。 */
export interface MemoryHealDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-010 记忆内核。 */
  readonly core: () => MemoryCoreLike | undefined
  /** O-017 遗忘审计（钉子与删除的唯一执行口）。 */
  readonly audit: () => AuditLike | undefined
  /** O-012 判重（只借 `scan()`）。 */
  readonly dedupe: () => DedupeLike | undefined
  /** O-003 时钟；缺席退回系统时间。 */
  readonly clock: () => ClockLike | undefined
  /** 系统时间兜底。 */
  readonly now: () => number
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 记忆自愈服务。 */
export class MemoryHeal implements MemoryHealService {
  readonly #deps: MemoryHealDeps

  /** 累计巡检次数。 */
  #diagnoses = 0

  /** 累计发现条数。 */
  #findings = 0

  /** 累计修复成功条数。 */
  #repaired = 0

  /** 累计失败条数。 */
  #failed = 0

  /**
   * @param deps 依赖。
   */
  constructor(deps: MemoryHealDeps) {
    this.#deps = deps
  }

  /** 是否可用。 */
  get available(): boolean {
    if (!this.#deps.settings.enable) return false
    return this.#core() !== undefined
  }

  /** 不可用原因。 */
  get reason(): HealUnavailableReason | undefined {
    if (!this.#deps.settings.enable) return 'disabled'
    return this.#core() !== undefined ? undefined : 'no-core'
  }

  /** 七种问题的说明书。 */
  specs(): readonly FindingSpec[] {
    return Object.freeze([
      FINDING_SPECS['dangling-pin'],
      FINDING_SPECS['tombstone-leak'],
      FINDING_SPECS['resurface-ghost'],
      FINDING_SPECS['zero-strength'],
      FINDING_SPECS['empty-summary'],
      FINDING_SPECS['duplicate-group'],
      FINDING_SPECS['pin-overflow'],
    ])
  }

  /**
   * 巡检一遍。**只读**。
   * @param limit 最多翻多少条记忆。
   */
  diagnose(limit?: number): HealthReport {
    const stamp = this.#stamp()
    const core = this.#core()
    if (core === undefined) {
      return Object.freeze({
        at: stamp,
        scanned: 0,
        complete: false,
        findings: Object.freeze([]),
        counts: Object.freeze({ auto: 0, confirm: 0, advise: 0 }),
        missing: Object.freeze(['ondra-memory-core']),
      })
    }

    const take = this.#limitOf(limit)
    const missing: string[] = []
    const records: MemoryRecordLike[] = []
    let complete = true

    // 分页扫：端口没有聚合面，也没有「按状态分布」的只读入口。
    const PAGE = 200
    for (let offset = 0; offset < take; offset += PAGE) {
      let page: readonly MemoryRecordLike[]
      try {
        page = core.listFacts({
          limit: Math.min(PAGE, take - offset),
          offset,
          orderBy: 'created-at',
        })
      } catch (error) {
        this.#failed += 1
        this.#deps.log.warn('分页取记忆失败（已扫 %d 条）：%s', records.length, messageOf(error))
        complete = false
        break
      }
      if (page.length === 0) break
      for (const record of page) records.push(record)
      if (page.length < PAGE) break
      if (records.length >= take) {
        complete = false
        break
      }
    }

    const findings: Finding[] = []

    // 1. 强度归零与摘要缺失：只看这次扫到的记录，不需要额外上游。
    findings.push(
      ...zeroStrengthOf(records, record => {
        try {
          return core.strengthOf(record, stamp)
        } catch (error) {
          this.#failed += 1
          this.#deps.log.warn('算强度失败（%s）：%s', record.id, messageOf(error))
          return undefined
        }
      }),
    )
    findings.push(...emptySummariesOf(records))

    // 2. 墓碑泄漏：要 core.tombstoned()，缺了就没法判。
    if (typeof core.tombstoned === 'function') {
      findings.push(
        ...tombstoneLeaksOf(records, text => {
          try {
            return core.tombstoned(text)
          } catch (error) {
            this.#failed += 1
            this.#deps.log.warn('查墓碑失败：%s', messageOf(error))
            return false
          }
        }),
      )
    } else {
      missing.push('ondra-memory-core.tombstoned')
    }

    // 3. 钉子相关：要 O-017。
    const audit = this.#audit()
    if (audit === undefined) {
      if (this.#deps.settings.verbose) {
        this.#deps.log.info('审计服务未装载：跳过悬空钉子、待曝光幽灵、钉子偏多三类检查')
      }
      missing.push('ondra-memory-audit')
    } else {
      let pins: readonly { readonly id: string; readonly note: string }[] = []
      try {
        pins = audit.pinned().slice(0, MAX_PINS)
      } catch (error) {
        this.#failed += 1
        this.#deps.log.warn('取钉子清单失败：%s', messageOf(error))
      }
      const exists = (id: string): boolean => {
        try {
          return core.getFact(id) !== undefined
        } catch (error) {
          this.#failed += 1
          this.#deps.log.warn('查记忆是否存在失败（%s）：%s', id, messageOf(error))
          // 查不到就当它还在：**宁可漏报，不可误删**。
          return true
        }
      }
      findings.push(...danglingPinsOf(pins, exists))
      findings.push(...pinOverflowOf(pins.length))

      try {
        const report = audit.scan(stamp)
        findings.push(...resurfaceGhostsOf(report.resurfaceDue, exists))
        if (!report.complete && this.#deps.settings.verbose) {
          this.#deps.log.info('审计扫描未跑完整（撞了它自己的上限）：待曝光幽灵这一类可能不全')
        }
      } catch (error) {
        this.#failed += 1
        this.#deps.log.warn('审计扫描失败（待曝光幽灵这一类跳过）：%s', messageOf(error))
      }
    }

    // 4. 疑似重复：要 O-012，且受开关控制。
    if (!this.#deps.settings.checkDuplicates) {
      if (this.#deps.settings.verbose) this.#deps.log.info('已关闭疑似重复检查（check-duplicates=false）')
    } else {
      const dedupe = this.#dedupe()
      if (dedupe === undefined) {
        missing.push('ondra-memory-dedupe')
      } else {
        try {
          findings.push(...duplicateGroupsOf(dedupe.scan(take)))
        } catch (error) {
          this.#failed += 1
          this.#deps.log.warn('疑似重复扫描失败：%s', messageOf(error))
        }
      }
    }

    const settled = settleFindings(findings)
    this.#diagnoses += 1
    this.#findings += settled.length

    this.#deps.log.info(
      '巡检完成：扫 %d 条，发现 %d 项（可自动 %d / 需确认 %d / 只能建议 %d）%s',
      records.length,
      settled.length,
      countsOf(settled).auto,
      countsOf(settled).confirm,
      countsOf(settled).advise,
      complete ? '' : '（未跑完整）',
    )

    return Object.freeze({
      at: stamp,
      scanned: records.length,
      complete,
      findings: settled,
      counts: countsOf(settled),
      missing: Object.freeze(missing),
    })
  }

  /**
   * 出一份计划。`advise` 档也列出来，但 `planned=false`。
   * @param report 已有报告；省略就当场巡检。
   */
  plan(report?: HealthReport): RepairPlan {
    const source = report ?? this.diagnose()
    const items: RepairItem[] = source.findings.map(finding => ({
      key: `${finding.code}:${finding.id}`,
      code: finding.code,
      tier: finding.tier,
      id: finding.id,
      action: finding.action,
      // `advise` 档永远不计划执行：它本来就该由别的插件或人做。
      planned: finding.tier !== 'advise' && finding.action !== null,
      detail: finding.detail,
    }))

    let actionable = 0
    for (const item of items) if (item.planned) actionable += 1

    return Object.freeze({
      at: source.at,
      items: Object.freeze(items),
      actionable,
      advisory: items.length - actionable,
      complete: source.complete,
    })
  }

  /**
   * 执行修复。**必须传 `{ confirm: 'repair' }`**。
   *
   * 逐项独立 try/catch：一项失败不影响其余（§13.4 第 1 问的同一条道理）。
   * @param keys 计划项 key 列表。
   * @param options 二次确认。
   */
  apply(keys: readonly string[], options?: { readonly confirm: 'repair' }): readonly RepairOutcome[] {
    if (options?.confirm !== 'repair') {
      throw new HealError(
        'confirmation-required',
        '修复会改记忆库，必须显式传 { confirm: \'repair\' }：本插件不做无人确认的自动修复',
      )
    }

    const core = this.#core()
    if (core === undefined) {
      throw new HealError('no-core', '记忆内核不可用：没有库可修')
    }

    // 先按当前库状态重新巡检一次：**计划可能已经过期**（人看完到点确认之间隔了几分钟）。
    // 用过期计划去修，会去动一条已经不存在、或已经不再有问题的记录。
    const fresh = this.#diagnoseQuiet()
    const wanted = new Set<RepairOutcome['key']>(
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [],
    )
    const outcomes: RepairOutcome[] = []

    for (const key of wanted) {
      const finding = fresh.find(item => `${item.code}:${item.id}` === key)
      if (finding === undefined) {
        outcomes.push(
          Object.freeze({
            key,
            ok: false,
            refusal: 'not-found',
            detail: '这一项在最新巡检里已经不存在了（可能已被别处修好，或状态已变）：跳过',
          }),
        )
        continue
      }
      if (finding.tier === 'advise' || finding.action === null) {
        outcomes.push(
          Object.freeze({
            key,
            ok: false,
            refusal: 'not-actionable',
            detail: `「${FINDING_SPECS[finding.code].zh}」本插件修不了：${FINDING_SPECS[finding.code].owner ?? '归应用外壳或人'}`,
          }),
        )
        continue
      }
      outcomes.push(this.#repairOne(finding, core))
    }

    return Object.freeze(outcomes)
  }

  /** 统计快照。 */
  stats(): HealStats {
    return Object.freeze({
      available: this.available,
      diagnoses: this.#diagnoses,
      findings: this.#findings,
      repaired: this.#repaired,
      failed: this.#failed,
    })
  }

  /* ---------------- 内部 ---------------- */

  /** 执行单项修复。全部经 O-017 的公开方法，绝不直连表。 */
  #repairOne(finding: Finding, core: MemoryCoreLike): RepairOutcome {
    const key = `${finding.code}:${finding.id}`
    const audit = this.#audit()
    if (audit === undefined) {
      this.#failed += 1
      return Object.freeze({
        key,
        ok: false,
        refusal: 'no-audit',
        detail: '审计服务（O-017）未装载：钉子清理与删除都必须经它，本插件不直连表',
      })
    }

    try {
      if (finding.action === 'unpin') {
        const removed = audit.unpin(finding.id)
        if (removed) this.#repaired += 1
        return Object.freeze({
          key,
          ok: removed,
          refusal: removed ? undefined : 'not-found',
          detail: removed ? '悬空钉子已清掉' : '钉子已经不在了（可能被别处清过）',
        })
      }

      if (finding.action === 'forget') {
        // 只修「墓碑里已有同内容」的那一类：正文被墓碑覆盖说明人早就忘了它。
        const record = core.getFact(finding.id)
        if (record === undefined) {
          return Object.freeze({
            key,
            ok: false,
            refusal: 'not-found',
            detail: '这条记忆已经不在了',
          })
        }
        const outcome = audit.forget(finding.id, '自愈：该内容已在墓碑里，清理残留的同内容记录')
        if (outcome.forgotten) this.#repaired += 1
        return Object.freeze({
          key,
          ok: outcome.forgotten,
          refusal: outcome.forgotten ? undefined : 'failed',
          detail: outcome.forgotten
            ? `已再次忘记${outcome.pinRemoved ? '（并清掉了它的钉子）' : ''}`
            : '内核说没有这条：可能已在别处删掉',
        })
      }
    } catch (error) {
      this.#failed += 1
      this.#deps.log.warn('修复 %s 失败：%s', key, messageOf(error))
      return Object.freeze({
        key,
        ok: false,
        refusal: 'failed',
        detail: `修复失败（不影响其余项）：${messageOf(error)}`,
      })
    }

    this.#failed += 1
    return Object.freeze({
      key,
      ok: false,
      refusal: 'not-actionable',
      detail: '这一项没有可执行动作',
    })
  }

  /**
   * 巡检一遍但**不污染统计**（`apply()` 动手前的复核用）。
   *
   * 为什么要复核：人看完计划到点确认之间可能隔了几分钟，这期间库可能已被
   * 别处改过。拿过期计划去修，会去动一条已经不存在、或已经不再有问题的记录。
   */
  #diagnoseQuiet(): readonly Finding[] {
    const before = { diagnoses: this.#diagnoses, findings: this.#findings }
    const report = this.diagnose()
    // 复核不该污染「巡检次数」统计：那不是用户发起的巡检。
    this.#diagnoses = before.diagnoses
    this.#findings = before.findings
    return report.findings
  }

  /** 取记忆内核；不可用一律当缺席。 */
  #core(): MemoryCoreLike | undefined {
    const core = this.#deps.core()
    if (core === undefined) return undefined
    return core.available ? core : undefined
  }

  /** 取审计服务。 */
  #audit(): AuditLike | undefined {
    const audit = this.#deps.audit()
    if (audit === undefined) return undefined
    return audit.available ? audit : undefined
  }

  /** 取判重服务。 */
  #dedupe(): DedupeLike | undefined {
    const dedupe = this.#deps.dedupe()
    if (dedupe === undefined) return undefined
    return dedupe.available ? dedupe : undefined
  }

  /** 巡检条数：取配置与入参的较小值，并夹在硬上限内。 */
  #limitOf(limit?: number): number {
    const wanted =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.trunc(limit)
        : this.#deps.settings.scanLimit
    return Math.min(MAX_SCAN_ROWS, Math.max(1, wanted))
  }

  /** 当前时刻：优先时钟，其次系统时间。 */
  #stamp(): number {
    const clock = this.#deps.clock()
    if (clock !== undefined) {
      try {
        const now = clock.now()
        if (Number.isFinite(now) && now > 0) return Math.trunc(now)
      } catch {
        // 时钟坏了不该让巡检失败，退系统时间。
      }
    }
    return Math.trunc(this.#deps.now())
  }
}
