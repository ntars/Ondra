/**
 * O-126 配置的**单一真源**（默认值只在这里出现一次）。
 *
 * ## 十三个值里只有两个有手册出处
 *
 * | 值 | 出处 |
 * |---|---|
 * | `enable: false` | 手册 §9.4 逐字：「vision 默认关闭，出站前提示（与 privacy 联动）」 |
 * | `videoFrames: 4` | 手册语料·第一编 2.3 逐字：「视频→抽 4 帧 + 音轨转写」 |
 *
 * 其余十一个都是工程取值：`provider ollama` / `timeoutMs 30000` / `maxImageBytes 8MiB` /
 * `maxOutputChars 2000` / `detail auto` / `cloudWithoutPrivacy false` 等。
 * **不要把它们写成「手册规定」**——那会让下一个人以为改不了。逐条列在 README「待裁决」。
 *
 * ## 为什么默认 provider 是 ollama（本机）
 *
 * §14.2 要求「默认最稳，不是最快的、不是最省的」。三家里：
 * - `openai` / `qwen` 要密钥、要出站、要花钱，而且**出站就撤不回来**；
 * - `ollama` 在本机，最坏情况是「模型没装，用不了」——一个可解释的失败。
 *
 * 一张截图里可能有聊天记录、身份证、工资条。「用不了」比「已经发出去了」便宜得多。
 *
 * ## 为什么 `model` 默认空串而不是填一个模型名
 *
 * 手册没给模型名。填 `gpt-4o-mini` 看起来贴心，实际是把「版本会过期」这件事
 * 埋进默认值：半年后它下线，用户看到的是「视觉坏了」，而配置里明明写着一个名字。
 * 空串 → `reason='no-model'` → 面板直说「你还没告诉我看哪个模型」。
 * 示例名写在字段说明里，写的是「示例」，不是默认值。
 */

import type {
  FieldSpecLike,
  ProviderEndpoint,
  ResolvedEndpoint,
  SectionDeclLike,
  VisionProvider,
  VisionReason,
} from './types.js'
import { PROVIDER_ENDPOINTS, VISION_PROVIDERS } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。手册要求默认关。 */
  readonly enable: boolean
  /** 哪一家。 */
  readonly provider: VisionProvider
  /** 覆盖默认接入点（自建网关 / 内网 Ollama）。留空用该家的默认地址。 */
  readonly baseUrl: string
  /** 模型名。**手册没给**，必填，留空即不可用。 */
  readonly model: string
  /** 凭据的**环境变量名**（不是值）。留空用该家的默认变量名。 */
  readonly credentialRef: string
  /** 图片细节档（只对 OpenAI 兼容端点有意义）。 */
  readonly detail: 'auto' | 'low' | 'high'
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs: number
  /** 单张图片的字节上限。 */
  readonly maxImageBytes: number
  /** 正文最多保留多少字，超了截断并标 `truncated`。 */
  readonly maxOutputChars: number
  /** 视频抽几帧（手册：4）。 */
  readonly videoFrames: number
  /** ffmpeg 可执行文件（按 PATH 找）。 */
  readonly ffmpegPath: string
  /** 没有 O-076 时是否仍允许出站。**默认不允许**。 */
  readonly cloudWithoutPrivacy: boolean
  /** 降级时打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'vision'

/** 超时下限（毫秒）。低于它基本必然超时，等于没配。 */
export const TIMEOUT_MIN = 1000

/** 超时上限（毫秒）。视觉请求本来就慢，但一分钟以上用户已经在等别的东西了。 */
export const TIMEOUT_MAX = 120000

/** 图片字节上限的下限（1 MiB）。再小连手机截图都放不进去。 */
export const IMAGE_BYTES_MIN = 64 * 1024

/** 图片字节上限的上限（20 MiB）。OpenAI 的硬限就是 20 MB，超了发过去也是 400。 */
export const IMAGE_BYTES_MAX = 20 * 1024 * 1024

/** 正文字数上限的下限。 */
export const OUTPUT_CHARS_MIN = 120

