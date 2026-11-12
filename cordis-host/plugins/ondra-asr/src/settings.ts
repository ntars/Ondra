/**
 * O-127 配置的**单一真源**（默认值只在这里出现一次）。
 *
 * ## 十六个值里只有两个有手册出处
 *
 * | 值 | 出处 |
 * |---|---|
 * | `provider: 'local'` | 手册 §1.5 逐字：「本地 whisper 优先云端兜底」 |
 * | `allowCloudFallback: true` | 同上，「云端兜底」就是兜底那半句 |
 *
 * 其余十四个都是工程取值：`binary whisper-cli` / `threads 4` / `timeout-ms 180000` /
 * `cloud-model whisper-1` / `max-audio-bytes 25 MiB` 等。**不要把它们写成「手册规定」**。
 *
 * ## 为什么 `provider` 默认 `local`
 *
 * 语音是最私密的一类内容：一段语音里有说话人的音色、情绪、背景里的电视声、
 * 家里人的对话。能在本机转就不出站——这条不是「省流量」，是 §9.4 那条隐私红线的
 * 同一口气。代价是没装 whisper 时默认路径不可用，所以 `allowCloudFallback` 默认开：
 * 手册要求「云端兜底」，兜底不默认开，那句「兜底」就等于没有。
 *
 * 两者合起来的效果：**先在本机试，本机没有才出站，且出站仍要过 privacy**。
 *
 * ## 为什么 `quiet` 默认 true
 *
 * 手册逐字：「失败静默」。用户发一段语音，转不出来时不该收到一条报错——
 * 她能说「我这边听不太清，你再说一遍吗」，但不该弹「ASR error 500」。
 * 静默不等于看不见：`stats().byReason` 与 `stats().lastError` 一直在，
 * 面板与日志（`quiet=false` 时）都能查。
 */

import type {
  AsrProvider,
  FieldSpecLike,
  ResolvedEndpoint,
  SectionDeclLike,
} from './types.js'
import { ASR_PROVIDERS } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 首选来源。 */
  readonly provider: AsrProvider
  /** 本地 whisper 可执行文件名（按 PATH 找）。 */
  readonly binary: string
  /** whisper 的模型文件路径（`-m`）。**必填**，空着即 `no-model`。 */
  readonly modelPath: string
  /** 语言提示；留空即自动检测。 */
  readonly language: string
  /** whisper 的线程数（`-t`）。 */
  readonly threads: number
  /** ffmpeg 可执行文件（转 16k 单声道 WAV 用；按 PATH 找）。 */
  readonly ffmpegPath: string
  /** 本地转写超时（毫秒）。语音比图片慢得多。 */
  readonly timeoutMs: number
  /** 云端接入点（OpenAI 兼容）。 */
  readonly cloudBaseUrl: string
  /** 云端模型 id。 */
  readonly cloudModel: string
  /** 云端凭据的**环境变量名**（不是值）。 */
  readonly credentialRef: string
  /** 本地失败时是否走云端。 */
  readonly allowCloudFallback: boolean
  /** 没有 O-076 时是否仍允许云端出站。**默认不允许**。 */
  readonly cloudWithoutPrivacy: boolean
  /** 音频字节上限。 */
  readonly maxAudioBytes: number
  /** 正文最多保留多少字。 */
  readonly maxChars: number
  /** 失败不打 warn（手册：失败静默）。 */
  readonly quiet: boolean
  /** 成功时也打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'asr'

/** 超时下限（毫秒）。低于它连 10 秒的语音都转不完。 */
export const TIMEOUT_MIN = 5000

/** 超时上限（毫秒，30 分钟）。一段一小时的录音会超过它，但那时该先切片。 */
export const TIMEOUT_MAX = 1800000

/** 音频字节上限的下限（64 KiB，约 4 秒 wav）。 */
export const AUDIO_BYTES_MIN = 64 * 1024

/** 音频字节上限的上限（100 MiB）。云端 25 MB 是硬限，本地放宽但要防误传视频。 */
export const AUDIO_BYTES_MAX = 100 * 1024 * 1024

