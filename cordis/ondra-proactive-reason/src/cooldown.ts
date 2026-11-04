/**
 * 72 小时冷却表。
 *
 * ## 为什么它单独落盘，不和 O-042 共用一个状态文件
 *
 * 两个插件是两个写者。共用一个 JSON 文件的后果是**后写的覆盖先写的**，
 * 而症状是「冷却偶尔失效」或「额度偶尔清零」——两边都查不出原因，
 * 因为每个插件都认为自己写成功了。故各写各的文件。
 *
 * ## 为什么要落盘
 *
 * 冷却窗口是 72 小时，而进程会被重启。纯内存的冷却表在每次重启后归零，
 * 于是「同一件事」在最坏情况下每小时被重提一次。落盘的成本是每次记账写一个
 * 几 KB 的文件（一天最多三次），收益是冷却真的生效。
 *
 * ## 为什么可以只按 topic 全等
 *
 * topic 是上游的稳定 id（`promise:p-xxx`），不是正文。全等就够了。
 * 这是本文件**没有相似度算法**的原因——不是省事，是相似度在这里必然误判（见 `topics.ts`）。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'

/** 存档版本。 */
export const COOLDOWN_VERSION = 1

/** 表的上限。超了先淘汰最早到期的——那些本来就快失效了。 */
export const MAX_COOLDOWN_ENTRIES = 2000

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 一条冷却。 */
export interface CooldownEntry {
  /** 话题键。 */
  readonly topic: string
  /** 冷却截止时刻。 */
  readonly until: number
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 空表。 */
export function emptyCooldown(): readonly CooldownEntry[] {
  return Object.freeze([]) as readonly CooldownEntry[]
}

/**
 * 把任意读到的值归一化成冷却表。**永不抛错**。
 * @param raw `JSON.parse` 的结果。
 * @param at 当前时刻（已过期的条目直接丢掉）。
 */
export function normalizeCooldown(raw: unknown, at: number): readonly CooldownEntry[] {
  if (!isRecord(raw)) return emptyCooldown()
  if (raw['version'] !== COOLDOWN_VERSION) return emptyCooldown()
  const list = raw['entries']
  if (!Array.isArray(list)) return emptyCooldown()

  const seen = new Set<string>()
  const out: CooldownEntry[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const topic = item['topic']
    const until = item['until']
    if (typeof topic !== 'string' || topic === '') continue
    if (typeof until !== 'number' || !Number.isFinite(until)) continue
    if (until <= at) continue
    if (seen.has(topic)) continue
    seen.add(topic)
    out.push(Object.freeze({ topic, until: Math.trunc(until) }))
  }
  out.sort((a, b) => a.until - b.until)
  return Object.freeze(out)
}

/**
 * 某话题的冷却截止时刻（`0` = 不在冷却）。
 * @param entries 表。
 * @param topic 话题键。
 */
export function coolingUntil(entries: readonly CooldownEntry[], topic: string): number {
  for (const entry of entries) {
    if (entry.topic === topic) return entry.until
  }
  return 0
}

/**
 * 记一条（同话题覆盖，不叠加）。
 *
 * 覆盖而不是延长：冷却的语义是「从现在起 72 小时别提」，
 * 若延长，一天提三次就把这件事锁到三天以后，越来越久。
 * @param entries 原表。
 * @param topic 话题键。
 * @param until 截止时刻。
 */
export function markEntry(
  entries: readonly CooldownEntry[],
  topic: string,
  until: number,
): readonly CooldownEntry[] {
  const next: CooldownEntry[] = entries.filter(entry => entry.topic !== topic)
  next.push(Object.freeze({ topic, until: Math.trunc(until) }))
  if (next.length > MAX_COOLDOWN_ENTRIES) {
    // 先淘汰最早到期的（它们本来就要失效了）。
    next.sort((a, b) => a.until - b.until)
    next.splice(0, next.length - MAX_COOLDOWN_ENTRIES)
  }
  return Object.freeze(next)
}

/**
 * 清掉过期条目。
 * @param entries 表。
 * @param at 当前时刻。
 */
export function pruneEntries(entries: readonly CooldownEntry[], at: number): readonly CooldownEntry[] {
  const kept = entries.filter(entry => entry.until > at)
  return kept.length === entries.length ? entries : Object.freeze(kept)
}

/**
 * 从磁盘读冷却表。
 * @param file 绝对路径；`undefined` 表示没有路径服务。
 * @param at 当前时刻。
 */
export function readCooldown(
  file: string | undefined,
  at: number,
): readonly CooldownEntry[] | undefined {
  if (file === undefined) return undefined
  try {
    const text = readFileSync(file, 'utf8')
    if (text.trim() === '') return undefined
    return normalizeCooldown(JSON.parse(text) as unknown, at)
  } catch {
    // 文件不存在 / 权限不足 / 半截 JSON，都按「没有存档」处理。
    return undefined
  }
}

/**
 * 原子写冷却表。
 * @param file 绝对路径；`undefined` 时返回 `false`。
 * @param entries 表。
 */
export function writeCooldown(file: string | undefined, entries: readonly CooldownEntry[]): boolean {
  if (file === undefined) return false
  const tmp = file + TMP_SUFFIX
  try {
    const payload = JSON.stringify({ version: COOLDOWN_VERSION, entries })
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
