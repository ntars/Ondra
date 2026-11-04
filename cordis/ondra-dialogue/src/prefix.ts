/**
 * 稳定段的拼装与指纹 —— **纯函数，不碰 ctx**。
 *
 * ## 为什么指纹必须由「拼好的全文」算，而不是由「各段指纹之和」算
 *
 * 两种算法在正常路径上结果一样，但在一种情况下会分叉：段的**顺序**变了、
 * 内容没变。按段求和会把「人格在前、世界书在后」与「世界书在前、人格在后」
 * 算成同一个指纹——而这两者对模型是完全不同的两段话，缓存也不能互认。
 *
 * 所以指纹只从最终那条 system 消息的 `content` 算。这也是它能被
 * `prefixOf()` 直接拿去和界面显示的值对上的原因：一个值，一个来源。
 *
 * ## 为什么用 djb2 而不是 SHA-256
 *
 * 这里的指纹只用于「这一轮的前缀和上一轮是不是同一份」与界面显示，
 * 不用于安全。djb2 是 40 行以内的纯算术，没有依赖，也不会因为
 * 换运行时（Node 内建 crypto 的可用性）而失效。碰撞概率对「几百个会话
 * 各自比较自己前后两轮」这个场景完全够用。
 */

import type { StablePart, TailPart } from './types.js'

/** 段 id 的合法形状（手册 §8.4）。内联而不 import 常量，避免多一条模块依赖。 */
const PART_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * djb2 指纹，输出 8 位小写十六进制。
 *
 * 用 `>>> 0` 把结果夹成无符号 32 位：不夹的话 `hash * 33 + c` 会溢出成
 * 负数，`toString(16)` 会给出带负号的串，两个不同内容可能拼出同一个显示值。
 * @param text 文本。
 */
export function djb2(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    // 逐字符取码点（不用 charCodeAt 的代理对拆分：中文 BMP 内无影响，
    // emoji 会被拆成两个码元，但那只影响指纹分布，不影响一致性）。
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 过滤并规整稳定段。
 *
 * 三条丢弃规则（都只影响「进不进前缀」，不报错）：
 * 1. `id` 不合规 —— 界面按 id 显示段名，非法 id 会渲染成空白行；
 * 2. 正文 trim 后为空 —— 空段会在前缀里留下连续空行，白占 token；
 * 3. 重复 id —— 后一个会覆盖前一个的显示名，但两段文字都在，
 *    界面上看起来是「同一段出现了两次」，最难解释。
 * @param parts 原始段。
 */
export function normalizeStable(parts: readonly StablePart[] | undefined): readonly StablePart[] {
  if (parts === undefined || parts.length === 0) return []
  const seen = new Set<string>()
  const out: StablePart[] = []
  for (const part of parts) {
    if (!PART_ID_RE.test(part.id)) continue
    if (typeof part.text !== 'string') continue
    const text = part.text.trim()
    if (text === '') continue
    if (seen.has(part.id)) continue
    seen.add(part.id)
    out.push({ id: part.id, text, source: part.source })
  }
  return out
}

/**
 * 把稳定段拼成一条 system 正文。
 *
 * 分隔符固定 `\n\n`（与手册 §9.5 的上下文装配一致），**不做配置项**：
 * 换分隔符会让同一份人格在不同机器上产生不同指纹，缓存互不认。
 * @param parts 已规整的段。
 */
export function joinStable(parts: readonly StablePart[]): string {
  return parts.map(part => part.text).join('\n\n')
}

/**
 * 排序并过滤易变段。
 *
 * 过滤三条：id 非法、正文为空、置信度低于门槛（ABI 要求「过滤低置信度」）。
 * `ttlMinutes` **不在这里判**：段上没有「生成时刻」，用 `Date.now()` 去减
 * 只会得到「全都过期」——过期该由产出方判断，它才知道自己是什么时候算的。
 * @param parts 原始段。
 * @param minConfidence 最低置信度。
 */
export function orderTails(
  parts: readonly TailPart[] | undefined,
  minConfidence: number,
): readonly TailPart[] {
  if (parts === undefined || parts.length === 0) return []
  const kept: TailPart[] = []
  for (const part of parts) {
    if (!PART_ID_RE.test(part.id)) continue
    if (typeof part.text !== 'string') continue
    const text = part.text.trim()
    if (text === '') continue
    const confidence = part.confidence
    if (confidence !== undefined && Number.isFinite(confidence) && confidence < minConfidence) continue
    kept.push({
      id: part.id,
      text,
      order: Number.isFinite(part.order) ? part.order : 0,
      // 可选字段用条件展开而不是写 `undefined`：`exactOptionalPropertyTypes`
      // 下 `ttlMinutes: undefined` 与「没有这个字段」是两件事。
      ...(part.ttlMinutes === undefined ? {} : { ttlMinutes: part.ttlMinutes }),
      ...(confidence === undefined ? {} : { confidence }),
    })
  }
  // `Array.prototype.sort` 在 ES2019 起是稳定排序：同 `order` 保持传入顺序，
  // 所以不需要再拼一个「原始下标」当第二排序键。
  kept.sort((a, b) => a.order - b.order)
  return kept
}

/**
 * 把易变段拼成一段文本。空数组返回空串（调用方据此决定要不要插那条消息）。
 * @param parts 已排序的段。
 */
export function joinTails(parts: readonly TailPart[]): string {
  return parts.map(part => part.text).join('\n\n')
}
