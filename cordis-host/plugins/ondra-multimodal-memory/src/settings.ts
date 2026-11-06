/**
 * O-128 配置的**单一真源**（默认值只在这里出现一次）。
 *
 * ## 十八个值里只有三个有手册出处
 *
 * | 值 | 出处 |
 * |---|---|
 * | `maxTextChars: 200` | 手册 §2.2 逐字：「条目 ≤200 字」 |
 * | `videoFrames: 4` | 手册 §1.5 逐字：「视频→4 帧+音轨」（语料 2.3 同一句） |
 * | `respectTombstone: true` | 手册 §2.4「合并时不许复活」+ O-140 的墓碑闸 |
 *
 * 其余十五个都是工程取值。**不要把它们写成「手册规定」**——
 * 写成规定，下一个人就不敢改了，而其中至少一半（`defaultSubject`、
 * `maxFullChars`）本来就该按场景调。
 *
 * ## 为什么 `maxTextChars` 默认 200 而不是「够长就好」
 *
 * 一段三分钟的语音转写有上千字。把上千字塞进记忆条目，后果不是「记得更全」，
 * 而是三条连锁：
 *
 * 1. **注入预算被一条吃光**。手册 §2.6 默认预算 2600 字符，
 *    一条 1200 字的转写就占掉一半，本轮别的记忆全被挤掉；
 * 2. **检索失真**。条目越长，关键词权重越平均，命中一条就命中了一大片；
 * 3. **寿命公式失真**。显著度按写入打分表算，长文本会多拿「≥40 字 +6」，
 *    那本来是奖励「说得具体」，不是奖励「说得长」。
 *
 * 所以条目短、全文留在边表（`maxFullChars`）。这与手册 §2.6
 * 「首轮一次大块 + 正文留盘按需展开」是同一条手法。
 *
 * ## 为什么 `defaultChannel` 是 `fact`（4 天）而不是 O-010 的默认 `gist`（12 天）
 *
 * 三通道是**视图层调制**：`fact` 4 天 / `gist` 12 天 / `affect` 180 天。
 * 一张截图、一段语音，绝大多数是「这一刻的现场」——用户三周后不会再问
 * 「我上周发你的那个报错截图」。给 12 天会让一堆一次性现场挤占注入预算，
 * 而真正该长留的是从里面提炼出的事实（那是 O-011 的活，不是本包的）。
 *
 * 想长留的调用方显式传 `options.channel = 'gist'` 即可。
 *
 * ## 为什么 `useEvidenceGate` 默认开
 *
 * 手册 §2.2：「无出处不入库」。视觉描述是**模型说的**，不是用户说的；
 * 不给它过一道门，就等于把模型的猜测当事实记下来——那正是
 * 「自我强化幻觉污染整库」的入口。门控缺席时本包仍然入库（记 `degraded`），
 * 因为「门控没装」和「这条没出处」是两件事，不能混。
 *
 * ## 为什么 `quiet` 默认 false
 *
 * 与 O-127 相反。语音转不出来是用户当场就知道的事（她没听见回复），
 * 再打一条日志只是噪音；而「这张图没记住」用户**当场不会知道**——
 * 她三天后问「我上次发的那个截图」才发现。所以入库失败必须留痕。
 */

