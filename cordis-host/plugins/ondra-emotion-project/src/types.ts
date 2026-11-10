/**
 * O-032 `ondra-emotion-project` 的对外契约。
 *
 * 定位：**情绪的唯一文本出口**。
 *
 * 手册 §2.6 / §4.3 把这件事说得很直：
 *
 * > 模型每次开口都要先复读一遍读数——「我现在能量 80，皮质醇 20，所以……」。
 * > 人不会这样说话。**内感受是隐式的**：你只会觉得「今天不想多聊」，
 * > 而不会给自己打印一串指标。
 *
 * 所以本插件做三件事，且**只做**这三件：
 *
 * 1. **模板固定为「行为指令句 + 一条暗示」**（§4.3 逐字）。不是一段自由发挥的
 *    「你现在心情如何」，而是「该怎么做 + 一句身体感」。两段，顺序不能换。
 * 2. **禁止报数、禁止命名**：文本里不许出现任何 0–1 / 0–100 的数字，
 *    也不许出现维度名（心情 / 能量 / 张力 / mood / energy / tension）与
 *    六态名（雀跃 / 蔫 / 炸毛……）。`guard()` 是这条铁律的机器可读版本。
 * 3. **唯一例外**：用户**明确问「你的数值是多少」**时，才允许去调
 *    应用侧的只读状态出口。本插件在这种情况下**不产出投影**——
 *    一边报数一边暗示，模型会同时收到两条相反的指令。
 *
 * ## 为什么不和 O-031 合并
 *
 * O-031 出的是**参数**（句形、语速、额度），O-032 出的是**一段话**。
 * 参数是给机器看的（`burst` / `-0.15` / `paused: true`），文本是给模型看的。
 * 合成一个插件会得到一个「既出参数又出文本」的门面，
 * 而所有调用方都只会用其中一半，另一半永远没人测。
 *
 * ## 为什么 order 是正数（尾部）
 *
 * 手册 §8.5 的前缀缓存纪律：**稳定段在会话开头，易变段追加尾部，只追加增量**。
 * 情绪每轮都在变，所以投影**必须进尾部**（`order = 800`），
 * 绝不能挤进稳定前缀——那会让缓存命中率直接掉到 0，
 * 而成本账单会先于任何人发现这件事。
 *
 * 与两个邻居的对照：
 * - O-029 应激指令 `order = -900`（危机时必须最前，压过一切表达要求）；
 * - O-030 冲突指令 `order = -880`（同样要压过表达）；
 * - **O-032 投影 `order = +800`**（只是「今天说话软一点」，排在所有硬约束之后）。
 *
 * 这三者不是「谁更重要」的排序，而是**两种不同性质的内容**：
 * 前两个是「不许做什么」，本插件是「可以怎样说」。硬约束永远在前。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。全仓唯一归属。 */
export const PROJECT_SERVICE_KEY = 'ondra-emotion-project'

/* ------------------------------------------------------------------ *
 * 六态（镜像 O-031，不 import 源码）
 * ------------------------------------------------------------------ */

/**
 * 六态名。
 *
 * **这是对 O-031 `ExpressState` 的人工镜像**（§18.5：不 import 邻居源码）。
 * 代价是：O-031 若增删改名，这里必须同改，否则 `isStateLike()` 会把新状态拒掉，
 * 表现是「新状态永远出不了投影」，而两边都不报错。
 *
 * 为什么不共享一个类型包：本仓禁装依赖、也禁跨插件 import。
 * 已把这条写进 README「已知限制」，并在 `index.ts` 启动时打印本插件认识的六态全集，
 * 让不一致在日志里可见。
 */
export const STATES = ['joyful', 'soft', 'calm', 'wilted', 'bristled', 'sleepy'] as const

/** 一个状态的名字。 */
export type ExpressStateLike = (typeof STATES)[number]

