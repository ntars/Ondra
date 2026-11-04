/**
 * 判定核心：**纯函数，不读时钟、不写盘、不碰 ctx**。
 *
 * 这样做的理由很实际：探针的错几乎都是「状态机错」而不是「IO 错」——
 * 一条断开之后又来一条心跳，是算 `down` 还是 `ok`；心跳迟到三秒
 * 是 `stale` 还是 `ok`。这些都能在纸上对拍，而一旦掺进定时器与文件，
 * 就只能在真机上猜。
 */

import type {
  ChannelEvent,
  ChannelHealth,
  EventCounters,
  EvidenceKind,
  EvidenceSource,
  HealthReason,
  HealthState,
} from './types.js'
import { NAME_RE } from './types.js'

/**
 * 重连时刻最多留几条。
 *
 * 判定只需要「窗口内几次」，留 16 条够覆盖 `reconnectLimit` 的上界（10）加余量；
 * 再多的历史对判定毫无用处，只会让落盘文件慢慢变胖。
 */
export const RECONNECT_KEEP = 16

/** 钟差容差：上报时刻比现在超前这么多以上，判 `clock-skew`。 */
export const CLOCK_SKEW_MS = 60_000

/**
 * 一个通道的原始记录。
 *
 * 刻意把 `live` / `restored` 放在记录里而不是另建一张表：
 * 「这条记录是刚刚推上来的，还是上次退出前留下的」决定了面板该不该显示
 * 「数据可能过期」，而这个判断只需要一个布尔。
 */
export interface ChannelRecord {
  /** 通道 id。 */
  readonly channelId: string
  /** 中文名。 */
  readonly label: string
  /** 最后一条证据的时刻。 */
  readonly lastEventAt: number | null
  /** 最后一条证据的种类。 */
  readonly lastEventKind: EvidenceKind | null
  /** 最后一次出错的时刻。 */
  readonly lastErrorAt: number | null
  /** 最后一个错误码。 */
  readonly lastErrorCode: string | null
  /** 最近一条说明。 */
  readonly detail: string
  /** 计数。 */
  readonly counts: EventCounters
  /** 最近若干次重连的时刻（升序）。 */
  readonly reconnectTimes: readonly number[]
  /** 是否曾经连上过（用来区分「首次连接」与「重连」）。 */
  readonly seenConnected: boolean
  /** 本次进程内是否收到过上报。 */
  readonly live: boolean
  /** 是否来自磁盘恢复。 */
  readonly restored: boolean
  /** 记录最后更新时刻。 */
  readonly updatedAt: number
}

/** 判定所需的阈值（都来自配置，不由被观测方提供）。 */
export interface Thresholds {
  /** 现在。 */
  readonly now: number
  /** 心跳期望间隔（毫秒）。 */
  readonly expectMs: number
  /** `stale` 倍率。 */
  readonly staleFactor: number
  /** 错误影响窗口（毫秒）。 */
  readonly errorWindowMs: number
  /** 窗口内重连几次算风暴。 */
  readonly reconnectLimit: number
}

/** 一次判定的结果。 */
export interface Verdict {
  /** 状态。 */
  readonly state: HealthState
  /** 原因。 */
  readonly reason: HealthReason
  /** 补充说法（可空串）。 */
  readonly detail: string
}

/** 判一个字符串能不能当通道 id（它会被拼进文件名，故必须严）。 */
export function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && NAME_RE.test(value)
}

/**
 * 造一条空记录（从没上报过）。
 * @param channelId 通道 id。
 * @param label 中文名。
 * @param now 现在。
 */
export function emptyRecord(channelId: string, label: string, now: number): ChannelRecord {
  return {
    channelId,
    label,
    lastEventAt: null,
    lastEventKind: null,
    lastErrorAt: null,
    lastErrorCode: null,
    detail: '',
    counts: { inbound: 0, outbound: 0, errors: 0, reconnects: 0 },
    reconnectTimes: [],
    seenConnected: false,
    live: false,
    restored: false,
    updatedAt: now,
  }
}

