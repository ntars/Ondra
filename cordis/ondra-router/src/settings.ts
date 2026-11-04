/**
 * 配置的**单一真源**（唤醒判定的阈值 + 队列上限）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * ## 为什么没有「群聊主动」这个开关
 *
 * 手册 §5.7 把「群聊不主动」列进**节制红线**（「节制不是功能，是生存红线」），
 * 背景是批量小号与 AI 互刷引发的社区反感。红线做成开关，等于把
 * 「一装就可能被举报封号」变成群里一个可以点的小勾。所以它恒为假，
 * 不在 `FIELD_SPECS` 里出现——这不是漏了配置。
 *
 * ## 为什么 `strictWhitelist` 默认关
 *
 * 白名单数据归各适配器（手册 §6.1「白名单必须区分 QQ 号和群聊两类分别配置」）。
 * 适配器还没实现时，`whitelisted` 是 `undefined`。默认把 `undefined` 当拒绝，
 * 结果是「装上插件，所有通道全哑」，而原因藏在一条 warn 里。默认放行 +
 * 一个明确开关，方向更对：要安全的人自己开，而开了之后的行为写在文档里。
 *
 * ## `wakeProbability` 是手册 §14.3「通道唤醒」三口径的合一
 *
 * 手册把三种做法并列：本地唤醒（`wakeProbability`）/ 全量响应 / 关键词唤醒。
 * 三者不是三套代码，是同一件事的三个参数值：
 *
 * - 全量响应 = `1`（**默认**，最稳：不漏消息）；
 * - 本地唤醒 = `0 < p < 1`（有时不回，拟人）；
 * - 关键词唤醒 = 群聊那条分支（`mention` / `keyword`），与概率无关。
 *
 * 按 §12.1 的判定顺序，这属于「能融会贯通 → 融」，不是三个分支。
 * 概率**只作用于私聊的 `wake`**：群里被点名还掷骰子，就是失礼。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务照常注册，`admit()` 一律 `disabled`。 */
  readonly enable: boolean
  /** 群里命中关键词时回不回。手册 §6.1「@ 机器人或关键词」。 */
  readonly replyOnKeyword: boolean
  /** 私聊来信被叫醒的概率（0–1）。1 = 全量响应（默认）。 */
  readonly wakeProbability: number
  /** 白名单未声明时是否拒绝。 */
  readonly strictWhitelist: boolean
  /** 单个会话最多积压几条。 */
  readonly maxQueue: number
  /** 最多同时记多少个会话（占用 + 队列 + 去重表共用这个上限）。 */
  readonly maxConversations: number
  /** 同一条消息的重复投递判定窗口（毫秒）。 */
  readonly dedupeMs: number
  /** 每次受理打一行日志。只影响噪声。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（无冒号、小写连字符）。 */
export const CONFIG_SECTION_ID = 'router'

/** 单会话积压下界：1 条。低于 1 就不是队列了。 */
export const MAX_QUEUE_FLOOR = 1

/**
 * 单会话积压上界：32 条。
 *
 * 手册没给这个数。取 32 的理由：一个会话在「她还没回完」的几十秒里
 * 涌进 32 条已经是异常（人手速上限约 5 条/10 秒），再往上留也留不住；
 * 而每一条都带正文，32 条 × 9 个通道 × 数十会话 = 内存不可控。
 */
export const MAX_QUEUE_CEIL = 32

/** 会话数下界。 */
export const MAX_CONVERSATIONS_FLOOR = 1

/** 会话数上界：512。再多就该考虑落盘了，而落盘不是本插件的事。 */
export const MAX_CONVERSATIONS_CEIL = 512

/** 去重窗口下界：0 表示不去重。 */
export const DEDUPE_MS_FLOOR = 0

/**
 * 去重窗口上界：10 秒。
 *
 * 手册 §5.4 的四重锁第一重是「1 秒去重」，默认就取 1 秒。
 * 上界压到 10 秒是为了防「把它当 30 分钟重复去重」——
 * 那是发送侧的闸（§5.3-3，窗口 30 分钟、minLen 4），归适配器，
 * 混进来会让「用户真的连发两遍同一句话」被吃成一条。
 */
