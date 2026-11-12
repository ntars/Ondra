/**
 * 配置：字段声明表 + 四层合并接入 + 补全与夹紧。
 *
 * ## 这个文件为什么此前不存在，以及它不存在时发生了什么
 *
 * 本插件从进仓起就**没有** `settings.ts`。后果不是「少一个界面开关」这么轻：
 *
 * | 环节 | 没有段时 | 有段之后 |
 * | --- | --- | --- |
 * | `scanSections()` | `lib/settings.js` 不存在 → 直接跳过，设置页**没有这一条** | 出现「记忆向量」一段，六个开关都在 |
 * | `buildMemberConfigs()` | 拿不到用户层 → `config` 恒 `undefined` | 用户改的值原样进 `apply` |
 * | `apply()` 里的总开关 | 恒读出厂值 `enabled: false` → `return`，**永不 `provide`** | 用户点开就注册服务 |
 *
 * 也就是说：`ctx.get('ondra-memory-vector')` 的四处消费方（O-014 召回、
 * `external.ts` 的通道表、O-0xx 遗忘权的两条读）在**任何**配置下都拿到
 * `undefined`，而宿主 `index.ts` 的注释还写着「用户能在设置页看到这一段、
 * 能自己打开」。那句注释是对的意图、错的事实。
 *
 * ## 两条纪律（与 O-003~O-014 一脉相承）
 *
 * 1. **默认值只在这里存一份。** `FIELD_SPECS` 是唯一真源，`DEFAULT_CONFIG`
 *    由它派生（`index.ts` 不再自己写一遍）；`cordis.patch.yml` 刻意不写
 *    `config`——写了就是把默认值抄成第二份。
 * 2. **Config 键是 camelCase，段字段键是 kebab-case。** §8.4 只认小写与连字符，
 *    而 Cordis 插件实例配置历来是 camelCase。两边必须有一张**双向唯一**的
 *    映射表，缺了它注册期会抛 `bad-field-spec`。
 */

import type { Config } from './index.js'
import type { ConfigSchemaLike, FieldSpecLike, SectionDeclLike } from './types.js'

/** 段键。与插件短名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'memory-vector'

/** 段标题。设置页里显示的名字。 */
const CONFIG_SECTION_TITLE = '记忆向量'

/** 允许的模式值。 */
export const MODES: readonly Config['mode'][] = ['auto', 'literal', 'hybrid', 'vector']

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。每个 `doc` 都写清「默认值为什么是这个数」：
 * 没有理由的默认值等于作者随手写的数，下一个人不敢改也不知道该不该改。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enabled: {
    kind: 'boolean',
    default: false,
    doc:
      '向量分支总开关。**出厂关闭**：台账第 16 组裁决「2-gram 倒排（O-014）是默认分支」，'
      + '语义召回是按需增强。关闭时本服务不注册，召回的语义因子自动退出归一化（不报错）。'
      + '打开后内置哈希嵌入就地建索引，零依赖、零费用、离线可跑。',
  },
  mode: {
    kind: 'enum',
    default: 'auto',
    options: MODES,
    doc:
      '检索模式。auto 按索引规模自动走三档（<300 纯字面 / 300–1000 混合 / >1000 向量 + ANN），'
      + '两个阈值来自台账原文；其余三档用于调试与 A/B 对拍，会把模式钉死不自动切换。',
  },
  autoSync: {
    kind: 'boolean',
    default: true,
    doc:
      '装载时是否从记忆内核同步一次全量索引。内核缺席时跳过（不算错误）；'
      + '之后由消费方按需调 sync()，本插件不装定时器——周期任务归 O-014。',
  },
  persist: {
    kind: 'boolean',
    default: true,
    doc:
      '是否把向量索引落到存储端口（SQLite / 内存 / JSON 三后端通用）。'
      + '关掉则索引仅存内存，重启后重嵌——哈希嵌入很快，代价可接受。',
  },
  annProbes: {
    kind: 'number',
    default: 3,
    min: 1,
    max: 64,
    advancedOnly: true,
    doc:
      'IVF 探桶数，只在索引 >1000 条时生效。多探更准也更慢；'
      + '3 是「召回率不明显掉、耗时仍线性」的折中。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '读数与同步是否各打一行日志。排查「为什么没召回」时打开，平时关掉以免刷日志。',
  },
})

/**
 * 默认配置 —— 由 `FIELD_SPECS` 派生，**不复制字面量**。
 *
 * 上一轮在 `ondra-memory-intake` 抓到过这类毛病：同一语义的默认值在两个文件里
 * 各写一遍，改一处忘另一处，症状是「界面上写 6、实际跑 8」，两者都不报错。
 */
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze(
  Object.fromEntries(
    (Object.keys(FIELD_SPECS) as (keyof Config)[]).map(camel => [camel, FIELD_SPECS[camel].default]),
  ) as unknown as Config,
)

/**
 * camel ↔ kebab 双向表。
 *
 * `satisfies` 而不是类型断言：漏一个字段时这里立刻报错，而断言只会静默放过。
 */
export const KEY_PAIRS = {
  enabled: 'enabled',
  mode: 'mode',
  autoSync: 'auto-sync',
  persist: 'persist',
  annProbes: 'ann-probes',
  verbose: 'verbose',
} as const satisfies Readonly<Record<keyof Config, string>>

/** 反向表（kebab → camel），供解析结果回填。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], camel]),
  ) as unknown as Record<string, keyof Config>,
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: CONFIG_SECTION_TITLE,
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-memory-vector',
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

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const enabled = raw['enabled']
  const mode = raw['mode']
  const autoSync = raw['autoSync']
  const persist = raw['persist']
  const annProbes = raw['annProbes']
  const verbose = raw['verbose']
  return Object.freeze({
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_CONFIG.enabled,
    mode:
      typeof mode === 'string' && (MODES as readonly string[]).includes(mode)
        ? (mode as Config['mode'])
        : DEFAULT_CONFIG.mode,
    autoSync: typeof autoSync === 'boolean' ? autoSync : DEFAULT_CONFIG.autoSync,
    persist: typeof persist === 'boolean' ? persist : DEFAULT_CONFIG.persist,
    annProbes:
      typeof annProbes === 'number' && Number.isFinite(annProbes) && annProbes > 0
        ? Math.min(64, Math.trunc(annProbes))
        : DEFAULT_CONFIG.annProbes,
    verbose: typeof verbose === 'boolean' ? verbose : DEFAULT_CONFIG.verbose,
  })
}

/**
 * 向 O-005 注册配置段。注册放进 `ctx.effect` 里：段是本插件的资源，
 * 卸载时必须一起撤，否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文（只用 `effect`）。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
export function registerSection(
  ctx: { effect(callback: () => () => void, label?: string): void },
  schema: ConfigSchemaLike,
  log: { warn?(message: string, ...args: unknown[]): void },
): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, CONFIG_SECTION.owner), 'ondra-memory-vector: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn?.(
      '向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s',
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}
