/**
 * 纯业务层：**分级表 + 票据判定**。
 *
 * 这一层不许碰文件、不许碰时钟、不许碰日志——所有输入（含「现在」）都由调用方传进来。
 * 这样每一条判定都能在单测里用一个数字复现，不需要伪造时间。
 *
 * ## 判定顺序即接口
 *
 * ```
 * 没票                  → no-ticket
 * 票已吊销              → ticket-revoked
 * 票已过期（at >= 截止）→ ticket-expired
 * 次数用尽              → ticket-exhausted
 * 等级不够              → level-too-low
 * spend 没确认 / 串不对 → confirm-required / confirm-mismatch
 * 全过                  → 放行（并消耗一次）
 * ```
 *
 * 顺序不能换：先看「票还在不在」再看「等级够不够」，否则一张过期的高等级票
 * 会先被判成「等级够」，然后调用方才发现它早就过期了——两个错误原因里，
 * 只有后一个是真的。
 *
 * ## 为什么「过期时刻」存的是截止时刻而不是发现时刻
 *
 * 一张票 10:00 到期，14:00 才有人来查。这时「什么时候过的期」的正确答案是 10:00。
 * 存 14:00 会让审计得出「14:00 那次调用把票用过期了」的结论，而那次调用什么都没做。
 * 所以 `endedAt` 在过期时直接写 `expiresAt`，`settle()` 只做「把已经发生的事记下来」。
 */

import {
  ACTION_RE,
  LEVEL_RANK,
  LEVEL_SPECS,
  LEVELS,
  SandboxDeniedError,
  SUBJECT_RE,
} from './types.js'
import type {
  Decision,
  DenyReason,
  EndReason,
  LevelSpec,
  SandboxErrorCode,
  SandboxLevel,
  TicketRecord,
  TicketState,
  TicketView,
} from './types.js'

/** 一小时的毫秒数。 */
const HOUR_MS = 3_600_000

/** 判定用到的配置子集。 */
export interface TicketRules {
  /** 默认票期（小时）。 */
  readonly defaultTtlHours: number
  /** 票期上限（小时）。 */
  readonly maxTtlHours: number
  /** 默认次数上限。 */
  readonly defaultUses: number
  /** 单票次数上限。 */
  readonly maxUses: number
  /** 票据档容量。 */
  readonly maxTickets: number
}

/** 规整后的申票参数。 */
export interface NormalizedGrant {
  readonly subject: string
  readonly action: string
  readonly level: SandboxLevel
  readonly expiresAt: number
  readonly maxUses: number
}

/** 规整后的过闸参数。 */
export interface NormalizedCheck {
  readonly subject: string
  readonly action: string
  readonly level: SandboxLevel
  readonly confirm: string | undefined
}

/** 一次纯判定的结果（不含副作用）。 */
export interface Verdict {
  readonly allowed: boolean
  readonly reason?: DenyReason
  readonly detail: string
  readonly endedAt?: number
  readonly endedBy?: EndReason
}

/**
 * 级别是否在闭集里。
 * @param value 待判值。
 */
export function isLevel(value: unknown): value is SandboxLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

/**
 * 取级别序；非法级别返回 -1（调用方应先 `isLevel`）。
 * @param level 级别。
 */
export function rankOf(level: SandboxLevel): number {
  return LEVEL_RANK[level] ?? -1
}

/**
 * 取级别说明。
 * @param level 级别。
 */
export function levelSpecOf(level: SandboxLevel): LevelSpec {
  return LEVEL_SPECS[level]
}

/** 抛 `bad-request`。 */
function badRequest(message: string, detail?: string): never {
  throw new SandboxDeniedError('bad-request', detail === undefined ? message : message + '：' + detail)
}

/**
 * 时刻的人话写法。**只进 `detail`，不参与判定。**
 * @param at 毫秒时刻。
 */
export function atZh(at: number): string {
  return String(at) + '（' + new Date(at).toISOString() + '）'
}

/**
 * 校主体名。
 * @param value 待判值。
 */
export function checkSubject(value: unknown): string {
  if (typeof value !== 'string' || !SUBJECT_RE.test(value)) {
    badRequest('主体名不合法（须匹配 ' + String(SUBJECT_RE) + '，不许带冒号或空格）', String(value))
  }
  return value
}

