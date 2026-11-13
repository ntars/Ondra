/**
 * O-128 `ondra-multimodal-memory` 的对外契约（手册 §1.5 / 语料·第一编 2.3，P1）。
 *
 * ## 手册给的原话，一共两句
 *
 * ```
 * | O-128 | `ondra-multimodal-memory` | 视觉描述/转写文本入库，带 `modality` 与 `source_path` |
 * 关键参数：图片→描述；语音→转写；视频→4 帧+音轨
 * ```
 *
 * 两句拆开是四件事，本文件逐件落：
 *
 * 1. **入库** —— 写进 O-010 的记忆库（`addFact()`），不另建一套记忆表；
 * 2. **带 `modality` 与 `source_path`** —— 这两列 `memory_fact` 里**没有**，
 *    见下面「为什么必须有一张边表」；
 * 3. **三种来源** —— 图片/语音/视频，各自的正文从哪来（O-126 / O-127）；
 * 4. **视频 = 4 帧 + 音轨** —— 拼接责任在**本包**（台账第 15 组下轮起点第 4 条），
 *    所以本包有一份 `video.ts`，但**不重新抽帧、不重新转写**，只调两包的服务。
 *
 * ## 为什么必须有一张边表（`memory_multimodal`）
 *
 * 手册要求「入库时带 `modality` 与 `source_path`」。而 O-010 的 `FactInput` 与
 * `MemoryRecord` 里**没有** `meta`，`memory_fact` 表里也**没有**这两列
 * （见 `ondra-memory-core/src/schema.ts` 的 `FACT_TABLE`，22 列逐个核对过）。
 *
 * 三条路，只有第三条不违反纪律：
 *
 * | 做法 | 为什么不行 |
 * |---|---|
 * | 去改 O-010 加一列 | O-010 已 `done`，§16.3 明令禁止改已完成的插件；而且改表结构要迁移，那是 O-008 的地盘 |
 * | 把 `modality` 拼进正文 | 正文是**给检索与注入用的**，掺进元数据会让关键词检索命中一堆 `[image]`；且用户会看见 |
 * | 本包自建一张**边表**，按 `fact_id` 指向那条记忆 | ✅ 记忆正文仍只有一份（在 O-010），边表只存「这条记忆是从哪种文件来的」 |
 *
 * 所以边表**不是第二份记忆库**：它没有正文的权威副本（`full_text` 是留档，
 * 见下），删掉边表不影响任何一条记忆的可用性，只是「这条记忆来自哪张图」查不到了。
 *
 * ## `full_text` 为什么存在
 *
 * 手册 §2.2：「条目 ≤200 字」。而一段三分钟的语音转写有上千字。
 *
 * 若把转写原样交给 O-010，它会在 200 字处截断并记一条 issue——**这是对的**，
 * 因为「条目」就该短。但截掉的那 800 字去哪了？如果没地方去，用户说的后半段
 * 就真的没了，而语音文件本身也不是谁都能再听一遍。
 *
 * 所以：**进检索的是截断后的条目，全文留在边表的 `full_text` 里**。
 * 这正是手册 §2.6「首轮一次大块 + 正文留盘按需展开」的同一手法，
 * 只是这里的「盘」是边表的一列，不是另一个文件。
 *
 * ## 本包不发工具，只发服务
 *
 * 与 O-126 / O-127 同一条推理：手册给的是三个名词（图片/语音/视频），
 * 不是三个函数签名。凭空定一套参数，就是让模型照一份编出来的说明书调用。
 * 真正的调用方是代码：通道适配器收到一张图 → 问 O-126 要描述 → 交给本包入库。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。全仓唯一归属。 */
export const MM_SERVICE_KEY = 'ondra-multimodal-memory'

/** 服务键 / 工具名 / 配置键的硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 边表名。
 *
 * 前缀 `memory_` 是**故意的**：它跟 O-010 的 `memory_raw` / `memory_fact` /
 * `memory_tombstone` 排在一起，一眼能看出是记忆域的旁挂表；谁要清库时不会漏掉它。
 */
export const MM_TABLE = 'memory_multimodal'

/** 多模态种类。手册：图片→描述；语音→转写；视频→4 帧 + 音轨。 */
export type Modality = 'image' | 'audio' | 'video'

/** 全部种类（枚举闭合自检用：本表与联合类型必须逐项对应）。 */
export const MODALITIES: readonly Modality[] = Object.freeze(['image', 'audio', 'video'])

