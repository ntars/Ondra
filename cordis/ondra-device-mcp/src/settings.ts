/**
 * 配置的**单一真源**。
 *
 * ## 为什么没有 `endpoint`
 *
 * master-plan §9.12 把「device-mcp 的 `endpoint`」列为**假字段**：
 * 旧 UI 让人填一个地址，而源码根本不读它（走本地命令）。
 * 填了地址就以为连上了，是最坏的一种「假开关」：界面绿着，实际什么都没发生。
 * 所以本包的字段表里没有地址；数据从哪来由 `DeviceBridge` 端口决定。
 *
 * ## 为什么联系人默认关
 *
 * 五个能力里，通讯录是唯一「一次能拿走一群人信息」的那一个。
 * 通知与短信天然是一条一条来的，电池与前台 App 只有一行；
 * 通讯录一次能给几百条姓名与号码。所以它单独默认关，且**关键词必填**。
 * 这不是过度谨慎——手册 §9.4 的隐私口径是「刻意不暴露项」，
 * desktop-mcp 连剪贴板内容都不返回，本包没有理由比它松。
 *
 * ## 为什么「打码」与「截断」是默认值而不是开关的默认关
 *
 * 默认关的意思是「默认把原文交给模型」。而模型看到的东西会进对话、进日志、
 * 进上下文缓存。所以隐私默认必须是**开**（`maskPhones: true`），
 * 想关掉的人要自己动手——这是一个有意设计的摩擦。
 */

import type { FieldSpecLike, SectionDeclLike, ToolKey } from './types.js'
import {
  CALL_TIMEOUT_MS,
  DEFAULT_LIMIT,
  LIMIT_CEIL,
  SMS_BODY_MAX,
  TIMEOUT_CEIL,
  TIMEOUT_FLOOR,
  TOOL_KEYS,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关，手册 §16.3）。 */
  readonly enable: boolean
  /** 开着的能力（取值是能力键，不是工具名）。 */
  readonly enabledTools: readonly ToolKey[]
  /** 单次调用超时（毫秒）。 */
  readonly callTimeoutMs: number
  /** 默认条数。 */
  readonly defaultLimit: number
  /** 短信正文截断长度。 */
  readonly smsBodyMax: number
  /** 号码打码（默认开）。 */
  readonly maskPhones: boolean
  /** 通知是否带正文（默认不带）。 */
  readonly includeNotificationBody: boolean
  /** 允许把 `ondra-adb` 当作短信来源（默认允许；关掉就连 adb 也不碰）。 */
  readonly useAdbForSms: boolean
  /** 每次调用打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'device-mcp'

/** `defaultLimit` 的下界：1。 */
export const LIMIT_FLOOR = 1

/** `smsBodyMax` 的下界：20。低于它就是「只看到开头几个字」。 */
export const BODY_FLOOR = 20

/** `smsBodyMax` 的上界：2000。 */
export const BODY_CEIL = 2_000

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  enabledTools: 'enabled-tools',
  callTimeoutMs: 'call-timeout-ms',
  defaultLimit: 'default-limit',
  smsBodyMax: 'sms-body-max',
  maskPhones: 'mask-phones',
  includeNotificationBody: 'include-notification-body',
  useAdbForSms: 'use-adb-for-sms',
  verbose: 'verbose',
})

/** 查表版（理由同其它插件：`Map.get` 天然带 `undefined`）。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/**
 * 出厂默认开的能力。
 *
 * **不含 `contacts`**：见文件头。其余四个都是「一次一条、量小、用途明确」的只读项。
 */