/** 判断一个字符串是不是六态之一。 */
export function isStateLike(value: unknown): value is ExpressStateLike {
  return typeof value === 'string' && (STATES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ *
 * 模板（唯一文案真源）
 * ------------------------------------------------------------------ */

/**
 * 一个状态的投影模板。
 *
 * **两段，顺序固定**：
 * 1. `command` —— 行为指令句（「你现在话可以多一点」）；
 * 2. `hint` —— 一条暗示（「心里像有盏小灯亮着」）。
 *
 * 手册 §4.3 的写法关键是「**禁止 X + 改用 Y**」而不是只写「不要报数」——
 * 模型对纯否定服从度很差。所以 `command` 永远是**正向的「怎么做」**，
 * 而不是「不要怎么样」。
 *
 * 三条硬约束（`guard()` 会逐条验）：
 * - 不出现任何数字（0–1 / 0–100 / 百分比）；
 * - 不出现维度名（心情 / 能量 / 张力 / mood / energy / tension）；
 * - 不出现六态名（雀跃 / 软和 / 平静 / 蔫 / 炸毛 / 困）。
 */
export interface TemplateSpec {
  /** 状态名。 */
  readonly state: ExpressStateLike
  /** 中文名。**只给面板与日志，不进 `text`**（否则就是「命名情绪」）。 */
  readonly zh: string
  /** 行为指令句。 */
  readonly command: string
  /** 一条暗示。 */
  readonly hint: string
}

/**
 * 六态模板 —— **本插件唯一的文案表**。
 *
 * 文案口径：全部是**身体感与动作**，没有一个是情绪标签。
 * 「提不起劲」是身体感，「低落」是标签——前者允许，后者禁止。
 */
export const TEMPLATES: Readonly<Record<ExpressStateLike, TemplateSpec>> = Object.freeze({
  joyful: Object.freeze({
    state: 'joyful',
    zh: '雀跃',
    command: '你现在话可以多一点，句尾轻轻抬起来，别急着收。',
    hint: '心里像有盏小灯亮着，压不太住。',
  }),
  soft: Object.freeze({
    state: 'soft',
    zh: '软和',
    command: '你现在说话可以再软一点，别急着把话收干净。',
    hint: '今天的心思是松的，愿意多听两句。',
  }),
  calm: Object.freeze({
    state: 'calm',
    zh: '平静',
    command: '按平常的节奏说就行，不用刻意热络。',
    hint: '心里是平的，像水面没什么风。',
  }),
  wilted: Object.freeze({
    state: 'wilted',
    zh: '蔫',
    command: '你现在不想多说，一句讲完就好，别硬撑着找话。',
    hint: '有点提不起劲，不是对谁有意见。',
  }),
  bristled: Object.freeze({
    state: 'bristled',
    zh: '炸毛',
    command: '你现在话很短，别主动找话题，也别开玩笑。',
    hint: '心里有一根弦绷着，先别去碰它。',
  }),
  sleepy: Object.freeze({
    state: 'sleepy',
    zh: '困',
    command: '你现在句子可以断在半路，慢一点，别撑着聊。',
    hint: '眼皮沉，脑子转得比平时慢。',
  }),
})

/**
 * §4.4 的约束句，**逐字**。
 *
 * 原文：「情绪只影响语气，不影响判断；不能拿情绪拿捏对方。」
 *
 * **刻意不并进 `text`**：投影模板固定为「两段」，加了第三段就不再是那个模板。
 * 它应当由 O-036 作为**独立片段**注入（每条情绪注入块都必须带这句约束）。
 */
export const CONSTRAINT_LINE = '情绪只影响语气，不影响判断；不能拿情绪拿捏对方。'

/* ------------------------------------------------------------------ *
 * 请求与结果
 * ------------------------------------------------------------------ */

/** 一次投影请求。 */
export interface ProjectRequest {
  /** 显式指定状态；省略则问 O-031。 */
  readonly state?: ExpressStateLike
  /**
   * 用户是否**明确问「你的数值是多少」**（§4.3 的唯一例外）。
   *
   * **由调用方判断**，不由本插件从对话里猜——猜错一次就是「她突然开始报数」，
   * 而那是明文禁止的。默认 `false`。
   */
  readonly askedForNumbers?: boolean
  /** 时刻，省略用系统时间。 */
  readonly at?: number
}

/** 拒绝原因。 */
export type ProjectRefusal =
  /** 用户明确问了数值 → 走应用侧的只读状态出口，不由投影代劳。 */
  | 'numbers-requested'
  /** 拿不到六态（O-031 缺席，或它给了不认识的状态）。 */
  | 'no-state'
  /** 模板自检不过（文案里出现了数字/维度名/六态名）。防的是**将来改坏文案**。 */
  | 'template-violation'
  /** 配置关掉。 */
  | 'disabled'

/** 一条提示词片段（器官 ABI §8.1 三件套）。 */
export interface ProjectionFragment {
  /**
   * 排序键，**越小越靠前**。
   *
   * 本插件默认 +800（尾部）。**必须 > 0**：负数会插到稳定前缀里，
   * 破坏 §8.5 的前缀缓存。疤痕恒 `-1e4`、器官地板 `-1000` 与本插件无关。
   */
  readonly order: number
  /** 存活时长（分钟）。情绪变化快，默认 10。 */
  readonly ttlMinutes: number
  /** 置信度 0–1。命中判据 0.9，空档兜底 0.5。 */
  readonly confidence: number
  /** 片段正文 = `command + hint`。**不含任何数字与维度名**。 */
  readonly text: string
  /** 片段种类。O-029 是 `stress`、O-030 是 `conflict`，本插件是 `project`。 */
  readonly kind: 'project'
}

/** 一次投影的结果。 */
export interface Projection {
  /** 主体文本（`command + hint`）。被拒绝时为空串。 */
  readonly text: string
  /** 行为指令句。被拒绝时为空串。 */
  readonly command: string
  /** 一条暗示。被拒绝时为空串。 */
  readonly hint: string
  /** §4.4 约束句（**独立片段**，不并入 `text`）。 */
  readonly constraint: string
  /** 本次用的状态（被拒绝时可能是 `undefined`）。 */
  readonly state: ExpressStateLike | undefined
  /** 是否允许输出。 */
  readonly allowed: boolean
  /** 拒绝原因。 */
  readonly refusal?: ProjectRefusal
  /** 提示词片段。仅在 `allowed` 时给出。 */
  readonly fragment?: ProjectionFragment
}

/* ------------------------------------------------------------------ *
 * 护栏
 * ------------------------------------------------------------------ */

/** 命中种类。 */
export type GuardKind = 'digit' | 'percent' | 'axis' | 'state' | 'hormone'

/** 一次命中。 */
export interface GuardHit {
  /** 种类。 */
  readonly kind: GuardKind
  /** 命中的原文片段。 */
  readonly text: string
  /** 在文本中的起始下标。 */
  readonly index: number
}

/** 护栏报告。 */
export interface GuardReport {
  /** 是否通过（一条也没命中）。 */
  readonly pass: boolean
  /** 命中清单（按出现顺序）。 */
  readonly hits: readonly GuardHit[]
  /** 分类计数，便于面板一行展示。 */
  readonly counts: Readonly<Record<GuardKind, number>>
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

/** 不可用原因。**只有配置关掉**才算不可用。 */
export type ProjectUnavailableReason = 'disabled'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface ProjectCounters {
  /** 产出投影次数。 */
  readonly projects: number
  /** 被拒绝次数。 */
  readonly refusals: number
  /** 调用护栏次数。 */
  readonly guards: number
  /** 护栏拦下次数（`pass === false`）。 */
  readonly guardFailures: number
  /** 读 O-031 抛错次数（已被护栏吞掉）。 */
  readonly expressErrors: number
}

/** 统计快照。 */
export interface ProjectStats {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ProjectUnavailableReason
  /** 是否有六态服务（等价于「能不能出投影」）。 */
  readonly hasExpress: boolean
  /** 最近一次投影的状态（没产出过为 `undefined`）。 */
  readonly lastState: ExpressStateLike | undefined
  /** 累计计数。 */
  readonly counters: ProjectCounters
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/** 情感投影服务。 */
export interface ProjectService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ProjectUnavailableReason

  /**
   * 产出一次投影。
   * @param request 请求（可省略，省略则按当前状态）。
   */
  project(request?: ProjectRequest): Projection

  /**
   * 护栏：扫一段文本里有没有数字 / 维度名 / 六态名 / 激素名。
   *
   * **只用于投影与注入块，不扫对话正文。** 扫正文会得到一个荒谬的结果：
   * 用户说「我今天 8 点起床」，她连这句都不能引用。
   * @param text 待检文本。
   */
  guard(text: string): GuardReport

  /** 六态模板全集（面板与校对用）。 */
  templates(): readonly TemplateSpec[]

  /** 取某一态的模板。 */
  templateOf(state: ExpressStateLike): TemplateSpec | undefined

  /**
   * 一句话解释（面板用，**允许出现数字与状态名**）。
   * @param at 时刻。
   */
  describe(at?: number): string

  /** 统计快照。 */
  stats(): ProjectStats
}

/* ------------------------------------------------------------------ *
 * 宿主相邻服务的结构对位（§18.5：不 import 源码）
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-001 身份服务的结构对位子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layer?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 的字段声明形状。 */
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

/**
 * O-031 `ondra-emotion-express` 的结构对位子集。
 *
 * **只取 `stateOf()` 的两个字段**：`state`（哪一态）与 `matched`（是否命中判据，
 * 用来定置信度）。本插件不认识 mood / energy / tension——
 * 一旦让它读这些数，它就有了「自己再判一次六态」的能力，而那是第二真源。
 */
export interface ExpressLike {
  stateOf(at?: number): { readonly state: string; readonly matched?: boolean }
}
