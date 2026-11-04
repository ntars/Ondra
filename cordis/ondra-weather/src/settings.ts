/**
 * 配置的**单一真源**。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么 `coords` 默认是空串而不是「一个常见的城市」
 *
 * 天气是**唯一**一类「猜错也看起来正常」的数据：给个默认北京，杭州的用户
 * 会连着几天看到「北京晴」，而插件每个字段都合格。所以默认空 → `no-coords`
 * → 不提。宁可少一句话，不可让她说错天气。
 *
 * ## 为什么 `0,0` 判成 `bad-coords`
 *
 * `0,0` 是数字输入框的经典残留值，真实含义几乎总是「没填」。它落在几内亚湾
 * 海面上，接口照样返回一套合法数据——这是「半对」里最难发现的一种。
 * 真有用户在赤道几内亚湾海上，请填 `0.1,0.1`。
 */

import { COORDS_RE } from './types.js'
import type { CoordResult, FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`snapshot()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 坐标，`纬度,经度`。空串表示没配。 */
  readonly coords: string
  /** 地点标签，只用于措辞（例如「杭州」）。可空。 */
  readonly place: string
  /** 缓存有效期（分钟）。 */
  readonly ttlMinutes: number
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs: number
  /** 降级是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'weather'

/** 缓存有效期下限：再短就是在刷接口，而天气本身 10 分钟才会变一次。 */
export const TTL_MIN = 1

/** 缓存有效期上限：3 小时。超过这个数，缓存里的「实况」已经不是实况。 */
export const TTL_MAX = 180

/** 超时下限。 */
export const TIMEOUT_MIN = 500

/** 超时上限：比 15 秒更长的等待，用户已经忘了自己在等什么。 */
export const TIMEOUT_MAX = 15000

/** 地点标签长度上限（只用于措辞，不需要长文本）。 */
export const PLACE_MAX = 24

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，snapshot() 一律 disabled。',
  },
  coords: {
    kind: 'string',
    default: '',
    pattern: COORDS_RE.source,
    doc: '坐标「纬度,经度」，例如 30.27,120.16。留空 = 不提天气（绝不猜城市）。',
  },
  place: {
    kind: 'string',
    default: '',
    doc: '地点标签，只用于措辞，例如「杭州」。可留空。',
  },
  ttlMinutes: {
    kind: 'number',
    default: 10,
    min: TTL_MIN,
    max: TTL_MAX,
    doc: `缓存有效期（分钟，${TTL_MIN}–${TTL_MAX}）。过期即作废，不做陈旧兜底。`,
  },
  timeoutMs: {
    kind: 'number',
    default: 4000,
    min: TIMEOUT_MIN,
    max: TIMEOUT_MAX,
    advancedOnly: true,
    doc: `单次请求超时（毫秒，${TIMEOUT_MIN}–${TIMEOUT_MAX}）。`,
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  coords: FIELD_SPECS.coords.default as string,
  place: FIELD_SPECS.place.default as string,
  ttlMinutes: FIELD_SPECS.ttlMinutes.default as number,
  timeoutMs: FIELD_SPECS.timeoutMs.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  coords: 'coords',
  place: 'place',
  ttlMinutes: 'ttl-minutes',
  timeoutMs: 'timeout-ms',
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
  title: '天气',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-weather',
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

/** 取一个去空白的字符串，超长截断。 */
function textOf(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 解析坐标字符串。**唯一入口**：配置、面板、调试都过这一关。
 *
 * 三种坏法各有原因码：空串 → `no-coords`（没配，正常的沉默）；
 * 形状不对/越界/`0,0` → `bad-coords`（配了但不对，必须说出来）。
 * @param raw 原始文本。
 */
export function parseCoords(raw: unknown): CoordResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'no-coords' }
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'no-coords' }

  const matched = COORDS_RE.exec(text)
  if (matched === null) return { ok: false, reason: 'bad-coords' }

  const lat = Number(matched[1])
  const lon = Number(matched[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, reason: 'bad-coords' }
  if (lat < -90 || lat > 90) return { ok: false, reason: 'bad-coords' }
  if (lon < -180 || lon > 180) return { ok: false, reason: 'bad-coords' }
  if (lat === 0 && lon === 0) return { ok: false, reason: 'bad-coords' }

  return { ok: true, lat, lon }
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  // 坐标不在这里「修」成合法的：写错了要如实留成 `bad-coords`，
  // 悄悄改成空串会让面板显示「没配」，排查时找不到真正的错。
  const coords = typeof raw['coords'] === 'string' ? raw['coords'].trim() : DEFAULT_CONFIG.coords

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    coords,
    place: textOf(raw['place'], DEFAULT_CONFIG.place, PLACE_MAX),
    ttlMinutes: clampInt(raw['ttlMinutes'], DEFAULT_CONFIG.ttlMinutes, TTL_MIN, TTL_MAX),
    timeoutMs: clampInt(raw['timeoutMs'], DEFAULT_CONFIG.timeoutMs, TIMEOUT_MIN, TIMEOUT_MAX),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（数值被夹紧、地点标签被截断）。
 *
 * 单独给一个函数，是因为 `completeConfig()` 拿到的已经是夹紧后的值，
 * 它自己不知道「刚才那个数越界了」。
 * @param value 原始配置。
 * @returns 被改过的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []
  for (const key of ['ttlMinutes', 'timeoutMs'] as const) {
    const given = raw[key]
    if (given === undefined) continue
    const bounds = key === 'ttlMinutes' ? [TTL_MIN, TTL_MAX] : [TIMEOUT_MIN, TIMEOUT_MAX]
    if (typeof given !== 'number' || !Number.isFinite(given) || given < bounds[0] || given > bounds[1]) {
      drift.push(key)
    }
  }
  const place = raw['place']
  if (typeof place === 'string' && place.trim().length > PLACE_MAX) drift.push('place')
  return drift
}
