/**
 * 状态文件的读写。
 *
 * ## 落点与写法沿用 O-042 的三条硬要求（手册 §9.3）
 *
 * - **0600**：里面有「用户上次开口是什么时候」——那是隐私；
 * - **临时文件 + rename**：直接覆写会在断电时留下半截 JSON，而半截 JSON 的后果是
 *   「重启后上次主动时刻与退场计数归零」，症状是「重启后她立刻又说一句」，
 *   且**不会报任何错**；
 * - **只在状态真的变了时写**：判定（`plan()`）不写盘，只有 `commit()` / 用户开口 /
 *   静音写。否则面板每几秒刷一次判定，就变成每几秒写一次盘。
 *
 * ## 与 O-042 分两个文件
 *
 * `proactive-quota.json` ≠ `proactive-state.json`。两个插件各自写各自的文件，
 * 共用一个 JSON 必然后写覆盖先写，而症状是「计数偶尔回退」——两边都查不出原因。
 *
 * ## 缺字段怎么补
 *
 * - **时刻类**（`lastProactiveAt` / `lastUserAt`）缺了补 `0`（表示「不知道」），
 *   **绝不补成「现在」**：补成现在会让「上次主动」看起来刚刚发生过，
 *   于是间隔闸永远拦着她，而她一句话都说不出来；
 * - **计数类**缺了补 `0`；
 * - **`retreatDayKey`** 缺了补空串：空串不等于今天，当日退场计数因此自然归零
 *   （昨天的退场句不算今天）。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { QuotaState } from './types.js'

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

/** 空状态。 */
export function emptyState(): QuotaState {
  return Object.freeze({
    version: STATE_VERSION,
    lastProactiveAt: 0,
    proactiveSinceUser: 0,
    lastUserAt: 0,
    retreatDayKey: '',
    retreatDayCount: 0,
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

/**
 * 把任意读到的值归一化成状态。**永不抛错**。
 * @param raw 原始值（`JSON.parse` 的结果）。
 */
export function normalizeState(raw: unknown): QuotaState {
  if (!isRecord(raw)) return emptyState()
  // 版本不认识 → 按空状态处理。硬迁移一份「猜出来的计数」比清零更危险：
  // 清零最多多给她几条额度，猜错会让计数停在一个谁也不知道的位置。
  if (count(raw['version']) !== STATE_VERSION) return emptyState()

  return Object.freeze({
    version: STATE_VERSION,
    lastProactiveAt: stamp(raw['lastProactiveAt']),
    proactiveSinceUser: count(raw['proactiveSinceUser']),
    lastUserAt: stamp(raw['lastUserAt']),
    retreatDayKey: typeof raw['retreatDayKey'] === 'string' ? raw['retreatDayKey'] : '',
    retreatDayCount: count(raw['retreatDayCount']),
    mutedUntil: stamp(raw['mutedUntil']),
  })
}

/**
 * 从磁盘读状态。
 * @param file 绝对路径；`undefined` 表示没有路径服务（纯内存模式）。
 * @returns 读到了就返回状态；文件不存在或读坏了返回 `undefined`。
 */
export function readState(file: string | undefined): QuotaState | undefined {
  if (file === undefined) return undefined
  try {
    const text = readFileSync(file, 'utf8')
    if (text.trim() === '') return undefined
    return normalizeState(JSON.parse(text) as unknown)
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
export function writeState(file: string | undefined, state: QuotaState): boolean {
  if (file === undefined) return false
  const tmp = file + TMP_SUFFIX
  try {
    const payload = JSON.stringify({
      version: state.version,
      lastProactiveAt: state.lastProactiveAt,
      proactiveSinceUser: state.proactiveSinceUser,
      lastUserAt: state.lastUserAt,
      retreatDayKey: state.retreatDayKey,
      retreatDayCount: state.retreatDayCount,
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
