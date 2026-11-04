/**
 * O-025 `ondra-worldbook-scenes` 的对外契约。
 *
 * 定位：**「这一刻该用哪张骨架」的唯一判定口**。给它这句话，它回答
 * 「哪几张场景卡被触发、为什么是这一张、命中了哪些词」，并渲染成可直接进提示词的文本。
 *
 * 五件必须先说清的事：
 *
 * 1. **场景卡的字段是从真实人设包里读出来的，不是猜的。**
 *    `ondra-persona-skills/哦鲸鲸.skill.zip` 的 `references/scenes.md`（14,120 字）里，
 *    每张卡都是固定六栏：`触发 / 内心 / 表面 / 台词 / 动作 / 收尾`，
 *    外加可选的 `> **升级**` 与 `> **硬规则**`。本文件的 `SceneField` 就是这六栏加两个可选栏，
 *    **解析器按这个结构写，不按想象写**。换一个包如果格式不同，解析会**报出未识别的行**
 *    而不是硬塞进某个字段。
 *
 * 2. **「内心」永不进提示词。** 素材文件自己写着：
 *    「『内心』栏全部是按 persona.md 推演的，不是原文独白。她真正说出口的话永远比内心短。」
 *    把内心塞进提示词，她会把心里话念出来——而这不是"多一点细节"，
 *    是把一个"嘴上比心里短"的人改写成"想到什么说什么"的人。
 *    这条没有开关（`settings.ts` 里刻意没有 `includeInner`）。
 *
 * 3. **一轮只用一张骨架。** 素材用法第一句就是「先找最接近的触发，再用那条的骨架，
 *    不要自由发挥」。两张卡同时生效会得到互相矛盾的指令（一张要"0 秒炸"、
 *    一张要"先否认再漏一句实话"），而模型会各取一半，最后哪种都不像她。
 *    互斥的粒度可配（`group` / `layer` / `slot` / `off`），默认按**章节组**互斥（见 `settings.ts`）。
 *
 * 4. **「同层互斥」是台账原文，但"层"在 O-024 里只是预算桶。**
 *    直译成「同一层只活一条」会让同一层里 N 条互补设定互相杀死。
 *    故实现成四种粒度并存，默认 `group`（人设包自己的章节组），
 *    `layer` 保留为严格读法。登记待裁决，改一行默认值即可切。
 *
 * 5. **递归 ≤3 是硬上限，不可配超过。** 递归是为了「A 触发 B」（一张卡的正文里提到另一张
 *    的处境），但 A→B→A 会死循环。上限 3 是台账原文；配大了会被夹回 3 并告警。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。镜像的代价是两边人工同步，纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:worldbook-scenes`）。全仓唯一归属。 */
export const SCENES_SERVICE_KEY = 'ondra-worldbook-scenes'

/**
 * 六层 id 的**结构对位镜像**（与 O-024 `types.ts` 的 `LAYER_IDS` 逐字一致）。
 *
 * 为什么不 import：§18.5 禁止同轮两个插件互相 import；而且 O-024 缺席时
 * 本插件仍然要能解析场景卡（只是没有预算）。镜像的代价是人工同步——
 * 改了 O-024 的层表，必须同改这里（两处都在文件头标了对应关系）。
 */
export const LAYER_IDS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] as const

/** 预算桶 id（镜像 O-024）。 */
export type LayerId = (typeof LAYER_IDS)[number]

/** 互斥粒度。 */
export type ExclusionMode =
  /** 按章节组互斥（默认）：`## 一、20 个核心场景` 为一组，组内只活一张。 */
  | 'group'
  /** 按预算层互斥：严格读法（同层只活一张）。 */
  | 'layer'
  /** 按作者声明的互斥槽：只有声明了同一个 `slot` 的才互斥。 */
  | 'slot'
  /** 不互斥（同一轮可以多张卡）。 */
  | 'off'

/** 卡片里的一个栏位（`表面` / `台词` / `动作` …）。 */
export interface SceneField {
  /** 栏名（逐字来自文件，如 `台词`）。 */
  readonly label: string
  /** 栏内容（逐字，未改写）。 */
  readonly value: string
}

