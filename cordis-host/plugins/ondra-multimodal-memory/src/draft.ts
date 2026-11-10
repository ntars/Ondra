/**
 * 草稿校验与归一化：把「上游声称的一份草稿」变成「本包敢往库里写的一条记录」。
 *
 * ## 为什么不信上游的字段
 *
 * 上游是本仓自己的插件，理论上不会乱来。但入库是**不可逆**的那一步：
 * 一条 `modality: 'video'` 却带着图片正文的记录，三年后没人能查清它是怎么进去的。
 * 所以这里做四件确定性的事，每件都不问模型：
 *
 * 1. **类型收窄**：每个字段都按 `typeof` 判一遍，不合格就当缺省，不抛错；
 * 2. **指纹重算**：拿 `modality + '\0' + sourcePath + '\0' + text` 重算一遍，
 *    与上游给的比对。不一致就**用重算值**并记一条降级说明。
 * 3. **数组清洗**：`spans` / `boxes` / `frames` 逐项校验，坏项丢掉而不是整条丢掉；
 * 4. **字数重算**：`chars` 按码位重数，不信上游的 `String.length`。
 *
 * ## 为什么指纹要重算（这是本文件最重要的一条）
 *
 * 去重的语义是「同一份内容只记一次」。而「同一份内容」必须由**内容**判定，
 * 不能由上游**声称**。三个理由：
 *
 * - 上游改了 `text` 却忘了改 `fingerprint`（最可能的漂移方式），
 *   用上游值就会把两段不同的内容判成重复——**悄悄吞掉一条记忆**；
 * - 重算错的方向只有一个：内容不同就指纹不同，最多多记一条，
 *   而多记一条是**看得见**的（记忆列表里两条相似的），吞掉一条是看不见的；
 * - 契约把拼接方式写死在注释里，重算是可复现的，不需要额外信息。
 *
 * 所以：**宁可多一条，不可少一条。** 指纹不一致时记 `degraded: 'fingerprint-mismatch'`，
 * 让「上游算错了」这件事显形，而不是被静默修好。
 *
 * ## 为什么证据来源按 `modality` 定，而不是一律 `TOOL`
 *
 * 手册 §2.2 的四类引文不是「数据从哪来」，而是「**这话是谁说的**」。
 *
 * | 种类 | 正文是谁的话 | 引文来源 |
 * |---|---|---|
 * | `audio` | 用户自己说的（whisper 只是转写通道） | `USER` |
 * | `image` | 模型对图片的描述（用户没说过这些字） | `TOOL` |
 * | `video` 帧条目 | 同上 | `TOOL` |
 *
 * 这个区分有实际后果：O-140 的归功闸规定「把决定归功于人类但没有 USER 引文的，
 * 最后一道门拒绝」。一段「我明天去医院」的语音转写，标 `TOOL` 就会被拒——
 * 而那明明是用户亲口说的。反过来，把图片描述标成 `USER`，就等于允许
 * 「用户答应周末吃饭」这种断言靠一张图的模型猜测立住。
 *
 * **归属错误比记不住更伤信任**（手册 §2.2）。所以这一列必须按「谁说的」判。
 */

import type { Config } from './settings.js'
import type {
  DetectionBox,
  Modality,
  MultimodalDraft,
  TranscriptSpan,
} from './types.js'
import { MODALITIES } from './types.js'
import { charsOf, clip, fingerprintOf, numberOr, squeeze, stringOr, titleOf } from './text.js'

/** 归一化的结果。 */
export type NormalizeOutcome =
  | { readonly ok: true; readonly draft: MultimodalDraft; readonly notes: readonly string[] }
  | { readonly ok: false; readonly reason: 'no-draft' | 'bad-modality' | 'empty-text' | 'bad-path'; readonly detail: string }

/** 路径字符上限（POSIX 单路径 1024 已很宽，这里留一倍余量）。 */
export const PATH_MAX = 2048

/** 视频帧描述单条上限（字）。一帧的画面描述不该比一条记忆还长。 */
export const FRAME_DESC_MAX = 120

/** 是不是三种来源之一。 */
export function isModality(value: unknown): value is Modality {
  return typeof value === 'string' && (MODALITIES as readonly string[]).includes(value)
}

