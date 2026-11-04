/**
 * 状态文件的读写。
 *
 * ## 落点与写法来自手册原文
 *
 * §9.3：「状态落点 `user/proactive-state.json`（0600，临时文件 + rename 原子写）」。
 * 这三条都不是风格问题：
 *
 * - **0600**：状态里有她说过的话（去重窗口内的正文），是隐私；
 * - **临时文件 + rename**：直接覆写会在断电/崩溃时留下半截 JSON，
 *   而半截 JSON 的后果是「重启后所有计数归零」——正好等于 §5.3-7 说的
 *   「重启绕过防封」，且**不会报任何错**；
 * - **落盘时机**：只在状态真的变了时写（放行一次、风控一次），
 *   被拦下的判定不写盘——否则一个静默时段的夜晚能写几千次。
 *
 * ## 读的时候「缺字段补基线」
 *
 * 手册 §3.2 的原话是「缺字段按基线补，不按 0 补」。这条对情绪数值成立，
 * 对本文件要分开看：
 *
 * - **计数类**（`dayCount` / `riskHits` / `failHits`）的基线就是 0；
 * - **时刻类**（`lastUserAt`）缺了必须补 0 表示「不知道」，**不能补成「现在」**——
 *   补成「现在」会让「连续沉默几天」永远算出 0，衰减永远不生效；
 * - **`dayKey` 缺了要连带把 `dayCount` 归零**，否则昨天的 3 条会被算进今天。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { RECORD_WINDOW_MS } from './types.js'
import type { GateState, SentRecord } from './types.js'

/** 存档版本。读到不认识的版本按空状态处理，不猜迁移。 */
export const STATE_VERSION = 1

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 计数上限（防一份坏存档写出一个天文数字）。 */
const MAX_COUNT = 1_000_000

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 空状态。
 * @param dayKey 当日键。
 */
export function emptyState(dayKey: string): GateState {
  return Object.freeze({
    version: STATE_VERSION,
    dayKey,
    dayCount: 0,
    daySent: 0,
    sent: Object.freeze([]) as readonly SentRecord[],
    lastByConversation: Object.freeze({}) as Readonly<Record<string, number>>,
    riskHits: 0,
    retryUntil: 0,
    openUntil: 0,
    failHits: 0,
    failUntil: 0,
    lastUserAt: 0,
    mutedUntil: 0,
  })
}

/** 读一个非负整数。 */
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(MAX_COUNT, Math.max(0, Math.trunc(value)))
}

/** 读一个非负时刻。 */
function stamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

/** 读发送记录表。坏条目逐条丢弃，不整体作废。 */
function readSent(value: unknown): readonly SentRecord[] {
  if (!Array.isArray(value)) return Object.freeze([]) as readonly SentRecord[]
  const out: SentRecord[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const at = stamp(item['at'])
    const text = item['text']
    if (at <= 0 || typeof text !== 'string') continue
    out.push(Object.freeze({ at, text }))
  }
  out.sort((a, b) => a.at - b.at)
  return Object.freeze(out)
}

/** 读会话冷却表。 */
function readConversations(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) return Object.freeze({}) as Readonly<Record<string, number>>
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    const at = stamp(raw)
    if (at > 0) out[key] = at
  }
  return Object.freeze(out)
}

/**
 * 把任意读到的值归一化成状态。**永不抛错**。
 * @param raw 原始值（`JSON.parse` 的结果）。
 * @param dayKey 当前自然日键。
 */
export function normalizeState(raw: unknown, dayKey: string): GateState {
  if (!isRecord(raw)) return emptyState(dayKey)
  // 版本不认识 → 按空状态处理。硬迁移一份「猜出来的计数」比清零更危险：
  // 清零最多多给她几条额度，猜错会让计数停在一个谁也不知道的位置。
  if (count(raw['version']) !== STATE_VERSION) return emptyState(dayKey)

  const storedDay = typeof raw['dayKey'] === 'string' ? raw['dayKey'] : ''
  const sameDay = storedDay === dayKey

  return Object.freeze({
    version: STATE_VERSION,
    dayKey,
    // 换日或日期缺失 → 当日计数归零（昨天的额度不算今天）。
    dayCount: sameDay ? count(raw['dayCount']) : 0,
    daySent: sameDay ? count(raw['daySent']) : 0,
    sent: readSent(raw['sent']),
    lastByConversation: readConversations(raw['lastByConversation']),
    riskHits: count(raw['riskHits']),
    retryUntil: stamp(raw['retryUntil']),
    openUntil: stamp(raw['openUntil']),
    failHits: count(raw['failHits']),
    failUntil: stamp(raw['failUntil']),
    lastUserAt: stamp(raw['lastUserAt']),
    mutedUntil: stamp(raw['mutedUntil']),
  })
}

/**
 * 从磁盘读状态。
 * @param file 绝对路径；`undefined` 表示没有路径服务（纯内存模式）。
 * @param dayKey 当前自然日键。
 * @returns 读到了就返回状态；文件不存在或读坏了返回 `undefined`。
 */
export function readState(file: string | undefined, dayKey: string): GateState | undefined {
  if (file === undefined) return undefined
  try {
    const text = readFileSync(file, 'utf8')
    if (text.trim() === '') return undefined
    return normalizeState(JSON.parse(text) as unknown, dayKey)
  } catch {
    // 文件不存在 / 权限不足 / JSON 半截，都按「没有存档」处理。
    // 不在这里打日志：调用方更清楚「这是首次启动还是存档坏了」。
    return undefined
  }
}

/**
 * 原子写状态。
 * @param file 绝对路径；`undefined` 时直接返回 `false`。
 * @param state 状态。
 * @returns 是否写成功。
 */
export function writeState(file: string | undefined, state: GateState): boolean {
  if (file === undefined) return false
  const tmp = file + TMP_SUFFIX
  try {
    const payload = JSON.stringify({
      version: state.version,
      dayKey: state.dayKey,
      dayCount: state.dayCount,
      daySent: state.daySent,
      sent: state.sent,
      lastByConversation: state.lastByConversation,
      riskHits: state.riskHits,
      retryUntil: state.retryUntil,
      openUntil: state.openUntil,
      failHits: state.failHits,
      failUntil: state.failUntil,
      lastUserAt: state.lastUserAt,
      mutedUntil: state.mutedUntil,
    })
    // 先写临时文件（0600），再 rename 覆盖。rename 在同一分区上是原子的。
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 把状态压到「只保留有用部分」：记录裁到一小时、冷却表裁到十分钟。
 *
 * 每次变更后调一次，保证存档不会随运行时间变长。
 * @param state 状态。
 * @param at 当前时刻。
 */
export function compactState(state: GateState, at: number): GateState {
  const floor = at - RECORD_WINDOW_MS
  const sent = state.sent.filter(record => record.at > floor)
  const convFloor = at - 10 * 60_000
  const table: Record<string, number> = {}
  for (const [key, value] of Object.entries(state.lastByConversation)) {
    if (value > convFloor) table[key] = value
  }
  return Object.freeze({
    ...state,
    sent: Object.freeze(sent),
    lastByConversation: Object.freeze(table),
  })
}