/** 一张场景卡。 */
export interface SceneCard {
  /** 稳定 id（`<人设id>-<组序>-<卡序>`，不随标题改字而变）。 */
  readonly id: string
  /** 标题（已剥掉 `①` 这类序号）。 */
  readonly title: string
  /** 递归用的短标题：`/` 之前那一段（`被叫醒 / 新会话开场` → `被叫醒`）。 */
  readonly titleKey: string
  /** 所属章节组（`## ` 那一行，原样）。 */
  readonly group: string
  /** 组的稳定 id。 */
  readonly groupId: string
  /** 归哪一层预算桶（用于 `exclusion: 'layer'`）。 */
  readonly layer: LayerId
  /** 互斥槽（空串 = 不参与 `slot` 互斥）。 */
  readonly slot: string
  /** 层内排序键。默认 0。 */
  readonly priority: number
  /** 关键词（从 `触发` 栏抽出来的；抽不出来就是空数组，那张卡永不命中）。 */
  readonly triggers: readonly string[]
  /** 栏位（按文件顺序，**含「内心」**——剔除发生在渲染期，不在解析期）。 */
  readonly fields: readonly SceneField[]
  /** 原样正文（递归扫描用）。 */
  readonly raw: string
  /** 来源：人设包 / 运行时注册。 */
  readonly source: 'persona' | 'runtime'
  /** 来自哪个人设。 */
  readonly personaId: string
}

/** 一次命中。 */
export interface SceneHit {
  readonly card: SceneCard
  /** 原始分（按关键词长度与出现次数累加）。 */
  readonly score: number
  /** 有效分 = `score / (depth + 1)`：直接命中的永远压过递归带出来的。 */
  readonly effective: number
  /** 递归深度（0 = 直接命中）。 */
  readonly depth: number
  /** 命中了哪些词（审计用）。 */
  readonly terms: readonly string[]
  /** 怎么来的。 */
  readonly via: 'direct' | 'recursive'
  /** 递归来源卡 id；直接命中为 `undefined`。 */
  readonly parentId: string | undefined
}

/** 一条被互斥淘汰的卡。 */
export interface SceneExclusion {
  readonly id: string
  readonly title: string
  /** 输给了谁。 */
  readonly lostTo: string
  /** 按什么粒度淘汰的。 */
  readonly reason: Exclude<ExclusionMode, 'off'>
}

/** 一轮的判定结果。 */
export interface ScenePlan {
  /** 存活的卡（按有效分降序，最多一张——互斥关闭时才可能多张）。 */
  readonly hits: readonly SceneHit[]
  /** 被互斥淘汰的卡。 */
  readonly excluded: readonly SceneExclusion[]
  /** 递归实际走到的最大深度（没有递归为 0）。 */
  readonly depth: number
  /** 本轮命中的全部关键词（去重）。 */
  readonly terms: readonly string[]
  /** 参与判定的原文摘要（截断，供审计；**不进提示词**）。 */
  readonly excerpt: string
}

/** 渲染产物。 */
export interface SceneBlock {
  readonly text: string
  readonly chars: number
  readonly tokens: number
  /** 渲染进去的卡 id。 */
  readonly ids: readonly string[]
}

/** 判定选项（覆盖配置，一次性）。 */
export interface PlanOptions {
  readonly exclusion?: ExclusionMode
  readonly maxDepth?: number
  readonly recursion?: boolean
}

/** 解析出的一张卡（还没有 id 与计量，由 `service.ts` 补）。 */
export interface ParsedCard {
  readonly title: string
  readonly titleKey: string
  /** 组名（`## ` 行）；没有 H2 时为空串。 */
  readonly group: string
  readonly fields: readonly SceneField[]
  readonly trigger: string
  readonly raw: string
  /** 解析时的位置（0 起，用于生成稳定 id）。 */
  readonly index: number
  readonly groupIndex: number
}

