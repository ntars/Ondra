/**
 * 状态文件的读写。
 *
 * ## 落点与写法
 *
 * `user/life-rhythm.json`，**0600**，临时文件 + `rename` 原子替换。
 * 这里存的是「她今天干了什么」与「她现在多累」——都属于隐私，
 * 也属于「坏了会看起来一切正常」的那一类：半截 JSON 读回来按空状态处理，
 * 症状是「重启后她又精神了，而且今天什么都没干」，日志里一个字都没有。
 *
 * ## 缺字段怎么补
 *
 * - **能量**缺了补 80（不是 0，也不是 100）：`0` 会让面板显示「极度疲惫」，
 *   那是伪造出来的状态；`100` 会让一个刚装好的她永远精神。
 * - **时刻**缺了补 `0`（表示「不知道」），**绝不补成「现在」**：
 *   补成现在会让「上次活动」看起来刚刚发生过，于是冷却闸永远拦着她。
 * - **兴趣表**缺了用出厂表重建；有一半坏条目时逐条丢弃，不整表清空
 *   （清空等于把她长出来的兴趣一次性抹掉）。
 * - **笔记**只保留最近 `maxNotes` 条，坏的逐条丢。
 *
 * ## 为什么不存「上次结算到的钟点」以外的任何派生值
 *
 * 有效权重、活动类别、时长全是算出来的。存派生值就会出现「存档里的权重」
 * 与「按半衰期算出来的权重」两套数，面板显示一个、判定用另一个。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { emptyEnergy } from './energy.js'
import type { EnergyState } from './energy.js'
import { idOf } from './activities.js'
import { ACTIVITY_KINDS, INTEREST_TAGS } from './types.js'
import type { ActivityKind, Interest, LifeNote, Retention } from './types.js'

/** 存档版本。读到不认识的版本按空状态处理，不猜迁移。 */
export const STATE_VERSION = 1

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 出厂能量：精神，但不是满格（满格会让第一次回落显得像故障）。 */
export const DEFAULT_ENERGY = 80

/** 兴趣表上限：再多面板读不动，且 20 个兴趣等于没有偏好。 */
export const MAX_INTERESTS = 48

/** 一张完整的状态。 */
export interface LifeState {
  readonly version: number
  readonly energy: EnergyState
  /** 上次开始活动的时刻；0 表示「不知道」。 */
  readonly lastActivityAt: number
  /** 上次活动的时间槽（同日去重与日志解释用）。 */
  readonly lastSlot: string
  readonly interests: readonly Interest[]
  /** 新的在前。 */
  readonly notes: readonly LifeNote[]
  /** 累计活动次数（跨重启保留，面板要看「她一共干过多少事」）。 */
  readonly activities: number
  /** 累计探索次数。 */
  readonly explored: number
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读一个非负整数。 */
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(1_000_000, Math.max(0, Math.trunc(value)))
}

/** 读一个非负时刻。 */
function stamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

/** 读一个有限的权重。 */
function weightOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(10, Math.max(0.01, value))
}

/** 读一个类别。 */
function kindOf(value: unknown): ActivityKind | undefined {
  return ACTIVITY_KINDS.find(item => item === value)
}

/** 读一个标签。 */
function tagOfValue(value: unknown): Interest['tag'] | undefined {
  return INTEREST_TAGS.find(item => item === value)
}

/** 读一个保留期。 */
function retentionOfValue(value: unknown): Retention {
  return value === 'long' ? 'long' : 'temp'
}

/**
 * 归一化一条兴趣。缺 `id` 时按标签重算（老存档可能没写 id）。
 * @param raw 原始值。
 */
function normalizeInterest(raw: unknown): Interest | undefined {
  if (!isRecord(raw)) return undefined
  const label = raw['label']
  const tag = tagOfValue(raw['tag'])
  if (typeof label !== 'string' || label.trim() === '' || tag === undefined) return undefined
  const id = typeof raw['id'] === 'string' && raw['id'] !== '' ? raw['id'] : idOf(label)
  return Object.freeze({
    id,
    label: label.trim().slice(0, 24),
    tag,
    weight: weightOf(raw['weight']),
    lastAt: stamp(raw['lastAt']),
    times: count(raw['times']),
    source: raw['source'] === 'explored' ? 'explored' : 'seed',
  })
}

/**
 * 归一化一条笔记。
 * @param raw 原始值。
 */
function normalizeNote(raw: unknown): LifeNote | undefined {
  if (!isRecord(raw)) return undefined
  const kind = kindOf(raw['kind'])
  const text = raw['text']
  const id = raw['id']
  if (kind === undefined || typeof text !== 'string' || typeof id !== 'string' || id === '') return undefined
  const reacted = raw['reacted']
  return Object.freeze({
    id,
    at: stamp(raw['at']),
    kind,
    label: typeof raw['label'] === 'string' ? raw['label'].slice(0, 24) : '',
    text: text.slice(0, 120),
    retention: retentionOfValue(raw['retention']),
    source: raw['source'] === 'react' ? 'react' : 'activity',
    reacted: reacted === 'like' || reacted === 'meh' ? reacted : undefined,
  })
}