/**
 * 校动作名。
 * @param value 待判值。
 */
export function checkAction(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_RE.test(value)) {
    badRequest('动作名不合法（须匹配 ' + String(ACTION_RE) + '，不许带冒号或空格）', String(value))
  }
  return value
}

/** 把数字夹进区间；非有限数一律回退。 */
function clampOf(given: unknown, fallback: number, min: number, max: number): number {
  if (typeof given !== 'number' || !Number.isFinite(given)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(given)))
}

/**
 * 规整申票参数。**类型错就抛 `bad-request`，数值越界则夹紧**——
 * 越界通常是「想要更长」而不是「写错了」，夹紧比拒绝有用；写错类型则必须当场说清。
 * @param raw 原始请求。
 * @param rules 配置。
 * @param at 签发时刻。
 */
export function normalizeGrant(raw: unknown, rules: TicketRules, at: number): NormalizedGrant {
  if (typeof raw !== 'object' || raw === null) badRequest('申票请求必须是一个对象')
  const req = raw as { subject?: unknown; action?: unknown; level?: unknown; ttlMs?: unknown; uses?: unknown }
  const subject = checkSubject(req.subject)
  const action = checkAction(req.action)
  const levelGiven = req.level
  if (!isLevel(levelGiven)) {
    badRequest('级别不在四级闭集里（read / suggest / act / spend）', String(levelGiven))
  }
  const level: SandboxLevel = levelGiven

  const ttlGiven = req.ttlMs
  if (ttlGiven !== undefined && (typeof ttlGiven !== 'number' || !Number.isFinite(ttlGiven))) {
    badRequest('ttlMs 必须是正数（毫秒）', String(ttlGiven))
  }
  const ttlMs = clampOf(
    ttlGiven,
    rules.defaultTtlHours * HOUR_MS,
    HOUR_MS,
    rules.maxTtlHours * HOUR_MS,
  )
  const uses = clampOf(req.uses, rules.defaultUses, 1, rules.maxUses)

  return Object.freeze({
    subject,
    action,
    level,
    expiresAt: at + ttlMs,
    maxUses: uses,
  })
}

/**
 * 规整过闸参数。`level` 省略时按 `read`——最保守的假设。
 * @param raw 原始请求。
 */
export function normalizeCheck(raw: unknown): NormalizedCheck {
  if (typeof raw !== 'object' || raw === null) badRequest('过闸请求必须是一个对象')
  const req = raw as { subject?: unknown; action?: unknown; level?: unknown; confirm?: unknown }
  const subject = checkSubject(req.subject)
  const action = checkAction(req.action)
  const levelGiven = req.level
  let level: SandboxLevel = 'read'
  if (levelGiven !== undefined) {
    if (!isLevel(levelGiven)) {
      badRequest('级别不在四级闭集里（read / suggest / act / spend）', String(levelGiven))
    }
    level = levelGiven
  }
  const confirmGiven = req.confirm
  if (confirmGiven !== undefined && typeof confirmGiven !== 'string') {
    badRequest('confirm 必须是字符串（就是动作名本身）', String(confirmGiven))
  }
  return Object.freeze({
    subject,
    action,
    level,
    confirm: confirmGiven,
  })
}

/**
 * 造票据 id。`at` 的 36 进制 + 序号，天然按时间可读，且匹配 `KEY_RE`。
 * @param at 签发时刻。
 * @param seq 进程内自增序号。
 */
export function newTicketId(at: number, seq: number): string {
  return 'tk-' + at.toString(36) + '-' + seq.toString(36)
}

/**
 * 造一张票。
 * @param grant 规整后的申票参数。
 * @param id 票据 id（由调用方保证全档唯一）。
 * @param at 签发时刻。
 */
export function makeTicket(grant: NormalizedGrant, id: string, at: number): TicketRecord {
  return Object.freeze({
    id,
    subject: grant.subject,
    action: grant.action,
    level: grant.level,
    issuedAt: at,
    expiresAt: grant.expiresAt,
    uses: 0,
    maxUses: grant.maxUses,
    lastUsedAt: null,
    endedAt: null,
    endedBy: null,
  })
}