/**
 * 一段带时间戳的文本（**镜像** O-126 / O-127 的同名结构）。
 *
 * 时间单位是毫秒整数。这条不是本包定的，是 O-126 定的；本包只按字段名读。
 */
export interface TranscriptSpan {
  /** 起点，毫秒。 */
  readonly startMs: number
  /** 终点，毫秒。 */
  readonly endMs: number
  /** 这段的字。 */
  readonly text: string
  /** 说话人标签；上游不给就缺省（**不编 `speaker-1`**）。 */
  readonly speaker?: string
}

/** 一个检测框（**镜像** O-126）。坐标归一化 0–1，原点左上。 */
export interface DetectionBox {
  /** 模型给的标签。 */
  readonly label: string
  /** 左上角 x，0–1。 */
  readonly x: number
  /** 左上角 y，0–1。 */
  readonly y: number
  /** 宽，0–1。 */
  readonly w: number
  /** 高，0–1。 */
  readonly h: number
  /** 置信度（0–1），上游给了才带。 */
  readonly confidence?: number
}

/**
 * 入库草稿 —— **契约镜像**，真源在 `cordis/ondra-vision/src/types.ts`。
 *
 * §15.5 禁止同轮两个插件互相 import（任一单独卸载都不该让另一个编译失败），
 * 而 §15.3 又要求共享结构由先做方定义。两条同时成立的唯一解就是「镜像」：
 * 字段名、类型、语义逐字一致，实现各自独立。
 *
 * **维护纪律**：O-126 改一个字段，这里必须跟着改。漏改不会崩——本包读不到就
 * 当字段缺省处理——但会静默少存一份元数据，所以这条写在这里。
 *
 * 刻意**不含** `importance` / `kind` / `pool`：那是记忆域自己的判断
 * （O-010 / O-131），视觉与语音插件没有资格替记忆域定「这条重不重要」。
 */
export interface MultimodalDraft {
  /** 种类。 */
  readonly modality: Modality
  /** 原始文件路径（原样带过去，本包只读、不搬、不删）。 */
  readonly sourcePath: string
  /** 正文：图片是描述，语音是转写。**这一条是入库的主体**。 */
  readonly text: string
  /** 一句话标题（≤40 字）。 */
  readonly title: string
  /** 产出时刻。 */
  readonly at: number
  /** 谁产出的（provider id 或本地二进制名）。 */
  readonly provider: string
  /** 用的哪个模型；没有模型名就缺省。 */
  readonly model?: string
  /** 正文字数（码位，不是字节）。 */
  readonly chars: number
  /** 正文有没有被上游的 `max-output-chars` 截断。 */
  readonly truncated: boolean
  /**
   * 内容指纹：`fnv1a64(modality + '\0' + sourcePath + '\0' + text)` 的 16 位十六进制。
   *
   * 本包**会重算一遍**并与它比对（见 `draft.ts`），因为去重是「同内容只记一次」，
   * 而「同内容」必须由内容本身判定，不能由上游声称。
   */
  readonly fingerprint: string
  /** 时间戳（语音/视频才有）。 */
  readonly spans?: readonly TranscriptSpan[]
  /** 检测框（定位才有）。 */
  readonly boxes?: readonly DetectionBox[]
  /** 抽出来的帧（视频才有），绝对路径。 */
  readonly frames?: readonly string[]
  /** 降级说明：有值就表示「这条能用，但比正常路径少点什么」。 */
  readonly degraded?: string
}

/**
 * 结果码。**一个码只对应一种处境**（同一纪律见 O-076 的 `DeclareCode`）。
 *
 * 三个码刻意分开，因为修法完全不同：
 * - `no-core`：没装记忆内核 → 装 O-010；
 * - `empty-text`：上游给了空正文 → 看 O-126 / O-127 为什么没读出东西；
 * - `rejected`：证据门控拒了 → 看 `detail` 里的原因码，是正文在替谁说话。
 *
 * 合成一个 `failed`，用户只能猜。
 */