/** 正文字数下限。 */
export const CHARS_MIN = 200

/** 正文字数上限。 */
export const CHARS_MAX = 200000

/** 线程数下限。 */
export const THREADS_MIN = 1

/** 线程数上限。给到 64 已经远超普通机器；再多只会互相抢核。 */
export const THREADS_MAX = 64

/** 模型路径字符上限。 */
export const PATH_MAX = 400

/** 语言标记的形状：`zh` / `en` / `pt-BR` / `auto`。 */
export const LANGUAGE_RE = /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/

/*
 * 配置段里 `language` 字段的 `pattern`。
 *
 * 与上面的 `LANGUAGE_RE` **故意不同**：多一个可选的空串。
 *
 * 本字段的默认值就是空串（「留空即自动检测」），而 `ondra-config-schema`
 * 在 `register()` 时会拿 `pattern` 校验 `default` 本身——正则不收空串，
 * 整段注册就抛错。空串是本插件**合法且默认**的取值，所以它必须进正则。
 *
 * 影响范围要说准：宿主在装载前会把用户层配置作为成员配置注入
 * （`buildMemberConfigs`），所以设置页改这一段的**值仍然生效**。真正失效的
 * 是这一段的 schema 级校验与逐字段回退——非法值不再被挡回默认值，而每次
 * 启动都会留一行读起来像故障的 warn（「注册配置段失败」）。
 */
export const LANGUAGE_PATTERN = '^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)?$'

