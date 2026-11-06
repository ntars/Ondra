/**
 * O-137 `ondra-lexicon` 的对外契约（〔研〕自研）。
 *
 * 定位：**统计「主人怎么说话」，压成一段约 130 字的易变段**，让她模仿节奏，
 * 而不是模仿内容。台账原文：「语感统计：最近 300 条真人消息算中位句长/无标点率/语气词；
 * 注入约 130 字；只统计不覆盖人格；注入块带 marker」。
 *
 * ## 六条边界，决定了整个形状
 *
 * 1. **只存形状，不存原话。** `observe()` 进来一条消息，立刻压成
 *    `MessageShape`（句长数组 + 有没有标点 + 句末语气词计数），**原文当次丢弃**。
 *    存档里也只有形状。这样「记住形状不记住话」不是一句承诺，而是结构事实：
 *    就算有人把 `user/lexicon-shape.json` 打开，也读不到主人说过什么。
 *
 * 2. **只认真人，不认她自己。** `from: 'assistant'` 一律拒收。把她的句子统计进去，
 *    语感会自我强化（她越说越像上一轮的她），而主人真实的变化被稀释。
 *    统计对象是主人，不是她自己。
 *
 * 3. **不覆盖人格。** 本包产出的正文只有「事实 + 一句参考」，不含任何
 *    指令式改写（没有「你应该」「请改成」）。人格四段归 O-023、由 O-033 冻结成前缀；
 *    这里给的是**易变段**，每轮都可能不同，写进前缀会把缓存命中率打回 0（§8.5）。
 *
 * 4. **样本不足就交空段。** 少于 `minSamples` 时 `compose()` 返回 `text: ''`。
 *    空段不是「省一点字」，是**不许占位**：一段「暂无数据」会挤掉真正的注入，
 *    还会让模型把占位当信息。
 *
 * 5. **中位数，不是平均值。** 主人贴一段代码或一条长语音转写，平均值会被一条
 *    拉飞；中位数只关心「一半的句子比它短」。台账写的也是中位句长。
 *
 * 6. **注入块带固定 marker。** `MARKER` 是 O-142（注入去重）与提示词预览认块的唯一依据，
 *    不许改、不许本地化。改一次，去重就静默失配。
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（§15.5），全部用结构对位镜像。
 */

/** 本插件注册的服务键（连字符，非 `ondra:lexicon`）。全仓唯一归属。 */
export const LEXICON_SERVICE_KEY = 'ondra-lexicon'

/** 服务键 / 工具名 / 配置键的唯一合法形状（手册 §8.4）。**带冒号会被模型侧直接拒绝**。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 注入块的固定 marker。
 *
 * 逐字固定：O-142 按它认「这块是语感」并做跨轮去重，提示词预览按它折叠成一行。
 * 本地化会同时打坏这两处，所以它**不是** locale 里的文案，而是契约常量。
 */
export const MARKER = '[语感]'

/** 样本窗口默认条数（台账逐字：最近 300 条）。 */
export const SAMPLE_WINDOW = 300

/**
 * 注入段的默认排序键（易变段之间比较，越小越靠前）。
 *
 * 取 620 的理由：排在记忆注入（百位）之后、收尾纪律（千位）之前——
 * 语感是「怎么说话」，不该抢在「说什么」前面。调用方可覆盖。
 */
export const BLOCK_ORDER = 620

/**
 * 句末语气词闭集。
 *
 * 为什么是闭集而不是分词器：本仓禁装依赖，而中文分词器体积与启动成本都不该
 * 绑在每一次回合上。闭集只认**句末单字**，因此噪声可控（句中的「啊」不算）。
 * 代价写在 README「已知限制」：方言语气词（「咧」「哩」）不在表内。
 */
export const PARTICLES: readonly string[] = Object.freeze([
  '啊',
  '呀',
  '吧',
  '呢',
  '吗',
  '啦',
  '哦',
  '喔',
  '诶',
  '唉',
  '哎',
  '嗯',
  '哈',
  '嘛',
  '呐',
  '咯',
  '嘞',
  '噢',
  '唔',
  '嘿',
  '呗',
  '喽',
])

/** 消息来源，二值闭集。与 `DialogueRole` 的 `user` / `assistant` 逐字对位。 */
export const SOURCES = ['user', 'assistant'] as const

/** 一种来源。 */
export type LexiconSource = (typeof SOURCES)[number]

/** 出段的原因，三值闭集。每个值对应一种处置。 */
export const BLOCK_REASONS = ['ok', 'disabled', 'too-few'] as const

/** 一种出段原因。 */
export type BlockReason = (typeof BLOCK_REASONS)[number]

/** 原因的中文说法。**只给日志与面板**，不进提示词。 */
export const REASON_ZH: Readonly<Record<BlockReason, string>> = Object.freeze({
  ok: '样本够了，已出一段语感',
  disabled: '语感统计已关闭',
  'too-few': '样本还不够，这一轮不出段（不占位）',
})