export type MmReason =
  /** 入库成功。 */
  | 'ok'
  /** 配置里关着。 */
  | 'disabled'
  /** 服务已经卸载（调用方还握着旧引用）。 */
  | 'disposed'
  /** 没有记忆内核（O-010 缺席或不可用）。**本包不自己存记忆**。 */
  | 'no-core'
  /** 草稿不是对象。 */
  | 'no-draft'
  /** `modality` 不是 image / audio / video 之一。 */
  | 'bad-modality'
  /** 正文是空的（**绝不用占位文案顶上**）。 */
  | 'empty-text'
  /** 同一个指纹已经入过库（去重命中）。 */
  | 'duplicate'
  /** 这段内容被用户要求忘记过（墓碑命中），不许复活。 */
  | 'tombstoned'
  /** O-140 判了 `reject`。 */
  | 'rejected'
  /** O-140 判了 `seed`：本包没有种子文件落点，只能不入库。 */
  | 'seeded'
  /** 写记忆时抛了错（库锁、磁盘满等）。 */
  | 'write-failed'
  /** 视频合成：没有 O-126，抽不了帧。 */
  | 'no-vision'
  /** 视频合成：抽帧失败或一帧都没抽出来。 */
  | 'no-frames'
  /** 视频合成：给了音轨但 O-127 不在位。 */
  | 'no-asr'
  /** 视频合成：音轨转写失败。 */
  | 'no-audio'
  /** 文件路径为空或不是字符串。 */
  | 'bad-path'

/** 全部结果码（枚举闭合自检用：本表与联合类型必须逐项对应）。 */
export const MM_REASONS: readonly MmReason[] = Object.freeze([
  'ok',
  'disabled',
  'disposed',
  'no-core',
  'no-draft',
  'bad-modality',
  'empty-text',
  'duplicate',
  'tombstoned',
  'rejected',
  'seeded',
  'write-failed',
  'no-vision',
  'no-frames',
  'no-asr',
  'no-audio',
  'bad-path',
])

/** 记忆种类（**镜像** O-010 的 `MemoryKind`）。 */
export type MemoryKindLike = 'episode' | 'fact' | 'reflection' | 'skill' | 'lesson'

/** 记忆种类全集（镜像）。 */
export const MEMORY_KINDS_LIKE: readonly MemoryKindLike[] = Object.freeze([
  'episode',
  'fact',
  'reflection',
  'skill',
  'lesson',
])

/** 11 个寿命类别（**镜像** O-010 的 `MemoryCategory`）。 */
export type MemoryCategoryLike =
  | 'watch'
  | 'daily'
  | 'food'
  | 'place'
  | 'misc'
  | 'event'
  | 'feeling'
  | 'study'
  | 'person'
  | 'promise'
  | 'self'

/** 11 个类别全集（镜像，顺序与 O-010 一致：从最快忘到最难忘）。 */
export const MEMORY_CATEGORIES_LIKE: readonly MemoryCategoryLike[] = Object.freeze([
  'watch',
  'daily',
  'food',
  'place',
  'misc',
  'event',
  'feeling',
  'study',
  'person',
  'promise',
  'self',
])

/** 三通道视图（**镜像** O-010 的 `MemoryChannel`）。 */
export type MemoryChannelLike = 'fact' | 'gist' | 'affect'

/** 三通道全集（镜像）。 */
export const MEMORY_CHANNELS_LIKE: readonly MemoryChannelLike[] = Object.freeze([
  'fact',
  'gist',
  'affect',
])

/**
 * 入库选项：**记忆域的判断**，由调用方给。
 *
 * 为什么不放进 `MultimodalDraft`：草稿是「视觉/语音插件的产出」，
 * 而「这条重不重要、算哪一类」是记忆域的判断。让视觉插件决定 kind，
 * 等于让它替记忆域拍板——手册 §2.2 的「归属纪律」同一条道理。
 */
export interface IngestOptions {
  /** 五类标签；省略按 `modality` 取配置默认。 */
  readonly kind?: MemoryKindLike | string
  /** 11 类寿命类别；省略按 `modality` 取配置默认。 */
  readonly category?: MemoryCategoryLike | string
  /** 主体（谁的事）；省略取 `defaultSubject`。 */
  readonly subject?: string
  /** 通道；省略取 `defaultChannel`。 */
  readonly channel?: MemoryChannelLike | string
  /** 摘要；省略用草稿标题。 */
  readonly summary?: string
  /** 显著度 0–100；省略交给 O-010 的写入打分表算（本包不抢这个活）。 */
  readonly salience?: number
  /** 唤醒度 0–1；省略交给 O-010 的默认。 */
  readonly arousal?: number
  /** 写入时刻；省略取草稿的 `at`。 */
  readonly at?: number
}