import type {
  FieldSpecLike,
  MemoryCategoryLike,
  MemoryChannelLike,
  MemoryKindLike,
  SectionDeclLike,
} from './types.js'
import {
  MEMORY_CATEGORIES_LIKE,
  MEMORY_CHANNELS_LIKE,
  MEMORY_KINDS_LIKE,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 调用方没说主体时用哪个（`user` / `self` / 人名）。 */
  readonly defaultSubject: string
  /** 调用方没说通道时用哪个。 */
  readonly defaultChannel: MemoryChannelLike
  /** 图片条目的五类标签。 */
  readonly imageKind: MemoryKindLike
  /** 图片条目的寿命类别。 */
  readonly imageCategory: MemoryCategoryLike
  /** 语音条目的五类标签。 */
  readonly audioKind: MemoryKindLike
  /** 语音条目的寿命类别。 */
  readonly audioCategory: MemoryCategoryLike
  /** 视频条目的五类标签。 */
  readonly videoKind: MemoryKindLike
  /** 视频条目的寿命类别。 */
  readonly videoCategory: MemoryCategoryLike
  /** 进检索的条目上限（字）。手册 §2.2「条目 ≤200 字」。 */
  readonly maxTextChars: number
  /** 标题上限（字）。手册 §2.2「summary ≤80 字」，标题比它更短。 */
  readonly maxTitleChars: number
  /** 边表留档的全文上限（字）。 */
  readonly maxFullChars: number
  /** 是否按指纹去重。 */
  readonly dedupe: boolean
  /** 是否尊重墓碑（用户要求忘记过的内容不再入库）。 */
  readonly respectTombstone: boolean
  /** 是否过 O-140 证据门控。 */
  readonly useEvidenceGate: boolean
  /** 视频抽几帧（手册写的是 4）。 */
  readonly videoFrames: number
  /** 视频帧要不要逐帧问 O-126 要描述（关掉只存帧路径）。 */
  readonly videoDescribeFrames: boolean
  /** 失败不打 warn。默认 false：入库失败用户当场不会知道。 */
  readonly quiet: boolean
  /** 成功时也打一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'multimodal-memory'

/** 条目字数的下限（20）。低于它连「一句话标题」都放不下。 */
export const TEXT_MIN = 20

/**
 * 条目字数的上限（4000）。
 *
 * 与 O-010 `maxTextChars` 的上限**取同一个数**：本包设得比它大，超出的部分
 * 会被 O-010 再截一次并记 issue——用户看到的是「记忆短了」，而日志里写着
 * 「本包没截」。两个上限必须对齐，否则「谁截的」永远查不清。
 */
export const TEXT_MAX = 4000

/** 标题下限。 */
export const TITLE_MIN = 8

/** 标题上限（120）。再长就不该叫标题了。 */
export const TITLE_MAX = 120

/**
 * 摘要上限（80 字，手册 §2.2「summary ≤80 字」）。
 *
 * 它**不是**从标题上限乘出来的：两个数各有出处，乘一下会把「手册规定 80」
 * 悄悄变成「40×2」，以后改标题上限就会顺手改掉摘要上限。
 */
export const SUMMARY_MAX = 80

/** 全文字数下限。一段正常语音就有几百字，低于 1000 的留档没有意义。 */
export const FULL_MIN = 1000

/** 全文字数上限（50 万字，约 8 小时的转写）。再大说明这不是一条记忆，是一份档案。 */
export const FULL_MAX = 500000

/** 抽帧数下限。 */
export const FRAMES_MIN = 1

/** 抽帧数上限（12）。手册写 4；放宽到 12 是给「长视频要更多画面」留余地。 */
export const FRAMES_MAX = 12

/** 主体字符上限。 */
export const SUBJECT_MAX = 64

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后服务照常注册，ingest() 一律 disabled。',
  },
  defaultSubject: {
    kind: 'string',
    default: 'user',
    doc: '调用方没说主体时用哪个。默认 user：图与语音都是用户发来的。群聊里应显式传 speaker。',
  },
  defaultChannel: {
    kind: 'enum',
    default: 'fact',
    values: MEMORY_CHANNELS_LIKE,
    advancedOnly: true,
    doc: '默认通道（fact 4 天 / gist 12 天 / affect 180 天）。多模态多是「一次性现场」，故取最短档。',
  },
  imageKind: {
    kind: 'enum',
    default: 'episode',
    values: MEMORY_KINDS_LIKE,
    advancedOnly: true,
    doc: '图片条目的五类标签。默认 episode：一张图记的是一件事，不是一条抽象事实。',
  },
  imageCategory: {
    kind: 'enum',
    default: 'event',
    values: MEMORY_CATEGORIES_LIKE,
    advancedOnly: true,
    doc: '图片条目的寿命类别。默认 event（40 小时基线）。',
  },
  audioKind: {
    kind: 'enum',
    default: 'episode',
    values: MEMORY_KINDS_LIKE,
    advancedOnly: true,
    doc: '语音条目的五类标签。默认 episode：一段语音是「她说了一件事」。',
  },
  audioCategory: {
    kind: 'enum',
    default: 'daily',
    values: MEMORY_CATEGORIES_LIKE,
    advancedOnly: true,
    doc: '语音条目的寿命类别。默认 daily（3 小时基线）：日常一句，本该很快淡。',
  },
  videoKind: {
    kind: 'enum',
    default: 'episode',
    values: MEMORY_KINDS_LIKE,
    advancedOnly: true,
    doc: '视频条目的五类标签。',
  },
  videoCategory: {
    kind: 'enum',
    default: 'event',
    values: MEMORY_CATEGORIES_LIKE,
    advancedOnly: true,
    doc: '视频条目的寿命类别。默认 event。',
  },
  maxTextChars: {
    kind: 'number',
    default: 200,
    min: TEXT_MIN,
    max: TEXT_MAX,
    doc: `进检索的条目上限（字）。手册 §2.2「条目 ≤200 字」；超出的部分留在边表的全文列。`,
  },
  maxTitleChars: {
    kind: 'number',
    default: 40,
    min: TITLE_MIN,
    max: TITLE_MAX,
    advancedOnly: true,
    doc: '标题上限（字）。',
  },
  maxFullChars: {
    kind: 'number',
    default: 200000,
    min: FULL_MIN,
    max: FULL_MAX,
    advancedOnly: true,
    doc: '边表留档的全文上限（字）。超长转写在这里截断，并记一条降级说明。',
  },
  dedupe: {
    kind: 'boolean',
    default: true,
    doc: '按内容指纹去重。关掉后同一张图描述两次会变成两条记忆。',
  },
  respectTombstone: {
    kind: 'boolean',
    default: true,
    doc: '尊重墓碑：用户要求忘记过的内容，同一份文件再来也不入库。',
  },
  useEvidenceGate: {
    kind: 'boolean',
    default: true,
    doc: '过 O-140 证据门控（手册 §2.2「无出处不入库」）。门控缺席时仍入库，但记降级。',
  },
  videoFrames: {
    kind: 'number',
    default: 4,
    min: FRAMES_MIN,
    max: FRAMES_MAX,
    doc: '视频抽几帧。手册写的是 4。',
  },
  videoDescribeFrames: {
    kind: 'boolean',
    default: true,
    doc: '逐帧问 O-126 要描述。关掉只存帧路径（省 4 次模型调用，但视频条目只剩「有 4 张画面」）。',
  },
  quiet: {
    kind: 'boolean',
    default: false,
    doc: '失败不打 warn。默认 false——入库失败用户当场不会知道，必须留痕。',
  },
  verbose: {
    kind: 'boolean',
    default: true,
    doc: '成功时也打一行日志。',
  },
})