/**
 * 吃一条证据，返回**新**记录（不改入参）。
 *
 * 三条刻意的规则：
 * 1. **`connected` 累加重连次数，但只在「曾经连上过」时算。** 首次连接不是重连，
 *    否则每个通道刚启动就背一次「重连」，`reconnect-limit` 立刻误报。
 * 2. **`error` 也刷新 `lastEventAt`。** 出错是「有动静」，把它排除在外，
 *    一个不停报错的通道会先被判 `recent-error`、五分钟后突然变 `stale`，
 *    像是一件事变成了另一件事。
 * 3. **`disconnected` 之后再怎样都由 `lastEventKind` 决断**，不在累加里做特殊分支——
 *    状态机只有一处（`evaluate`），记录层不预判。
 * @param record 原记录。
 * @param event 证据。
 * @param at 采纳时刻（已由调用方解析成毫秒）。
 */
export function applyEvent(record: ChannelRecord, event: ChannelEvent, at: number): ChannelRecord {
  const counts = record.counts
  let reconnectTimes = record.reconnectTimes
  let reconnects = counts.reconnects
  let seenConnected = record.seenConnected

  if (event.kind === 'connected') {
    if (seenConnected) {
      reconnects += 1
      reconnectTimes = [...reconnectTimes, at].slice(-RECONNECT_KEEP)
    }
    seenConnected = true
  }

  const next: EventCounters = {
    inbound: counts.inbound + (event.kind === 'inbound' ? 1 : 0),
    outbound: counts.outbound + (event.kind === 'outbound' ? 1 : 0),
    errors: counts.errors + (event.kind === 'error' ? 1 : 0),
    reconnects,
  }

  return {
    channelId: record.channelId,
    label: record.label,
    lastEventAt: at,
    lastEventKind: event.kind,
    lastErrorAt: event.kind === 'error' ? at : record.lastErrorAt,
    lastErrorCode: event.kind === 'error' ? (event.code ?? '') : record.lastErrorCode,
    detail: event.detail ?? record.detail,
    counts: next,
    reconnectTimes,
    seenConnected,
    live: true,
    restored: record.restored,
    updatedAt: at,
  }
}

/**
 * 数窗口内的重连次数。
 * @param times 重连时刻（升序）。
 * @param now 现在。
 * @param windowMs 窗口。
 */
function reconnectCount(times: readonly number[], now: number, windowMs: number): number {
  let count = 0
  for (let index = times.length - 1; index >= 0; index -= 1) {
    const at = times[index]
    if (at === undefined) continue
    if (now - at > windowMs) break
    count += 1
  }
  return count
}

/**
 * 判定一个通道现在的状态。
 *
 * 判定顺序**不能换**，每一条都排在前面是因为它更「硬」：
 * 1. 没有证据 → `unknown`（不是健康）；
 * 2. 时间戳在未来 → `ok` + `clock-skew`（先照活算，但把话说明白）；
 * 3. 它自己说断开 → `down`（**终态**，直到再来一条 `connected`；
 *    不能因为「断开很久了」就降级成 `stale`——那会把一个明确的结论变成猜测）；
 * 4. 太久没证据 → `stale`；
 * 5. 重连风暴 → `degraded`（比单条错误更值得处理，故排在前面）；
 * 6. 窗口内有错 → `degraded`；
 * 7. 其余 → `ok`。
 * @param record 记录。
 * @param thresholds 阈值。
 */
