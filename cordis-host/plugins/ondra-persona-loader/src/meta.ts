/**
 * `meta.json` 的解析与归一化。
 *
 * 三条原则：
 *
 * 1. **宽进严出。** 两个人设包的 `meta.json` 字段并不完全一致
 *    （一个带 `alias`、一个不带；`source.chapters` 一个是数字一个是字符串；
 *    `source.characters` 一个是数组一个是数字）。所以这里**逐字段挑**，
 *    挑不到的留空，**不补一个像样的默认值**——补出来的「性格」比没有更坏。
 *
 * 2. **只有 `id` 是硬要求。** 它会成为别处的键（`activePersona` 配置、日志命名空间），
 *    所以必须合规；其余字段缺了只是「界面上少一块」，不该拒收整个包。
 *    这也是「字段缺失走默认、字段给错才拒」这条纪律在本插件里的落点。
 *
 * 3. **不做内容判断。** 这个包写得好不好、像不像，是 `ondra-persona-core`
 *    与验收测试集的事；本文件只回答「它自称是什么」。
 */

import { PERSONA_ID_PATTERN } from './types.js'
import type {
  PersonaIssue,
  PersonaIssueCode,
  PersonaProfile,
  PersonaSource,
  PersonaTagsSource,
} from './types.js'

/** 触发词上限。与 `maxPersonas` 无关，纯粹防「一个包写两千个触发词」。 */
const TRIGGER_LIMIT = 32

/** 别名上限。 */
const ALIAS_LIMIT = 32

/** 性格标签上限。 */
const PERSONALITY_LIMIT = 32

/** chips 最多几条（人设卡一行放不下更多）。 */
const TAG_LIMIT = 3

/** 归一化后的 `meta.json`。 */
export interface NormalizedMeta {
  /** 合规的人设 id。 */
  readonly id: string
  /** 包名（可能是中文）。 */
  readonly name: string
  /** 展示名。 */
  readonly displayName: string
  /** 版本，缺失为空串。 */
  readonly version: string
  /** 语言，缺失为 `zh-CN`（本仓两个人设包都是 `zh-CN`）。 */
  readonly language: string
  /** 触发词。 */
  readonly triggerWords: readonly string[]
  /** 人设卡 chips。 */
  readonly tags: readonly string[]
  /** chips 来源。 */
  readonly tagsSource: PersonaTagsSource
  /** 档案。 */
  readonly profile: PersonaProfile
  /** 语料来源。 */
  readonly source: PersonaSource
  /** 结构统计。 */
  readonly structure: Readonly<Record<string, string | number>>
  /** 安全声明。 */
  readonly safety: Readonly<Record<string, unknown>>
  /** 版权声明。 */
  readonly license: string
  /** `meta.files`：路径 → 说明。 */
  readonly declaredFiles: Readonly<Record<string, string>>
}

/** 解析结果。 */
export interface MetaParseResult {
  /** 解析成功时的归一化结果。 */
  readonly meta?: NormalizedMeta
  /** 过程中发现的问题。 */
  readonly issues: readonly PersonaIssue[]
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取字符串（去空白；空白视为缺失）。 */
function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 取数字。 */
function pickNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 取字符串数组：去空白、去重、截断。
 * @param record 源对象。
 * @param key 键名。
 * @param limit 上限。
 */
function pickStringArray(record: Record<string, unknown>, key: string, limit: number): string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 归一化 `profile` 段。
 * @param raw `meta.profile`。
 */
export function normalizeProfile(raw: unknown): PersonaProfile {
  if (!isRecord(raw)) {
    return Object.freeze({
      alias: Object.freeze([]),
      personality: Object.freeze([]),
    })
  }
  const fingerprint = isRecord(raw['speech_fingerprint'])
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(raw['speech_fingerprint']).filter(
            (entry): entry is [string, string | number] =>
              typeof entry[1] === 'string' || typeof entry[1] === 'number',
          ),
        ),
      )
    : undefined
  return Object.freeze({
    fullName: pickString(raw, 'full_name'),
    alias: Object.freeze(pickStringArray(raw, 'alias', ALIAS_LIMIT)),
    ageRange: pickString(raw, 'age_range'),
    occupation: pickString(raw, 'occupation'),
    personality: Object.freeze(pickStringArray(raw, 'personality', PERSONALITY_LIMIT)),
    attachmentStyle: pickString(raw, 'attachment_style'),
    loveLanguage: pickString(raw, 'love_language'),
    speechFingerprint: fingerprint,
  })
}

/**
 * 归一化 `source` 段（只取六个两边都稳的字段，见 `types.ts` 的说明）。
 * @param raw `meta.source`。
 */
export function normalizeSource(raw: unknown): PersonaSource {
  if (!isRecord(raw)) return Object.freeze({})
  return Object.freeze({
    work: pickString(raw, 'work'),
    author: pickString(raw, 'author'),
    platform: pickString(raw, 'platform'),
    readingMethod: pickString(raw, 'reading_method'),
    quotesChecked: pickNumber(raw, 'quotes_checked'),
    quotesMatched: pickNumber(raw, 'quotes_matched'),
  })
}

