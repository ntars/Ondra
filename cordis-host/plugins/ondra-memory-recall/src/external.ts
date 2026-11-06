/**
 * 两条**外部**通道的适配层（向量 O-122 / recognition O-141）。
 *
 * 三条纪律：
 *
 * 1. **缺席不是错误。** 没装就是 `absent`，装了但没命中是 `empty`。
 *    两者必须分开——混成空数组，监控分不清「能力缺失」与「今天没什么可想起的」。
 * 2. **它们抛错不许外传（C3 的同一条道理）。** 向量库崩了不该让整轮对话想不起任何事，
 *    故一律 try/catch 转 `error` 状态，本条通道退出融合，其余通道照跑。
 * 3. **返回值必须验形状。** 外部通道是别的插件实现的，`score` 可能是 `NaN`、
 *    `id` 可能不是字符串。不验就会把一个 `NaN` 带进排序，
 *    结果是「排序莫名其妙全乱」而日志里一切正常。
 */

import type { RankedItem } from './lexical.js'
import type { ChannelState, ExternalHitLike, RecognitionSourceLike, VectorSourceLike } from './types.js'

/** 探针结果。 */
export interface ProbeResult {
  /** 通道状态。 */
  readonly state: ChannelState
  /** 命中（已排序、已清洗）。 */
  readonly items: readonly RankedItem[]
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 清洗外部命中：丢掉形状不对的、夹紧分数、按 id 去重取最高分。
 * @param raw 原始返回。
 */
function sanitize(raw: unknown): RankedItem[] {
  if (!Array.isArray(raw)) return []
  const best = new Map<string, number>()
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const hit = item as Partial<ExternalHitLike>
    if (typeof hit.id !== 'string' || hit.id.length === 0) continue
    if (typeof hit.score !== 'number' || !Number.isFinite(hit.score)) continue
    const score = Math.min(1, Math.max(0, hit.score))
    const previous = best.get(hit.id)
    if (previous === undefined || score > previous) best.set(hit.id, score)
  }
  return [...best.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => (right.score === left.score ? (left.id < right.id ? -1 : 1) : right.score - left.score))
}

/**
 * 探向量分支。
 * @param source 向量服务（可能缺席）。
 * @param text 查询文本。
 * @param options `enabled` 是否允许启用；`limit` 该分支返回上限。
 */
export function probeVector(
  source: VectorSourceLike | undefined,
  text: string,
  options: { readonly enabled: boolean; readonly limit: number },
): ProbeResult {
  if (!options.enabled) {
    return { state: { channel: 'vector', family: 'semantic', status: 'absent', items: 0, detail: '配置里关掉了（vectorBranch=off）' }, items: [] }
  }
  if (source === undefined) {
    return {
      state: { channel: 'vector', family: 'semantic', status: 'absent', items: 0, detail: '没有 ondra-memory-vector（O-122），语义因子退出归一化' },
      items: [],
    }
  }
  if (source.available === false) {
    return { state: { channel: 'vector', family: 'semantic', status: 'absent', items: 0, detail: '向量服务在位但不可用' }, items: [] }
  }
  try {
    const items = sanitize(source.search(text, { limit: options.limit }))
    return {
      state: { channel: 'vector', family: 'semantic', status: items.length === 0 ? 'empty' : 'used', items: items.length },
      items,
    }
  } catch (error) {
    return {
      state: { channel: 'vector', family: 'semantic', status: 'error', items: 0, detail: messageOf(error) },
      items: [],
    }
  }
}

/**
 * 探 recognition 分支。
 * @param source recognition 服务（可能缺席）。
 * @param text 查询文本。
 * @param options `enabled` 与 `limit`。
 */
export function probeRecognition(
  source: RecognitionSourceLike | undefined,
  text: string,
  options: { readonly enabled: boolean; readonly limit: number },
): ProbeResult {
  if (!options.enabled) {
    return {
      state: { channel: 'recognition', family: 'recognition', status: 'absent', items: 0, detail: '配置里关掉了（recognitionBranch=off）' },
      items: [],
    }
  }
  if (source === undefined) {
    return {
      state: { channel: 'recognition', family: 'recognition', status: 'absent', items: 0, detail: '没有 ondra-memory-recognition（O-141），该通道不参与融合' },
      items: [],
    }
  }
  if (source.available === false) {
    return { state: { channel: 'recognition', family: 'recognition', status: 'absent', items: 0, detail: 'recognition 服务在位但不可用' }, items: [] }
  }
  try {
    const items = sanitize(source.search(text, { limit: options.limit }))
    return {
      state: { channel: 'recognition', family: 'recognition', status: items.length === 0 ? 'empty' : 'used', items: items.length },
      items,
    }
  } catch (error) {
    return { state: { channel: 'recognition', family: 'recognition', status: 'error', items: 0, detail: messageOf(error) }, items: [] }
  }
}
