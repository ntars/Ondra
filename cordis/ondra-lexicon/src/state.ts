/**
 * 形状存档：**只落形状，不落原话**。
 *
 * ## 存的是什么
 *
 * 每条样本只有：判重指纹、时刻、整条字数、每句长度、有没有标点、句末语气词计数。
 * 打开 `user/lexicon-shape.json` 能看到「某人有一条 9 个字的句子」，看不到
 * 「某人说了什么」。这不是加密，是**根本不写**——加密还得管密钥，不写就没有。
 *
 * ## 为什么要落盘
 *
 * 不落盘的话，每次重启都要重新攒够 30 条才出段，而重启在开发期一天好几次。
 * 症状是「语感时有时无」，而且不报错。
 *
 * ## 为什么是临时文件 + rename
 *
 * 与 O-044 / O-134 同一套写法（0600 + 临时文件 + rename）。直接覆写会在断电时
 * 留下半截 JSON，下一次读取按空存档处理——表现是「语感突然消失」，
 * 而日志里一个字都没有。
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { MessageShape } from './types.js'

/** 存档版本。读到不认识的版本按空存档处理，不猜迁移。 */
export const STATE_VERSION = 1

/** 存档文件名（放在 `user` 区）。 */
export const STATE_FILE_NAME = 'lexicon-shape.json'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 一份存档。 */
export interface LexiconState {
  /** 版本。 */
  readonly version: number
  /** 形状序列，按入窗顺序（旧 → 新）。 */
  readonly samples: readonly MessageShape[]
}

/** 空存档。 */
export function emptyState(): LexiconState {
  return Object.freeze({ version: STATE_VERSION, samples: Object.freeze([]) as readonly MessageShape[] })
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读一个非负整数。 */
function intOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

/**
 * 归一化一条形状。**任何字段坏了就整条丢掉**：一条半坏的样本会让中位数算错，
 * 而中位数没有「看得出来不对」的余地。
 * @param value 存档里的原始对象。
 * @returns 可用形状；不合法时 undefined。
 */
export function normalizeShape(value: unknown): MessageShape | undefined {
  if (!isRecord(value)) return undefined

  const fingerprint = typeof value['fingerprint'] === 'string' ? value['fingerprint'] : ''
  if (fingerprint.length === 0) return undefined

  const rawSentences = Array.isArray(value['sentenceChars']) ? value['sentenceChars'] : []
  const sentenceChars: number[] = []
  for (const item of rawSentences) {
    const length = intOf(item)
    if (length > 0) sentenceChars.push(length)
  }

  const rawParticles = isRecord(value['particles']) ? value['particles'] : {}
  const particles: Record<string, number> = {}
  for (const [particle, count] of Object.entries(rawParticles)) {
    const times = intOf(count)
    if (times > 0) particles[particle] = times
  }

  return Object.freeze({
    fingerprint,
    at: intOf(value['at']),
    chars: intOf(value['chars']),
    sentenceChars: Object.freeze(sentenceChars),
    noPunct: value['noPunct'] === true,
    particles: Object.freeze(particles),
  })
}

/**
 * 归一化整份存档。版本不认识、结构不对 → 空存档。
 * @param value 解析出来的 JSON。
 */
export function normalizeState(value: unknown): LexiconState {
  if (!isRecord(value)) return emptyState()
  if (intOf(value['version']) !== STATE_VERSION) return emptyState()

  const rawSamples = Array.isArray(value['samples']) ? value['samples'] : []
  const samples: MessageShape[] = []
  for (const item of rawSamples) {
    const shape = normalizeShape(item)
    if (shape !== undefined) samples.push(shape)
  }
  return Object.freeze({ version: STATE_VERSION, samples: Object.freeze(samples) })
}

/**
 * 读存档。**任何失败都当空存档**，不抛：少一段语感不是错误，是降级。
 * @param file 存档路径；undefined 表示没有路径服务。
 */
export function readState(file: string | undefined): LexiconState {
  if (file === undefined || file.length === 0) return emptyState()
  try {
    const raw = readFileSync(file, { encoding: 'utf8' })
    return normalizeState(JSON.parse(raw) as unknown)
  } catch {
    return emptyState()
  }
}

/**
 * 写存档。失败返回 false（调用方只告警，不改行为）。
 * @param file 存档路径。
 * @param state 存档内容。
 */
export function writeState(file: string, state: LexiconState): boolean {
  const tmp = `${file}${TMP_SUFFIX}`
  try {
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      // 权限收紧失败不影响数据正确性：它只影响「别人能不能读到形状」。
    }
    return true
  } catch {
    return false
  }
}

/**
 * 追加一条形状，并保持窗口上限。**新样本在尾部**，超了从头部挤掉。
 * @param samples 当前形状序列。
 * @param shape 新形状。
 * @param window 窗口条数。
 */
export function appendShape(
  samples: readonly MessageShape[],
  shape: MessageShape,
  window: number,
): readonly MessageShape[] {
  const limit = Math.max(1, Math.trunc(window))
  const next = [...samples, shape]
  if (next.length <= limit) return Object.freeze(next)
  return Object.freeze(next.slice(next.length - limit))
}

/**
 * 丢掉超过时间窗口的样本。
 *
 * 语感会变：一个月前他爱打句号，现在不打了。不设时间窗，旧样本会一直占着
 * 300 个名额里的位置，让「最近」变成「很久以前」。
 * @param samples 当前形状序列。
 * @param newestAt 最新一条的时刻（作为「现在」的锚点）。
 * @param maxAgeHours 最大年龄（小时）；<=0 表示不限制。
 */
export function pruneByAge(
  samples: readonly MessageShape[],
  newestAt: number,
  maxAgeHours: number,
): readonly MessageShape[] {
  if (maxAgeHours <= 0) return samples
  const floor = newestAt - maxAgeHours * 3_600_000
  const kept = samples.filter(shape => shape.at >= floor)
  if (kept.length === samples.length) return samples
  return Object.freeze(kept)
}