/** 正文字数上限的上限。 */
export const OUTPUT_CHARS_MAX = 20000

/** 抽帧张数下限。 */
export const FRAMES_MIN = 1

/** 抽帧张数上限。手册说 4；给到 16 已经够用，再多就是让用户自己拼视频。 */
export const FRAMES_MAX = 16

/** 模型名字符数上限。 */
export const MODEL_MAX = 120

/** 地址字符数上限。 */
export const BASE_URL_MAX = 300

/** 凭据引用名的形状：POSIX 环境变量名（与 O-035 / O-076 同口径）。 */
export const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 细节档取值。 */
export const DETAIL_LEVELS: readonly Config['detail'][] = Object.freeze(['auto', 'low', 'high'])

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '总开关。手册 §9.4 要求默认关闭：一张图出站就等于把用户的屏幕发给别人。',
  },
  provider: {
    kind: 'enum',
    default: 'ollama',
    values: VISION_PROVIDERS,
    doc: '哪一家：ollama（本机）/ openai（OpenAI 兼容）/ qwen（通义千问兼容端点）。',
  },
  baseUrl: {
    kind: 'string',
    default: '',
    pattern: '^(https?://.+)?$',
    doc: '覆盖默认接入点。留空用该家默认地址；写错即 bad-base，不会静默回退。',
  },
  model: {
    kind: 'string',
    default: '',
    doc: '模型名，必填。示例：ollama 的 llava、openai 的 gpt-4o-mini、qwen 的 qwen-vl-plus（示例不是默认值）。',
  },
  credentialRef: {
    kind: 'string',
    default: '',
    pattern: CREDENTIAL_REF_RE.source,
    doc: '凭据的环境变量名（不是值）。留空用该家默认：openai 是 OPENAI_API_KEY，qwen 是 DASHSCOPE_API_KEY。',
  },
  detail: {
    kind: 'enum',
    default: 'auto',
    values: DETAIL_LEVELS,
    doc: '图片细节档，只对 OpenAI 兼容端点有意义。auto = 由 provider 决定。',
  },
  timeoutMs: {
    kind: 'number',
    default: 30000,
    min: TIMEOUT_MIN,
    max: TIMEOUT_MAX,
    advancedOnly: true,
    doc: `单次请求超时（毫秒，${TIMEOUT_MIN}–${TIMEOUT_MAX}）。视觉比文本慢，别按文本的 4 秒配。`,
  },
  maxImageBytes: {
    kind: 'number',
    default: 8 * 1024 * 1024,
    min: IMAGE_BYTES_MIN,
    max: IMAGE_BYTES_MAX,
    advancedOnly: true,
    doc: `单张图片字节上限（${IMAGE_BYTES_MIN}–${IMAGE_BYTES_MAX}）。超了直接拒，不做压缩。`,
  },
  maxOutputChars: {
    kind: 'number',
    default: 2000,
    min: OUTPUT_CHARS_MIN,
    max: OUTPUT_CHARS_MAX,
    advancedOnly: true,
    doc: `正文最多保留多少字（${OUTPUT_CHARS_MIN}–${OUTPUT_CHARS_MAX}）。超了截断并标 truncated。`,
  },
  videoFrames: {
    kind: 'number',
    default: 4,
    min: FRAMES_MIN,
    max: FRAMES_MAX,
    advancedOnly: true,
    doc: '视频抽几帧。手册语料写的是 4 帧。',
  },
  ffmpegPath: {
    kind: 'string',
    default: 'ffmpeg',
    advancedOnly: true,
    doc: 'ffmpeg 可执行文件（按 PATH 找）。找不到就是 no-ffmpeg，不影响看图。',
  },
  cloudWithoutPrivacy: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '没有 ondra-privacy 时是否仍允许把图发到云端。默认不允许——出站必须有人替我说能不能发。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '降级时打一行日志。只影响日志噪声，不影响行为。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  provider: FIELD_SPECS.provider.default as VisionProvider,
  baseUrl: FIELD_SPECS.baseUrl.default as string,
  model: FIELD_SPECS.model.default as string,
  credentialRef: FIELD_SPECS.credentialRef.default as string,
  detail: FIELD_SPECS.detail.default as Config['detail'],
  timeoutMs: FIELD_SPECS.timeoutMs.default as number,
  maxImageBytes: FIELD_SPECS.maxImageBytes.default as number,
  maxOutputChars: FIELD_SPECS.maxOutputChars.default as number,
  videoFrames: FIELD_SPECS.videoFrames.default as number,
  ffmpegPath: FIELD_SPECS.ffmpegPath.default as string,
  cloudWithoutPrivacy: FIELD_SPECS.cloudWithoutPrivacy.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  provider: 'provider',
  baseUrl: 'base-url',
  model: 'model',
  credentialRef: 'credential-ref',
  detail: 'detail',
  timeoutMs: 'timeout-ms',
  maxImageBytes: 'max-image-bytes',
  maxOutputChars: 'max-output-chars',
  videoFrames: 'video-frames',
  ffmpegPath: 'ffmpeg-path',
  cloudWithoutPrivacy: 'cloud-without-privacy',
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
  title: '视觉',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-vision',
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