/** 一条待统计的消息。**调用方交进来的原始形状**。 */
export interface LexiconSample {
  /** 正文。空串或全空白会被拒收。 */
  readonly text: string
  /** 谁说的。缺省按 `user` 处理（真人）。 */
  readonly from?: LexiconSource
  /**
   * 是不是主人本人说的。缺省 `true`。
   *
   * 群聊里别人的话也是「真人消息」，但不是主人的语感。`ownerOnly` 打开时
   * `owner: false` 会被拒收（`not-owner`），而不是「悄悄算进去」。
   */
  readonly owner?: boolean
  /** 发送时刻（毫秒）。缺省用当前时刻。只用于时间窗口与审计。 */
  readonly at?: number
}

/** 一次入库的结果。 */
export interface ObserveOutcome {
  /** 收下几条。 */
  readonly accepted: number
  /** 判重跳过几条（通道重推同一条消息）。 */
  readonly duplicate: number
  /** 拒收几条。 */
  readonly rejected: number
  /** 当前窗口里的样本条数。 */
  readonly samples: number
}

/** 一条消息被压成的形状。**原文不在这里**，这是刻意的。 */
export interface MessageShape {
  /** 判重指纹（正文 + 时刻）。只给判重与审计用，不进正文。 */
  readonly fingerprint: string
  /** 时刻（毫秒）。 */
  readonly at: number
  /** 整条消息的码位长度（去空白）。 */
  readonly chars: number
  /** 每一句的码位长度（去空白、去标点）。空数组表示这条没有可统计的句子。 */
  readonly sentenceChars: readonly number[]
  /** 整条消息有没有标点。**按消息算，不按句算**（见 README 裁决 2）。 */
  readonly noPunct: boolean
  /** 句末语气词计数（闭集内的字）。 */
  readonly particles: Readonly<Record<string, number>>
}

/** 三维统计 + 解释用的窗口信息。 */
export interface LexiconStats {
  /** 参与统计的样本条数。 */
  readonly samples: number
  /** 句长中位数（码位）。没有句子时为 0。 */
  readonly medianSentenceChars: number
  /** 无标点消息占比，0–1。没有样本时为 0。 */
  readonly noPunctRate: number
  /** 最高频的几个句末语气词（已按次数降序、次数相同按表内顺序）。 */
  readonly topParticles: readonly string[]
  /** 最旧一条的时刻；空窗口时为 0。 */
  readonly oldestAt: number
  /** 最新一条的时刻；空窗口时为 0。 */
  readonly newestAt: number
}

/** `compose()` 的产物：一段可以直接当易变段用的正文。 */
export interface LexiconBlock {
  /** 固定 marker，恒等于 `MARKER`。 */
  readonly marker: string
  /** 正文。**原因不是 `ok` 时为空串**（不占位）。 */
  readonly text: string
  /** 正文字数（码位）。 */
  readonly chars: number
  /** 建议排序键。 */
  readonly order: number
  /** 建议存活时长（分钟）。语感一天内不会变，默认 1440。 */
  readonly ttlMinutes: number
  /** 置信度 0–1，按样本量线性给。 */
  readonly confidence: number
  /** 为什么是这个结果。 */
  readonly reason: BlockReason
}

/** 对外服务面。 */
export interface LexiconService {
  /** 开关开着吗（关掉后服务仍注册，`compose()` 恒返回 `disabled` 的空段）。 */
  readonly available: boolean
  /** 形状存档能不能写（路径服务缺席或写失败时为 false）。 */
  readonly stored: boolean
  /** 收一条或一批消息。**永不抛错**。 */
  observe(input: LexiconSample | readonly LexiconSample[]): ObserveOutcome
  /** 读当前统计。纯读，不改任何状态。 */
  stats(): LexiconStats
  /** 出一段注入正文。样本不足时给空串，不是给占位。 */
  compose(): LexiconBlock
  /** 清空窗口（含存档）。 */
  reset(): void
  /** 卸载时调用：把窗口写盘并释放引用。 */
  dispose(): void
}

/* ------------------------------------------------------------------ *
 * 上游依赖的结构对位子集（只用到的那几个成员，不 import 上游源码）
 * ------------------------------------------------------------------ */

/** 日志口。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-002 路径服务的结构对位子集。 */
export interface PathLike {
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  ensure(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  prepareFile(filePath: string): string
  exists(filePath: string): boolean
}

/** O-003 日历切片的对位子集。 */
export interface ClockPartsLike {
  readonly hour: number
  readonly minute: number
}

/** O-003 时钟服务的结构对位子集。 */
export interface ClockLike {
  now(): number
  dayKey(epoch?: number): string
  parts(epoch?: number): ClockPartsLike
}

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly advancedOnly?: boolean
  readonly secret?: boolean
  readonly doc?: string
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 的解析结果形状。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 配置真源的结构对位（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