/**
 * 归一化 `structure` 段（原包是一堆计数，原样保留给界面）。
 * @param raw `meta.structure`。
 */
export function normalizeStructure(raw: unknown): Readonly<Record<string, string | number>> {
  if (!isRecord(raw)) return Object.freeze({})
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim()
  }
  return Object.freeze(out)
}

/**
 * 归一化 `meta.files`（路径 → 说明）。
 * @param raw `meta.files`。
 */
export function normalizeDeclaredFiles(raw: unknown): Readonly<Record<string, string>> {
  if (!isRecord(raw)) return Object.freeze({})
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const path = key.replace(/\\/g, '/').replace(/^\.\//, '').trim()
    const doc = value.trim()
    if (path === '' || doc === '') continue
    out[path] = doc
  }
  return Object.freeze(out)
}

/**
 * 把任意字符串收拾成合规的 id 候选。
 *
 * 只做「机械替换」，不做音译——把中文名硬翻成拼音是编造。
 * @param value 原始字符串。
 */
export function toIdCandidate(value: string): string {
  const lowered = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/[-_]+$/, '')
  return lowered.length > 64 ? lowered.slice(0, 64) : lowered
}

/**
 * 算人设 id：`slug` → `name` → 包文件名 → 放弃。
 *
 * 三级顺序的理由：`slug` 是作者明确写下的稳定标识；`name` 有时也是 ASCII
 * （例如 `oh-jingjing`）；包文件名是最后一根稻草，且**只在它能被机械转成合法 id 时**才用。
 * @param slug `meta.slug`。
 * @param name `meta.name`。
 * @param fallback 包文件名（已去掉 `.skill.zip`）。
 */
export function resolveId(slug: unknown, name: unknown, fallback: string): string | undefined {
  const candidates: string[] = []
  if (typeof slug === 'string') candidates.push(slug.trim().toLowerCase())
  if (typeof name === 'string') candidates.push(name.trim().toLowerCase())
  candidates.push(toIdCandidate(fallback))
  for (const candidate of candidates) {
    if (PERSONA_ID_PATTERN.test(candidate)) return candidate
  }
  return undefined
}

/**
 * 解析 `meta.json`。
 * @param jsonText 文件内容。
 * @param fallbackId 包文件名（已去掉 `.skill.zip`），用于最后一级 id 推导。
 * @param fileLabel 包文件名，用于问题定位。
 */
export function parseMeta(jsonText: string, fallbackId: string, fileLabel: string): MetaParseResult {
  const issues: PersonaIssue[] = []
  /** 收一条问题。 */
  const push = (code: PersonaIssueCode, detail: string): void => {
    issues.push({ code, file: fileLabel, detail })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    push('bad-meta', 'meta.json 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)))
    return { issues: Object.freeze(issues) }
  }
  if (!isRecord(parsed)) {
    push('bad-meta', 'meta.json 的顶层不是对象')
    return { issues: Object.freeze(issues) }
  }

  const id = resolveId(parsed['slug'], parsed['name'], fallbackId)
  if (id === undefined) {
    push(
      'bad-id',
      '算不出合规的人设 id（需要在 meta.json 里补 `slug`，只允许小写字母开头、' +
        '小写字母/数字/连字符/下划线，2–64 位）',
    )
    return { issues: Object.freeze(issues) }
  }

  const name = pickString(parsed, 'name') ?? id
  const displayName = pickString(parsed, 'display_name') ?? name
  const profile = normalizeProfile(parsed['profile'])
  const declared = pickStringArray(parsed, 'tags', TAG_LIMIT)
  const tagsSource: PersonaTagsSource =
    declared.length > 0 ? 'meta' : profile.personality.length > 0 ? 'personality' : 'none'
  const tags = declared.length > 0 ? declared : profile.personality.slice(0, TAG_LIMIT)

  const triggerWords = pickStringArray(parsed, 'trigger_words', TRIGGER_LIMIT)
  if (triggerWords.length === 0) {
    // 不是致命：人设照样能用（用户手动选），但「叫她名字就切过去」这条会失效。
    issues.push({
      code: 'no-trigger',
      id,
      file: fileLabel,
      detail: 'meta.json 没有可用的 `trigger_words`：自动切换人设不会生效，只能手动选',
    })
  }

  const meta: NormalizedMeta = Object.freeze({
    id,
    name,
    displayName,
    version: pickString(parsed, 'version') ?? '',
    language: pickString(parsed, 'language') ?? 'zh-CN',
    triggerWords: Object.freeze(triggerWords),
    tags: Object.freeze(tags),
    tagsSource,
    profile,
    source: normalizeSource(parsed['source']),
    structure: normalizeStructure(parsed['structure']),
    safety: isRecord(parsed['safety']) ? Object.freeze({ ...parsed['safety'] }) : Object.freeze({}),
    license: pickString(parsed, 'license') ?? '',
    declaredFiles: normalizeDeclaredFiles(parsed['files']),
  })
  return { meta, issues: Object.freeze(issues) }
}