/** 一次入库的结果。**永不抛错**。 */
export interface IngestResult {
  /** 成功没有（`duplicate` 也算成功：内容已经在库里了）。 */
  readonly ok: boolean
  /** 结果码。 */
  readonly reason: MmReason
  /** 记忆 id；失败或去重未命中时缺省。 */
  readonly factId?: string
  /** 内容指纹（重算后的）。 */
  readonly fingerprint: string
  /** 进检索的正文长度（截断后）。 */
  readonly chars: number
  /** 条目有没有被截断（上游截断或本包按 `max-text-chars` 截断都算）。 */
  readonly truncated: boolean
  /** 边表写成功没有。false = 内容进去了，但「来自哪张图」查不到。 */
  readonly indexed: boolean
  /** `reason='duplicate'` 时指向已有那条记忆的 id。 */
  readonly duplicateOf?: string
  /** 降级说明（少点什么，但这条能用）。 */
  readonly degraded?: string
  /** 一句补充说明（门控原因码、写入异常等）。 */
  readonly detail?: string
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
}

/** 边表里的一行（读出来的视图）。 */
export interface MmEntry {
  /** 指向的记忆 id（O-010 的 `memory_fact.id`）。 */
  readonly factId: string
  /** 种类。 */
  readonly modality: Modality
  /** 原始文件路径。 */
  readonly sourcePath: string
  /** 内容指纹。 */
  readonly fingerprint: string
  /** 标题。 */
  readonly title: string
  /** 产出方。 */
  readonly provider: string
  /** 模型名；没有就是 `null`。 */
  readonly model: string | null
  /** 进检索的正文长度。 */
  readonly chars: number
  /** 全文长度（边表里 `full_text` 的字数）。 */
  readonly fullChars: number
  /** 条目有没有被截断。 */
  readonly truncated: boolean
  /** 帧路径（视频才有，按时间顺序）。 */
  readonly frames: readonly string[]
  /** 时间戳（语音/视频才有）。 */
  readonly spans: readonly TranscriptSpan[]
  /** 检测框。 */
  readonly boxes: readonly DetectionBox[]
  /** 降级说明；没有就是 `null`。 */
  readonly degraded: string | null
  /** 草稿的产出时刻。 */
  readonly at: number
  /** 写入时刻。 */
  readonly createdAt: number
}

/** 边表查询条件。 */
export interface MmQuery {
  /** 只看某种来源。 */
  readonly modality?: Modality
  /** 只看某个文件。 */
  readonly sourcePath?: string
  /** 条数上限（默认 50，硬上限 500）。 */
  readonly limit?: number
  /** 排序方向（按写入时刻，默认从新到旧）。 */
  readonly order?: 'asc' | 'desc'
}

/** 视频入库的入参。 */
export interface VideoIngestInput {
  /** 视频文件绝对路径。 */
  readonly path: string
  /**
   * 已分离好的音轨路径（可选）。
   *
   * **为什么必须由调用方给**：O-127 只收音频文件，它不做「从视频里抽音轨」；
   * O-126 的 ffmpeg 只用来抽帧。本包若自己再起一次 ffmpeg，就等于在第三个地方
   * 重写同一套解码调用——§1.8「能复用却自研 = 违规」。
   * 所以：调用方（通道适配器或未来的媒体预处理）负责分离，本包负责拼。
   */
  readonly audioPath?: string
  /** 抽几帧；省略用配置 `videoFrames`（手册写的是 4）。 */
  readonly frameCount?: number
  /** 入库选项（对两条记忆都生效）。 */
  readonly options?: IngestOptions
}

/** 视频入库的结果。 */
export interface VideoIngestResult {
  /** 至少一条入库成功才算成功。 */
  readonly ok: boolean
  /** 结果码：整批的结论（`ok` / `no-vision` / `no-frames` / `no-audio` / `disabled` …）。 */
  readonly reason: MmReason
  /** 逐条结果（帧条目在前，音轨条目在后）。 */
  readonly entries: readonly IngestResult[]
  /** 一句补充说明。 */
  readonly detail?: string
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
}

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface MmCounters {
  /** 收到的草稿数。 */
  readonly drafts: number
  /** 入库成功数。 */
  readonly ingested: number
  /** 去重命中数。 */
  readonly duplicates: number
  /** 墓碑命中数。 */
  readonly tombstoned: number
  /** 门控拒绝数。 */
  readonly rejected: number
  /** 门控判种子数（本包没有种子落点，等价于不入库）。 */
  readonly seeded: number
  /** 写入失败数。 */
  readonly failed: number
  /** 视频合成次数。 */
  readonly videoRuns: number
}

