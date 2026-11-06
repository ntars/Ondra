/**
 * 接线与降级：把纯判定层（`tickets.ts`）接上时钟、路径与票据档。
 *
 * ## 三个写方法，一个读方法
 *
 * - `grant()` 签票（写盘）
 * - `check()` 过闸并**消耗一次**（写盘）
 * - `revoke()` 吊销（写盘）
 * - `snapshot()` / `stats()` 只读
 *
 * `check()` 会消耗次数，这一点必须写在醒目的地方：外壳想「先问问能不能做」
 * 应该看 `snapshot()`，而不是拿 `check()` 试一下——试一下也要扣一次。
 * 不给「不扣次的 check」，因为那种方法一旦存在，所有调用都会先用它再真做，
 * 于是每一次动作都过两遍闸，而第二遍可能落在不同的时刻上。
 *
 * ## 四种降级，各自看得见
 *
 * | 缺什么 | 退回什么 | 怎么看出来 |
 * |---|---|---|
 * | `ondra-path-layout` | 只在内存，重启后全部票作废 | `stored=false` + 一行 `warn` |
 * | `ondra-clock` | 系统时间（本包只用「现在」，不用日历） | 无感，不额外报 |
 * | `ondra-config-schema` | 插件实例配置 + 本地 `completeConfig` | 一行 `warn` |
 * | `ondra-identity` | 日志命名空间退回 `ondra.sandbox` | 无感 |
 *
 * ## 它不发出、不渲染、不排期
 *
 * 没有工具注册、没有提示词、没有界面、没有定时器。唯一的时间来源是调用方
 * 走到这里的那一秒——票的寿命因此完全由「谁在什么时候来查」决定，不需要后台扫描。
 */

import type {
  CheckRequest,
  ClockLike,
  Decision,
  GrantRequest,
  LevelSpec,
  LogLike,
  PathLike,
  SandboxErrorCode,
  SandboxLevel,
  SandboxService,
  SandboxStats,
  Snapshot,
  TicketRecord,
  TicketView,
} from './types.js'
import { KEY_RE, LEVELS, SandboxDeniedError, STATE_FILE_NAME } from './types.js'
import type { Config } from './settings.js'
import {
  codeOf,
  consume,
  explainEnded,
  isLive,
  judge,
  levelSpecOf,
  makeTicket,
  newTicketId,
  normalizeCheck,
  normalizeGrant,
  pickTicket,
  prune,
  reasonZh,
  revokeRecord,
  settle,
  toDecision,
  toView,
} from './tickets.js'
import type { TicketRules } from './tickets.js'
import { readTickets, writeTickets } from './store.js'

/** 依赖。 */
export interface SandboxDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 时钟服务（可能缺席）。 */
  readonly clock: () => ClockLike | undefined
  /** 路径服务（可能缺席）。 */
  readonly path: () => PathLike | undefined
  /** 系统时钟（毫秒）。 */
  readonly now: () => number
}

/** 从配置里挑出判定层要的那几个数。 */
function rulesOf(settings: Config): TicketRules {
  return {
    defaultTtlHours: settings.defaultTtlHours,
    maxTtlHours: settings.maxTtlHours,
    defaultUses: settings.defaultUses,
    maxUses: settings.maxUses,
    maxTickets: settings.maxTickets,
  }
}

/** 能力分级沙箱。 */
export class Sandbox implements SandboxService {
  readonly #deps: SandboxDeps

  /** 全部票据（含已终态的，新的在前由 `snapshot()` 排）。 */
  #tickets: readonly TicketRecord[] = []

  /** 是否已经读过盘。 */
  #loaded = false

  /** 最近一次写盘是否成功。 */
  #writeOk = false

  /** 写盘次数与失败次数。 */
  #writes = 0
  #writeFailures = 0

  /** 被回收的终态票据数。 */
  #pruned = 0

  /** 签发 / 过闸 / 放行 / 拒绝计数。 */
  #grants = 0
  #checks = 0
  #allows = 0
  #denials = 0

  /** 各拒绝原因的次数。 */
  #byReason: Record<string, number> = {}