/**
 * 正文的证据来源。
 *
 * `audio` → `USER`（用户亲口说的）；`image` / `video` → `TOOL`（模型描述的）。
 * 理由见文件头最后一节。
 * @param modality 种类。
 */
export function evidenceSourceOf(modality: Modality): 'USER' | 'TOOL' {
  return modality === 'audio' ? 'USER' : 'TOOL'
}

/**
 * 某一种来源的默认五类标签。
 * @param modality 种类。
 * @param config 配置。
 */
export function defaultKindOf(modality: Modality, config: Config): string {
  if (modality === 'image') return config.imageKind
  if (modality === 'audio') return config.audioKind
  return config.videoKind
}

/**
 * 某一种来源的默认寿命类别。
 * @param modality 种类。
 * @param config 配置。
 */
export function defaultCategoryOf(modality: Modality, config: Config): string {
  if (modality === 'image') return config.imageCategory
  if (modality === 'audio') return config.audioCategory
  return config.videoCategory
}

/**
 * 清洗时间戳数组。
 *
 * 三条丢弃规则：起止不是有限数、终点早于起点、文本是空的。
 * **不重排**：上游给的是时间顺序，重排会让「第 3 段跑到第 1 段前面」这种
 * 上游 bug 被静默掩盖；顺序可疑时保留原样，让人一眼看出不对。
 * @param value 原始值。
 */
export function sanitizeSpans(value: unknown): readonly TranscriptSpan[] {
  if (!Array.isArray(value)) return []
  const out: TranscriptSpan[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const start = numberOr(row['startMs'])
    const end = numberOr(row['endMs'])
    const text = stringOr(row['text'])
    if (start === undefined || end === undefined || text === undefined) continue
    if (end < start || text === '') continue
    const speaker = stringOr(row['speaker'])
    out.push(
      speaker === undefined || speaker === ''
        ? { startMs: Math.trunc(start), endMs: Math.trunc(end), text }
        : { startMs: Math.trunc(start), endMs: Math.trunc(end), text, speaker },
    )
  }
  return out
}

/**
 * 清洗检测框数组。
 *
 * 坐标**必须在 0–1 之间**：越界的框不是「稍微偏了」，是上游把像素坐标当成了
 * 归一化坐标（O-126 已明确「换算不了就整批拒收」）。这里再挡一次，
 * 因为一条框错了会让整张图的可解释性归零。
 * @param value 原始值。
 */
export function sanitizeBoxes(value: unknown): readonly DetectionBox[] {
  if (!Array.isArray(value)) return []
  const out: DetectionBox[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const label = stringOr(row['label'])
    const x = numberOr(row['x'])
    const y = numberOr(row['y'])
    const w = numberOr(row['w'])
    const h = numberOr(row['h'])
    if (label === undefined || x === undefined || y === undefined || w === undefined || h === undefined) {
      continue
    }
    const inRange = (n: number): boolean => n >= 0 && n <= 1
    if (!inRange(x) || !inRange(y) || !inRange(w) || !inRange(h)) continue
    if (w <= 0 || h <= 0) continue
    const confidence = numberOr(row['confidence'])
    out.push(
      confidence === undefined
        ? { label, x, y, w, h }
        : { label, x, y, w, h, confidence: Math.min(1, Math.max(0, confidence)) },
    )
  }
  return out
}

/**
 * 清洗帧路径数组（只留非空字符串，去重，保持顺序）。
 * @param value 原始值。
 */
export function sanitizeFrames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    const path = stringOr(item)
    if (path === undefined || path === '' || path.length > PATH_MAX) continue
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/**
 * 归一化一份草稿。
 *
 * **永不抛错**：任何不合格都折成一个原因码。
 * @param raw 上游给的草稿（类型未知，因为跨插件边界）。
 * @param now 当前时刻（`at` 缺失时用）。
 * @param config 配置（取标题上限）。
 */
