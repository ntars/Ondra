/**
 * O-053 `ondra-sticker` 的对外契约。
 *
 * 定位：**贴纸包的读取与分发唯一入口**。目录即索引、文件名即标签，不写清单文件。
 *
 * ## 为什么"文件名即标签"
 *
 * 一份清单文件（`index.json`）会带来三个必然问题：①手工往目录里丢图，
 * 清单不会更新，图"看不见"；②清单与文件重命名不同步，点开的是一张错图；
 * ③清单本身要谁写、写在哪、格式怎么版本化，每题都要再立一套规范。
 *
 * 而「文件名即标签」的代价只有一个：**标签写在文件名上**。这个代价是值得的——
 * 用户把 `开心_01.png` 拖进目录，它就出现在「开心」里，不需要打开任何界面。
 * 手册 §7.3-3 的贴纸管理（网格 4 列 72×72、删 / 上传 / 拖拽排序）也只是
 * 「对这个目录做界面」，没有第二份数据。
 *
 * ## 为什么"缺失回退内置"不是"内置一套图"
 *
 * 手册没给内置贴纸的素材，`material/` 里也没有（只有 10 张位图，全是
 * 品牌 logo 与截图）。**凭空造 4 张笑脸 SVG** 会让产品在第一次交付时
 * 就带上一套没人审过的美术资产，而它们会出现在每一台机器上。
 *
 * 所以"内置"落成**一个可注册的兜底层**：出厂为空，`registerPack()` 是入口。
 * 三层顺序是「人设包 → 共享包 → 内置包」，某一层为空就跳过，
 * 全空时如实报 `no-pack`，并把 `no-builtin` 记进 `degraded`——
 * 让面板能说明白"为什么没贴图"是"没有图"，不是"坏了"。
 *
 * ## 与手册路径的兼容
 *
 * 手册 §7.3-3 写的是 `personas/<id>/stickers/`。本仓的人设是 **zip 包**
 * （O-020 `ondra-persona-loader` 只认 `personas/*.zip`），那个目录不存在。
 * 因此按 §12 的"只读兼容层"处理：**先查手册路径，不存在再用本插件的默认根**。
 * 两条都只读；本插件只在默认根里建目录（`personas/` 归 O-020）。
 */

/** 本插件注册的服务键（连字符，非 `ondra:sticker`）。全仓唯一归属。 */
export const STICKER_SERVICE_KEY = 'ondra-sticker'

/** 服务键 / 工具名 / 配置键的硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 格式名。渠道侧按它决定用什么方式发。 */
export type StickerFormatName = 'png' | 'jpg' | 'gif' | 'webp'

/** 支持的图片格式（扩展名 → 格式名）。不在表里的一律跳过并计数。 */
export const FORMATS: Readonly<Record<string, StickerFormatName>> = Object.freeze({
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
})

/** 包的来源。 */
export type PackKind =
  /** 人设专属包（可按人设切换）。 */
  | 'persona'
  /** 所有人设共用的包。 */
  | 'shared'
  /** 内置兜底包（出厂为空，可注册）。 */
  | 'builtin'
  /** 运行期注册的包（`registerPack()`，不落盘）。 */
  | 'registered'

/** 一张贴纸。 */
export interface StickerEntry {
  /** 稳定 id：`<包id>/<文件名>`。 */
  readonly id: string
  /** 归一后的标签（同义已合并）。 */
  readonly tag: string
  /** 来自哪个包。 */
  readonly packId: string
  /** 绝对路径（注册包可能只有文件名）。 */
  readonly path: string
  /** 文件名（含扩展名）。 */
  readonly file: string
  /** 字节数。0 字节的文件会被跳过（见 `skipped`）。 */
  readonly bytes: number
  /** 格式。 */
  readonly format: StickerFormatName
  /** 文件名里的序号（无数则 0），决定同标签内的顺序。 */
  readonly order: number
}

/** 一个包的概况。**空目录也会出现在这里**——面板要能看见"目录建了但没有图"。 */
export interface StickerPackView {
  /** 包 id（人设包是人设 id，其余是固定名）。 */
  readonly id: string
  /** 来源。 */
  readonly kind: PackKind
  /** 目录（注册包为空串）。 */
  readonly dir: string
  /** 目录是否存在。注册包恒为 `true`。 */
  readonly present: boolean
  /** 图片张数。 */
  readonly files: number
  /** 不同标签数。 */
  readonly tags: number
  /** 被跳过的文件数（格式不支持 / 0 字节）。 */
  readonly skipped: number
  /** 读目录失败的原因（不存在不算失败，此时为空）。 */
  readonly error?: string
}

/** 取图结果码。**每一个都有分支真的发出**。 */
export type StickerReason =
  /** 取到了。 */
  | 'ok'
  /** 配置关掉了。 */
  | 'disabled'
  /** 拼不出任何一个包目录（O-002 缺席且没有 `rootOverride`）。 */
  | 'no-root'
  /** 有目录但一张图都没有（含内置为空）。 */
  | 'no-pack'
  /** 有图，但没有这个标签。 */
  | 'no-tag'
  /** 标签归一后是空的（传了空串或纯符号）。 */
  | 'bad-tag'

/** 降级说明：功能可用，但少了一层。 */
export type StickerDegraded =
  /** 内置兜底包是空的（出厂状态）。 */
  | 'no-builtin'
  /** 拿不到当前人设 id，只能用人设无关的两层。 */
  | 'no-persona'
  /** 路径服务缺席，改用 `rootOverride`。 */
  | 'no-path-layout'
  /** 人设包目录读取失败（权限等），已跳过。 */
  | 'pack-error'