/** 是不是三家里的一家。 */
export function isProvider(value: unknown): value is VisionProvider {
  return typeof value === 'string' && (VISION_PROVIDERS as readonly string[]).includes(value)
}

/** 是不是三档细节之一。 */
export function isDetailLevel(value: unknown): value is Config['detail'] {
  return typeof value === 'string' && (DETAIL_LEVELS as readonly string[]).includes(value)
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 *
 * 唯一不在这里「修」的是 `baseUrl` 与 `credentialRef`：
 * 前者写错要如实留成 `bad-base`（悄悄回退到默认地址 = 图发到了别处还说成功），
 * 后者写成值（`sk-...`）要如实留成非法（悄悄清空 = 用户以为配好了）。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    provider: isProvider(raw['provider']) ? raw['provider'] : DEFAULT_CONFIG.provider,
    baseUrl: textOf(raw['baseUrl'], DEFAULT_CONFIG.baseUrl, BASE_URL_MAX),
    model: textOf(raw['model'], DEFAULT_CONFIG.model, MODEL_MAX),
    credentialRef: textOf(raw['credentialRef'], DEFAULT_CONFIG.credentialRef, 64),
    detail: isDetailLevel(raw['detail']) ? raw['detail'] : DEFAULT_CONFIG.detail,
    timeoutMs: clampInt(raw['timeoutMs'], DEFAULT_CONFIG.timeoutMs, TIMEOUT_MIN, TIMEOUT_MAX),
    maxImageBytes: clampInt(
      raw['maxImageBytes'],
      DEFAULT_CONFIG.maxImageBytes,
      IMAGE_BYTES_MIN,
      IMAGE_BYTES_MAX,
    ),
    maxOutputChars: clampInt(
      raw['maxOutputChars'],
      DEFAULT_CONFIG.maxOutputChars,
      OUTPUT_CHARS_MIN,
      OUTPUT_CHARS_MAX,
    ),
    videoFrames: clampInt(raw['videoFrames'], DEFAULT_CONFIG.videoFrames, FRAMES_MIN, FRAMES_MAX),
    ffmpegPath: textOf(raw['ffmpegPath'], DEFAULT_CONFIG.ffmpegPath, 200),
    cloudWithoutPrivacy: bool('cloudWithoutPrivacy', DEFAULT_CONFIG.cloudWithoutPrivacy),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（数值被夹紧、枚举被回退、字符串被截断）。
 *
 * 单独给一个函数，是因为 `completeConfig()` 拿到的已经是夹紧后的值，
 * 它自己不知道「刚才那个数越界了」。不告诉用户，用户会以为 99999 生效了。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  if (!isRecord(value)) return []
  const done = completeConfig(value)
  const drift: string[] = []

  if (value['provider'] !== undefined && !isProvider(value['provider'])) {
    drift.push(`provider 不是三家里的一家（${VISION_PROVIDERS.join(' / ')}），已回退 ${done.provider}`)
  }
  if (value['detail'] !== undefined && !isDetailLevel(value['detail'])) {
    drift.push(`detail 不是 ${DETAIL_LEVELS.join(' / ')} 之一，已回退 ${done.detail}`)
  }

  const numbers: readonly (readonly [keyof Config, number, number, number])[] = [
    ['timeoutMs', TIMEOUT_MIN, TIMEOUT_MAX, done.timeoutMs],
    ['maxImageBytes', IMAGE_BYTES_MIN, IMAGE_BYTES_MAX, done.maxImageBytes],
    ['maxOutputChars', OUTPUT_CHARS_MIN, OUTPUT_CHARS_MAX, done.maxOutputChars],
    ['videoFrames', FRAMES_MIN, FRAMES_MAX, done.videoFrames],
  ]
  for (const [key, min, max, actual] of numbers) {
    const raw = value[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    if (Math.trunc(raw) !== actual) {
      drift.push(`${String(key)} 越界（${min}–${max}），已夹到 ${actual}`)
    }
  }

  if (typeof value['model'] === 'string' && value['model'].trim().length > MODEL_MAX) {
    drift.push(`model 超过 ${MODEL_MAX} 字，已截断`)
  }
  return drift
}

/**
 * 凭据引用名：配置留空时用该家的默认变量名。
 * @param config 配置。
 */
export function credentialRefOf(config: Config): string {
  if (config.credentialRef !== '') return config.credentialRef
  return PROVIDER_ENDPOINTS[config.provider].credentialRef
}

/** 解析接入点的结果。 */
export type EndpointResult =
  | { readonly ok: true; readonly endpoint: ResolvedEndpoint }
  | { readonly ok: false; readonly reason: VisionReason; readonly detail: string }

/**
 * 判断一个主机是不是本机（本机 = 不出站）。
 *
 * IPv6 的主机名带方括号（`[::1]:11434`），直接 `split(':')` 会切出一个 `[`，
 * 于是 `http://[::1]:11434` 被判成云端——一次本地调用被迫去问出站许可。
 */
function isLoopbackHost(host: string): boolean {
  let name: string
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    name = close > 0 ? host.slice(1, close) : host.slice(1)
  } else {
    name = host.split(':')[0] ?? ''
  }
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '0.0.0.0'
}

