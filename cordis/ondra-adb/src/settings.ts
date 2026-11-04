/**
 * 配置的**单一真源**。每个数字的出处写在注释里。
 *
 * ## 字段为什么是这七个（而不是旧 UI 的那三个）
 *
 * master-plan §9.12 点名过一处错位：
 *
 * ```
 * adb | UI 填 serial | 源码实际读 adbPath / pollSeconds / replyWebhook | 全部错位
 * ```
 *
 * 新体系的要求是「字段定义由插件用 `Config` 声明，界面只按 schema 渲染」，
 * 所以本表就是全部字段。`serial` **保留**（多设备时必须指定，否则 adb 会
 * `more than one device` 直接失败），但它不是旧 UI 里那个孤零零的 `serial`——
 * 它只是 `adbPath` 的伴生项，装载期会说明「指定了哪台」。
 *
 * ## `pollSeconds` 与 `execTimeoutMs` 为什么是两个字段
 *
 * 合成一个就会互相打架：轮询周期是 15 秒，而单条命令允许跑 8 秒，
 * 于是「一轮没跑完下一轮又来了」必须由 `busy` 挡掉（本包有 `polling` 标志）。
 * 分开之后，两者的关系是**可检查的**：命令超时必须小于周期，否则每一轮都会
 * 撞上 `busy`，表现为「一直在轮询、一直读不到」。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import {
  BATCH_CEIL,
  BATCH_FLOOR,
  EXEC_CEIL,
  EXEC_FLOOR,
  EXEC_TIMEOUT_MS,
  POLL_SECONDS,
  POLL_SECONDS_CEIL,
  POLL_SECONDS_FLOOR,
  SEEN_MAX,
  UNREAD_BATCH,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关，手册 §16.3：端侧默认全部关闭）。 */
  readonly enable: boolean
  /** `adb` 可执行文件路径或命令名。 */
  readonly adbPath: string
  /** 指定设备序列号（空 = 不指定，交给 adb 自己挑）。 */
  readonly serial: string
  /** 轮询周期（秒）。 */
  readonly pollSeconds: number
  /** 单轮最多处理几条。 */
  readonly batchLimit: number
  /** 单条命令超时（毫秒）。 */
  readonly execTimeoutMs: number
  /** 是否把短信转交给人格并回一条（默认关）。 */
  readonly autoReply: boolean
  /** 回复桥地址（用户自备 Intent 桥的 HTTP 入口）。 */
  readonly replyWebhook: string
  /** 允许把回复发到非回环地址（默认不允许）。 */
  readonly allowRemoteBridge: boolean
  /** 已答集合上限（超过就裁到一半）。 */
  readonly seenMax: number
  /** 已答集合落盘路径；留空由 `path-layout` 推出。 */
  readonly stateFile: string
  /** 每次轮询打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'adb'

/** `seenMax` 的下界：50（低于它裁一半就只剩 25 条，等于一直在重答）。 */
export const SEEN_FLOOR = 50

/** `seenMax` 的上界：50000。 */
export const SEEN_CEIL = 50_000

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  adbPath: 'adb-path',
  serial: 'serial',
  pollSeconds: 'poll-seconds',
  batchLimit: 'batch-limit',
  execTimeoutMs: 'exec-timeout-ms',
  autoReply: 'auto-reply',
  replyWebhook: 'reply-webhook',
  allowRemoteBridge: 'allow-remote-bridge',
  seenMax: 'seen-max',
  stateFile: 'state-file',
  verbose: 'verbose',
})

/**
 * 查表版。用 `Map` 而不是直接下标：`KEY_PAIRS[key]` 的类型是 `string`，
 * 后面接 `?? key` 会被 TS 判成「右操作数不可达」；`Map.get()` 天然带 `undefined`。
 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '短信轮询开关。默认关：装上就去读手机短信，那是事故不是功能。',
  },
  adbPath: {
    kind: 'string',
    default: 'adb',
    doc: 'adb 可执行文件路径或命令名（在 PATH 里就写 adb）。',
  },
  serial: {
    kind: 'string',
    default: '',
    doc: '设备序列号。空 = 交给 adb 挑；接了多台时会被 adb 拒绝（more than one device）。',
  },
  pollSeconds: {
    kind: 'number',
    default: POLL_SECONDS,
    min: POLL_SECONDS_FLOOR,
    max: POLL_SECONDS_CEIL,
    doc: '轮询周期（§9.11 实测 15 秒）。',
  },
  batchLimit: {
    kind: 'number',
    default: UNREAD_BATCH,
    min: BATCH_FLOOR,
    max: BATCH_CEIL,
    doc: '单轮最多处理几条（§9.11 实测 20）。上限锁 20，防止一次涌上百条把模型打成 429。',
  },
  execTimeoutMs: {
    kind: 'number',
    default: EXEC_TIMEOUT_MS,
    min: EXEC_FLOOR,
    max: EXEC_CEIL,
    advancedOnly: true,
    doc: '单条命令超时。**必须小于 pollSeconds×1000**，否则每轮都撞 busy。',
  },
  autoReply: {
    kind: 'boolean',
    default: false,
    doc: '把短信转交人格并回一条。默认关——只读默认（§16.3）。**没有 replyWebhook 时此开关无效**：会被降为只读并报一条 drift。',
  },
  replyWebhook: {
    kind: 'string',
    default: '',
    doc: '回复桥地址。空 = 不回短信（只读）。发短信不做，靠这个桥 + 用户自备 Intent（§9.11）。',
  },
  allowRemoteBridge: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '允许把回复发到非回环地址。默认只允许 127.0.0.1 / localhost / ::1。',
  },
  seenMax: {
    kind: 'number',
    default: SEEN_MAX,
    min: SEEN_FLOOR,
    max: SEEN_CEIL,
    advancedOnly: true,
    doc: '已答集合上限（§9.11 实测 1000）。超过就裁到一半，保留较新的。',
  },
  stateFile: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '已答集合落盘路径。留空则用 user/adb-seen.json（0600）。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次轮询打一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值（自检比对两份表）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  adbPath: 'adb',
  serial: '',
  pollSeconds: POLL_SECONDS,
  batchLimit: UNREAD_BATCH,
  execTimeoutMs: EXEC_TIMEOUT_MS,
  autoReply: false,
  replyWebhook: '',
  allowRemoteBridge: false,
  seenMax: SEEN_MAX,
  stateFile: '',
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
  title: '手机短信（adb）',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-adb',
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
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 * @param onBad 有坏条目时的回调。
 */