/** 出厂配置（由 `FIELD_SPECS` 派生，**不手写第二份**）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  defaultSubject: FIELD_SPECS.defaultSubject.default as string,
  defaultChannel: FIELD_SPECS.defaultChannel.default as MemoryChannelLike,
  imageKind: FIELD_SPECS.imageKind.default as MemoryKindLike,
  imageCategory: FIELD_SPECS.imageCategory.default as MemoryCategoryLike,
  audioKind: FIELD_SPECS.audioKind.default as MemoryKindLike,
  audioCategory: FIELD_SPECS.audioCategory.default as MemoryCategoryLike,
  videoKind: FIELD_SPECS.videoKind.default as MemoryKindLike,
  videoCategory: FIELD_SPECS.videoCategory.default as MemoryCategoryLike,
  maxTextChars: FIELD_SPECS.maxTextChars.default as number,
  maxTitleChars: FIELD_SPECS.maxTitleChars.default as number,
  maxFullChars: FIELD_SPECS.maxFullChars.default as number,
  dedupe: FIELD_SPECS.dedupe.default as boolean,
  respectTombstone: FIELD_SPECS.respectTombstone.default as boolean,
  useEvidenceGate: FIELD_SPECS.useEvidenceGate.default as boolean,
  videoFrames: FIELD_SPECS.videoFrames.default as number,
  videoDescribeFrames: FIELD_SPECS.videoDescribeFrames.default as boolean,
  quiet: FIELD_SPECS.quiet.default as boolean,
  verbose: FIELD_SPECS.verbose.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab）的**唯一映射**。
 * 必须**双向唯一**，否则两个字段会抢同一个段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  defaultSubject: 'default-subject',
  defaultChannel: 'default-channel',
  imageKind: 'image-kind',
  imageCategory: 'image-category',
  audioKind: 'audio-kind',
  audioCategory: 'audio-category',
  videoKind: 'video-kind',
  videoCategory: 'video-category',
  maxTextChars: 'max-text-chars',
  maxTitleChars: 'max-title-chars',
  maxFullChars: 'max-full-chars',
  dedupe: 'dedupe',
  respectTombstone: 'respect-tombstone',
  useEvidenceGate: 'use-evidence-gate',
  videoFrames: 'video-frames',
  videoDescribeFrames: 'video-describe-frames',
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
  title: '多模态记忆',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-multimodal-memory',
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

/** 是不是五类标签之一。 */
export function isMemoryKind(value: unknown): value is MemoryKindLike {
  return typeof value === 'string' && (MEMORY_KINDS_LIKE as readonly string[]).includes(value)
}

