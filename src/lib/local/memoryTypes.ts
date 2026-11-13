/**
 * 手机端记忆引擎的类型底座。
 *
 * 与 `emotionTypes.ts` 同一个理由：只搬算法闭包内的声明，逐字复制。
 * 源：`cordis-host/plugins/ondra-memory-core/src/types.ts`。
 */

/**
 * 11 个寿命类别（手册 §2.4）。
 *
 * 顺序即存档字段顺序，与桌面版一致。
 */
export const MEMORY_CATEGORIES = [
  'watch',
  'daily',
  'food',
  'place',
  'misc',
  'event',
  'feeling',
  'study',
  'person',
  'promise',
  'self',
] as const

/** 寿命类别。 */
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

/**
 * 三个记忆通道。
 *
 * - `fact`：事实（谁在哪、做什么），衰减最快；
 * - `gist`：梗概（聊过什么），中速；
 * - `affect`：情绪印象，最慢。
 */
export const MEMORY_CHANNELS = ['fact', 'gist', 'affect'] as const

/** 记忆通道。 */
export type MemoryChannel = (typeof MEMORY_CHANNELS)[number]

/** 一条记忆的存续状态。 */
export type MemoryState = 'active' | 'archived' | 'sealed'

/** 寿命分解。每一段都是可解释的乘数。 */
export interface Stability {
  /** 类别基线（小时）。 */
  readonly baseHours: number
  /** 显著度系数 `0.45 + salience/100 × 1.25`。 */
  readonly salienceFactor: number
  /** 唤醒度系数 `1 + arousal × 0.65`。 */
  readonly arousalFactor: number
  /** 通道系数 `channelDays / anchorDays`。 */
  readonly channelFactor: number
  /** 提及因子 `min(15, 3×(1+ln(1+timesSaid))) / 3`。 */
  readonly mentionFactor: number
  /** 命中因子 `min(4, 1+0.6·log2(1+hits))`。 */
  readonly hitFactor: number
  /** 合计（小时）。 */
  readonly hours: number
}