export function normalizeDraft(raw: unknown, now: number, config: Config): NormalizeOutcome {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'no-draft', detail: '草稿不是对象' }
  }
  const row = raw as Record<string, unknown>

  const modality = row['modality']
  if (!isModality(modality)) {
    return {
      ok: false,
      reason: 'bad-modality',
      detail: `modality 不是 ${MODALITIES.join(' / ')} 之一：${String(modality).slice(0, 40)}`,
    }
  }

  const sourcePath = stringOr(row['sourcePath'])
  if (sourcePath === undefined || sourcePath === '') {
    return { ok: false, reason: 'bad-path', detail: 'sourcePath 是空的' }
  }
  if (sourcePath.length > PATH_MAX) {
    return { ok: false, reason: 'bad-path', detail: `sourcePath 超过 ${PATH_MAX} 字符` }
  }

  const text = typeof row['text'] === 'string' ? row['text'] : ''
  if (squeeze(text) === '') {
    // 绝不用占位文案顶上：占位会被当成「她真的看见了/听见了」入库。
    return { ok: false, reason: 'empty-text', detail: '正文是空的（上游没读出内容）' }
  }

  const notes: string[] = []

  const atRaw = numberOr(row['at'])
  const at = atRaw === undefined ? now : Math.trunc(atRaw)

  const titleRaw = stringOr(row['title'])
  const title =
    titleRaw === undefined || titleRaw === ''
      ? titleOf(text, config.maxTitleChars)
      : clip(titleRaw, config.maxTitleChars).text
  if (titleRaw !== undefined && titleRaw !== '' && charsOf(titleRaw) > config.maxTitleChars) {
    notes.push('title-truncated')
  }

  const provider = stringOr(row['provider'])
  if (provider === undefined || provider === '') {
    // 上游没报是谁产出的：如实写 unknown，不冒充某个 provider。
    notes.push('provider-missing')
  }

  const model = stringOr(row['model'])
  const declaredTruncated = row['truncated'] === true

  const spans = sanitizeSpans(row['spans'])
  const boxes = sanitizeBoxes(row['boxes'])
  const frames = sanitizeFrames(row['frames'])

  const computed = fingerprintOf(modality, sourcePath, text)
  const declared = stringOr(row['fingerprint'])
  if (declared !== undefined && declared !== '' && declared !== computed) {
    // 上游算错了（或改了正文没改指纹）。用重算值，并让这件事显形。
    notes.push('fingerprint-mismatch')
  }

  const degradedRaw = stringOr(row['degraded'])
  const degraded =
    degradedRaw === undefined || degradedRaw === ''
      ? notes.length === 0
        ? undefined
        : notes.join(',')
      : notes.length === 0
        ? degradedRaw
        : `${degradedRaw},${notes.join(',')}`

  const draft: MultimodalDraft = {
    modality,
    sourcePath,
    text,
    title,
    at,
    provider: provider === undefined || provider === '' ? 'unknown' : provider,
    ...(model === undefined || model === '' ? {} : { model }),
    chars: charsOf(text),
    truncated: declaredTruncated,
    fingerprint: computed,
    ...(spans.length === 0 ? {} : { spans }),
    ...(boxes.length === 0 ? {} : { boxes }),
    ...(frames.length === 0 ? {} : { frames }),
    ...(degraded === undefined ? {} : { degraded }),
  }

  return { ok: true, draft, notes }
}

/**
 * 把 4 帧的描述拼成一段正文。
 *
 * 三条写法上的取舍：
 *
 * 1. **帧序号用全角圈号**（①②③④）：一眼能看出这是「第几帧」，而不是句号串；
 * 2. **没描述到的那一帧写「（未描述）」**，不跳过——跳过会让「3 个描述」
 *    看起来像「3 帧」，而实际抽了 4 帧；
 * 3. **不加「这是一个视频」这类开场白**：正文要能直接进检索，
 *    多一句废话就多一份注入预算。
 * @param frames 帧路径（按时间顺序）。
 * @param descriptions 与 `frames` 等长的描述；缺的用空串。
 */
export function composeFramesText(
  frames: readonly string[],
  descriptions: readonly string[],
): string {
  const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫']
  const parts: string[] = []
  for (let index = 0; index < frames.length; index += 1) {
    const mark = marks[index] ?? `(${index + 1})`
    const raw = descriptions[index] ?? ''
    const desc = squeeze(raw)
    parts.push(`${mark}${desc === '' ? '（未描述）' : clip(desc, FRAME_DESC_MAX).text}`)
  }
  return parts.join('；')
}