/** 统计快照，供 `ondra-startup-check` 与应用外壳读取。 */
export interface MmStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: MmReason
  /** 边表可写不可写。 */
  readonly indexed: boolean
  /** 边表行数（不可写时为 0）。 */
  readonly rows: number
  /** 记忆内核的后端标识（`sqlite` / `memory`）。 */
  readonly coreProvider: string
  /** 本包用的存储后端标识；边表不可写时是空串。 */
  readonly storeProvider: string
  /** 累计计数。 */
  readonly counters: MmCounters
  /** 按原因码分类的计数（**只统计出现过的**，不预置 17 个 0）。 */
  readonly byReason: Readonly<Record<string, number>>
  /** 最后一次成功时刻，0 表示从未成功。 */
  readonly lastOkAt: number
  /** 最后一次失败的原因码。 */
  readonly lastError?: MmReason
}

/** 多模态记忆服务。 */
export interface MultimodalMemoryService {
  /** 服务能不能工作：开关 + 记忆内核。 */
  readonly available: boolean
  /** 不能工作的原因（`available=true` 时缺省）。 */
  readonly reason?: MmReason

  /** 把一份草稿入库。 */
  ingest(draft: MultimodalDraft, options?: IngestOptions): IngestResult
  /** 批量入库（**不做批内判重**，逐条走同一条流水线）。 */
  ingestMany(
    drafts: readonly MultimodalDraft[],
    options?: IngestOptions,
  ): readonly IngestResult[]
  /** 视频 → 4 帧（描述）+ 音轨（转写）→ 入库。 */
  ingestVideo(input: VideoIngestInput): Promise<VideoIngestResult>
  /** 按记忆 id 取边表行（**不含全文**，列表用，轻）。 */
  get(factId: string): MmEntry | undefined
  /**
   * 按记忆 id 取留档的全文。
   *
   * 手册 §2.6「首轮一次大块 + 正文留盘按需展开」的「展开」在这里：
   * `list()` 只回元数据，真要读那段三分钟语音说了什么，才调这个方法。
   * 一次只读一行，**不做批量**——批量取全文等于把整库搬进内存。
   */
  fullText(factId: string): string | undefined
  /** 查边表。 */
  list(query?: MmQuery): readonly MmEntry[]
  /** 按指纹查（去重与「这条记过没有」用）。 */
  seen(fingerprint: string): MmEntry | undefined
  /** 统计快照。 */
  stats(): MmStats
  /** 卸载（幂等；本包没有定时器与子进程，只清内存计数）。 */
  dispose(): void
}

// ---------------------------------------------------------------------------
// 下面全是**依赖的结构对位子集**：只镜像本包真正调用的成员。
// 一个字段都不多写——多写就等于声称自己会调用它，而下一个人会照着去实现。
// ---------------------------------------------------------------------------

/** 一条引文（镜像 O-010 的 `EvidenceRef`）。 */
export interface EvidenceRefLike {
  /** 来源标记：`USER` / `TOOL` / `ACT` / `SELF`。 */
  readonly source: string
  /** 逐字引文。 */
  readonly quote: string
  /** 引文来自第几条素材。 */
  readonly messageIndex?: number
}

/** 写入一条事实的入参（镜像 O-010 的 `FactInput`，只取本包用到的字段）。 */
export interface FactInputLike {
  readonly id?: string
  readonly kind: string
  readonly category: string
  readonly text: string
  readonly summary?: string
  readonly subject?: string
  readonly channel?: string
  readonly salience?: number
  readonly arousal?: number
  readonly evidence?: readonly EvidenceRefLike[]
  readonly at?: number
}

/** 一条记忆的读出视图（镜像 O-010 的 `MemoryRecord`，只取三个字段）。 */
export interface MemoryRecordLike {
  readonly id: string
  readonly text: string
  readonly createdAt: number
}

/** 记忆内核（镜像 O-010 的 `MemoryCoreService`，只取三个成员）。 */
export interface MemoryCoreLike {
  readonly available: boolean
  addFact(input: FactInputLike): MemoryRecordLike
  tombstoned(text: string): boolean
  stats(): { readonly provider: string }
}

/** 证据门控的裁决（镜像 O-140 的 `GateVerdict`，只取四个字段）。 */
export interface GateVerdictLike {
  readonly action: 'accept' | 'strip' | 'seed' | 'reject'
  readonly text: string
  readonly summary: string
  readonly reasons: readonly { readonly code: string; readonly detail: string }[]
}

