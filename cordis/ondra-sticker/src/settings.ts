/**
 * 配置的**单一真源**（目录布局 + 缓存 + 归一开关）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么目录名要做校验
 *
 * `userSubdir` 与 `personaSubdir` 会被拼进路径。用户填 `..` 或 `/etc`
 * 就能让本插件去扫数据根之外的地方——虽然只读，但那是越界。
 * 因此只接受"一段普通目录名"（字母数字点横线），否则回退默认值并记进 drift。
 *
 * ## 为什么保留 `personaSubdir`（手册路径）
 *
 * 手册 §7.3-3 写的是 `personas/<id>/stickers/`。本仓的人设是 zip 包，
 * 那个目录通常不存在；但**别人按手册手工建了它**也完全可能。
 * 按 §12「能兼容就做只读兼容层」：先查它，没有再用默认根。
 * 关掉 `readLegacyPath` 就只看默认根——给"我知道自己在干什么"的人一个开关。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`pick()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 贴纸根在数据根 `user/` 下的子目录名。 */
  readonly userSubdir: string
  /** 手册路径前缀（`personas/<id>/stickers`）。 */
  readonly personaSubdir: string
  /** 是否先查手册路径。 */
  readonly readLegacyPath: boolean
  /** 绝对路径覆盖（O-002 缺席时用）。空串表示不覆盖。 */
  readonly rootOverride: string
  /** 是否把标签过一遍同义表。 */
  readonly normalizeTags: boolean
  /** 索引缓存时长（毫秒）。0 表示每次都重扫。 */
  readonly cacheTtlMs: number
  /** 是否在装载时建好三个目录（让用户有地方丢图）。 */
  readonly createDirs: boolean
  /** 取图结果是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'sticker'

/** 一段合法目录名。 */
export const SEGMENT_RE = /^[A-Za-z0-9._-]{1,32}$/

/** 缓存时长的上界（10 分钟已经长到"新丢的图要等一集剧"）。 */
export const CACHE_TTL_CEIL = 600000

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后一律不取图（服务照常注册）。',
  },
  userSubdir: {
    kind: 'string',
    default: 'stickers',
    pattern: SEGMENT_RE.source,
    doc: '贴纸根在数据根 user/ 下的子目录名。只接受一段普通目录名。',
  },
  personaSubdir: {
    kind: 'string',
    default: 'personas',
    pattern: SEGMENT_RE.source,
    advancedOnly: true,
    doc: '手册 §7.3-3 的路径前缀（personas/<id>/stickers）。先查它，没有再查默认根。',
  },
  readLegacyPath: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '是否先查手册路径。关掉就只看默认根。',
  },
  rootOverride: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '绝对路径覆盖，O-002 路径服务缺席时用。空串表示不覆盖。',
  },
  normalizeTags: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '是否把标签过一遍同义表（高兴→开心、joyful→开心）。关掉则文件名原样当标签。',
  },
  cacheTtlMs: {
    kind: 'number',
    default: 60000,
    min: 0,
    max: CACHE_TTL_CEIL,
    doc: `索引缓存时长（0–${CACHE_TTL_CEIL} 毫秒）。0 表示每次取图都重扫目录。`,
  },
  createDirs: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '装载时建好贴纸根与 shared / builtin 两个子目录，让用户有地方丢图。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '取图结果打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  userSubdir: FIELD_SPECS.userSubdir.default as string,
  personaSubdir: FIELD_SPECS.personaSubdir.default as string,
  readLegacyPath: FIELD_SPECS.readLegacyPath.default as boolean,
  rootOverride: FIELD_SPECS.rootOverride.default as string,
  normalizeTags: FIELD_SPECS.normalizeTags.default as boolean,
  cacheTtlMs: FIELD_SPECS.cacheTtlMs.default as number,
  createDirs: FIELD_SPECS.createDirs.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  userSubdir: 'user-subdir',
  personaSubdir: 'persona-subdir',
  readLegacyPath: 'read-legacy-path',
  rootOverride: 'root-override',
  normalizeTags: 'normalize-tags',
  cacheTtlMs: 'cache-ttl-ms',
  createDirs: 'create-dirs',
  verbose: 'verbose',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config]),
  ),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '贴纸',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-sticker',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 * @param raw 原始配置对象。
 */
export function normalizeUserLayer(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[KEY_PAIRS[key as keyof Config] ?? key] = value
  }
  return out
}

/**
 * 把 O-005 的解析结果（kebab 键）回填成 Config 形状（camel 键）。
 * @param values 解析结果的 `values`。
 */
export function valuesToConfigShape(values: unknown): Record<string, unknown> {
  if (!isRecord(values)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[SECTION_KEYS[key] ?? key] = value
  }
  return out
}

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 一段目录名是否合法。`..` 与绝对路径都不合法（会被拼出数据根之外）。
 * @param value 待验值。
 */
function isSegment(value: unknown): value is string {
  return typeof value === 'string' && value !== '..' && value !== '.' && SEGMENT_RE.test(value)
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  const override = raw['rootOverride']
  const rootOverride = typeof override === 'string' && override.startsWith('/') ? override.replace(/\/+$/, '') : ''

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    userSubdir: isSegment(raw['userSubdir']) ? raw['userSubdir'] : DEFAULT_CONFIG.userSubdir,
    personaSubdir: isSegment(raw['personaSubdir']) ? raw['personaSubdir'] : DEFAULT_CONFIG.personaSubdir,
    readLegacyPath: bool('readLegacyPath', DEFAULT_CONFIG.readLegacyPath),
    rootOverride,
    normalizeTags: bool('normalizeTags', DEFAULT_CONFIG.normalizeTags),
    cacheTtlMs: clampInt(raw['cacheTtlMs'], DEFAULT_CONFIG.cacheTtlMs, 0, CACHE_TTL_CEIL),
    createDirs: bool('createDirs', DEFAULT_CONFIG.createDirs),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过。
 * @param value 原始配置。
 * @returns 被改过的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []

  for (const key of ['userSubdir', 'personaSubdir'] as const) {
    const given = raw[key]
    if (given !== undefined && !isSegment(given)) drift.push(key)
  }

  const override = raw['rootOverride']
  if (override !== undefined && override !== '' && !(typeof override === 'string' && override.startsWith('/'))) {
    drift.push('rootOverride')
  }

  const ttl = raw['cacheTtlMs']
  if (ttl !== undefined) {
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0 || ttl > CACHE_TTL_CEIL) drift.push('cacheTtlMs')
  }
  return drift
}