/** 是不是 11 类寿命类别之一。 */
export function isMemoryCategory(value: unknown): value is MemoryCategoryLike {
  return typeof value === 'string' && (MEMORY_CATEGORIES_LIKE as readonly string[]).includes(value)
}

/** 是不是三通道之一。 */
export function isMemoryChannel(value: unknown): value is MemoryChannelLike {
  return typeof value === 'string' && (MEMORY_CHANNELS_LIKE as readonly string[]).includes(value)
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 *
 * 唯一不在这里「修」的是 `defaultSubject`：它可以是任意人名，
 * 没有可校验的形状。空串会被回退成默认值——空主体的记忆无法回答「这是谁的事」。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  const subject = textOf(raw['defaultSubject'], DEFAULT_CONFIG.defaultSubject, SUBJECT_MAX)

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    defaultSubject: subject === '' ? DEFAULT_CONFIG.defaultSubject : subject,
    defaultChannel: isMemoryChannel(raw['defaultChannel'])
      ? raw['defaultChannel']
      : DEFAULT_CONFIG.defaultChannel,
    imageKind: isMemoryKind(raw['imageKind']) ? raw['imageKind'] : DEFAULT_CONFIG.imageKind,
    imageCategory: isMemoryCategory(raw['imageCategory'])
      ? raw['imageCategory']
      : DEFAULT_CONFIG.imageCategory,
    audioKind: isMemoryKind(raw['audioKind']) ? raw['audioKind'] : DEFAULT_CONFIG.audioKind,
    audioCategory: isMemoryCategory(raw['audioCategory'])
      ? raw['audioCategory']
      : DEFAULT_CONFIG.audioCategory,
    videoKind: isMemoryKind(raw['videoKind']) ? raw['videoKind'] : DEFAULT_CONFIG.videoKind,
    videoCategory: isMemoryCategory(raw['videoCategory'])
      ? raw['videoCategory']
      : DEFAULT_CONFIG.videoCategory,
    maxTextChars: clampInt(raw['maxTextChars'], DEFAULT_CONFIG.maxTextChars, TEXT_MIN, TEXT_MAX),
    maxTitleChars: clampInt(raw['maxTitleChars'], DEFAULT_CONFIG.maxTitleChars, TITLE_MIN, TITLE_MAX),
    maxFullChars: clampInt(raw['maxFullChars'], DEFAULT_CONFIG.maxFullChars, FULL_MIN, FULL_MAX),
    dedupe: bool('dedupe', DEFAULT_CONFIG.dedupe),
    respectTombstone: bool('respectTombstone', DEFAULT_CONFIG.respectTombstone),
    useEvidenceGate: bool('useEvidenceGate', DEFAULT_CONFIG.useEvidenceGate),
    videoFrames: clampInt(raw['videoFrames'], DEFAULT_CONFIG.videoFrames, FRAMES_MIN, FRAMES_MAX),
    videoDescribeFrames: bool('videoDescribeFrames', DEFAULT_CONFIG.videoDescribeFrames),
    quiet: bool('quiet', DEFAULT_CONFIG.quiet),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过。
 *
 * 只在「用户给了一个数但被夹紧/丢弃」时报告。没给（`undefined`）不算漂移——
 * 那是正常取默认值。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  if (!isRecord(value)) return []
  const done = completeConfig(value)
  const drift: string[] = []

  const enums: readonly (readonly [keyof Config, readonly string[]])[] = [
    ['defaultChannel', MEMORY_CHANNELS_LIKE],
    ['imageKind', MEMORY_KINDS_LIKE],
    ['imageCategory', MEMORY_CATEGORIES_LIKE],
    ['audioKind', MEMORY_KINDS_LIKE],
    ['audioCategory', MEMORY_CATEGORIES_LIKE],
    ['videoKind', MEMORY_KINDS_LIKE],
    ['videoCategory', MEMORY_CATEGORIES_LIKE],
  ]
  for (const [key, values] of enums) {
    const raw = value[key]
    if (raw !== undefined && !(typeof raw === 'string' && values.includes(raw))) {
      drift.push(`${String(key)} 不是 ${values.join(' / ')} 之一，已回退 ${String(done[key])}`)
    }
  }

  const numbers: readonly (readonly [keyof Config, number, number, number])[] = [
    ['maxTextChars', TEXT_MIN, TEXT_MAX, done.maxTextChars],
    ['maxTitleChars', TITLE_MIN, TITLE_MAX, done.maxTitleChars],
    ['maxFullChars', FULL_MIN, FULL_MAX, done.maxFullChars],
    ['videoFrames', FRAMES_MIN, FRAMES_MAX, done.videoFrames],
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
