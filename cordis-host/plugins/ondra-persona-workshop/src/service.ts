/**
 * 工坊服务的实现：**只读上游 + 纯计算**。
 *
 * 全文件没有任何写调用，也不持有任何跨调用状态（除了三个计数器）。
 * 这一条是刻意的：人设包是产品资产（master-plan §17-7），用户的包也是用户的；
 * 工坊一旦开始写，「谁改了这个人设」就再没人说得清。
 *
 * 依赖全部是取值函数（`() => ctx.get(...)`），上游晚装载能自愈、早卸载立刻反映。
 */

import { auditOf, scoreOf, tallyOf } from './audit.js'
import { draftOf } from './draft.js'
import { MAX_AUDIT } from './types.js'
import type {
  AuditReport,
  ClockLike,
  CoreLike,
  LoaderLike,
  LogLike,
  PersonaDetailLike,
  WorkshopService,
  WorkshopStats,
  VariantDraft,
} from './types.js'
import { WorkshopError } from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。 */
export interface WorkshopDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-020 加载器。 */
  readonly loader: () => LoaderLike | undefined
  /** O-021 人格内核。 */
  readonly core: () => CoreLike | undefined
  /** O-003 时钟。 */
  readonly clock: () => ClockLike | undefined
  /** 系统时间兜底。 */
  readonly now: () => number
}

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 工坊服务。 */
export class Workshop implements WorkshopService {
  readonly #deps: WorkshopDeps

  /** 累计体检次数。 */
  #audits = 0

  /** 累计草案次数。 */
  #drafts = 0

  /** 槽位判定可用的次数。 */
  #slotChecks = 0

  /**
   * @param deps 依赖。
   */
  constructor(deps: WorkshopDeps) {
    this.#deps = deps
  }

  /** 是否可用：关掉就是不可用；没有加载器也不知道有哪些包。 */
  get available(): boolean {
    if (!this.#deps.settings.enable) return false
    const loader = this.#deps.loader()
    return loader !== undefined && loader.available
  }

  /** 不可用原因。 */
  get reason(): 'disabled' | 'no-loader' | undefined {
    if (!this.#deps.settings.enable) return 'disabled'
    const loader = this.#deps.loader()
    return loader !== undefined && loader.available ? undefined : 'no-loader'
  }

  /** 当前可体检的人设 id 清单。**排序交给 O-020**（它已按 role 再按 id 排好）。 */
  ids(): readonly string[] {
    const loader = this.#deps.loader()
    if (loader === undefined || !loader.available) return Object.freeze([])
    try {
      return Object.freeze(loader.list().map(item => item.id))
    } catch (error) {
      this.#deps.log.warn('列人设清单失败：%s', messageOf(error))
      return Object.freeze([])
    }
  }

  /**
   * 取一个包详情。id 省略时取当前激活人设。
   * @param id 人设 id。
   */
  #detailOf(id?: string): PersonaDetailLike {
    const loader = this.#deps.loader()
    if (loader === undefined || !loader.available) {
      throw new WorkshopError('no-loader', '人设加载器（ondra-persona-loader）未装载，查不到任何包')
    }
    const target = id ?? loader.activeId()
    if (target === undefined || target === '') {
      throw new WorkshopError('no-persona', '没有指定人设，也没有当前激活人设')
    }
    let detail: PersonaDetailLike | undefined
    try {
      detail = loader.get(target)
    } catch (error) {
      throw new WorkshopError('no-persona', `读人设「${target}」时出错`, messageOf(error))
    }
    if (detail === undefined) {
      throw new WorkshopError('no-persona', `没有这个包：${target}`, '先用 ids() 看看有哪些')
    }
    return detail
  }

  /**
   * 体检一个包。
   * @param id 人设 id；省略取当前激活人设。
   * @param at 时刻。
   */
  audit(id?: string, at?: number): AuditReport {
    const detail = this.#detailOf(id)
    this.#audits += 1

    const core = this.#deps.core()
    const slotAvailable = core !== undefined && core.available
    if (slotAvailable) this.#slotChecks += 1

    const checks = auditOf(detail, slotAvailable ? core : undefined)
    const tally = tallyOf(checks)
    return Object.freeze({
      personaId: detail.id,
      archiveName: detail.archiveName,
      bundled: detail.rootKind === 'bundled',
      checks,
      tally,
      score: scoreOf(checks),
      usable: tally.fail === 0,
      at: this.#epoch(at),
    })
  }

  /**
   * 出一个派生草案。
   * @param id 人设 id；省略取当前激活人设。
   * @param at 时刻。
   */
  draft(id?: string, at?: number): VariantDraft {
    const detail = this.#detailOf(id)
    this.#drafts += 1

    const core = this.#deps.core()
    const slotAvailable = core !== undefined && core.available
    if (slotAvailable) this.#slotChecks += 1

    const checks = auditOf(detail, slotAvailable ? core : undefined)
    // 新包 id 由本插件给一个**建议值**（只用于拼骨架目录名），不写进任何文件。
    // 起名是产品决策，插件不替人拍板；用户改了 newId 之后骨架自己会跟着变。
    const suggested = (detail.id + '-variant').slice(0, 64)
    return draftOf(detail, checks, suggested, this.#epoch(at))
  }

  /**
   * 横向对比。一次体检所有包，最多 `maxPersonas` 个。
   *
   * 单个包体检抛错不该让整张对比表消失：逐包 try/catch，坏包跳过。
   * @param at 时刻。
   */
  compare(at?: number): readonly AuditReport[] {
    const ids = this.ids()
    if (ids.length === 0) return Object.freeze([])

    const limit = Math.min(MAX_AUDIT, this.#deps.settings.maxPersonas, ids.length)
    const out: AuditReport[] = []
    for (let index = 0; index < limit; index += 1) {
      const id = ids[index]
      if (id === undefined) continue
      try {
        out.push(this.audit(id, at))
      } catch (error) {
        this.#deps.log.warn('体检「%s」失败，跳过（不影响其余包）：%s', id, messageOf(error))
      }
    }
    return Object.freeze(out)
  }

  /** 统计快照。 */
  stats(): WorkshopStats {
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      audits: this.#audits,
      drafts: this.#drafts,
      slotChecks: this.#slotChecks,
    })
  }

  /** 取时刻：优先时钟服务，其次系统时间。 */
  #epoch(at?: number): number {
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) return Math.trunc(at)
    const clock = this.#deps.clock()
    if (clock !== undefined) {
      try {
        const now = clock.now()
        if (typeof now === 'number' && Number.isFinite(now) && now > 0) return Math.trunc(now)
      } catch {
        // 时钟坏了不当故障：退回系统时间。
      }
    }
    return this.#deps.now()
  }
}
