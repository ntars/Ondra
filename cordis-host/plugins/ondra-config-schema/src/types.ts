/**
 * O-005 `ondra-config-schema` 的对外契约。
 *
 * 定位：**全仓唯一的「配置四层怎么合」与「这个值到底从哪一层来」**。
 *
 * 为什么必须收成一个插件：四层配置（出厂 → 组合包 → 用户 → 运行时）如果各插件
 * 各自实现一遍合并，会出现两类只在长跑后才暴露的灾难——
 * ① 数组该替换却被深合并，用户在界面上删掉一条永远删不掉；
 * ② 合并失败时整段回退，导致「一个字段填错，整屏设置全部打回出厂值」。
 * 这两类都没有报错、只有行为诡异，事后无法从日志看出规律。
 *
 * **本服务不持有别人的默认值。** 默认值由**声明方**在注册段时一次性交出
 * （`FieldSpec.default`），注册表里只存这一份；声明方此后经 `resolve()` 取值，
 * 不再自带第二份 `DEFAULT_CONFIG`。这样「默认值真源」与「合并算法真源」
 * 各只有一处，不会互相漂移。
 *
 * 本文件只放类型与错误类；合并与追溯算法在 `layers.ts`，注册表在 `registry.ts`，
 * 框架接线在 `index.ts`。
 */

/** 本插件注册的服务键（连字符，非 `ondra:config-schema`）。全仓唯一归属。 */
export const CONFIG_SCHEMA_SERVICE_KEY = 'ondra-config-schema'

/** 撤销函数：调用即注销该段，重复调用无副作用。 */
export type Disposer = () => void

/**
 * 配置的四个层，**按优先级从低到高**排列。
 *
 * 语义与上游 Cordis / `@ntars/ondra-settings` 的解析顺序对齐：
 * `schema 默认值 → 组合基座 → 用户层 → 运行时（volatile）`。
 */
export type LayerName = 'factory' | 'bundle' | 'user' | 'runtime'

/**
 * 层的固定顺序。**只有这一份**，任何消费方都不得自己排一遍。
 *
 * 冻结是为了防「某个插件 push 进一个新层」——那会让本插件声称的四层
 * 悄悄变成五层，而界面上仍显示四层。
 */
export const LAYER_ORDER: readonly LayerName[] = Object.freeze([
  'factory',
  'bundle',
  'user',
  'runtime',
] as const)

/**
 * 简单模式四档（手册 §3.3-2：关闭 / 缓慢 / 标准 / 快速）。
 *
 * 四档只影响「一段配置的成组取值」，不新增配置层：`presetOf()` 返回一个
 * 普通对象，由调用方放进 `bundle` 层。这样「四档」与「四层」互不污染。
 */
export type PresetName = 'off' | 'slow' | 'standard' | 'fast'

/** 四档的固定顺序（界面按此顺序渲染，不许各插件自己排）。 */
export const PRESET_ORDER: readonly PresetName[] = Object.freeze([
  'off',
  'slow',
  'standard',
  'fast',
] as const)

/** 字段的取值种类。刻意只有五种：够表达全部配置，且能被静态校验。 */
export type FieldKind = 'string' | 'number' | 'boolean' | 'enum' | 'json'

/** 问题码。中文文案另给，码给机器分支用。 */
export type IssueCode =
  /** 值与该字段声明的种类不符。 */
  | 'type-mismatch'
  /** 数字越界。 */
  | 'out-of-range'
  /** 枚举值不在候选里。 */
  | 'not-in-enum'
  /** 字符串不匹配声明的形状（如配置键正则）。 */
  | 'pattern-mismatch'
  /** 层里出现了段内未声明的字段。 */
  | 'unknown-field'
  /** 密钥类字段被写进了配置：一律丢弃（手册 §6 全局禁令 6）。 */
  | 'secret-not-allowed'
  /** 一个字段声明本身不合法（注册期拦截）。 */
  | 'bad-field-spec'
  /** 段键 / 字段键不符合 §8.4 命名硬约束。 */
  | 'bad-name'
  /** 段键已被别的插件占用（§15.4 服务键/段键单一归属）。 */
  | 'section-taken'
  /** 段键不存在。 */
  | 'section-missing'

/**
 * 一条配置问题。
 *
 * 刻意带上 `layer`：**「哪个层的哪个字段错了」是本服务存在的核心理由**。
 * 只说「配置不合法」等于没说——用户不知道去改哪一层。
 */
