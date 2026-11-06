/**
 * O-054 `ondra-avatar` 的对外契约。
 *
 * 定位：**立绘的接线层**。把「脸上该是什么」解析成「该显示哪张图 / 哪个模型」，
 * 交给渲染方（界面层或外部 Live2D 运行时）。手册 §1.7 已裁决：
 * 「O-054 avatar / O-074 pet —— **不必自研**：airi（50.9k 星）、
 * dsh-whale-girl-live2d、dsh-pet、agentpet」。
 *
 * ## 三条边界，写在这里是因为它们决定了整个形状
 *
 * 1. **不渲染。** 本插件不创建 canvas、不碰 DOM、不开窗口、不装 WebGL。
 *    它只交一份 `AvatarFrame`（态 + 素材 + 动作建议）。
 *    理由是 §12.4：独立前端工程是明令禁止的形态；而渲染必须在浏览器环境里，
 *    插件跑在宿主进程。把渲染塞进来，得到的是一个"看起来像插件的前端项目"。
 *
 * 2. **不判情绪。** 六态真源是 O-031 `ondra-emotion-express`；
 *    「正文 → 六态」是 O-052 `ondra-expression-decide`。
 *    本插件两者都只**读**，一个数都不重算（§18.4 服务键单一归属）。
 *
 * 3. **不造图。** 没有素材就是没有素材，给 `no-asset` 与一张空帧，
 *    绝不内置一套占位立绘。凭空造美术资产会让每台机器上都出现
 *    一套没人审过的图，且它会随包发布（与 O-053 内置贴纸包同一条纪律）。
 *
 * ## 为什么帧里要带 `source`
 *
 * O-052 的标记有 `text / state / default` 三种来源，其中只有 `text`
 * 表示「正文里有依据，可以换脸」。`state` 的语义是**脸上不动**
 * （她可以心里平静、嘴上阴阳）。如果本插件只看 `state` 字段，
 * 就会把「跟内态走」也当成「换脸」，于是每轮都闪一下。
 * 所以 `source` 是一等公民，`motion` 由它算出来。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const AVATAR_SERVICE_KEY = 'ondra-avatar'

/** 名字合规正则：服务键、工具名、配置键共用。**带冒号会被模型侧直接拒绝**。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/* ------------------------------------------------------------------ *
 * 六态（闭合集合，不许增删改名）
 * ------------------------------------------------------------------ */

/**
 * 六态的顺序与 O-031 / O-052 完全一致。
 *
 * **刻意与上游同序、同名**：立绘的表情是按这个名字去找文件的
 * （`calm.png`），任何一处改名，症状都是「某个表情永远显示不出来」，
 * 而日志里一切正常——文件找不到不是错误，只是没有。
 */
export const AVATAR_STATES = ['joyful', 'soft', 'calm', 'wilted', 'bristled', 'sleepy'] as const

/** 一个表情态。 */
export type AvatarState = (typeof AVATAR_STATES)[number]

/** 六态中文名。**只给面板与日志**，不进正文也不进提示词（§4.3 内感受铁律）。 */
export const STATE_ZH: Readonly<Record<AvatarState, string>> = Object.freeze({
  joyful: '雀跃',
  soft: '软和',
  calm: '平静',
  wilted: '蔫',
  bristled: '炸毛',
  sleepy: '困',
})

/**
 * 判一个值是不是六态之一。
 *
 * 用途有两个：验证上游（O-031 / O-052）回的名字，以及验证文件名主干。
 * **不能省**——上游若加了第七态，本插件会拿到一个不认识的字符串，
 * 直接拿去拼文件名会得到「永远 404」的路径，而不是一条可读的报错。
 * @param value 待验的值。
 */
