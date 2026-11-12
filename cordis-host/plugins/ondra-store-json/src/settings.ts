/**
 * 配置：字段声明表 + 四层合并接入 + 补全与夹紧。
 *
 * ## 这个文件为什么此前不存在，以及它不存在时会发生什么
 *
 * 本插件出厂 `enabled: false`（台账第 16 组：SQLite 是默认底座），而 README 与
 * 插件注释都写着「不想接受内存后端的『退出即丢』时，把持久化换成本插件」——
 * 也就是说**它本来就是一个由用户打开的分支**。但没有 `settings.ts` 就没有配置段：
 *
 * | 环节 | 没有段时 | 有段之后 |
 * | --- | --- | --- |
 * | `scanSections()` | 设置页**没有这一条** | 出现「JSONL 存储」一段 |
 * | 用户能改 `enabled` 吗 | 不能（插件抽屉里那个开关只影响**装载名单**） | 能 |
 * | 抽屉里打开之后 | `loaded=true`，但 `apply()` 读到出厂 `false` → `log.info('enabled=false')` 后 `return`，**服务仍不注册** | 服务注册 |
 *
 * 第三行是最坏的一种：界面上「已启用」，实际什么都没发生，中间只差一句
 * `log.info`。所以这个文件不是「多一个开关」，是把两条分开的开关接上。
 *
 * ## 两条纪律
 *
 * 1. **默认值只在这里存一份。** `FIELD_SPECS` 是唯一真源，`DEFAULT_CONFIG`
 *    由它派生（`index.ts` 不再自己写一遍）。
 * 2. **Config 键是 camelCase，段字段键是 kebab-case。** §8.4 只认小写与连字符；
 *    两边靠一张双向唯一映射表，缺了它注册期会抛 `bad-field-spec`。
 */

import type { Config } from './index.js'
import type { ConfigSchemaLike, FieldSpecLike, SectionDeclLike } from './types.js'

/** 段键。与插件短名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'store-json'

/** 段标题。设置页里显示的名字。 */
const CONFIG_SECTION_TITLE = 'JSONL 存储'

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。每个 `doc` 都写清「默认值为什么是这个数」。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enabled: {
    kind: 'boolean',
    default: false,
    doc:
      '是否注册本后端。**出厂关闭**：台账第 16 组裁决「SQLite（WAL）是默认底座」。'
      + '打开它 = 你显式选择 JSONL 分支（无 SQLite 的环境、库文件损坏且快照不可用、'
      + '又不接受内存后端「退出即丢」时用）。SQLite 在位时两个后端会同时注册，'
      + '写哪个由消费方的取值顺序决定——本插件不越权裁决，也绝不同时写两个（那是双真源）。',
  },
  maxRowsPerTable: {
    kind: 'number',
    default: 20000,
    min: 1,
    max: 2_000_000,
    doc:
      '单表行数上限。到上限**拒绝新增并抛错**，不淘汰旧行（与 SQLite 后端同口径）——'
      + '静默丢旧数据比报错更难查。',
  },
  compactFactor: {
    kind: 'number',
    default: 4,
    min: 0,
    max: 1024,
    advancedOnly: true,
    doc:
      '自动压缩倍数。某表自上次压缩以来的追加行数达到「存活行数与 64 的较大者」的 N 倍时'
      + '自动压缩；0 = 关闭自动压缩，只能手跑 compact()。4 是「压缩不占太多 CPU、'
      + '文件不无限膨胀」的折中。',
  },
  tightenPermissions: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc:
      '是否把数据目录收紧到 0700、文件收紧到 0600（Windows 上自动跳过）。'
      + '关掉只在「要和别的程序共享这个目录」时才需要，别为了省事关。',
  },
})

/** 默认配置 —— 由 `FIELD_SPECS` 派生，不复制字面量。 */
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze(
  Object.fromEntries(
    (Object.keys(FIELD_SPECS) as (keyof Config)[]).map(camel => [camel, FIELD_SPECS[camel].default]),
  ) as unknown as Config,
)

/** camel ↔ kebab 双向表。`satisfies` 而不是断言：漏一个字段这里立刻报错。 */
export const KEY_PAIRS = {
  enabled: 'enabled',
  maxRowsPerTable: 'max-rows-per-table',
  compactFactor: 'compact-factor',
  tightenPermissions: 'tighten-permissions',
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
  owner: 'ondra-store-json',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。未知键原样保留，交给 O-005 报 `unknown-field`。
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

/** 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。 */
export function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const enabled = raw['enabled']
  const maxRows = raw['maxRowsPerTable']
  const compact = raw['compactFactor']
  const tighten = raw['tightenPermissions']
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_CONFIG.enabled,
    maxRowsPerTable:
      typeof maxRows === 'number' && Number.isFinite(maxRows) && maxRows > 0
        ? Math.min(2_000_000, Math.trunc(maxRows))
        : DEFAULT_CONFIG.maxRowsPerTable,
    compactFactor:
      typeof compact === 'number' && Number.isFinite(compact) && compact >= 0
        ? Math.min(1024, Math.trunc(compact))
        : DEFAULT_CONFIG.compactFactor,
    tightenPermissions: typeof tighten === 'boolean' ? tighten : DEFAULT_CONFIG.tightenPermissions,
  }
}

/**
 * 向 O-005 注册配置段。注册放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
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
    ctx.effect(() => schema.register(CONFIG_SECTION, CONFIG_SECTION.owner), 'ondra-store-json: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并用不上，插件实例配置照样能跑。
    log.warn?.(
      '向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s',
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}
