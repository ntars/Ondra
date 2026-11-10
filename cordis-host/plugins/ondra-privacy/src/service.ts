/**
 * 服务层：把「事实」喂给纯函数，把结果记账。
 *
 * ## 这里的四件难事，以及为什么这么解
 *
 * 1. **`undeclare()` 必须连带撤掉那条能力的同意。**
 *    能力消失了，它的同意就成了没有对应物的残留。留着它会在面板上显示
 *    「有 1 条同意」，而没有任何东西可以撤回——用户会以为关不掉。
 *    这是本包唯一一处「一处动作删两类记录」，所以写在方法注释里而不是藏在循环里。
 *
 * 2. **`grant()` 必须校验「这个键对应一条真的声明」。**
 *    否则打错一个字就能造出一条永远用不上的同意，面板上多一行看不懂的记录。
 *
 * 3. **计数分桶。** `denied` 只计 `tier === 'block'`；`asked` 是「要点头」。
 *    混在一个数里，面板上就分不清「她拦住了一次」和「她问了你一次」。
 *
 * 4. **`evaluate()` 永不抛错**（C3 的同一条纪律）。
 *    它跑在别人的业务路径上，抛一个错会把对方的对话打断。出错就回
 *    `deny` + `internal-error`，宁可拦一次，不可静默放行。
 */

import type {
  Consent,
  ConsentBy,
  ConsentLedger,
  ConsentResult,
  Decision,
  DeclareResult,
  EgressRequest,
  EgressSpec,
  EgressView,
  EgressVerdict,
  NoticeText,
  PrivacyReason,
  PrivacyService,
  PrivacyStats,
  PrivacyStatus,
  TierDoc,
} from './types.js'
import { MAX_SPECS } from './types.js'
import type { Config } from './settings.js'
import { ConsentStore, consentKeyOf, splitKey } from './consent.js'
import type { ConsentLogLike } from './consent.js'
import { evaluateWith, normalizeHost, normalizeHostPattern, hostMatches, specIssue } from './egress.js'
import { TIERS, buildNotice } from './notice.js'

/** 构造依赖。 */
export interface PrivacyDeps {
  /** 现取配置（**每次现取**：配置热更后立刻生效，不缓存）。 */
  readonly settings: () => Config
  /** 日志。 */
  readonly log: ConsentLogLike
  /** 取当前时刻。 */
  readonly now: () => number
  /** 同意账本。 */
  readonly store: ConsentStore
  /** 账本相对位置（没有落盘时返回 `undefined`）。 */
  readonly ledgerDisplay: () => string | undefined
}

/** 可变计数（`readonly` 接口背后必须是可写的映射类型）。 */
type Counters = { -readonly [K in keyof PrivacyStats]: PrivacyStats[K] }

