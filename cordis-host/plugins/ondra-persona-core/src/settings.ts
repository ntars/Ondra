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
 * 一个关键默认值的理由，必须写在这儿：
 *
 * - **`relation 'friend'`**：五种关系里唯一不预设亲密度的一个。
 *   女友 / 妹妹 / 女儿三者都预设了一种亲密关系，**产品不该替用户决定「她跟你是什么关系」**
 *   （手册 §1.10 边界：人格是虚构角色设定；§1.11 宣传片 02 章把「关系」列为用户可选项）。
 *   出厂选 `friend`，用户改一次就记住（落盘归 O-005 用户层）。
 *   这条登记待裁决：若主人认为陪伴产品的默认关系应当是「女友」，改一个默认值即可。
 *
 * 其余默认值的理由：
 * - `includeExtras false`：没被映射到槽位的章节**默认不进内核**。
 *   打开它等于「任何人设包新加一节，就自动进提示词」，而那一节可能是人名表、
 *   可能是写作说明——塞进提示词的代价是每轮都付 token。要开就显式开。
 * - `cacheKernels true`：内核缓存是 §8.5 前缀缓存的**同一件事的前置**。
 *   关掉它只对「一边改包一边调试」有用。
 * - `boundaryItemLimit 80`：边界条目上限。实包红线 6 条 + 硬规则 4 条 + 诚实边界 3 条 +
 *   `safety.red_lines` 4 条 ≈ 17 条；80 是「有人写了 200 条红线」时仍然读得完的量级。
 *   到上限**截断并报数**，不静默丢。
 *
 * **刻意没有的配置项**：
 * - **没有「槽位标题关键词」的配置项。** 映射表在 `slots.ts`，是数据不是偏好；
 *   放进配置就变成「每个用户一套切法」，从此没法解释「为什么她的内核不一样」。
 * - **没有「单槽位字数上限」。** 裁剪归 O-023，这里加一个就是第二套预算。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'
import { BUILTIN_RELATION_IDS, PERSONA_CORE_SERVICE_KEY } from './types.js'
import type { RelationId } from './types.js'

/** 全部合法关系 id（五个内置 + 自定义）。 */
export const RELATION_IDS: readonly RelationId[] = Object.freeze([...BUILTIN_RELATION_IDS, 'custom'])

/**
 * 人设 id 的合规判定。
 *
 * 与 O-020 `types.ts` 的 `PERSONA_ID_PATTERN` **逐字一致**（§8.4 同一条正则）。
 * 不 import 它是因为 §18.5 禁止同轮互相 import；镜像的代价是改正则要改两处，
 * 而这条正则是手册写死的，改它的概率接近零——比「为一个正则建立编译期耦合」划算。
 */
const PERSONA_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合比对）。 */
export interface Config {
  /** 总开关。关掉后服务仍注册但 `available=false`。 */
  readonly enable: boolean
  /** 固定人设 id。空串 = 用加载器的当前人设。 */
  readonly personaId: string
  /** 关系 id。默认 `friend`（不预设亲密）。 */
  readonly relation: RelationId
  /** 是否把未映射的章节也拼进内核。默认 `false`。 */
  readonly includeExtras: boolean
  /** 是否缓存内核。默认 `true`。 */
  readonly cacheKernels: boolean
  /** 边界条目上限。默认 80。 */
  readonly boundaryItemLimit: number
}

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'persona-core'

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '总开关。关掉后不再组装内核，服务以「不可用」状态注册。',
  },
  personaId: {
    kind: 'string',
    default: '',
    advancedOnly: true,
    doc: '固定用哪个人设。留空表示跟随人设加载器（O-020）的当前人设，这是常态。',
  },
  relation: {
    kind: 'enum',
    default: 'friend',
    options: RELATION_IDS,
    doc: '关系。默认 friend——五种关系里唯一不预设亲密度的一个，产品不替用户决定「她跟你是什么关系」。',
  },
  includeExtras: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '是否把没被映射到槽位的章节也拼进内核。默认 false：新章节可能是人名表或写作说明，塞进提示词每轮都要付 token。',
  },
  cacheKernels: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '是否缓存内核（键含人设版本，换包即失效）。关掉只对「一边改包一边调试」有用。',
  },
  boundaryItemLimit: {
    kind: 'number',
    default: 80,
    min: 4,
    max: 500,
    advancedOnly: true,
    doc: '边界条目上限。到上限截断并报数，不静默丢。',
  },
})

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: FIELD_SPECS.enable.default as boolean,
  personaId: FIELD_SPECS.personaId.default as string,
  relation: FIELD_SPECS.relation.default as RelationId,
  includeExtras: FIELD_SPECS.includeExtras.default as boolean,
  cacheKernels: FIELD_SPECS.cacheKernels.default as boolean,
  boundaryItemLimit: FIELD_SPECS.boundaryItemLimit.default as number,
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
  personaId: 'persona-id',
  relation: 'relation',
  includeExtras: 'include-extras',
  cacheKernels: 'cache-kernels',
  boundaryItemLimit: 'boundary-item-limit',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '人格内核',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: PERSONA_CORE_SERVICE_KEY,
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

/** 夹一个整数。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 判一个字符串是不是合法关系 id。 */
export function isRelationId(value: unknown): value is RelationId {
  return typeof value === 'string' && (RELATION_IDS as readonly string[]).includes(value)
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const personaRaw = typeof raw['personaId'] === 'string' ? raw['personaId'].trim().toLowerCase() : ''
  // 空串是合法值（= 跟随加载器的当前人设）；非空但不合规的 id 回退空串，
  // 因为「写错的 id」比「跟随当前」更不该被当成有效配置带进下游。
  const personaId = personaRaw === '' || PERSONA_ID_PATTERN.test(personaRaw) ? personaRaw : ''
  return Object.freeze({
    enable: raw['enable'] === undefined ? DEFAULT_CONFIG.enable : raw['enable'] === true,
    personaId,
    relation: isRelationId(raw['relation']) ? raw['relation'] : DEFAULT_CONFIG.relation,
    includeExtras: raw['includeExtras'] === undefined ? DEFAULT_CONFIG.includeExtras : raw['includeExtras'] === true,
    cacheKernels: raw['cacheKernels'] === undefined ? DEFAULT_CONFIG.cacheKernels : raw['cacheKernels'] === true,
    boundaryItemLimit: clampInt(raw['boundaryItemLimit'], DEFAULT_CONFIG.boundaryItemLimit, 4, 500),
  })
}

/**
 * 实际生效的关系：配置值，或调用方临时指定。
 *
 * 分开的理由：`compose({ relation })` 允许一次性预览别的档（设置面板滑到「妹妹」看效果），
 * 但**不该改配置**——预览改配置会让「我只是看看」变成「我改了她的关系」。
 * @param configured 配置里的关系。
 * @param wanted 调用方指定。
 */
export function effectiveRelation(configured: RelationId, wanted: unknown): RelationId {
  return isRelationId(wanted) ? wanted : configured
}