/** 凭据引用名的形状：POSIX 环境变量名（与 O-035 / O-076 同口径）。 */
export const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，transcribe() 一律 disabled。',
  },
  provider: {
    kind: 'enum',
    default: 'local',
    values: ASR_PROVIDERS,
    doc: '首选来源。手册要求「本地 whisper 优先云端兜底」，所以默认 local。',
  },
  binary: {
    kind: 'string',
    default: 'whisper-cli',
    doc: 'whisper 可执行文件（按 PATH 找）。whisper.cpp 新版叫 whisper-cli，旧版叫 main。',
  },
  modelPath: {
    kind: 'string',
    default: '',
    doc: 'whisper 模型文件路径（.bin）。必填：whisper 的 -m 没有默认值，本包也不猜。',
  },
  language: {
    kind: 'string',
    default: '',
    pattern: LANGUAGE_PATTERN,
    doc: '语言提示（zh / en / auto）。留空即自动检测。',
  },
  threads: {
    kind: 'number',
    default: 4,
    min: THREADS_MIN,
    max: THREADS_MAX,
    advancedOnly: true,
    doc: `whisper 的线程数（${THREADS_MIN}–${THREADS_MAX}）。设成核数的一半通常最稳。`,
  },
  ffmpegPath: {
    kind: 'string',
    default: 'ffmpeg',
    advancedOnly: true,
    doc: 'ffmpeg 可执行文件（按 PATH 找）。不是合规 WAV 时用它转 16k 单声道；找不到就退回直接试原文件。',
  },
  timeoutMs: {
    kind: 'number',
    default: 180000,
    min: TIMEOUT_MIN,
    max: TIMEOUT_MAX,
    advancedOnly: true,
    doc: `本地转写超时（毫秒，${TIMEOUT_MIN}–${TIMEOUT_MAX}）。CPU 上转 5 分钟语音可能要一两分钟。`,
  },
  cloudBaseUrl: {
    kind: 'string',
    default: 'https://api.openai.com/v1',
    pattern: '^https?://.+$',
    doc: '云端接入点（OpenAI 兼容的 /audio/transcriptions）。',
  },
  cloudModel: {
    kind: 'string',
    default: 'whisper-1',
    doc: '云端模型 id。示例是 OpenAI 的 whisper-1；兼容端点可换成自己的。',
  },
  credentialRef: {
    kind: 'string',
    default: 'OPENAI_API_KEY',
    pattern: CREDENTIAL_REF_RE.source,
    doc: '云端凭据的环境变量名（不是值）。',
  },
  allowCloudFallback: {
    kind: 'boolean',
    default: true,
    doc: '本地失败时走云端。手册「云端兜底」；关掉即纯本机。',
  },
  cloudWithoutPrivacy: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '没有 ondra-privacy 时是否仍允许把语音传到云端。默认不允许。',
  },
  maxAudioBytes: {
    kind: 'number',
    default: 25 * 1024 * 1024,
    min: AUDIO_BYTES_MIN,
    max: AUDIO_BYTES_MAX,
    advancedOnly: true,
    doc: `音频字节上限（${AUDIO_BYTES_MIN}–${AUDIO_BYTES_MAX}）。云端 25 MB 是硬限。`,
  },
  maxChars: {
    kind: 'number',
    default: 20000,
    min: CHARS_MIN,
    max: CHARS_MAX,
    advancedOnly: true,
    doc: `正文最多保留多少字（${CHARS_MIN}–${CHARS_MAX}）。超了截断并标 truncated。`,
  },
  quiet: {
    kind: 'boolean',
    default: true,
    doc: '失败不打 warn（手册逐字要求「失败静默」）。计数与 lastError 照常记。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '成功时也打一行日志（含耗时与字数）。排查用。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  provider: FIELD_SPECS.provider.default as AsrProvider,
  binary: FIELD_SPECS.binary.default as string,
  modelPath: FIELD_SPECS.modelPath.default as string,
  language: FIELD_SPECS.language.default as string,
  threads: FIELD_SPECS.threads.default as number,
  ffmpegPath: FIELD_SPECS.ffmpegPath.default as string,
  timeoutMs: FIELD_SPECS.timeoutMs.default as number,
  cloudBaseUrl: FIELD_SPECS.cloudBaseUrl.default as string,
  cloudModel: FIELD_SPECS.cloudModel.default as string,
  credentialRef: FIELD_SPECS.credentialRef.default as string,
  allowCloudFallback: FIELD_SPECS.allowCloudFallback.default as boolean,
  cloudWithoutPrivacy: FIELD_SPECS.cloudWithoutPrivacy.default as boolean,
  maxAudioBytes: FIELD_SPECS.maxAudioBytes.default as number,
  maxChars: FIELD_SPECS.maxChars.default as number,
  quiet: FIELD_SPECS.quiet.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  provider: 'provider',
  binary: 'binary',
  modelPath: 'model-path',
  language: 'language',
  threads: 'threads',
  ffmpegPath: 'ffmpeg-path',
  timeoutMs: 'timeout-ms',
  cloudBaseUrl: 'cloud-base-url',
  cloudModel: 'cloud-model',
  credentialRef: 'credential-ref',
  allowCloudFallback: 'allow-cloud-fallback',
  cloudWithoutPrivacy: 'cloud-without-privacy',
  maxAudioBytes: 'max-audio-bytes',
  maxChars: 'max-chars',
  quiet: 'quiet',
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
  title: '语音转写',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-asr',
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

/** 是不是两种来源之一。 */
export function isProvider(value: unknown): value is AsrProvider {
  return typeof value === 'string' && (ASR_PROVIDERS as readonly string[]).includes(value)
}

/** 语言标记是否合法（空串合法 = 自动检测）。 */
export function isLanguage(value: unknown): boolean {
  return typeof value === 'string' && (value === '' || LANGUAGE_RE.test(value))
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 *
 * 唯一不在这里「修」的是 `modelPath` 与 `cloudBaseUrl`：
 * 前者写错要如实留成 `no-model`/`no-binary`（悄悄清空 = 用户以为配好了），
 * 后者写错要如实留成 `bad-base`（悄悄回退到默认地址 = 语音发去了别处还说成功）。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    provider: isProvider(raw['provider']) ? raw['provider'] : DEFAULT_CONFIG.provider,
    binary: textOf(raw['binary'], DEFAULT_CONFIG.binary, PATH_MAX),
    modelPath: textOf(raw['modelPath'], DEFAULT_CONFIG.modelPath, PATH_MAX),
    language: isLanguage(raw['language']) ? (raw['language'] as string).trim() : DEFAULT_CONFIG.language,
    threads: clampInt(raw['threads'], DEFAULT_CONFIG.threads, THREADS_MIN, THREADS_MAX),
    ffmpegPath: textOf(raw['ffmpegPath'], DEFAULT_CONFIG.ffmpegPath, PATH_MAX),
    timeoutMs: clampInt(raw['timeoutMs'], DEFAULT_CONFIG.timeoutMs, TIMEOUT_MIN, TIMEOUT_MAX),
    cloudBaseUrl: textOf(raw['cloudBaseUrl'], DEFAULT_CONFIG.cloudBaseUrl, PATH_MAX),
    cloudModel: textOf(raw['cloudModel'], DEFAULT_CONFIG.cloudModel, 120),
    credentialRef: textOf(raw['credentialRef'], DEFAULT_CONFIG.credentialRef, 64),
    allowCloudFallback: bool('allowCloudFallback', DEFAULT_CONFIG.allowCloudFallback),
    cloudWithoutPrivacy: bool('cloudWithoutPrivacy', DEFAULT_CONFIG.cloudWithoutPrivacy),
    maxAudioBytes: clampInt(
      raw['maxAudioBytes'],
      DEFAULT_CONFIG.maxAudioBytes,
      AUDIO_BYTES_MIN,
      AUDIO_BYTES_MAX,
    ),
    maxChars: clampInt(raw['maxChars'], DEFAULT_CONFIG.maxChars, CHARS_MIN, CHARS_MAX),
    quiet: bool('quiet', DEFAULT_CONFIG.quiet),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  if (!isRecord(value)) return []
  const done = completeConfig(value)
  const drift: string[] = []

  if (value['provider'] !== undefined && !isProvider(value['provider'])) {
    drift.push(`provider 不是 ${ASR_PROVIDERS.join(' / ')} 之一，已回退 ${done.provider}`)
  }
  if (value['language'] !== undefined && !isLanguage(value['language'])) {
    drift.push('language 形状不对（应形如 zh / en / pt-BR / auto），已回退自动检测')
  }

  const numbers: readonly (readonly [keyof Config, number, number, number])[] = [
    ['threads', THREADS_MIN, THREADS_MAX, done.threads],
    ['timeoutMs', TIMEOUT_MIN, TIMEOUT_MAX, done.timeoutMs],
    ['maxAudioBytes', AUDIO_BYTES_MIN, AUDIO_BYTES_MAX, done.maxAudioBytes],
    ['maxChars', CHARS_MIN, CHARS_MAX, done.maxChars],
  ]
  for (const [key, min, max, actual] of numbers) {
    const raw = value[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    if (Math.trunc(raw) !== actual) {
      drift.push(`${String(key)} 越界（${min}–${max}），已夹到 ${actual}`)
    }
  }
  return drift
}

/** 解析云端接入点的结果。 */
export type EndpointResult =
  | { readonly ok: true; readonly endpoint: ResolvedEndpoint }
  | { readonly ok: false; readonly reason: 'bad-base'; readonly detail: string }

/**
 * 把配置解析成「云端往哪儿发」。
 *
 * 写坏就如实报 `bad-base`，**不回退默认地址**：回退意味着用户以为语音发去了
 * 自建网关，实际发去了公网大厂。这是最不该静默的一种。
 * @param config 配置。
 */
export function resolveCloudEndpoint(config: Config): EndpointResult {
  const raw = config.cloudBaseUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'bad-base', detail: `cloud-base-url 不是合法地址：${raw.slice(0, 80)}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'bad-base', detail: `cloud-base-url 协议必须是 http 或 https：${parsed.protocol}` }
  }
  if (parsed.host === '') {
    return { ok: false, reason: 'bad-base', detail: 'cloud-base-url 缺主机名' }
  }
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '')
  return { ok: true, endpoint: { base, host: parsed.host } }
}

/**
 * 出站声明用的主机列表。地址写坏时给**空列表**（O-076 语义：空 = 哪儿都不许去）。
 * @param config 配置。
 */
export function egressHostsOf(config: Config): readonly string[] {
  const resolved = resolveCloudEndpoint(config)
  return resolved.ok ? [resolved.endpoint.host] : []
}