/**
 * 算票据状态。**不修改记录**：过期是「算出来的」，不是「写进去的」。
 * @param record 票据。
 * @param at 时刻。
 */
export function stateOf(record: TicketRecord, at: number): TicketState {
  if (record.endedBy === 'revoke') return 'revoked'
  if (record.endedBy === 'uses' || record.uses >= record.maxUses) return 'exhausted'
  if (record.endedBy === 'deadline' || at >= record.expiresAt) return 'expired'
  return 'live'
}

/**
 * 是否还活着。
 * @param record 票据。
 * @param at 时刻。
 */
export function isLive(record: TicketRecord, at: number): boolean {
  return stateOf(record, at) === 'live'
}

/**
 * 把「已经发生的到期」落成记录。
 *
 * 只补 `endedAt = expiresAt`，不做别的判断——这一层不改次数、不发日志。
 * 返回 `changed=false` 时调用方可以不写盘（避免每次读快照都摸一次磁盘）。
 * @param records 全部票据。
 * @param at 时刻。
 */
export function settle(
  records: readonly TicketRecord[],
  at: number,
): { readonly tickets: readonly TicketRecord[]; readonly changed: boolean } {
  let changed = false
  const tickets = records.map(record => {
    if (record.endedAt !== null) return record
    if (at < record.expiresAt) return record
    changed = true
    return Object.freeze({
      ...record,
      endedAt: record.expiresAt,
      endedBy: 'deadline' as EndReason,
    })
  })
  return { tickets: changed ? Object.freeze(tickets) : records, changed }
}

/**
 * 在可用票里挑一张：**先用等级最低的够用票，同级先用到期的**。
 *
 * 反过来（先挑等级最高的）会让一张 `spend` 票被 `read` 调用白白消耗一次，
 * 而 `spend` 票是最难签的。
 * @param records 全部票据。
 * @param subject 主体。
 * @param action 动作。
 * @param required 本次要求的级别。
 * @param at 时刻。
 */
export function pickTicket(
  records: readonly TicketRecord[],
  subject: string,
  action: string,
  required: SandboxLevel,
  at: number,
): TicketRecord | undefined {
  const need = rankOf(required)
  let best: TicketRecord | undefined
  for (const record of records) {
    if (record.subject !== subject || record.action !== action) continue
    if (!isLive(record, at)) continue
    if (rankOf(record.level) < need) continue
    if (best === undefined) {
      best = record
      continue
    }
    const rankGap = rankOf(record.level) - rankOf(best.level)
    if (rankGap < 0) {
      best = record
      continue
    }
    if (rankGap === 0 && record.expiresAt < best.expiresAt) best = record
  }
  return best
}

/**
 * 没有可用票时，找一张「最能解释为什么」的终态票。
 *
 * 这一步是为了让拒绝信息指向具体那张票：`ticket-expired` 必须能说出
 * 「哪张票、什么时候过的期」，否则调用方只知道「被拒了」。
 * 顺序：同一动作优先 → 等级够的优先 → 终态时刻最近的优先。
 * @param records 全部票据。
 * @param subject 主体。
 * @param action 动作。
 * @param required 本次要求的级别。
 */
export function explainEnded(
  records: readonly TicketRecord[],
  subject: string,
  action: string,
  required: SandboxLevel,
): TicketRecord | undefined {
  const need = rankOf(required)
  let best: TicketRecord | undefined
  for (const record of records) {
    if (record.subject !== subject || record.action !== action) continue
    if (record.endedAt === null) continue
    if (best === undefined) {
      best = record
      continue
    }
    const enough = rankOf(record.level) >= need ? 1 : 0
    const bestEnough = rankOf(best.level) >= need ? 1 : 0
    if (enough !== bestEnough) {
      if (enough > bestEnough) best = record
      continue
    }
    if ((record.endedAt ?? 0) > (best.endedAt ?? 0)) best = record
  }
  return best
}

/**
 * 纯判定。**不消耗次数**——消耗在 `consume()` 里，两步分开才能单测。
 *
 * `confirm` 的校验放在最后：先确认票还在，再要求确认。
 * 否则一张过期的 `spend` 票会先提示「请确认」，调用方确认完之后才被告知票早就过期了。
 * @param ticket 命中的票（`undefined` 表示没票）。
 * @param required 本次要求的级别。
 * @param confirm 确认串。
 * @param at 时刻。
 */