/** 解析结果。 */
export interface ParseResult {
  readonly cards: readonly ParsedCard[]
  /** 未识别的行（不是 `- **栏**：…` 也不是标题）。**报出来，不硬塞**。 */
  readonly unknownLines: readonly string[]
  /** 结构性提示（例如整份文件没有 `###` 卡）。 */
  readonly notes: readonly string[]
}

/** 不可用原因。 */
export type ScenesUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'
  /** 人设加载器（O-020）缺席。 */
  | 'no-loader'
  /** 没人设可用。 */
  | 'no-persona'
  /** 包里没有可读的场景文件。 */
  | 'no-file'
  /** 文件读到了，但一张卡都没解析出来。 */
  | 'no-card'

/** 统计快照。 */
export interface ScenesStats {
  readonly available: boolean
  readonly reason?: ScenesUnavailableReason
  /** 卡片数。 */
  readonly cards: number
  /** 组数。 */
  readonly groups: number
  /** 有触发词、能命中的卡数。 */
  readonly triggerable: number
  /** 一个触发词都没有的卡数（永不命中，值得告警）。 */
  readonly mute: number
  /** 当前人设 id。 */
  readonly personaId: string | null
  /** 场景文件相对路径。 */
  readonly file: string
  /** 互斥粒度。 */
  readonly exclusion: ExclusionMode
  /** 递归上限。 */
  readonly maxDepth: number
  /** 解析时未识别的行数。 */
  readonly unknownLines: number
  /** 每张卡的平均触发词数（保留一位小数）。 */
  readonly avgTriggers: number
}

/** 场景卡服务。 */
export interface ScenesService {
  /** 是否可用（有人设、有文件、解析出至少一张卡、未关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ScenesUnavailableReason

  /** 全部卡片（按组序 + 卡序，稳定）。 */
  cards(): readonly SceneCard[]
  /**
   * 取一张。
   * @param id 卡 id。
   */
  cardOf(id: string): SceneCard | undefined
  /** 章节组名（按出现顺序）。 */
  groups(): readonly string[]
  /**
   * 重新解析（换人设、导入新包后调它）。
   * @returns 解析出的卡片数。
   */
  refresh(): number

  /**
   * 判定这一句该用哪张卡。
   * @param text 本轮用户来信（或对话上下文）。
   * @param options 一次性覆盖。
   */
  plan(text: string, options?: PlanOptions): ScenePlan
  /**
   * 渲染成提示词片段。**剔除「内心」与「触发」**。
   * @param plan 判定结果。
   */
  block(plan: ScenePlan): SceneBlock

  /** 统计快照。 */
  stats(): ScenesStats
}

/* ------------------------------------------------------------------ *
 * 与上游的结构对位（不 import 任何 ondra-* 源码）
 * ------------------------------------------------------------------ */

/** O-020 人设加载器的结构对位子集（只用到读文本、取当前人设、列文件）。 */
export interface PersonaLoaderLike {
  readonly available: boolean
  activeId(): string | undefined
  readText(id: string, relPath: string): string | undefined
  files(id: string): readonly { readonly path: string }[]
}

/** O-024 世界书服务的结构对位子集（只用量化与层表，**不碰条目库**）。 */
export interface WorldbookLike {
  readonly available: boolean
  layers(): readonly { readonly id: string; readonly budget: number }[]
  measure(text: string): number
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** 日志门面（只用到三档）。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-005 字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
  readonly advancedOnly?: boolean
  readonly secret?: boolean
  readonly doc?: string
}

/** O-005 段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/* ------------------------------------------------------------------ *
 * 镜像维护纪律（给下一轮的人看）
 *
 * 1. `LAYER_IDS` 是 O-024 的镜像。O-024 改层表 → 这里必须同改。
 * 2. `PersonaLoaderLike` / `WorldbookLike` 是"最小够用"子集：
 *    **刻意不含** `pack()`——本插件一旦能打包，就会开始自己决定预算，
 *    于是同一轮出现两套预算（O-024 六层 + 本插件自己的），谁也说不清哪套生效。
 * 3. `SceneCard` 只加可选字段，不改已有字段名：改签名会让下游在运行期拿到
 *    `undefined`，而静态检查看不出来。
 * ------------------------------------------------------------------ */
