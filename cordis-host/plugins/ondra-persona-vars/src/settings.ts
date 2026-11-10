/**
 * 配置的**单一真源**（与 O-005 的口径一致：默认值由声明方拥有、只存一份）。
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * 三个关键默认值的理由：
 *
 * - **`userAddress ''`（空串）而不是 `'你'`。**
 *   空串的语义是「用户没设」，运行时兜底才是「你」。若这里直接写 `'你'`，
 *   界面就分不出「用户真的想被叫『你』」与「用户根本没填」，而这两件事
 *   在设置面板里必须显示成不同的状态（一个是已设定，一个是建议默认）。
 *
 * - **`toneLevel 50`**：滑杆中位。手册 §7.4 说旧三档的「标准」映射到中位，
 *   而「调到热情档，示例回复立刻变」是宣传片承诺——所以默认必须是
 *   **人设包原本的说话方式**（= 中位），不能默认偏任何一侧。
 *
 * - **`substituteInBoundaries true`**。边界条目里也可能出现 `{{user}}`
 *   （「不要用 {{user}} 不喜欢的方式说话」这类）。不替换的话，模型会读到
 *   一个字面量 `{{user}}`，而这个字面量进入红线的后果比进入正文更糟：
 *   红线读不懂就不会执行。
 *
 * **刻意没有的配置项**：
 * - **没有「变量名表」的配置项。** 变量是闭集（见 `types.ts` 文件头第 5 条）；
 *   放进配置就变成「每个用户一套变量语法」，从此没法跨用户对拍。
 * - **没有「加浓时多说几句」这类额度配置。** 句数上限归 O-023 的预算与
 *   O-038 的节奏（`maxMessages`），这里再放一个就是第二套上限。
 * - **没有「示例样句」的配置项。** `BAND_SAMPLES` 是产品文案（只给界面预览），
 *   让用户改它等于让用户改人设台词。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import { VARS_SERVICE_KEY } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 怎么称呼用户。空串 = 用户没设，运行时兜底「你」。 */
  readonly userAddress: string
  /** 她的名字（覆盖 `{{char}}`）。空串 = 没设，占位符原样保留。 */
  readonly charName: string
  /** 说话浓度 0–100。默认 50（滑杆中位 = 人设包原本的说法）。 */
  readonly toneLevel: number
  /** 是否替换边界条目里的占位符。默认 `true`。 */
  readonly substituteInBoundaries: boolean
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'persona-vars'

/**
 * 用户称呼的长度上限。
 *
 * 12 个字：称呼是**短词**（「你」「玖玖的猫」「主人」），不是一段话。
 * 不限长的后果是有人填一整句进去，然后内核里每个 `{{user}}` 都被替换成那句话，
 * 提示词突然膨胀几倍——而用户只会觉得「她怎么开始复读了」。
 */
export const USER_ADDRESS_MAX = 12

/** 她的名字长度上限。人设名也应是短词。 */
export const CHAR_NAME_MAX = 24

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不再替换变量、不再出浓度段，服务以「不可用」状态注册。',
  },
  userAddress: {
    kind: 'string',
    default: '',
    doc: '她怎么称呼你（填进 {{user}}）。留空表示没设，运行时兜底用「你」。上限 12 字。',
  },
  charName: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '她的名字（填进 {{char}}）。留空表示没设，占位符原样保留——不拿人设包的名字顶替。',
  },
  toneLevel: {
    kind: 'number',
    default: 50,
    min: 0,
    max: 100,
    doc: '说话浓度。0 = 很克制，50 = 适中（人设包原本的说法），100 = 很热情。只调同一种说法用多少，不新增词。',
  },
  substituteInBoundaries: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '是否也替换边界条目里的占位符。默认 true：红线里的 {{user}} 读不懂就不会被执行。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  userAddress: FIELD_SPECS.userAddress.default as string,
  charName: FIELD_SPECS.charName.default as string,
  toneLevel: FIELD_SPECS.toneLevel.default as number,
  substituteInBoundaries: FIELD_SPECS.substituteInBoundaries.default as boolean,
})

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * §8.4 要求配置键匹配 `^[a-z][a-z0-9_-]{1,63}$`（无大写），而 Cordis 插件实例
 * 配置历来是 camelCase。O-035 踩过这个坑：直接把 `FIELD_SPECS` 当段声明交出去，
 * 注册期会抛 `bad-field-spec`，现象是「配置段静默不可用、四层合并与来源追溯全失效」。
 * 映射必须**双向唯一**，否则两个字段会抢同一个段字段键。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  userAddress: 'user-address',
  charName: 'char-name',
  toneLevel: 'tone-level',
  substituteInBoundaries: 'substitute-in-boundaries',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '人格变量与浓度',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: VARS_SERVICE_KEY,
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 *
 * 未知键**原样保留**，交给 O-005 报 `unknown-field`——在这里悄悄吞掉，
 * 用户就只会看到「我填了怎么没生效」。
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

/** 夹一个 0–100 的整数。 */
function clampLevel(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * 修一个「短词」字段。
 *
 * 三条处理：去首尾空白；**内部换行与连续空白压成一个空格**
 * （称呼里混进换行会让提示词在那句话处断行，模型会把它读成两段不同的指令）；
 * 超长**截断而不是拒收**——拒收会让用户填的名字静默消失，截断至少还在。
 * @param value 原始值。
 * @param max 长度上限（按码点）。
 */
export function normalizeShortWord(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : chars.slice(0, max).join('')
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    userAddress: raw['userAddress'] === undefined
      ? DEFAULT_CONFIG.userAddress
      : normalizeShortWord(raw['userAddress'], USER_ADDRESS_MAX),
    charName: raw['charName'] === undefined
      ? DEFAULT_CONFIG.charName
      : normalizeShortWord(raw['charName'], CHAR_NAME_MAX),
    toneLevel: clampLevel(raw['toneLevel'], DEFAULT_CONFIG.toneLevel),
    substituteInBoundaries:
      raw['substituteInBoundaries'] === undefined
        ? DEFAULT_CONFIG.substituteInBoundaries
        : raw['substituteInBoundaries'] === true,
  })
}