export interface ConfigIssue {
  /** 段键。 */
  readonly section: string
  /** 字段键；段级问题不带。 */
  readonly key?: string
  /** 出错的层；默认值层面的问题不带。 */
  readonly layer?: LayerName
  /** 问题码。 */
  readonly code: IssueCode
  /** 一句中文，可直接给设置页显示。 */
  readonly message: string
}

/**
 * 一个配置字段的声明。**声明方给出的这一份就是默认值真源**。
 *
 * 声明纪律（注册期强制校验）：
 * - `key` 必须匹配 `^[a-z][a-z0-9_-]{1,63}$`（§8.4）；
 * - `default` 必须能通过本字段自己的种类校验，否则注册被拒；
 * - `secret: true` 的字段**禁止**给 `default`——密钥永不进配置文件（§6 禁令 6）。
 */
export interface FieldSpec {
  /** 取值种类。 */
  readonly kind: FieldKind
  /**
   * 出厂默认值。
   *
   * `undefined` 表示「没有出厂默认」，此时未被任何层设置的字段 `value` 为 `undefined`，
   * 消费方必须自己判空——本服务不替它编一个值出来。
   */
  readonly default?: unknown
  /**
   * `kind: 'enum'` 时的候选值，其余种类忽略。
   *
   * ## 为什么同时接受 `options`（同义写法，本仓实测必需）
   *
   * 这个字段名在本仓有过**两种写法**：schema 侧一直只认 `values`，而
   * 9 个声明方（`persona-core` / `memory-core` / `memory-dedupe` /
   * `memory-recall` / `memory-dream` / `memory-recognition` /
   * `prompt-inject` 等）写的是 `options`。
   *
   * 两者从未对齐的后果不是报错，而是**整段配置的四层合并被静默关掉**：
   * `checkFieldSpec()` 判「枚举必须给出 values 候选」→ 该段注册失败 →
   * 插件退回「只读自己的实例配置」，于是用户在设置页改的每一个值都不生效，
   * 而设置页照常显示、照常保存。九段配置同时失效，只在日志里各留一句 warn。
   *
   * 修在一处而不是去改九个插件：`options` 是声明方**已经写了几十处**的既有
   * 写法，逐个改既容易漏，也会让「以后新写一个插件该用哪个词」继续含糊。
   * 这里两个都收，`values` 优先——它是本接口的正式名字。
   */
  readonly values?: readonly string[]
  /** `kind: 'enum'` 候选值的**同义写法**；与 `values` 等价，`values` 优先。 */
  readonly options?: readonly string[]
  /** `kind: 'number'` 时的下界（含）。 */
  readonly min?: number
  /** `kind: 'number'` 时的上界（含）。 */
  readonly max?: number
  /** `kind: 'string'` 时的形状正则源码（例如配置键正则）。 */
  readonly pattern?: string
  /**
   * 是否密钥类字段。为真时：禁止默认值，且任何层提供的值都会被丢弃并记
   * `secret-not-allowed`。密钥只走环境变量与凭据域。
   */
  readonly secret?: boolean
  /**
   * 是否只在高级模式露出（手册 §3.3-2「高级模式才露具体数值」）。
   * 本插件只做**数据标记**，不渲染——渲染归应用外壳（L8 已下线）。
   */
  readonly advancedOnly?: boolean
  /** 一句中文说明，给设置页直接显示。 */
  readonly doc?: string
}

/** 一个配置段的声明：段键 + 字段表 + 可选的四档预设。 */
export interface SectionDecl {
  /** 段键，须匹配 `^[a-z][a-z0-9_-]{1,63}$`；全仓唯一归属。 */
  readonly id: string
  /** 中文段名，给界面显示。 */
  readonly title: string
  /** 字段表：键为字段名（同样受 §8.4 约束）。 */
  readonly fields: Readonly<Record<string, FieldSpec>>
  /** 四档预设：每档给一组字段增补值，缺档表示该档无增补。 */
  readonly presets?: Readonly<Partial<Record<PresetName, Readonly<Record<string, unknown>>>>>
  /** 声明方插件名（如 `ondra-clock`），便于界面回答「这段归谁管」。 */
  readonly owner?: string
}

/** 某一层的原始取值集合。**只放该层真正设置过的键**，未设置的键不要写 `null` 占位。 */
export type LayerValues = Readonly<Record<string, unknown>>

/**
 * 四层取值集合。
 *
 * 约定：**缺键或 `undefined` 表示「本层未设置」**，`null` 表示「显式置空」——
 * 后者会覆盖下层。刻意区分二者：界面上「清空这个字段」与「这个字段我没碰过」
 * 是两种意图，混为一谈会让默认值永远回不来。
 */
