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
 * ## 为什么 `provider` 默认是 `auto` 而不是写死一条
 *
 * 三条通道在这台机器上「有没有」是运行期才知道的：GPT-SoVITS 要用户自己起
 * 服务、`edge-tts` 要装 CLI、`say` 只有 macOS 有。写死任何一条，另外两种
 * 环境的用户第一次打开就是「语音坏了」。
 *
 * `auto` 的顺序按**手册 §9.4 的优先级**（local > macos-say > 云端），
 * 但只在「同步探测就绪」的那几条里挑——于是干净机器上自然落到 `say`，
 * 这与 master-plan §14.3「默认选最稳」并不矛盾：最稳的那条正是最终被选中的那条。
 *
 * ## 为什么 `maxChars` 是「拒绝」而不是「截断」
 *
 * 30 字的闸门在 O-051。这里是最后一道兜底：真的收到 500 字（调用方绕过了闸门），
 * 截断会让她把一句话念一半就停——听起来像卡带，而且没人会去查原因。
 * 直接拒绝 + 原因码，面板上看得见「这次太长，没念」。
 *
 * ## 为什么 `sayWpm` 单独一个字段
 *
 * `say` 的语速单位是「词/分钟」，`edge-tts` 是「相对百分比」，GPT-SoVITS 没有。
 * 三者的数字**不能互相换算**，所以只能各留各的基准值；把它硬塞进一个
 * `rate` 字段，迟早出现「给 say 传了 10」这种把语速调到 10 词/分钟的配置。
 */

import { ENGINE_NAMES, PRESET_IDS } from './types.js'
import type { EngineName, FieldSpecLike, PresetId, SectionDeclLike } from './types.js'