/** 一次取图的结果。 */
export interface StickerPick {
  /** 是否取到。 */
  readonly ok: boolean
  /** 结果码。 */
  readonly reason: StickerReason
  /** 调用方原本要的标签。 */
  readonly wanted: string
  /** 归一后的标签（`ok` 时与命中的条目一致）。 */
  readonly tag: string
  /** 命中的包。 */
  readonly packId?: string
  /** 命中的图。 */
  readonly entry?: StickerEntry
  /** 该标签在**命中包**里有多少张（轮转的分母）。 */
  readonly candidates: number
  /** 本次降级情况。 */
  readonly degraded: readonly StickerDegraded[]
}

/** 取图入参。 */
export interface PickOptions {
  /**
   * 只从这个包里取。
   *
   * 不填就走三层顺序（人设 → 共享 → 内置）。
   * 填了而包里没有这个标签 → 直接 `no-tag`，**不回退**：
   * 明确点了名却拿到别的包里的图，比拿不到更难查。
   */
  readonly packId?: string
}

/** 注册一个包的入参。 */
export interface PackRegistration {
  /** 包 id（必须符合 §8.4，且不得与磁盘包重名）。 */
  readonly id: string
  /** 文件绝对路径列表。标签仍由文件名推出（不传第二份标签）。 */
  readonly files: readonly string[]
  /** 是否作为内置兜底层（`kind` 记成 `builtin`，排在最后）。 */
  readonly builtin?: boolean
}

/** 统计快照（**只在内存**）。 */
export interface StickerStats {
  /** 扫目录次数（含强制刷新）。 */
  readonly scans: number
  /** 当前索引里的图片总数。 */
  readonly files: number
  /** 累计跳过的文件数。 */
  readonly skipped: number
  /** 包数。 */
  readonly packs: number
  /** 取图次数。 */
  readonly picks: number
  /** 没取到的次数。 */
  readonly misses: number
  /** 最近一次结果码。 */
  readonly lastReason?: StickerReason
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/** 贴纸服务。 */
export interface StickerService {
  /** 是否可用：开关打开且有根目录即可用（没有图只是 `no-pack`）。 */
  readonly available: boolean
  /** 不可用的唯一原因。 */
  readonly reason?: 'disabled'

  /** 全部包（含空目录与注册包）。首次调用会触发一次扫描。 */
  packs(): readonly StickerPackView[]
  /**
   * 某个包（或全部包）的标签列表。
   * @param packId 包 id；省略则合并全部包。
   */
  tags(packId?: string): readonly string[]
  /**
   * 取一张（**推进轮转**）。同一个标签连取两次会换一张，取完一轮才循环。
   * @param tag 标签（可传六态英文名，会经同义表归一）。
   * @param options 入参。
   */
  pick(tag: string, options?: PickOptions): StickerPick
  /**
   * 只算"会取到哪张"，**不推进轮转**（面板预览用）。
   * @param tag 标签。
   * @param options 入参。
   */
  resolve(tag: string, options?: PickOptions): StickerEntry | undefined
  /**
   * 重扫目录（上传/删除之后调用）。
   * @param force 为 `false` 时若缓存还新鲜就直接返回旧索引。
   */
  refresh(force?: boolean): readonly StickerPackView[]

  /**
   * 注册一个内存里的包（内置兜底的入口）。
   * @param input 入参。
   * @returns 撤销函数。
   */
  registerPack(input: PackRegistration): () => void
  /**
   * 注册一条同义标签（`高兴` → `开心`）。
   * @param alias 别名。
   * @param canonical 归一到哪个标签。
   * @returns 撤销函数。
   */
  registerAlias(alias: string, canonical: string): () => void

  /** 读数。 */
  stats(): StickerStats
}

/* ------------------------------------------------------------------ *
 * 相邻服务的结构对位（§18.5：不 import 源码，只按形状取）
 * ------------------------------------------------------------------ */

/** 日志器。 */
export interface LogLike {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
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
   * 与 `error` 分开的理由只有一个：**"目录不存在"与"目录读不了"要能区分**。
   * 前者是"还没建"，面板该说"把图放进去"；后者是故障，该说"权限不足"。
   * 只看消息文本去猜（`includes('no such file')`）在非英文 locale 下会失效。
   */
  readonly code?: string
}

/**
 * 文件系统抽象。
 *
 * 只暴露"列一层目录"这一个能力，且**只读**：
 * 本插件不需要读图片内容（贴纸是原样交给渠道的），也不需要写任何文件。
 * 把 `node:fs` 收在 `src/fs.ts` 一处，服务层才能在无文件系统的情况下逐例核对。
 */
export interface FsLike {
  list(dir: string): FsListing
}

/** O-002 路径服务的子集。 */
export interface PathLayoutLike {
  /**
   * 在数据根某区域下拼路径（不创建）。
   * @param area 区域名。
   * @param segments 相对该区域的片段。
   */
  fileIn?(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  /**
   * 确保子目录存在并收紧权限，返回绝对路径。
   * @param area 区域名。
   * @param segments 相对该区域的片段。
   */
  ensure?(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
}

/** O-020 人设服务的子集（只要当前人设 id）。 */
export interface PersonaCoreLike {
  stats?(): { readonly personaId: string | null }
}

/** O-003 时间服务的子集。 */
export interface ClockLike {
  now(): number
}

/** O-001 身份服务的子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
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

/** O-005 段声明。 */
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