export const DEFAULT_TOOLS: readonly ToolKey[] = Object.freeze(['notifications', 'sms', 'battery', 'foreground'])

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '只读设备能力开关。默认关：装上就能读手机通知与短信，那是事故不是功能。',
  },
  enabledTools: {
    kind: 'json',
    default: DEFAULT_TOOLS,
    doc: '开着的能力：notifications / sms / contacts / battery / foreground。**通讯录默认关**。',
  },
  callTimeoutMs: {
    kind: 'number',
    default: CALL_TIMEOUT_MS,
    min: TIMEOUT_FLOOR,
    max: TIMEOUT_CEIL,
    advancedOnly: true,
    doc: '单次调用超时（§9.11 实测 8 秒）。超时结果会被丢弃并标 late。',
  },
  defaultLimit: {
    kind: 'number',
    default: DEFAULT_LIMIT,
    min: LIMIT_FLOOR,
    max: LIMIT_CEIL,
    doc: '不传 limit 时的条数。',
  },
  smsBodyMax: {
    kind: 'number',
    default: SMS_BODY_MAX,
    min: BODY_FLOOR,
    max: BODY_CEIL,
    advancedOnly: true,
    doc: '短信正文截断长度（超了标 truncated）。',
  },
  maskPhones: {
    kind: 'boolean',
    default: true,
    doc: '号码打码（保留前 3 后 2）。默认开：模型看到的东西会进对话与上下文缓存。',
  },
  includeNotificationBody: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '通知是否返回正文。默认不带——通知正文里常有验证码与私信。',
  },
  useAdbForSms: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '允许把 ondra-adb 当作短信来源。关掉则只认注入的 DeviceBridge。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次调用打一行日志（不含号码与正文）。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值（自检比对两份表）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  enabledTools: DEFAULT_TOOLS,
  callTimeoutMs: CALL_TIMEOUT_MS,
  defaultLimit: DEFAULT_LIMIT,
  smsBodyMax: SMS_BODY_MAX,
  maskPhones: true,
  includeNotificationBody: false,
  useAdbForSms: true,
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 查表版。理由同 `KEY_MAP`。 */
const SECTION_MAP: ReadonlyMap<string, keyof Config> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Config])[],
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '手机只读能力',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-device-mcp',
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
    out[KEY_MAP.get(key) ?? key] = value
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
    out[SECTION_MAP.get(key) ?? key] = value
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
 * 归一化能力名单。
 *
 * 认三种写法：能力键（`notifications`）、工具名（`device-notifications`）、
 * 手册里的点号写法（`device.notifications`）。第三种**只接受读入**，
 * 不向外发布——理由是它不符合 §8.4，而人手里的旧配置可能就长那样。
 * @param value 原始值。
 * @param onBad 被丢弃的条目回调。
 */
function normalizeTools(value: unknown, onBad: (text: string) => void): readonly ToolKey[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: ToolKey[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim().toLowerCase()
    if (text === '') continue
    const bare = text.startsWith('device.') ? text.slice('device.'.length) : text.startsWith('device-') ? text.slice('device-'.length) : text
    const key = TOOL_KEYS.find(candidate => candidate === bare)
    if (key === undefined) {
      onBad(item)
      continue
    }
    if (!out.includes(key)) out.push(key)
  }
  return Object.freeze(out)
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 * @param onBad 有坏条目时的回调。
 */
export function completeConfig(value: unknown, onBad?: (text: string, kind: string) => void): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const report = (text: string, kind: string): void => {
    if (onBad !== undefined) onBad(text, kind)
  }

  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  // `enabledTools` 缺失时才用默认表；显式给了空数组**就是空**（用户全关，不许"帮忙"打开）。
  const tools =
    raw['enabledTools'] === undefined
      ? DEFAULT_TOOLS
      : normalizeTools(raw['enabledTools'], text => report(text, 'enabledTools'))

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    enabledTools: tools,
    callTimeoutMs: clampInt(raw['callTimeoutMs'], DEFAULT_CONFIG.callTimeoutMs, TIMEOUT_FLOOR, TIMEOUT_CEIL),
    defaultLimit: clampInt(raw['defaultLimit'], DEFAULT_CONFIG.defaultLimit, LIMIT_FLOOR, LIMIT_CEIL),
    smsBodyMax: clampInt(raw['smsBodyMax'], DEFAULT_CONFIG.smsBodyMax, BODY_FLOOR, BODY_CEIL),
    maskPhones: bool('maskPhones', DEFAULT_CONFIG.maskPhones),
    includeNotificationBody: bool('includeNotificationBody', DEFAULT_CONFIG.includeNotificationBody),
    useAdbForSms: bool('useAdbForSms', DEFAULT_CONFIG.useAdbForSms),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（越界值被夹紧）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['callTimeoutMs', TIMEOUT_FLOOR, TIMEOUT_CEIL],
    ['defaultLimit', LIMIT_FLOOR, LIMIT_CEIL],
    ['smsBodyMax', BODY_FLOOR, BODY_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) {
      drift.push(key)
    }
  }

  return drift
}