/**
 * 归一化能量块。
 * @param raw 原始值。
 * @param at 兜底时刻（存档没写结算时刻时用它）。
 */
function normalizeEnergy(raw: unknown, at: number): EnergyState {
  if (!isRecord(raw)) return emptyEnergy(at)
  const base = emptyEnergy(stamp(raw['settledAt']) || at)
  const energy = raw['energy']
  return Object.freeze({
    energy:
      typeof energy === 'number' && Number.isFinite(energy)
        ? Math.round(Math.min(100, Math.max(0, energy)) * 100) / 100
        : DEFAULT_ENERGY,
    settledAt: base.settledAt,
    frozen: raw['frozen'] === true,
    frozenAt: stamp(raw['frozenAt']),
    sleepRun: Math.max(0, typeof raw['sleepRun'] === 'number' ? raw['sleepRun'] : 0),
    bufferPending: raw['bufferPending'] === true,
    bufferMinutes: Math.max(0, typeof raw['bufferMinutes'] === 'number' ? raw['bufferMinutes'] : 0),
  })
}

/**
 * 空状态。
 * @param at 时刻。
 */
export function emptyState(at: number): LifeState {
  return Object.freeze({
    version: STATE_VERSION,
    energy: emptyEnergy(at),
    lastActivityAt: 0,
    lastSlot: '',
    interests: Object.freeze([]),
    notes: Object.freeze([]),
    activities: 0,
    explored: 0,
  })
}

/**
 * 把任意读到的值归一化成状态。**永不抛错**。
 * @param raw `JSON.parse` 的结果。
 * @param at 兜底时刻。
 * @param maxNotes 笔记上限。
 */
export function normalizeState(raw: unknown, at: number, maxNotes: number): LifeState {
  if (!isRecord(raw)) return emptyState(at)
  if (count(raw['version']) !== STATE_VERSION) return emptyState(at)

  const interests: Interest[] = []
  const rawInterests = Array.isArray(raw['interests']) ? raw['interests'] : []
  for (const item of rawInterests) {
    const normalized = normalizeInterest(item)
    // 按 id 去重：同一份存档被两份进程各加一次时会出现重复条目，
    // 而重复条目的后果是「同一件事的权重凭空翻倍」，抽查不出来。
    if (normalized !== undefined && !interests.some(exist => exist.id === normalized.id)) {
      interests.push(normalized)
    }
    if (interests.length >= MAX_INTERESTS) break
  }

  const notes: LifeNote[] = []
  const rawNotes = Array.isArray(raw['notes']) ? raw['notes'] : []
  for (const item of rawNotes) {
    const normalized = normalizeNote(item)
    if (normalized !== undefined) notes.push(normalized)
    if (notes.length >= maxNotes) break
  }

  return Object.freeze({
    version: STATE_VERSION,
    energy: normalizeEnergy(raw['energy'], at),
    lastActivityAt: stamp(raw['lastActivityAt']),
    lastSlot: typeof raw['lastSlot'] === 'string' ? raw['lastSlot'] : '',
    interests: Object.freeze(interests),
    notes: Object.freeze(notes),
    activities: count(raw['activities']),
    explored: count(raw['explored']),
  })
}

/**
 * 从磁盘读。读不到或读坏了返回 `undefined`（调用方据此判断「首次启动」）。
 * @param file 绝对路径；`undefined` 表示没有路径服务（纯内存模式）。
 * @param at 兜底时刻。
 * @param maxNotes 笔记上限。
 */
export function readState(file: string | undefined, at: number, maxNotes: number): LifeState | undefined {
  if (file === undefined) return undefined
  try {
    const text = readFileSync(file, 'utf8')
    if (text.trim() === '') return undefined
    return normalizeState(JSON.parse(text) as unknown, at, maxNotes)
  } catch {
    // 文件不存在 / 权限不足 / JSON 半截，都按「没有存档」处理。
    // 不在这里打日志：调用方更清楚「这是首次启动还是存档坏了」。
    return undefined
  }
}

/**
 * 原子写。序列化只写存档字段，不写派生值。
 * @param file 绝对路径；`undefined` 时返回 `false`。
 * @param state 状态。
 */
export function writeState(file: string | undefined, state: LifeState): boolean {
  if (file === undefined) return false
  const tmp = file + TMP_SUFFIX
  try {
    const payload = JSON.stringify({
      version: STATE_VERSION,
      energy: state.energy,
      lastActivityAt: state.lastActivityAt,
      lastSlot: state.lastSlot,
      interests: state.interests,
      notes: state.notes,
      activities: state.activities,
      explored: state.explored,
    })
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