export interface LayerSet {
  /** 出厂层：覆写/补齐 `FieldSpec.default`（preset 展开也放这里）。 */
  readonly factory?: LayerValues
  /** 组合包默认层。 */
  readonly bundle?: LayerValues
  /** 用户配置层。 */
  readonly user?: LayerValues
  /** 运行时覆盖层（volatile）。 */
  readonly runtime?: LayerValues
}

/** 一个字段的解析结果，带完整来源追溯。 */
export interface ResolvedField {
  /** 字段键。 */
  readonly key: string
  /** 最终生效值（已深拷贝 + 深冻结，消费方改不动）。 */
  readonly value: unknown
  /**
   * 最终值的**最高优先来源层**；`'default'` 表示四层都没给，取声明里的出厂默认。
   */
  readonly source: LayerName | 'default'
  /**
   * 参与合并的层，按优先级升序。
   *
   * 对象型字段会在多层间深合并，此时 `source` 只记最高那层，`mergedFrom`
   * 才说得清「这个对象的一半来自 bundle、另一半来自 user」。
   */
  readonly mergedFrom: readonly LayerName[]
  /** 被上层覆盖掉的下层（按优先级升序）。用来说明「我改了怎么没生效」。 */
  readonly overridden: readonly LayerName[]
  /** 该字段的丢弃原因（类型不符 / 密钥 / 未知字段等）。 */
  readonly issues: readonly ConfigIssue[]
}

/** 一个段的解析结果。 */
export interface ResolvedSection {
  /** 段键。 */
  readonly id: string
  /** 段名。 */
  readonly title: string
  /** 便捷取值表：只含已声明字段的生效值。 */
  readonly values: Readonly<Record<string, unknown>>
  /** 逐字段追溯。 */
  readonly fields: Readonly<Record<string, ResolvedField>>
  /** 本段的全部问题（含逐字段的，拍平后一份，界面一次能拿全）。 */
  readonly issues: readonly ConfigIssue[]
  /**
   * 有多少字段发生了「校验失败→回退默认值」。
   *
   * 手册要求「校验失败回退该字段默认值而非整体失败」，因此这里必须能被观测到：
   * 回退是静默的危险动作，不报数等于埋雷。
   */
  readonly fallbackCount: number
}

/** 对外服务。 */
export interface ConfigSchemaService {
  /** 层的固定顺序（只读快照）。 */
  readonly layers: readonly LayerName[]
  /** 四档的固定顺序（只读快照）。 */
  readonly presets: readonly PresetName[]
  /**
   * 注册一个配置段。
   * @param decl 段声明；键不合规、字段声明不合法或段键已被占用时抛 `ConfigSchemaError`。
   * @param by 登记方名字（插件名）。省略则用 `decl.owner`，再省略用配置里的 `anonymousOwner`。
   * @returns 撤销函数；重复调用无副作用，且只撤自己登记的那一份。
   */
  register(decl: SectionDecl, by?: string): Disposer
  /** 段是否已注册。 */
  has(id: string): boolean
  /** 全部已注册段键（升序，便于界面稳定渲染）。 */
  list(): readonly string[]
  /** 取段声明快照（深冻结）；不存在返回 `undefined`。 */
  section(id: string): SectionDecl | undefined
  /**
   * 解析一个段的四层合并结果。
   * @param id 段键。
   * @param layers 各层取值；缺层即「该层未设置」。
   * @returns 解析结果；段不存在时返回 `undefined`，**不抛错**（消费方按 `if (!r) return` 降级）。
   */
  resolve(id: string, layers: LayerSet): ResolvedSection | undefined
  /**
   * 取某段某档的增补值（放进 `bundle` 层用）。
   * @returns 深冻结的普通对象；该段或该档未声明时返回空对象，**不抛错**。
   */
  presetOf(id: string, preset: PresetName): Readonly<Record<string, unknown>>
}

/** 本插件的错误类：一律在**注册期**抛，运行期不抛。 */
export class ConfigSchemaError extends Error {
  /** 问题码。 */
  readonly code: IssueCode
  /** 出问题的段键。 */
  readonly section: string
  /** 出问题的字段键。 */
  readonly key?: string

  constructor(code: IssueCode, section: string, message: string, key?: string) {
    super(message)
    this.name = 'ConfigSchemaError'
    this.code = code
    this.section = section
    this.key = key
  }
}