export function completeConfig(value: unknown, onBad?: (text: string, kind: string) => void): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const report = (text: string, kind: string): void => {
    if (onBad !== undefined) onBad(text, kind)
  }

  const str = (key: keyof Config, fallback: string): string => {
    const given = raw[key]
    return typeof given === 'string' ? given.trim() : fallback
  }
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  const adbPath = str('adbPath', DEFAULT_CONFIG.adbPath)
  const webhook = str('replyWebhook', DEFAULT_CONFIG.replyWebhook)

  // 「自动回复」与「有没有桥」是一件事的两面：桥为空时这个开关**必须**是关的。
  // 否则每 15 秒都会去问一次人格、然后把答案丢在地上——既烧钱又什么都发不出去。
  // 约束只写在 `completeConfig` 一处，`service.poll()` 再兜一次（防有人绕过本函数）。
  const autoReplyGiven = bool('autoReply', DEFAULT_CONFIG.autoReply)
  const autoReply = autoReplyGiven && webhook !== ''
  if (autoReplyGiven !== autoReply) report('autoReply', 'autoReply（没有 replyWebhook，已降为只读）')

  // 命令超时必须小于轮询周期：否则每一轮都撞上 `busy`，症状是「一直在轮询却读不到」。
  const pollSeconds = clampInt(raw['pollSeconds'], DEFAULT_CONFIG.pollSeconds, POLL_SECONDS_FLOOR, POLL_SECONDS_CEIL)
  const execGiven = clampInt(raw['execTimeoutMs'], DEFAULT_CONFIG.execTimeoutMs, EXEC_FLOOR, EXEC_CEIL)
  const execCeilForPoll = Math.max(EXEC_FLOOR, pollSeconds * 1_000 - 1_000)
  const execTimeoutMs = Math.min(execGiven, execCeilForPoll)
  if (execGiven !== execTimeoutMs) report(String(execGiven), 'execTimeoutMs')

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    adbPath: adbPath === '' ? DEFAULT_CONFIG.adbPath : adbPath,
    serial: str('serial', DEFAULT_CONFIG.serial),
    pollSeconds,
    batchLimit: clampInt(raw['batchLimit'], DEFAULT_CONFIG.batchLimit, BATCH_FLOOR, BATCH_CEIL),
    execTimeoutMs,
    autoReply,
    replyWebhook: webhook,
    allowRemoteBridge: bool('allowRemoteBridge', DEFAULT_CONFIG.allowRemoteBridge),
    seenMax: clampInt(raw['seenMax'], DEFAULT_CONFIG.seenMax, SEEN_FLOOR, SEEN_CEIL),
    stateFile: str('stateFile', DEFAULT_CONFIG.stateFile),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（越界值被夹紧或被约束改写）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['pollSeconds', POLL_SECONDS_FLOOR, POLL_SECONDS_CEIL],
    ['batchLimit', BATCH_FLOOR, BATCH_CEIL],
    ['execTimeoutMs', EXEC_FLOOR, EXEC_CEIL],
    ['seenMax', SEEN_FLOOR, SEEN_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) {
      drift.push(key)
    }
  }

  // 单独检查跨字段约束：命令超时被周期压下来时也要报。
  const pollSeconds = raw['pollSeconds']
  const exec = raw['execTimeoutMs']
  if (typeof pollSeconds === 'number' && typeof exec === 'number' && exec >= pollSeconds * 1_000) {
    drift.push('execTimeoutMs（大于等于轮询周期，已压到周期减 1 秒）')
  }

  // 「开了自动回复但没有桥」→ 已降为只读，必须报出来（否则用户以为她在回短信）。
  const webhook = raw['replyWebhook']
  if (raw['autoReply'] === true && typeof webhook === 'string' && webhook.trim() === '') {
    drift.push('autoReply（没有 replyWebhook，已降为只读）')
  }

  return drift
}