/** 通道选择：`auto` 或指定一条。 */
export type ProviderChoice = 'auto' | EngineName

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`speak()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 通道选择。 */
  readonly provider: ProviderChoice
  /** 默认预设 id。 */
  readonly preset: string
  /** 指定音色 id。空串表示跟随预设。 */
  readonly voice: string
  /** 全局语速增量（相对值）。 */
  readonly rate: number
  /** 音量档。 */
  readonly volume: 'normal' | 'low'
  /** 单条文本长度上限，超过直接拒绝。 */
  readonly maxChars: number
  /** GPT-SoVITS 服务地址。 */
  readonly gsvEndpoint: string
  /** GPT-SoVITS 参考音频绝对路径。空串表示这条通道不可用。 */
  readonly gsvRefAudio: string
  /** GPT-SoVITS 参考音频对应的文本（可空，空则用 `no_prompt_text` 口径）。 */
  readonly gsvPromptText: string
  /** GPT-SoVITS 文本语种。 */
  readonly gsvTextLang: 'zh' | 'en' | 'ja' | 'ko' | 'auto'
  /** `edge-tts` 可执行文件名或绝对路径。 */
  readonly edgeBin: string
  /** macOS `say` 的系统音色名（`say -v` 那一列）。 */
  readonly sayVoice: string
  /** macOS `say` 的基准语速（词/分钟）。 */
  readonly sayWpm: number
  /** 单次合成超时（毫秒）。手册 §9.4 给 GPT-SoVITS 的 15000ms。 */
  readonly timeoutMs: number
  /** 播放开关。`off` 时 `speak()` 等同于 `synth()`。 */
  readonly playback: 'auto' | 'off'
  /** 缓存保留文件数上限。 */
  readonly cacheFiles: number
  /** 失败时是否打日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'tts'

/** 文本长度下限：再短就没有「一句话」可言（与 O-051 的下界同一个数）。 */
export const MAX_CHARS_MIN = 30

/** 文本长度上限：1000 字已经是三分钟语音，超过它说明调用链出了问题。 */
export const MAX_CHARS_MAX = 1000

/** 语速增量上下限：±50%（再快听不清，再慢不像说话）。 */
export const RATE_MIN = -0.5

/** 语速增量上限。 */
export const RATE_MAX = 0.5

/** `say` 语速下限。 */
export const SAY_WPM_MIN = 120

/** `say` 语速上限。 */
export const SAY_WPM_MAX = 300

/** 超时下限。 */
export const TIMEOUT_MIN = 1000

/** 超时上限：超过 30 秒的等待，用户已经以为没反应了。 */
export const TIMEOUT_MAX = 30000

/** 缓存文件数下限。 */
export const CACHE_MIN = 16

/** 缓存文件数上限。 */
export const CACHE_MAX = 2000

/** 音色 / 参考音频路径的长度上限（只为挡住粘贴进来的整段文本）。 */
export const TEXT_MAX = 512

/** `provider` 的可选值。 */
export const PROVIDER_VALUES: readonly ProviderChoice[] = Object.freeze(['auto', ...ENGINE_NAMES])

/** `gsvTextLang` 的可选值。 */
export const GSV_LANG_VALUES = ['zh', 'en', 'ja', 'ko', 'auto'] as const

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，speak() 一律 disabled。',
  },
  provider: {
    kind: 'enum',
    default: 'auto',
    values: PROVIDER_VALUES,
    doc: '通道：auto 按「本地 GPT-SoVITS → macOS say → Edge TTS」挑第一条就绪的。',
  },
  preset: {
    kind: 'enum',
    default: 'soft',
    values: PRESET_IDS,
    doc: '默认语音包预设：温柔/活泼/播音/东北/陕西/粤语/台湾/English。',
  },
  voice: {
    kind: 'string',
    default: '',
    doc: '指定音色 id，留空则跟随预设。',
  },
  rate: {
    kind: 'number',
    default: 0,
    min: RATE_MIN,
    max: RATE_MAX,
    advancedOnly: true,
    doc: `语速增量（${RATE_MIN}–${RATE_MAX}），0.1 表示快一成。`,
  },
  volume: {
    kind: 'enum',
    default: 'normal',
    values: ['normal', 'low'],
    doc: '音量档。macOS say 分支没有音量参数，会忽略这一项。',
  },
  maxChars: {
    kind: 'number',
    default: 300,
    min: MAX_CHARS_MIN,
    max: MAX_CHARS_MAX,
    advancedOnly: true,
    doc: `单条文本上限（${MAX_CHARS_MIN}–${MAX_CHARS_MAX} 字），超过直接拒绝，不截断。`,
  },
  gsvEndpoint: {
    kind: 'string',
    default: 'http://127.0.0.1:9880',
    doc: 'GPT-SoVITS 服务地址（api_v2）。只允许本机回环地址。',
  },
  gsvRefAudio: {
    kind: 'string',
    default: '',
    doc: '参考音频绝对路径。留空 = 这条通道不可用（它必须有音色样本）。',
  },
  gsvPromptText: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '参考音频对应的文字。留空则不带参考文本（音色会更飘）。',
  },
  gsvTextLang: {
    kind: 'enum',
    default: 'zh',
    values: GSV_LANG_VALUES,
    advancedOnly: true,
    doc: '合成语种：zh / en / ja / ko / auto。',
  },
  edgeBin: {
    kind: 'string',
    default: 'edge-tts',
    advancedOnly: true,
    doc: 'edge-tts 可执行文件名或绝对路径。',
  },
  sayVoice: {
    kind: 'string',
    default: 'Tingting',
    advancedOnly: true,
    doc: 'macOS say 的系统音色名（终端执行 say -v ? 可看全表）。',
  },
  sayWpm: {
    kind: 'number',
    default: 180,
    min: SAY_WPM_MIN,
    max: SAY_WPM_MAX,
    advancedOnly: true,
    doc: `say 的基准语速（${SAY_WPM_MIN}–${SAY_WPM_MAX} 词/分钟）。`,
  },
  timeoutMs: {
    kind: 'number',
    default: 15000,
    min: TIMEOUT_MIN,
    max: TIMEOUT_MAX,
    advancedOnly: true,
    doc: `单次合成超时（${TIMEOUT_MIN}–${TIMEOUT_MAX} 毫秒）。`,
  },
  playback: {
    kind: 'enum',
    default: 'auto',
    values: ['auto', 'off'],
    doc: 'auto 时用系统播放器出声；off 时只合成文件（通道发语音条用这个）。',
  },
  cacheFiles: {
    kind: 'number',
    default: 200,
    min: CACHE_MIN,
    max: CACHE_MAX,
    advancedOnly: true,
    doc: `缓存保留文件数（${CACHE_MIN}–${CACHE_MAX}），超出按最旧删除。`,
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '失败时打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  provider: FIELD_SPECS.provider.default as ProviderChoice,
  preset: FIELD_SPECS.preset.default as string,
  voice: FIELD_SPECS.voice.default as string,
  rate: FIELD_SPECS.rate.default as number,
  volume: FIELD_SPECS.volume.default as 'normal' | 'low',
  maxChars: FIELD_SPECS.maxChars.default as number,
  gsvEndpoint: FIELD_SPECS.gsvEndpoint.default as string,
  gsvRefAudio: FIELD_SPECS.gsvRefAudio.default as string,
  gsvPromptText: FIELD_SPECS.gsvPromptText.default as string,
  gsvTextLang: FIELD_SPECS.gsvTextLang.default as 'zh' | 'en' | 'ja' | 'ko' | 'auto',
  edgeBin: FIELD_SPECS.edgeBin.default as string,
  sayVoice: FIELD_SPECS.sayVoice.default as string,
  sayWpm: FIELD_SPECS.sayWpm.default as number,
  timeoutMs: FIELD_SPECS.timeoutMs.default as number,
  playback: FIELD_SPECS.playback.default as 'auto' | 'off',
  cacheFiles: FIELD_SPECS.cacheFiles.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  provider: 'provider',
  preset: 'preset',
  voice: 'voice',
  rate: 'rate',
  volume: 'volume',
  maxChars: 'max-chars',
  gsvEndpoint: 'gsv-endpoint',
  gsvRefAudio: 'gsv-ref-audio',
  gsvPromptText: 'gsv-prompt-text',
  gsvTextLang: 'gsv-text-lang',
  edgeBin: 'edge-bin',
  sayVoice: 'say-voice',
  sayWpm: 'say-wpm',
  timeoutMs: 'timeout-ms',
  playback: 'playback',
  cacheFiles: 'cache-files',
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
  title: '语音合成',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-tts',
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

/** 夹一个浮点（语速增量的精度到 0.01，再多没有意义）。 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.min(max, Math.max(min, value)) * 100) / 100
}

/** 取一个去空白的字符串，超长截断。 */
function textOf(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}

/** 取一个枚举值，不在表里就回退。 */
function oneOf<T extends string>(value: unknown, fallback: T, values: readonly T[]): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback
}

/**
 * 校验一个预设 id。**唯一入口**：配置、面板、参数都过这一关。
 * @param value 原始值。
 */
export function isPresetId(value: unknown): value is PresetId {
  return typeof value === 'string' && (PRESET_IDS as readonly string[]).includes(value)
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 *
 * 例外：`gsvRefAudio` / `gsvEndpoint` **不在**这里「修」成可用的形状。
 * 路径写错要如实留着，让 GPT-SoVITS 分支报 `not-configured`；
 * 悄悄清空会让面板显示「没配」，而用户明明填了，排查时找不到真正的错。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    provider: oneOf<ProviderChoice>(raw['provider'], DEFAULT_CONFIG.provider, PROVIDER_VALUES),
    // 预设写错回退默认，但 `configDriftOf()` 会报出来——静默回退等于让面板说谎。
    preset: isPresetId(raw['preset']) ? raw['preset'] : DEFAULT_CONFIG.preset,
    voice: textOf(raw['voice'], DEFAULT_CONFIG.voice, TEXT_MAX),
    rate: clampFloat(raw['rate'], DEFAULT_CONFIG.rate, RATE_MIN, RATE_MAX),
    volume: oneOf<'normal' | 'low'>(raw['volume'], DEFAULT_CONFIG.volume, ['normal', 'low']),
    maxChars: clampInt(raw['maxChars'], DEFAULT_CONFIG.maxChars, MAX_CHARS_MIN, MAX_CHARS_MAX),
    gsvEndpoint: textOf(raw['gsvEndpoint'], DEFAULT_CONFIG.gsvEndpoint, TEXT_MAX),
    gsvRefAudio: textOf(raw['gsvRefAudio'], DEFAULT_CONFIG.gsvRefAudio, TEXT_MAX),
    gsvPromptText: textOf(raw['gsvPromptText'], DEFAULT_CONFIG.gsvPromptText, TEXT_MAX),
    gsvTextLang: oneOf<'zh' | 'en' | 'ja' | 'ko' | 'auto'>(
      raw['gsvTextLang'],
      DEFAULT_CONFIG.gsvTextLang,
      GSV_LANG_VALUES,
    ),
    edgeBin: textOf(raw['edgeBin'], DEFAULT_CONFIG.edgeBin, TEXT_MAX),
    sayVoice: textOf(raw['sayVoice'], DEFAULT_CONFIG.sayVoice, TEXT_MAX),
    sayWpm: clampInt(raw['sayWpm'], DEFAULT_CONFIG.sayWpm, SAY_WPM_MIN, SAY_WPM_MAX),
    timeoutMs: clampInt(raw['timeoutMs'], DEFAULT_CONFIG.timeoutMs, TIMEOUT_MIN, TIMEOUT_MAX),
    playback: oneOf<'auto' | 'off'>(raw['playback'], DEFAULT_CONFIG.playback, ['auto', 'off']),
    cacheFiles: clampInt(raw['cacheFiles'], DEFAULT_CONFIG.cacheFiles, CACHE_MIN, CACHE_MAX),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（数值被夹紧、预设不认识、字符串被截断）。
 *
 * 单独给一个函数，是因为 `completeConfig()` 拿到的已经是夹紧后的值，
 * 它自己不知道「刚才那个数越界了」。
 * @param value 原始配置。
 * @returns 被改过的字段名（空数组表示没问题）。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly [keyof Config, number, number][] = [
    ['rate', RATE_MIN, RATE_MAX],
    ['maxChars', MAX_CHARS_MIN, MAX_CHARS_MAX],
    ['sayWpm', SAY_WPM_MIN, SAY_WPM_MAX],
    ['timeoutMs', TIMEOUT_MIN, TIMEOUT_MAX],
    ['cacheFiles', CACHE_MIN, CACHE_MAX],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) drift.push(key)
  }

  if (raw['preset'] !== undefined && !isPresetId(raw['preset'])) drift.push('preset')
  if (raw['provider'] !== undefined && !(PROVIDER_VALUES as readonly string[]).includes(String(raw['provider']))) {
    drift.push('provider')
  }
  for (const key of ['voice', 'gsvRefAudio', 'gsvEndpoint', 'edgeBin', 'sayVoice', 'gsvPromptText'] as const) {
    const given = raw[key]
    if (typeof given === 'string' && given.trim().length > TEXT_MAX) drift.push(key)
  }
  return drift
}