export function evaluate(record: ChannelRecord, thresholds: Thresholds): Verdict {
  if (record.lastEventAt === null) {
    return { state: 'unknown', reason: 'never-seen', detail: '还没有任何证据' }
  }

  const age = thresholds.now - record.lastEventAt
  if (age < -CLOCK_SKEW_MS) {
    return {
      state: 'ok',
      reason: 'clock-skew',
      detail: '上报时间比现在超前 ' + String(Math.round(-age / 1000)) + ' 秒，检查上报方的钟',
    }
  }

  if (record.lastEventKind === 'disconnected') {
    return {
      state: 'down',
      reason: 'closed',
      detail: record.detail === '' ? '它自己说断了，之后没再连上' : record.detail,
    }
  }

  const staleAfterMs = Math.max(1, Math.trunc(thresholds.expectMs * thresholds.staleFactor))
  if (age > staleAfterMs) {
    return {
      state: 'stale',
      reason: 'stale',
      detail: '已经 ' + String(Math.round(age / 1000)) + ' 秒没有任何证据',
    }
  }

  const reconnects = reconnectCount(record.reconnectTimes, thresholds.now, thresholds.errorWindowMs)
  if (reconnects >= thresholds.reconnectLimit) {
    return {
      state: 'degraded',
      reason: 'reconnect-loop',
      detail: '最近 ' + String(Math.round(thresholds.errorWindowMs / 1000)) + ' 秒重连了 ' + String(reconnects) + ' 次',
    }
  }

  if (record.lastErrorAt !== null && thresholds.now - record.lastErrorAt <= thresholds.errorWindowMs) {
    const code = record.lastErrorCode === null || record.lastErrorCode === '' ? '未知错误' : record.lastErrorCode
    return {
      state: 'degraded',
      reason: 'recent-error',
      detail: (record.detail === '' ? '最近出过错' : record.detail) + '（' + code + '）',
    }
  }

  return { state: 'ok', reason: 'ok', detail: record.detail === '' ? '有活着的新证据' : record.detail }
}

/**
 * 证据来源清单。
 * @param record 记录。
 * @param logPort 是否接上了日志端口。
 */
export function sourcesOf(record: ChannelRecord, logPort: boolean): readonly EvidenceSource[] {
  const out: EvidenceSource[] = []
  if (record.live) out.push('live')
  if (record.restored) out.push('restored')
  if (logPort) out.push('log-port')
  if (out.length === 0) out.push('none')
  return out
}

/**
 * 把记录 + 判定折成对外视图。
 * @param record 记录。
 * @param verdict 判定结果。
 * @param thresholds 阈值。
 * @param logPort 日志端口是否可用。
 */
export function toHealth(
  record: ChannelRecord,
  verdict: Verdict,
  thresholds: Thresholds,
  logPort: boolean,
): ChannelHealth {
  const ageMs =
    record.lastEventAt === null ? null : Math.max(0, thresholds.now - record.lastEventAt)

  return {
    channelId: record.channelId,
    label: record.label === '' ? record.channelId : record.label,
    state: verdict.state,
    reason: verdict.reason,
    detail: verdict.detail,
    lastEventAt: record.lastEventAt,
    lastEventKind: record.lastEventKind,
    lastErrorAt: record.lastErrorAt,
    lastErrorCode: record.lastErrorCode,
    ageMs,
    expectMs: thresholds.expectMs,
    staleAfterMs: Math.max(1, Math.trunc(thresholds.expectMs * thresholds.staleFactor)),
    counts: record.counts,
    sources: sourcesOf(record, logPort),
    at: thresholds.now,
  }
}

/**
 * 状态的严重度排序值（越大越糟）。
 *
 * `unknown` 排在 `degraded` 之后、`ok` 之前：它不代表故障，但也不能
 * 混进「一切正常」——新装的通道全显示绿色，是最容易骗过自己的假象。
 * @param state 状态。
 */
export function severityOf(state: HealthState): number {
  switch (state) {
    case 'down':
      return 4
    case 'stale':
      return 3
    case 'degraded':
      return 2
    case 'unknown':
      return 1
    case 'ok':
      return 0
    default:
      return 1
  }
}

/**
 * 取一组状态里最糟的那个。
 * @param states 状态列表。
 */
export function worstOf(states: readonly HealthState[]): HealthState {
  // 一个通道都没盯时给 `unknown` 而不是 `ok`：空集合不是「一切都好」。
  if (states.length === 0) return 'unknown'
  let worst: HealthState = states[0] ?? 'unknown'
  for (const state of states) {
    if (severityOf(state) > severityOf(worst)) worst = state
  }
  return worst
}