/** 证据门控（镜像 O-140 的 `EvidenceGateService`，只取 `judge`）。 */
export interface EvidenceGateLike {
  readonly available: boolean
  judge(request: {
    readonly text: string
    readonly summary?: string
    readonly subject?: string
    readonly evidence?: readonly { readonly source: string; readonly quote: string }[]
    readonly materials?: readonly { readonly text: string; readonly source?: string }[]
    readonly channel?: string
    readonly at?: number
  }): GateVerdictLike
}

/** 视觉服务的文本结果（镜像 O-126 的 `VisionTextResult`，只取五个字段）。 */
export interface VisionTextResultLike {
  readonly ok: boolean
  readonly reason: string
  readonly text: string
  readonly model?: string
  readonly detail?: string
}

/** 视觉服务的抽帧结果（镜像 O-126 的 `FramesResult`）。 */
export interface FramesResultLike {
  readonly ok: boolean
  readonly reason: string
  readonly frames: readonly string[]
  readonly detail?: string
}

/** 视觉服务（镜像 O-126 的 `VisionService`，只取两个动作）。 */
export interface VisionLike {
  readonly available: boolean
  describe(input: { readonly path: string }): Promise<VisionTextResultLike>
  frames(input: { readonly path: string; readonly count?: number }): Promise<FramesResultLike>
}

/** 转写结果（镜像 O-127 的 `TranscribeResult`，只取六个字段）。 */
export interface TranscribeResultLike {
  readonly ok: boolean
  readonly reason: string
  readonly text: string
  readonly spans: readonly TranscriptSpan[]
  readonly model?: string
  readonly detail?: string
}

/** 语音转写（镜像 O-127 的 `AsrService`，只取一个动作）。 */
export interface AsrLike {
  readonly available: boolean
  transcribe(input: { readonly path: string }): Promise<TranscribeResultLike>
}

/** 一行数据。 */
export type RowLike = Record<string, unknown>

/** 过滤算子（镜像 O-006）。 */
export type FilterOpLike = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'is-null' | 'not-null'

/** 过滤条件（镜像 O-006）。 */
export interface FilterLike {
  readonly column: string
  readonly op: FilterOpLike
  readonly value?: unknown
}

/** 查询条件（镜像 O-006）。 */
export interface SelectQueryLike {
  readonly where?: readonly FilterLike[]
  readonly orderBy?: readonly { readonly column: string; readonly direction?: 'asc' | 'desc' }[]
  readonly limit?: number
  readonly offset?: number
}

/** 列声明（镜像 O-006）。 */
export interface ColumnSpecLike {
  readonly name: string
  readonly type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'
  readonly notNull?: boolean
  readonly primaryKey?: boolean
  readonly default?: string
}

/** 索引声明（镜像 O-006）。 */
export interface IndexSpecLike {
  readonly name: string
  readonly columns: readonly string[]
}

/** 表声明（镜像 O-006）。 */
export interface TableSpecLike {
  readonly name: string
  readonly columns: readonly ColumnSpecLike[]
  readonly indexes?: readonly IndexSpecLike[]
  readonly strict?: boolean
}

/** 建表结果（镜像 O-006，只取 `issues`）。 */
export interface EnsureResultLike {
  readonly issues: readonly {
    readonly code: string
    readonly table: string
    readonly column?: string
    readonly detail: string
  }[]
}

/**
 * 存储端口的结构对位子集。
 *
 * 只走表级 CRUD，**不用 `raw`**：一旦写 SQL 就绑死 SQLite，
 * 而 O-007 的内存后端是「SQLite 打不开时的兜底」——边表跟着一起失效比丢元数据更糟。
 */
export interface StoreLike {
  readonly provider: string
  readonly state: string
  ensureTable(spec: TableSpecLike): EnsureResultLike
  insert(table: string, row: RowLike): void
  get(table: string, key: RowLike): RowLike | undefined
  select(table: string, query?: SelectQueryLike): RowLike[]
  count(table: string, where?: readonly FilterLike[]): number
}

/** 日志门面的结构对位子集。 */
export interface LogLike {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/** 时间服务的结构对位子集。 */
export interface ClockLike {
  now(): number
}

/** 字段声明（镜像 O-005）。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
  /** 数字读数的量纲（天 / 分钟 / 毫秒 / 字 / 轮）。空表示无量纲。 */
  readonly unit?: string
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}