/**
 * 把配置解析成「这次要往哪儿发」。**唯一入口**：出站声明、请求、日志都过这一关。
 *
 * 三种坏法都如实报 `bad-base`，**不回退默认地址**：回退意味着用户以为发去了自建网关，
 * 实际发去了公网大厂——这是最不该静默的一种。
 * @param config 配置。
 */
export function resolveEndpoint(config: Config): EndpointResult {
  const fallback: ProviderEndpoint = PROVIDER_ENDPOINTS[config.provider]
  const raw = config.baseUrl.trim()
  if (raw === '') {
    return { ok: true, endpoint: { base: fallback.base, host: fallback.host, local: fallback.local } }
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'bad-base', detail: `base-url 不是合法地址：${raw.slice(0, 80)}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'bad-base', detail: `base-url 协议必须是 http 或 https：${parsed.protocol}` }
  }
  if (parsed.host === '') {
    return { ok: false, reason: 'bad-base', detail: 'base-url 缺主机名' }
  }

  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '')
  return {
    ok: true,
    endpoint: { base, host: parsed.host, local: isLoopbackHost(parsed.host) },
  }
}

/**
 * 出站声明用的主机列表。
 *
 * 地址写坏时给**空列表**：O-076 的语义是「空 = 哪儿都不许去」，
 * 正好对上「我连要发去哪都不知道，那就别发」。
 * @param config 配置。
 */
export function egressHostsOf(config: Config): readonly string[] {
  const resolved = resolveEndpoint(config)
  return resolved.ok ? [resolved.endpoint.host] : []
}