export const DEDUPE_MS_CEIL = 10_000

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后一律不处置（服务照常注册，面板能看见「已关闭」）。',
  },
  replyOnKeyword: {
    kind: 'boolean',
    default: true,
    doc: '群里命中关键词时回一条（不是叫醒）。关掉后群里只认点名。',
  },
  wakeProbability: {
    kind: 'number',
    default: 1,
    min: 0,
    max: 1,
    advancedOnly: true,
    doc: '私聊来信被叫醒的概率（0–1）。1 = 每次都叫（默认，最稳）；0.8 表示有时不回，更拟人。**只作用于私聊**：群里被点名不掷骰子。',
  },
  strictWhitelist: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '适配器没给出白名单结论时按「不在白名单」拒绝。默认关：白名单数据归各适配器，默认拒会让还没实现的通道全哑。',
  },
  maxQueue: {
    kind: 'number',
    default: 8,
    min: MAX_QUEUE_FLOOR,
    max: MAX_QUEUE_CEIL,
    doc: `单个会话最多积压几条（${MAX_QUEUE_FLOOR}–${MAX_QUEUE_CEIL}）。满了明确拒绝，不悄悄丢掉最旧的那条。`,
  },
  maxConversations: {
    kind: 'number',
    default: 64,
    min: MAX_CONVERSATIONS_FLOOR,
    max: MAX_CONVERSATIONS_CEIL,
    advancedOnly: true,
    doc: `最多同时记多少个会话（${MAX_CONVERSATIONS_FLOOR}–${MAX_CONVERSATIONS_CEIL}）。占用、队列、去重表共用。`,
  },
  dedupeMs: {
    kind: 'number',
    default: 1000,
    min: DEDUPE_MS_FLOOR,
    max: DEDUPE_MS_CEIL,
    advancedOnly: true,
    doc: `同一条消息（按平台消息 id）重复投递的判定窗口（${DEDUPE_MS_FLOOR}–${DEDUPE_MS_CEIL} 毫秒）。手册 §5.4 取 1 秒；0 = 不去重。`,
  },
  verbose: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '每次受理打一行日志。只影响日志噪声。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  replyOnKeyword: FIELD_SPECS.replyOnKeyword.default as boolean,
  wakeProbability: FIELD_SPECS.wakeProbability.default as number,
  strictWhitelist: FIELD_SPECS.strictWhitelist.default as boolean,
  maxQueue: FIELD_SPECS.maxQueue.default as number,
  maxConversations: FIELD_SPECS.maxConversations.default as number,
  dedupeMs: FIELD_SPECS.dedupeMs.default as number,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  replyOnKeyword: 'reply-on-keyword',
  wakeProbability: 'wake-probability',
  strictWhitelist: 'strict-whitelist',
  maxQueue: 'max-queue',
  maxConversations: 'max-conversations',
  dedupeMs: 'dedupe-ms',
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
  title: '通道路由',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-router',
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
 * 夹一个 0–1 的小数。
 * @param value 待夹的值。
 * @param fallback 非法时的回退值。
 */
function clampUnit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    replyOnKeyword: bool('replyOnKeyword', DEFAULT_CONFIG.replyOnKeyword),
    wakeProbability: clampUnit(raw['wakeProbability'], DEFAULT_CONFIG.wakeProbability),
    strictWhitelist: bool('strictWhitelist', DEFAULT_CONFIG.strictWhitelist),
    maxQueue: clampInt(raw['maxQueue'], DEFAULT_CONFIG.maxQueue, MAX_QUEUE_FLOOR, MAX_QUEUE_CEIL),
    maxConversations: clampInt(
      raw['maxConversations'],
      DEFAULT_CONFIG.maxConversations,
      MAX_CONVERSATIONS_FLOOR,
      MAX_CONVERSATIONS_CEIL,
    ),
    dedupeMs: clampInt(raw['dedupeMs'], DEFAULT_CONFIG.dedupeMs, DEDUPE_MS_FLOOR, DEDUPE_MS_CEIL),
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

  const numeric: readonly [string, number, number][] = [
    ['maxQueue', MAX_QUEUE_FLOOR, MAX_QUEUE_CEIL],
    ['maxConversations', MAX_CONVERSATIONS_FLOOR, MAX_CONVERSATIONS_CEIL],
    ['dedupeMs', DEDUPE_MS_FLOOR, DEDUPE_MS_CEIL],
    ['wakeProbability', 0, 1],
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