  /** 各等级被放行的次数。 */
  #byLevel: Record<SandboxLevel, number> = { read: 0, suggest: 0, act: 0, spend: 0 }

  /** 进程内自增序号（造票 id 用，避免同一毫秒签两张撞名）。 */
  #seq = 0

  /** 最近一次失败原因。 */
  #lastIssue: string | undefined

  /** 是否已经提示过「时钟缺席」。只提示一次，避免每次判定都刷一行。 */
  #clockNoted = false

  /**
   * @param deps 依赖。
   */
  constructor(deps: SandboxDeps) {
    this.#deps = deps
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): SandboxErrorCode | undefined {
    return this.available ? undefined : 'disabled'
  }

  /** 票据档是否真的落盘。 */
  get stored(): boolean {
    return this.#filePath() !== undefined && (this.#writeOk || !this.#loaded)
  }

  /** 票据档的绝对路径；缺路径服务时 `undefined`。 */
  #filePath(): string | undefined {
    const path = this.#deps.path()
    if (path === undefined) return undefined
    try {
      return path.fileIn('user', STATE_FILE_NAME)
    } catch (error) {
      this.#lastIssue = '拼不出票据档路径：' + this.#messageOf(error)
      return undefined
    }
  }

  /** 取错误消息文本。 */
  #messageOf(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  /** 首次使用时惰性读盘。**失败不抛**，退成空档（见 store.ts 文件头）。 */
  #ensureLoaded(): void {
    if (this.#loaded) return
    this.#loaded = true
    const filePath = this.#filePath()
    const result = readTickets(filePath)
    this.#tickets = result.tickets
    this.#writeOk = filePath !== undefined
    if (filePath === undefined) {
      // 降级必须留一行：只在内存意味着重启后所有票作废，而调用方只会看到「票没了」。
      this.#lastIssue = '缺 ondra-path-layout：票据只在内存，重启后全部作废'
      this.#deps.log.warn('%s（stored=false）', this.#lastIssue)
    }
    if (result.issue !== undefined) {
      this.#lastIssue = result.issue
      this.#deps.log.warn('%s（重启后全部票据作废，所有主体回到 default-deny）', result.issue)
    }
    if (result.dropped > 0) {
      this.#deps.log.warn('票据档里有 %d 条记录不合法，已丢弃（它们对应的授权不再成立）', result.dropped)
    }
  }

  /** 落盘。失败只记日志并计数，**永不抛出**。 */
  #persist(): void {
    const filePath = this.#filePath()
    if (filePath === undefined) {
      this.#writeOk = false
      return
    }
    try {
      writeTickets(filePath, this.#tickets)
      this.#writes += 1
      this.#writeOk = true
    } catch (error) {
      this.#writeFailures += 1
      this.#writeOk = false
      this.#lastIssue = '写票据档失败：' + this.#messageOf(error)
      this.#deps.log.warn('%s（重启后这些票据会作废）', this.#lastIssue)
    }
  }

  /** 总开关关掉时，写方法一律拒绝（读接口照常）。 */
  #guard(): void {
    if (!this.available) {
      throw new SandboxDeniedError('disabled', '能力分级沙箱已关闭（enable=false）')
    }
  }

  /**
   * 当前时刻。
   *
   * **系统时间是唯一可信的时刻源**：`ondra-clock` 提供的是日历换算与可用性，
   * 不是「现在几点」的第二份真源；两份时刻源迟早会给出两个不同的「现在」。
   * 故先取系统时间，只有在系统时间不可用时才回问时钟服务。
   */
  #now(): number {
    const clock = this.#deps.clock()
    const stamp = this.#deps.now()
    if (Number.isFinite(stamp) && stamp > 0) {
      if (clock === undefined && !this.#clockNoted) {
        this.#clockNoted = true
        this.#deps.log.debug?.('ondra-clock 缺席：票期用系统时间计算（本包不用日历，只用到「现在」）')
      }
      return Math.trunc(stamp)
    }
    if (clock === undefined) return Date.now()
    try {
      return Math.trunc(clock.now())
    } catch (error) {
      this.#lastIssue = '时钟服务取值失败，退回系统时间：' + this.#messageOf(error)
      return Date.now()
    }
  }

  /** 记一次拒绝原因。 */
  #bump(reason: string): void {
    this.#byReason[reason] = (this.#byReason[reason] ?? 0) + 1
  }

  /** 造一个当前档里没出现过的票 id。 */
  #nextId(at: number): string {
    for (;;) {
      this.#seq += 1
      const id = newTicketId(at, this.#seq)
      if (KEY_RE.test(id) && !this.#tickets.some(ticket => ticket.id === id)) return id
      // 撞名只会发生在同一毫秒内签很多张；序号自增一次就可能撞上同一毫秒的旧票。
      // 继续自增即可，不需要额外的时间来源。
    }
  }

  /** 四级表（只读副本）。 */
  levels(): readonly LevelSpec[] {
    return Object.freeze(LEVELS.map(level => levelSpecOf(level)))
  }

  /**
   * 签一张票。
   * @param req 申票请求。
   */
  grant(req: GrantRequest): TicketView {
    this.#guard()
    this.#ensureLoaded()
    const at = this.#now()
    const settled = settle(this.#tickets, at)
    this.#tickets = settled.tickets

    const rules = rulesOf(this.#deps.settings)
    const normalized = normalizeGrant(req, rules, at)

    // 先回收终态票；回收不动才拒签。**活着的票一张都不动**（见 tickets.ts 的 prune）。
    const swept = prune(this.#tickets, rules.maxTickets)
    if (swept.dropped > 0) {
      this.#pruned += swept.dropped
      this.#tickets = swept.kept
      this.#deps.log.warn('票据档已满，回收了 %d 张最早的终态票据', swept.dropped)
    }
    if (this.#tickets.length >= rules.maxTickets) {
      const detail =
        '票据档已满（' + String(rules.maxTickets) + ' 张，且没有可回收的终态票）：先吊销或等它们过期'
      this.#denials += 1
      this.#bump('ticket-cap')
      this.#deps.log.warn('拒绝申票 %s/%s：%s', normalized.subject, normalized.action, detail)
      throw new SandboxDeniedError('sandbox-denied', detail, { reason: 'ticket-cap' })
    }

    const id = this.#nextId(at)
    const ticket = makeTicket(normalized, id, at)
    this.#tickets = Object.freeze([ticket, ...this.#tickets])
    this.#grants += 1
    this.#persist()
    this.#deps.log.info(
      '签发票据 %s：%s/%s 到「%s」，截止 %d，可用 %d 次',
      ticket.id,
      ticket.subject,
      ticket.action,
      ticket.level,
      ticket.expiresAt,
      ticket.maxUses,
    )
    return toView(ticket, at)
  }

  /**
   * 过闸：判定并消耗一次。拒绝抛 `SandboxDeniedError`。
   * @param req 过闸请求。
   */
  check(req: CheckRequest): Decision {
    this.#guard()
    this.#ensureLoaded()
    const at = this.#now()
    const settled = settle(this.#tickets, at)
    this.#tickets = settled.tickets
    const dirty = settled.changed

    const normalized = normalizeCheck(req)
    this.#checks += 1

    // 三步找票：够等级的活票 → 能解释「为什么没了」的终态票 → 等级不够的活票。
    // 顺序即信息量：能说出「你那张 10:00 过期的票」比「你没票」有用得多。
    let ticket = pickTicket(this.#tickets, normalized.subject, normalized.action, normalized.level, at)
    if (ticket === undefined) {
      ticket =
        explainEnded(this.#tickets, normalized.subject, normalized.action, normalized.level) ??
        this.#tickets.find(
          record =>
            record.subject === normalized.subject &&
            record.action === normalized.action &&
            isLive(record, at),
        )
    }

    const verdict = judge(ticket, normalized.level, normalized.confirm, at)

    if (!verdict.allowed) {
      const reason = verdict.reason ?? 'no-ticket'
      this.#denials += 1
      this.#bump(reason)
      if (dirty) this.#persist()
      const decision = toDecision(verdict, normalized, ticket, at)
      this.#deps.log.warn(
        '拒绝 %s/%s 到「%s」（%s）：%s',
        normalized.subject,
        normalized.action,
        normalized.level,
        reasonZh(reason),
        verdict.detail,
      )
      throw new SandboxDeniedError(codeOf(reason), verdict.detail, {
        reason,
        ticketId: ticket?.id,
        decision,
      })
    }

    // 走到这里 `judge` 已经放行，而放行必然意味着有票。
    const used = consume(ticket as TicketRecord, at)
    this.#tickets = Object.freeze(
      this.#tickets.map(record => (record.id === used.id ? used : record)),
    )
    this.#allows += 1
    this.#byLevel[normalized.level] += 1
    this.#persist()
    return toDecision(verdict, normalized, used, at, used.maxUses - used.uses)
  }

  /**
   * 吊销一张票。幂等：已终态的票原样返回，不报错。
   * @param ticketId 票 id。
   */
  revoke(ticketId: string): TicketView {
    this.#guard()
    if (typeof ticketId !== 'string' || !KEY_RE.test(ticketId)) {
      throw new SandboxDeniedError('bad-request', '票据 id 不合法（须匹配 ' + String(KEY_RE) + '）')
    }
    this.#ensureLoaded()
    const at = this.#now()
    const settled = settle(this.#tickets, at)
    this.#tickets = settled.tickets

    const index = this.#tickets.findIndex(record => record.id === ticketId)
    if (index < 0) {
      throw new SandboxDeniedError('bad-request', '票据 id 不在档里：' + ticketId)
    }
    const current = this.#tickets[index] as TicketRecord
    const updated = revokeRecord(current, at)
    if (updated === current) {
      this.#deps.log.debug?.('票据 %s 已是终态（%s），吊销请求按幂等处理', current.id, String(current.endedBy))
      return toView(current, at)
    }
    this.#tickets = Object.freeze(
      this.#tickets.map(record => (record.id === updated.id ? updated : record)),
    )
    this.#persist()
    this.#deps.log.info('吊销票据 %s（%s/%s），时刻 %d', updated.id, updated.subject, updated.action, at)
    return toView(updated, at)
  }

  /**
   * 只读快照。**含已终态的票**——过期的票必须查得到是哪张、什么时候过的期。
   * @param at 时刻，省略用当前时刻。
   */
  snapshot(at?: number): Snapshot {
    this.#ensureLoaded()
    const stamp = at === undefined ? this.#now() : at
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) {
      throw new SandboxDeniedError('bad-request', '时刻必须是正的有限数')
    }
    const moment = Math.trunc(stamp)
    const settled = settle(this.#tickets, moment)
    // 只更新内存，不写盘：只读方法不该摸磁盘。真落盘留给下一次 grant/check/revoke，
    // 而即使一次都没落盘，重启后 `settle()` 也会算出同样的 `endedAt`（它存的是截止时刻）。
    this.#tickets = settled.tickets
    const views = this.#tickets
      .map(record => toView(record, moment))
      .sort((a, b) => b.issuedAt - a.issuedAt || b.id.localeCompare(a.id))
    const live = this.#tickets.filter(record => isLive(record, moment)).length
    return Object.freeze({
      at: moment,
      tickets: Object.freeze(views),
      live,
      ended: this.#tickets.length - live,
      stored: this.stored,
    })
  }

  /** 累计统计快照。 */
  stats(): SandboxStats {
    this.#ensureLoaded()
    const at = this.#now()
    const settled = settle(this.#tickets, at)
    this.#tickets = settled.tickets
    const live = this.#tickets.filter(record => isLive(record, at)).length
    const byReason: Record<string, number> = {}
    for (const [reason, count] of Object.entries(this.#byReason)) byReason[reason] = count
    return Object.freeze({
      at,
      grants: this.#grants,
      checks: this.#checks,
      allows: this.#allows,
      denials: this.#denials,
      pruned: this.#pruned,
      writes: this.#writes,
      writeFailures: this.#writeFailures,
      live,
      ended: this.#tickets.length - live,
      stored: this.stored,
      byReason: Object.freeze(byReason),
      byLevel: Object.freeze({ ...this.#byLevel }),
      lastIssue: this.#lastIssue,
    })
  }
}