export function judge(
  ticket: TicketRecord | undefined,
  required: SandboxLevel,
  confirm: string | undefined,
  at: number,
): Verdict {
  if (ticket === undefined) {
    return { allowed: false, reason: 'no-ticket', detail: '这个主体在这个动作上一张票都没有（default-deny）' }
  }
  const state = stateOf(ticket, at)
  if (state === 'revoked') {
    return {
      allowed: false,
      reason: 'ticket-revoked',
      detail: '票据 ' + ticket.id + ' 已于 ' + atZh(ticket.endedAt ?? at) + ' 被吊销',
      endedAt: ticket.endedAt ?? undefined,
      endedBy: 'revoke',
    }
  }
  if (state === 'expired') {
    return {
      allowed: false,
      reason: 'ticket-expired',
      detail: '票据 ' + ticket.id + ' 已于 ' + atZh(ticket.expiresAt) + ' 过期',
      endedAt: ticket.endedAt ?? ticket.expiresAt,
      endedBy: 'deadline',
    }
  }
  if (state === 'exhausted') {
    return {
      allowed: false,
      reason: 'ticket-exhausted',
      detail: '票据 ' + ticket.id + ' 的 ' + String(ticket.maxUses) + ' 次已用完',
      endedAt: ticket.endedAt ?? ticket.lastUsedAt ?? undefined,
      endedBy: 'uses',
    }
  }
  if (rankOf(ticket.level) < rankOf(required)) {
    return {
      allowed: false,
      reason: 'level-too-low',
      detail:
        '票据 ' + ticket.id + ' 只到「' + ticket.level + '」，本次要求「' + required + '」',
    }
  }
  if (LEVEL_SPECS[required].needsConfirm && confirm !== ticket.action) {
    const detail =
      confirm === undefined
        ? '「' + required + '」级必须二次确认：请把动作名 ' + ticket.action + ' 放进 confirm'
        : 'confirm 与动作名不一致（收到 ' + confirm + '，要求 ' + ticket.action + '）'
    return {
      allowed: false,
      reason: confirm === undefined ? 'confirm-required' : 'confirm-mismatch',
      detail,
    }
  }
  return { allowed: true, detail: '放行：票据 ' + ticket.id + '（' + ticket.level + '）' }
}

/**
 * 消耗一次。用满时当场落终态 `uses`——这样「次数用尽」的时刻是确定的，
 * 而不是等下一次判定才补算。
 * @param record 票据。
 * @param at 时刻。
 */
export function consume(record: TicketRecord, at: number): TicketRecord {
  const uses = record.uses + 1
  const exhausted = uses >= record.maxUses
  return Object.freeze({
    ...record,
    uses,
    lastUsedAt: at,
    endedAt: exhausted ? at : record.endedAt,
    endedBy: exhausted ? ('uses' as EndReason) : record.endedBy,
  })
}

/**
 * 吊销一张票。已终态的原样返回（幂等）。
 * @param record 票据。
 * @param at 时刻。
 */
export function revokeRecord(record: TicketRecord, at: number): TicketRecord {
  if (record.endedAt !== null) return record
  return Object.freeze({ ...record, endedAt: at, endedBy: 'revoke' as EndReason })
}

/**
 * 组装视图。
 * @param record 票据。
 * @param at 时刻。
 */
export function toView(record: TicketRecord, at: number): TicketView {
  const state = stateOf(record, at)
  return Object.freeze({
    ...record,
    state,
    remaining: Math.max(0, record.maxUses - record.uses),
  })
}

/**
 * 回收终态票据，直到装得下。**只动已终态的**：
 * 活着的一张都不能替别人让位，否则「我明明签过票」会在某一刻无声失效。
 * @param records 全部票据。
 * @param maxTickets 容量。
 */
