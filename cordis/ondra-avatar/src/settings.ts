/**
 * 配置的**单一真源**（素材目录 + 换脸节奏）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么有一个 `minHoldMs`
 *
 * 手册没给这个参数（`grep` 全文没有「立绘停留」「换脸间隔」这类条款），
 * 但没有它，症状是可预期的：流式输出时每判一条就换一次脸，
 * 一张脸在屏幕上闪成灯。所以自定一个下限并登记为**待裁决**。
 *
 * 取 1200ms 的理由：手册 §9.2 的标点附加最长 500ms、长停顿 3000–9000ms，
 * 1200ms 正好是"一句话里不会被打断、又不会把下一句的表情拖住"的量级。
 * 0 表示不设下限（测试与录屏用）。
 *
 * ## 为什么 `provider` 有 `auto`
 *
 * 默认必须是"能用什么就用什么"：干净机器上既没有 Live2D 运行时也没有模型，
 * 写死 `live2d` 会让默认配置一装就报 `no-model`；写死 `static` 又会让
 * 装了渲染器的用户白装。`auto` 按「live2d → static → none」顺位挑，
 * 顺位本身就是 §14.2 的"默认最稳"：最稳的那条排最后兜底。
 */

import { AVATAR_STATES, PROVIDER_PREFS } from './types.js'
import type { AvatarState, FieldSpecLike, ProviderPref, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`frame()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 通道偏好：`auto` / `static` / `live2d`。 */
  readonly provider: ProviderPref
  /** 共享素材目录（相对数据根的 `user` 区域）。 */
  readonly dir: string
  /** 是否先查人设包自带的立绘目录（只读兼容层）。 */
  readonly usePersonaDir: boolean
  /** 一个表情至少停留多久（毫秒）。0 = 不设下限。 */
  readonly minHoldMs: number
  /** 既没有线索也拿不到六态时的表情。 */
  readonly defaultState: AvatarState
  /** 每次换脸打一行日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'avatar'

/** 停留下限的最小值。 */
export const MIN_HOLD_FLOOR = 0

/**
 * 停留下限的最大值：10 秒。
 *
 * 再长就不是"防闪"，而是"表情卡住"——用户会以为她卡了，
 * 而面板上一切正常（因为确实在按配置工作）。
 */
export const MIN_HOLD_CEIL = 10_000

/** 目录名的最大长度。够长，又不至于让日志一行放不下。 */
export const DIR_MAX = 64

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后一律不出帧（服务照常注册，面板能看见"已关闭"）。',
  },
  provider: {
    kind: 'enum',
    default: 'auto',
    values: PROVIDER_PREFS,
    doc: 'auto = 有模型且注册了渲染器就用 live2d，否则静态图，再否则不出图。static 强制静态图，live2d 优先模型。',
  },
  dir: {
    kind: 'string',
    default: 'avatar',
    doc: `共享素材目录（相对数据根的 user 区域，默认 user/avatar）。只允许一层目录名，不接受绝对路径与 ..。`,
  },
  usePersonaDir: {
    kind: 'boolean',
    default: true,
    doc: '先查人设包自带的 personas/<id>/avatar/（只读，有图才用）。',
  },
  minHoldMs: {
    kind: 'number',
    default: 1200,
    min: MIN_HOLD_FLOOR,
    max: MIN_HOLD_CEIL,
    doc: `一个表情至少停留多少毫秒（${MIN_HOLD_FLOOR}–${MIN_HOLD_CEIL}）。0 = 不设下限。手册未给此参数，自定并登记待裁决。`,
  },
  defaultState: {
    kind: 'enum',
    default: 'calm',
    values: AVATAR_STATES,
    advancedOnly: true,
    doc: '既没线索也拿不到六态时的表情。默认平静：副作用最小。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '换脸时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  provider: FIELD_SPECS.provider.default as ProviderPref,
  dir: FIELD_SPECS.dir.default as string,
  usePersonaDir: FIELD_SPECS.usePersonaDir.default as boolean,
  minHoldMs: FIELD_SPECS.minHoldMs.default as number,
  defaultState: FIELD_SPECS.defaultState.default as AvatarState,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  provider: 'provider',
  dir: 'dir',
  usePersonaDir: 'use-persona-dir',
  minHoldMs: 'min-hold-ms',
  defaultState: 'default-state',
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
  title: '立绘',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-avatar',
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

/**
 * 夹一个整数。
 * @param value 待夹的值。
 * @param fallback 非法时的回退值。
 * @param min 下界。
 * @param max 上界。
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 判一个目录名能不能用。
 *
 * 只允许**一层**相对目录名：拒绝空串、绝对路径、`..`、路径分隔符与 Windows 盘符。
 * 拒绝的理由不是洁癖——`path-layout` 的 `fileIn` 会把片段拼进数据根，
 * 一个 `../../etc` 就能把"素材目录"指到数据根外面去。
 * @param value 待验的值。
 */
export function isSafeDir(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value === '' || value.length > DIR_MAX) return false
  if (value === '.' || value === '..') return false
  if (value.includes('/') || value.includes('\\') || value.includes(':')) return false
  if (value.startsWith('.')) return false
  return true
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  const givenProvider = raw['provider']
  const provider =
    typeof givenProvider === 'string' && (PROVIDER_PREFS as readonly string[]).includes(givenProvider)
      ? (givenProvider as ProviderPref)
      : DEFAULT_CONFIG.provider

  const givenState = raw['defaultState']
  const defaultState =
    typeof givenState === 'string' && (AVATAR_STATES as readonly string[]).includes(givenState)
      ? (givenState as AvatarState)
      : DEFAULT_CONFIG.defaultState

  const dir = isSafeDir(raw['dir']) ? raw['dir'] : DEFAULT_CONFIG.dir

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    provider,
    dir,
    usePersonaDir: bool('usePersonaDir', DEFAULT_CONFIG.usePersonaDir),
    minHoldMs: clampInt(raw['minHoldMs'], DEFAULT_CONFIG.minHoldMs, MIN_HOLD_FLOOR, MIN_HOLD_CEIL),
    defaultState,
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

  const provider = raw['provider']
  if (provider !== undefined && !(typeof provider === 'string' && (PROVIDER_PREFS as readonly string[]).includes(provider))) {
    drift.push('provider')
  }

  const dir = raw['dir']
  if (dir !== undefined && !isSafeDir(dir)) drift.push('dir')

  const hold = raw['minHoldMs']
  if (hold !== undefined) {
    if (typeof hold !== 'number' || !Number.isFinite(hold) || hold < MIN_HOLD_FLOOR || hold > MIN_HOLD_CEIL) {
      drift.push('minHoldMs')
    }
  }

  const state = raw['defaultState']
  if (state !== undefined && !(typeof state === 'string' && (AVATAR_STATES as readonly string[]).includes(state))) {
    drift.push('defaultState')
  }
  return drift
}