/** 出站闸门。 */
export class PrivacyGate implements PrivacyService {
  readonly #specs = new Map<string, EgressSpec>()
  readonly #deps: PrivacyDeps
  #counters: Counters = {
    declares: 0,
    declaresOk: 0,
    declaresRefused: 0,
    evaluates: 0,
    allowed: 0,
    asked: 0,
    denied: 0,
    secretsFound: 0,
    granted: 0,
    revoked: 0,
    expiredCleared: 0,
    writeFailed: 0,
  }

  /**
   * @param deps 依赖。
   */
  constructor(deps: PrivacyDeps) {
    this.#deps = deps
  }

  /** 开关开着没有。 */
  get available(): boolean {
    return this.#deps.settings().enable
  }

  /** 不能用的原因。 */
  get reason(): PrivacyReason | undefined {
    return this.#deps.settings().enable ? undefined : 'disabled'
  }

  /** 登记一条出站能力。 */
  declare(spec: EgressSpec): DeclareResult {
    this.#counters.declares += 1
    const existing = [...this.#specs.values()]
    const issue = specIssue(spec, existing)
    if (issue !== null) {
      this.#counters.declaresRefused += 1
      const hint = declareHint(issue)
      return Object.freeze({
        ok: false,
        code: issue,
        detail: declareDetail(issue, spec),
        ...(hint !== undefined ? { hint } : {}),
      })
    }
    // 同 id 同主人 = 幂等覆盖：插件热重载会重跑 `apply()`，不覆盖会越积越多。
    if (!this.#specs.has(spec.id) && this.#specs.size >= MAX_SPECS) {
      this.#counters.declaresRefused += 1
      return Object.freeze({
        ok: false,
        code: 'too-many',
        detail: `已经登记了 ${this.#specs.size} 条出站能力（上限 ${MAX_SPECS}）。`,
        hint: '先 undeclare() 掉不再使用的能力。',
      })
    }
    const normalized: EgressSpec = Object.freeze({
      ...spec,
      hosts: Object.freeze(
        spec.hosts
          .map(host => normalizeHostPattern(host))
          .filter((host): host is string => host !== null),
      ),
    })
    this.#specs.set(spec.id, normalized)
    this.#counters.declaresOk += 1
    if (normalized.hosts.length === 0) {
      this.#deps.log.warn(
        '出站能力「%s」没有声明任何主机：它的每一次出站都会被拒（这是明确默认，不是漏配）',
        spec.id,
      )
    }
    return Object.freeze({ ok: true, code: 'ok', detail: `已登记「${spec.title}」。` })
  }

  /** 撤一条能力（**连带撤掉它的同意**）。 */
  undeclare(id: string): boolean {
    const removed = this.#specs.delete(id)
    if (!removed) return false
    // 见文件头第 1 条：能力没了，它的同意就是没有对应物的残留。
    let revoked = 0
    for (const row of this.#deps.store.all()) {
      if (row.id !== id) continue
      if (this.#deps.store.revoke(row.key)) revoked += 1
    }
    this.#counters.revoked += revoked
    if (revoked > 0) this.#deps.log.info('能力「%s」下线，连带撤回 %d 条同意', id, revoked)
    return true
  }

  /** 全部声明。 */
  specs(): readonly EgressSpec[] {
    return Object.freeze([...this.#specs.values()])
  }

  /** 展示视图。 */
  list(): readonly EgressView[] {
    const rows = this.#deps.store.all()
    return Object.freeze(
      this.specs().map(spec => {
        const mine = rows.filter(row => row.id === spec.id)
        let lastAt: number | undefined
        for (const row of mine) {
          if (lastAt === undefined || row.at > lastAt) lastAt = row.at
        }
        return Object.freeze({
          ...spec,
          consents: mine.length,
          ...(lastAt !== undefined ? { lastAt } : {}),
        })
      }),
    )
  }

  /** 问「这一次能不能发」。 */
  evaluate(request: EgressRequest): EgressVerdict {
    this.#counters.evaluates += 1
    try {
      const settings = this.#deps.settings()
      const host = normalizeHost(request.host) ?? request.host.trim().toLowerCase()
      const key = consentKeyOf(request.id, host)
      const verdict = evaluateWith({
        spec: this.#specs.get(request.id),
        request,
        consent: this.#deps.store.get(key),
        now: this.#deps.now(),
        mode: settings.approvalMode,
        enabled: settings.enable,
        strictHosts: settings.strictHosts,
        scanSecrets: settings.scanSecrets,
      })
      this.#tally(verdict)
      if (settings.verbose) {
        this.#deps.log.info(
          '出站判定 %s → %s（%s / %s）',
          verdict.consentKey,
          verdict.decision,
          verdict.tier,
          verdict.code,
        )
      }
      return verdict
    } catch (error) {
      // C3 同族：本包跑在别人的业务路径上，抛错会把对方的对话打断。
      this.#counters.denied += 1
      return Object.freeze({
        ok: false,
        decision: 'deny' as Decision,
        tier: 'block' as const,
        code: 'internal-error' as const,
        detail: `判定过程出错，已按拒绝处理：${error instanceof Error ? error.message : String(error)}`,
        consentKey: consentKeyOf(request.id, request.host),
        secrets: Object.freeze([]),
        truncated: false,
        requiresSandbox: false,
      })
    }
  }

  /** 点一次头。 */
  grant(consentKey: string, by: ConsentBy = 'user'): ConsentResult {
    const parts = splitKey(consentKey)
    if (parts === null) {
      return Object.freeze({
        ok: false,
        code: 'unknown-key',
        detail: '同意键不是 `能力id@主机` 的形状。',
        persisted: false,
      })
    }
    const spec = this.#specs.get(parts.id)
    if (spec === undefined) {
      return Object.freeze({
        ok: false,
        code: 'unknown-key',
        detail: `没有登记过「${parts.id}」，这条同意没有对应物。`,
        persisted: false,
      })
    }
    if (!spec.hosts.some(pattern => hostMatches(pattern, parts.host))) {
      return Object.freeze({
        ok: false,
        code: 'unknown-key',
        detail: `「${parts.id}」没有声明主机 ${parts.host}，先改声明再点头。`,
        persisted: false,
      })
    }
    const outcome = this.#deps.store.grant(consentKey, by, this.#deps.settings().consentTtlMs)
    if (outcome === null) {
      return Object.freeze({ ok: false, code: 'unknown-key', detail: '键不合规。', persisted: false })
    }
    this.#counters.granted += 1
    const row = outcome.row
    return Object.freeze({
      ok: true,
      code: 'ok',
      detail:
        row.expiresAt === 0
          ? `已记住：${consentKey}（永不过期）。`
          : `已记住：${consentKey}（${formatTtl(row.expiresAt - row.at)}后过期）。`,
      persisted: outcome.persisted,
    })
  }

  /** 撤回一条同意。 */
  revoke(consentKey: string): boolean {
    const removed = this.#deps.store.revoke(consentKey)
    if (removed) this.#counters.revoked += 1
    return removed
  }

  /** 全部同意。 */
  consents(): readonly Consent[] {
    return this.#deps.store.all()
  }

  /** 清过期。 */
  sweep(): number {
    const removed = this.#deps.store.sweep()
    this.#counters.expiredCleared += removed
    return removed
  }

  /** 合规告知。 */
  notice(): NoticeText {
    return buildNotice(this.specs(), this.#deps.settings().approvalMode, this.#deps.ledgerDisplay())
  }

  /** 三层提醒。 */
  tiers(): readonly TierDoc[] {
    return TIERS
  }

  /** 现状。 */
  status(): PrivacyStatus {
    const settings = this.#deps.settings()
    const display = this.#deps.ledgerDisplay()
    return Object.freeze({
      enabled: settings.enable,
      approvalMode: settings.approvalMode,
      specs: this.#specs.size,
      consents: this.#deps.store.validCount(),
      expired: this.#deps.store.expiredCount(),
      persisted: display !== undefined,
      ...(display !== undefined ? { ledgerDisplay: display } : {}),
      strictHosts: settings.strictHosts,
      scanSecrets: settings.scanSecrets,
      ...(settings.enable ? {} : { reason: 'disabled' as PrivacyReason }),
    })
  }

  /** 计数。 */
  stats(): PrivacyStats {
    // 落盘失败数由账本持有（它才知道写成功没有），这里**只读不改**：
    // 一个叫 `stats()` 的方法顺手写计数器，会让「看面板」变成一次状态变更。
    return Object.freeze({ ...this.#counters, writeFailed: this.#deps.store.writeFailed })
  }

  /** 换账本。 */
  useLedger(ledger: ConsentLedger | null): void {
    this.#deps.store.setLedger(ledger)
  }

  /** 撤（幂等）。 */
  dispose(): void {
    this.#specs.clear()
    this.#deps.store.clear()
  }

  /**
   * 记账。**分桶**：`denied` 只计 block，`asked` 只计 ask。
   * @param verdict 判定结果。
   */
  #tally(verdict: EgressVerdict): void {
    if (verdict.decision === 'allow') this.#counters.allowed += 1
    else if (verdict.decision === 'ask') this.#counters.asked += 1
    else this.#counters.denied += 1
    if (verdict.code === 'secret-detected') this.#counters.secretsFound += 1
  }
}

/**
 * 登记失败的说明。
 * @param code 码。
 * @param spec 声明。
 */
function declareDetail(code: DeclareResult['code'], spec: EgressSpec): string {
  switch (code) {
    case 'ok':
      return '已登记。'
    case 'bad-id':
      return `能力 id「${String(spec.id)}」不合规：必须匹配 ^[a-z][a-z0-9_-]{1,63}$。`
    case 'bad-owner':
      return `声明方「${String(spec.owner)}」不合规：必须是插件名（kebab）。`
    case 'bad-meta':
      return '标题 / 理由 / 出处有一个是空的：空着等于用户不知道自己在同意什么。'
    case 'bad-host':
      return '主机清单里有不合规写法（不许带路径、端口、用户名），或条数超限。'
    case 'bad-payload':
      return `内容种类「${String(spec.payload)}」不在 text / image / audio / file / metadata 里。`
    case 'bad-credential':
      return '凭据引用必须是环境变量名（如 ONDRA_LLM_KEY），不能是值。'
    case 'owner-conflict':
      return `「${spec.id}」已经被别的插件登记了：一个出站能力只能有一个主人。`
    case 'too-many':
      return '出站能力条数超过上限。'
  }
}

/**
 * 登记失败的指路。
 * @param code 码。
 */
function declareHint(code: DeclareResult['code']): string | undefined {
  switch (code) {
    case 'bad-credential':
      return '把值从配置里删掉，只留变量名；值放环境变量或凭据域（O-035 口径）。'
    case 'owner-conflict':
      return '换个 id，或让原主人撤掉它的声明。'
    case 'bad-host':
      return '只写主机名，如 `api.deepseek.com` 或 `*.openai.com`。'
    default:
      return undefined
  }
}

/**
 * 把毫秒说成人话。
 * @param ms 时长。
 */
function formatTtl(ms: number): string {
  const day = 24 * 60 * 60 * 1000
  if (ms >= day) return `${Math.round(ms / day)} 天`
  const hour = 60 * 60 * 1000
  if (ms >= hour) return `${Math.round(ms / hour)} 小时`
  return `${Math.max(1, Math.round(ms / 60000))} 分钟`
}