export function isAvatarState(value: unknown): value is AvatarState {
  return typeof value === 'string' && (AVATAR_STATES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ *
 * 素材键（六态 + 两个兜底名）
 * ------------------------------------------------------------------ */

/**
 * 兜底文件名。当前态没有图时按这个顺序找。
 *
 * 为什么要有兜底名而不是直接给空：一个只有 `calm.png` 的素材目录
 * 是**完全合理**的最小配置（用户先放一张试）。没有兜底名的话，
 * 其余五态全是空帧，用户会以为插件坏了。
 */
export const FALLBACK_KEYS = ['neutral', 'default'] as const

/** 兜底键。 */
export type FallbackKey = (typeof FALLBACK_KEYS)[number]

/** 素材键 = 六态 + 兜底名。文件名主干必须是其中之一。 */
export type AssetKey = AvatarState | FallbackKey

/** 全部合法素材键。 */
export const ASSET_KEYS: readonly AssetKey[] = Object.freeze([...AVATAR_STATES, ...FALLBACK_KEYS])

/**
 * 判一个文件名主干是不是合法素材键。
 * @param value 主干（去掉扩展名）。
 */
export function isAssetKey(value: unknown): value is AssetKey {
  return typeof value === 'string' && (ASSET_KEYS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ *
 * 帧与来源
 * ------------------------------------------------------------------ */

/**
 * 这一帧的依据从哪来。
 *
 * - `text`：正文里有线索（O-052 判出来的），**可以换脸**；
 * - `state`：跟当前六态走，语义是「脸上不动」；
 * - `default`：既没有线索也拿不到六态，只能用配置里的默认表情。
 */
export type FrameSource = 'text' | 'state' | 'default'

/** 判一个值是不是合法来源。 */
export function isFrameSource(value: unknown): value is FrameSource {
  return value === 'text' || value === 'state' || value === 'default'
}

/**
 * 此刻能显示什么。
 *
 * `static` = 静态图；`live2d` = 模型 + 已注册渲染器；`none` = 什么都显示不了。
 * 这个字段是**当前能力**，不是配置项——配置写 `live2d` 但没有模型时，
 * 这里会是 `static` 或 `none`，同时 `degraded` 里写明原因。
 */
export type AvatarProvider = 'static' | 'live2d' | 'none'

/** 配置里的偏好（与 `AvatarProvider` 差一个 `auto`）。 */
export type ProviderPref = 'auto' | 'static' | 'live2d'

/** 配置里的偏好取值表。 */
export const PROVIDER_PREFS: readonly ProviderPref[] = Object.freeze(['auto', 'static', 'live2d'])

/**
 * 服务整体不可用的原因。**只在「什么都显示不了」时出现**。
 *
 * 「某个态没图」是降级（`degraded`），不是不可用——服务照常出态。
 */
export type AvatarReason =
  /** 开关关掉。 */
  | 'disabled'
  /** 一张图都没有。 */
  | 'no-asset'
  /** 有模型文件，但没有渲染器。 */
  | 'no-renderer'
  /** 配置钉死了 live2d，但一个模型文件都没有。 */
  | 'no-model'
  /** 素材目录读不了（权限等，不是「不存在」）。 */
  | 'read-error'
  /** 拿不到数据根（O-002 缺席），连素材目录在哪都不知道。 */
  | 'no-path'

/**
 * 不可用原因的中文说明。**只给面板与日志**。
 *
 * 放在契约里而不是 index 里：面板（应用侧设置页 / 状态卡）要显示同一句话，
 * 各写一份就会出现"日志说 A、界面说 B"。
 */
export const REASON_ZH: Readonly<Record<AvatarReason, string>> = Object.freeze({
  disabled: '立绘已关闭',
  'no-asset': '素材目录里没有图（放一张 calm.png 就能显示）',
  'no-renderer': '有模型文件，但没有可用的 Live2D 渲染器',
  'no-model': '配置钉死了模型，但素材目录里没有模型文件',
  'read-error': '素材目录读不了（权限或路径异常）',
  'no-path': '拿不到数据根，不知道素材该放哪',
})

/**
 * 单帧的降级说明。**可以同时有多条**，顺序即发现顺序。
 *
 * 与 `AvatarReason` 分开的理由：`reason` 回答「为什么整块用不了」，
 * `degraded` 回答「这一帧哪里将就了」。两者混在一起，
 * 面板就分不清「没装」与「装了但这一张没图」。
 */
export type AvatarDegraded =
  /** 开关关掉。 */
  | 'disabled'
  /** O-031 缺席（或调用抛错）。 */
  | 'no-express'
  /** 没有任何依据，只能保持原样。 */
  | 'no-mark'
  /** 本该换脸，但被最短停留挡住。 */
  | 'held'
  /** 时钟回拨（`at` 早于当前表情的起始时刻）。 */
  | 'clock-back'
  /** 一张图都没有。 */
  | 'no-asset'
  /** 当前态没图，用了兜底图。 */
  | 'asset-fallback'
  /** 有模型但没有渲染器，退回静态图。 */
  | 'no-renderer'
  /** 配置钉死 live2d，但没有模型文件，退回静态图。 */
  | 'no-model'
  /** 上游给了一个不认识的态名（可能加了第七态）。 */
  | 'unknown-state'

/** 图片格式。按扩展名判定，不读文件头（读内容需要把整张图载进内存，没必要）。 */
export type AssetFormat = 'png' | 'webp' | 'jpg' | 'gif' | 'svg' | 'avif'

/** 一张立绘。 */
export interface AvatarAsset {
  /** 文件名主干（六态之一或兜底名）。**就是表情的键**。 */
  readonly key: AssetKey
  /** 文件名（含扩展名）。 */
  readonly file: string
  /** 绝对路径。 */
  readonly path: string
  /** 格式。 */
  readonly format: AssetFormat
  /** 字节数（恒 > 0：0 字节的图在扫描阶段就被跳过了）。 */
  readonly bytes: number
  /** 来自哪个目录（绝对路径）。 */
  readonly dir: string
}

/**
 * 一个 Live2D 模型。
 *
 * 只认文件，不解析模型内容——`.model3.json` 的结构随 Cubism 版本变，
 * 而本插件不做渲染，解析它没有任何用处。
 */
export interface ModelRef {
  /** 模型 id（文件名去掉 `.model3.json` / `.model.json`）。 */
  readonly id: string
  /** 入口文件名。 */
  readonly entry: string
  /** 入口文件绝对路径。 */
  readonly path: string
  /** 模型种类。目前只认 Live2D；VRM 的入口是 `.vrm`，等真有渲染器再加。 */
  readonly kind: 'live2d'
  /** 来自哪个目录。 */
  readonly dir: string
}

/** 一帧立绘。**不可变**，渲染方只读。 */
export interface AvatarFrame {
  /** 表情态。 */
  readonly state: AvatarState
  /** 中文名（面板用）。 */
  readonly zh: string
  /** 依据来源。**消费方要按它决定"要不要真的换脸"**。 */
  readonly source: FrameSource
  /** 渲染层用的表情名。live2d 有映射时用映射值，否则等于 `state`。 */
  readonly expression: string
  /** 此刻的能力。 */
  readonly provider: AvatarProvider
  /** 静态图（`provider==='static'` 或 `none` 时尝试给出，可能是兜底图）。 */
  readonly asset?: AvatarAsset
  /** 模型（`provider==='live2d'` 时给出）。 */
  readonly model?: ModelRef
  /**
   * 动作建议。
   *
   * - `switch`：换脸（渲染方应重播入场动作）；
   * - `hold`：保持（渲染方什么都不做）。
   *
   * 为什么不叫 `changed`：`hold` 也包含「同一张脸重新说一句」，
   * 那时渲染方不该重播动作——重播会让每句话都抖一下。
   */
  readonly motion: 'switch' | 'hold'
  /** 这个表情从何时开始（毫秒）。`hold` 时保持不变，`switch` 时为本次时刻。 */
  readonly since: number
  /** 本帧的产出时刻。 */
  readonly at: number
  /** 降级说明。空数组表示这一帧完全按依据给出。 */
  readonly degraded: readonly AvatarDegraded[]
}

/** 取帧的入参。两个都给时 `mark` 优先（它带来源）。 */
export interface FrameInput {
  /** O-052 的标记（只用到 `state` 与 `source` 两个字段）。 */
  readonly mark?: MarkLike
  /** 直接指定态（面板、测试、或上游自己已经判好时用）。 */
  readonly state?: AvatarState
  /** 时刻，省略用 `clock.now()`。 */
  readonly at?: number
}

/** 纯解析入参。 */
export interface ResolveOptions {
  /** 依据来源，省略按 `state`。 */
  readonly source?: FrameSource
  /** 时刻，省略用 `clock.now()`。 */
  readonly at?: number
  /** 上一帧。要判「该不该换脸」就传 `peek()`；不传则视为首帧。 */
  readonly previous?: AvatarFrame
}

/* ------------------------------------------------------------------ *
 * 渲染器（接线点）
 * ------------------------------------------------------------------ */

/**
 * 一个渲染器 —— 指「能把 Live2D 模型显示出来的东西」。
 *
 * 这是本插件**唯一**的对外接线口：airi / dsh-whale-girl-live2d 这类实现
 * 由外部（界面层或未来的渲染插件）注册进来，本插件只负责挑一个、
 * 把态翻成它认识的表情名。**本插件不 import 任何渲染库，也不渲染一个像素**。
 *
 * 刻意没有 `kind` 字段：静态图的"渲染"就是把 `asset.path` 塞进 `<img>`，
 * 不需要谁来注册。加一个只有一种取值的分类字段，读代码的人会以为
 * 还有别的分支（纪律 107）。
 */
export interface RendererSpec {
  /** 渲染器 id（如 `airi` / `whale-girl`）。 */
  readonly id: string
  /** 六态 → 该渲染器的表情 id。省略则用六态英文名。 */
  readonly expressions?: Readonly<Partial<Record<AvatarState, string>>>
  /**
   * 是否就绪。默认 `true`。
   *
   * 给 `false` 表示「注册了但此刻不能用」（比如模型还没下载完）——
   * 它不会参与选择，但仍在 `stats().registered` 里可见。
   */
  readonly ready?: boolean
}

/* ------------------------------------------------------------------ *
 * 扫描结果
 * ------------------------------------------------------------------ */

/** 素材目录的角色。 */
export type ScanLabel =
  /** 人设包自带（只读兼容层，先查）。 */
  | 'persona'
  /** 共享目录（默认根）。 */
  | 'shared'

/** 一个被扫过的目录。 */
export interface ScanDir {
  /** 绝对路径。 */
  readonly path: string
  /** 角色。 */
  readonly label: ScanLabel
  /**
   * 目录在不在。
   *
   * `false` = 还不存在（"把图放进去"）；`true` + `error` = 存在但读不了（故障）。
   * 两者在面板上要说不同的话，所以不能压成一个布尔。
   */
  readonly present: boolean
  /** 错误码（`ENOENT` / `EACCES` …）。 */
  readonly code?: string
  /** 错误消息。 */
  readonly error?: string
  /** 这个目录里可用的条目数（图 + 模型）。 */
  readonly count: number
}

/** 一次扫描的完整结果。 */
export interface AvatarScan {
  /** 扫过的目录（人设在前）。 */
  readonly dirs: readonly ScanDir[]
  /** 可用的图（按目录优先级去重，一个键最多一张）。 */
  readonly images: readonly AvatarAsset[]
  /** 可用的模型。 */
  readonly models: readonly ModelRef[]
  /** 需要人看一眼的问题（文件名不合法、同键多图、0 字节…）。 */
  readonly issues: readonly string[]
  /** 扫描时刻。 */
  readonly at: number
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

/** 统计快照。**只在内存**，进程重启归零。 */
export interface AvatarStats {
  /** 取过多少帧。 */
  readonly frames: number
  /** 其中建议换脸的帧数。 */
  readonly switches: number
  /** 其中建议保持的帧数。 */
  readonly holds: number
  /** 按来源分桶。 */
  readonly bySource: Readonly<Record<FrameSource, number>>
  /** 按态分桶。 */
  readonly byState: Readonly<Partial<Record<AvatarState, number>>>
  /** 已注册渲染器数（含未就绪）。 */
  readonly registered: number
  /** 最近一次扫描时刻；从未扫描为 `null`。 */
  readonly scannedAt: number | null
}

/* ------------------------------------------------------------------ *
 * 服务面
 * ------------------------------------------------------------------ */

/**
 * 立绘服务。
 *
 * 读方法多、写方法只有一个（`registerRenderer`），因为它本质是**只读投影**：
 * 状态的真源在 O-031 / O-052，素材的真源在文件系统。
 */
export interface AvatarService {
  /** 此刻能不能显示（`enable` 且 `provider !== 'none'`）。 */
  readonly available: boolean
  /** 不能显示的原因。 */
  readonly reason?: AvatarReason
  /** 此刻的能力。 */
  readonly provider: AvatarProvider
  /** 当前生效的渲染器 id（`provider==='live2d'` 时才有）。 */
  readonly renderer: string | null

  /**
   * 取一帧（**唯一推荐入口**）。会推进内部"上一帧"，`motion` 因此才有意义。
   * @param input 依据（标记 / 态 / 时刻），可省略。
   */
  frame(input?: FrameInput): AvatarFrame

  /** 只看上一帧，**不推进任何东西**（面板轮询用）。 */
  peek(): AvatarFrame | undefined

  /**
   * 纯解析：给一个态与来源，出帧。
   *
   * **不读上游、不记状态、不计统计**。要判「该不该换脸」请显式传
   * `previous: peek()`——不传就当首帧。这条刻意与 `frame()` 分开：
   * 面板试算不该污染真实计数。
   * @param state 表情态。
   * @param options 来源 / 时刻 / 上一帧。
   */
  resolve(state: AvatarState, options?: ResolveOptions): AvatarFrame

  /** 可用的图（按目录优先级去重）。 */
  assets(): readonly AvatarAsset[]
  /** 可用的模型。 */
  models(): readonly ModelRef[]
  /** 某个态会用到的图（含兜底链）。 */
  assetOf(state: AvatarState): AvatarAsset | undefined

  /** 最近一次扫描结果（**不重扫**）。 */
  lastScan(): AvatarScan
  /** 重扫素材目录（上传 / 删除后调）。 */
  refresh(): AvatarScan

  /**
   * 注册一个渲染器。返回撤销函数。
   * @param spec 渲染器描述。
   */
  registerRenderer(spec: RendererSpec): () => void

  /** 统计快照。 */
  stats(): AvatarStats
}

/* ------------------------------------------------------------------ *
 * 宿主相邻服务的结构对位（§18.5：不 import 对方源码）
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状。 */
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

/** O-003 时间服务的结构对位子集。 */
export interface ClockLike {
  now(): number
}

/** O-031 情绪表达服务的结构对位子集（**只读一个方法**）。 */
export interface ExpressLike {
  stateOf(at?: number): { readonly state: string }
}

/** O-052 标记的结构对位子集（只用到两个字段）。 */
export interface MarkLike {
  readonly state: string
  readonly source: string
}

/** O-002 路径服务的结构对位子集。 */
export interface PathLayoutLike {
  /**
   * 在数据根某区域下拼路径（不创建）。
   * @param area 区域名。
   * @param segments 相对该区域的片段。
   */
  fileIn?(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
}

/** O-020 人设服务的结构对位子集（只取当前人设 id）。 */
export interface PersonaCoreLike {
  stats?(): { readonly personaId: string | null }
}

/** 字段声明（与 O-005 对位）。 */
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
}

/** 配置段声明（与 O-005 对位）。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** 目录里的一项。 */
export interface DirEntryLike {
  /** 文件名（不含目录）。 */
  readonly name: string
  /** 是不是目录。 */
  readonly isDir: boolean
  /** 字节数（目录为 0）。 */
  readonly bytes: number
}

/** 一次列目录的结果。**读不到不抛**，用 `error` 说原因。 */
export interface FsListing {
  readonly entries: readonly DirEntryLike[]
  /** 错误消息。 */
  readonly error?: string
  /**
   * 错误码（`ENOENT` / `EACCES` …）。
   *
   * 与 `error` 分开的理由只有一条：**「目录不存在」与「目录读不了」要能区分**。
   * 前者是"还没建"，后者是故障。靠消息文本去猜（`includes('no such file')`）
   * 在非英文 locale 下会失效。
   */
  readonly code?: string
}

/**
 * 文件系统抽象。**只读、只列一层**。
 *
 * 立绘目录就是一层平目录（`calm.png`），递归会让"`old/` 里三年前的旧图"
 * 也冒出来，而用户以为早删了。
 */
export interface FsLike {
  list(dir: string): FsListing
}