export function prune(
  records: readonly TicketRecord[],
  maxTickets: number,
): { readonly kept: readonly TicketRecord[]; readonly dropped: number } {
  if (records.length <= maxTickets) return { kept: records, dropped: 0 }
  const ended = records.filter(record => record.endedAt !== null)
  const overflow = records.length - maxTickets
  if (ended.length === 0) return { kept: records, dropped: 0 }
  // 先回收「终态时刻最早」的：它们的信息量最小（最久以前的事）。
  const doomed = new Set(
    [...ended]
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .slice(0, Math.min(overflow, ended.length))
      .map(record => record.id),
  )
  return { kept: Object.freeze(records.filter(record => !doomed.has(record.id))), dropped: doomed.size }
}

/**
 * 把盘上的一条记录读成合法票据；不合法返回 `null`（由调用方计数并记日志）。
 * @param raw 原始值。
 */
export function normalizeRecord(raw: unknown): TicketRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const id = value.id
  const subject = value.subject
  const action = value.action
  const level = value.level
  if (typeof id !== 'string' || id === '') return null
  if (typeof subject !== 'string' || !SUBJECT_RE.test(subject)) return null
  if (typeof action !== 'string' || !ACTION_RE.test(action)) return null
  if (!isLevel(level)) return null
  const issuedAt = value.issuedAt
  const expiresAt = value.expiresAt
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || issuedAt <= 0) return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return null
  const uses = value.uses
  const maxUses = value.maxUses
  if (typeof uses !== 'number' || !Number.isInteger(uses) || uses < 0) return null
  if (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1) return null
  const lastUsedAt = value.lastUsedAt
  if (lastUsedAt !== null && (typeof lastUsedAt !== 'number' || !Number.isFinite(lastUsedAt))) return null
  const endedAt = value.endedAt
  if (endedAt !== null && (typeof endedAt !== 'number' || !Number.isFinite(endedAt))) return null
  const endedBy = value.endedBy
  if (endedAt === null) {
    if (endedBy !== null) return null
  } else if (endedBy !== 'deadline' && endedBy !== 'uses' && endedBy !== 'revoke') {
    return null
  }
  return Object.freeze({
    id,
    subject,
    action,
    level,
    issuedAt: Math.trunc(issuedAt),
    expiresAt: Math.trunc(expiresAt),
    uses: Math.trunc(uses),
    maxUses: Math.trunc(maxUses),
    lastUsedAt: lastUsedAt === null ? null : Math.trunc(lastUsedAt),
    endedAt: endedAt === null ? null : Math.trunc(endedAt),
    endedBy: endedAt === null ? null : (endedBy as EndReason),
  })
}

/**
 * 拒绝原因 → 固定错误码。
 * @param reason 拒绝原因。
 */
export function codeOf(reason: DenyReason): SandboxErrorCode {
  if (reason === 'ticket-expired') return 'ticket-expired'
  if (reason === 'ticket-exhausted') return 'ticket-exhausted'
  return 'sandbox-denied'
}

/**
 * 拒绝原因的中文短语（进日志用，不是错误文案）。
 * @param reason 拒绝原因。
 */
export function reasonZh(reason: DenyReason): string {
  switch (reason) {
    case 'no-ticket':
      return '没票'
    case 'level-too-low':
      return '等级不够'
    case 'ticket-expired':
      return '票已过期'
    case 'ticket-exhausted':
      return '票已用完'
    case 'ticket-revoked':
      return '票已吊销'
    case 'confirm-required':
      return '缺二次确认'
    case 'confirm-mismatch':
      return '确认串不符'
    case 'ticket-cap':
      return '票据档已满'
    default:
      return '未知原因'
  }
}

/**
 * 把判定结果拼成对外 `Decision`。
 * @param verdict 纯判定。
 * @param req 规整后的请求。
 * @param ticket 命中的票。
 * @param at 时刻。
 * @param remaining 放行后的剩余次数。
 */
export function toDecision(
  verdict: Verdict,
  req: NormalizedCheck,
  ticket: TicketRecord | undefined,
  at: number,
  remaining?: number,
): Decision {
  return Object.freeze({
    allowed: verdict.allowed,
    at,
    level: req.level,
    ticketId: ticket?.id,
    ticketLevel: ticket?.level,
    remaining,
    expiresAt: ticket?.expiresAt,
    endedAt: verdict.endedAt ?? ticket?.endedAt ?? undefined,
    endedBy: verdict.endedBy ?? ticket?.endedBy ?? undefined,
    reason: verdict.reason,
    detail: verdict.detail,
  })
}
