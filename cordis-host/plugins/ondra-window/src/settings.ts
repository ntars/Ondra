/**
 * O-081 的配置**单一真源**。
 *
 * ## 为什么这里没有几何字段
 *
 * 手册 §3.3-2 说「每个参数有合理默认值、全部可调」。但 48 / 44 / 20 / 19 / 12 不是
 * 「参数」，是**定案规格**：它们是设计稿、验收单、截图比对共用的同一组数。
 *
 * 开放出去的真实后果不是「用户可以调窗口」，而是**任何一个人的截图都和另一个人的对不上**，
 * 而 4px 的差异不会有任何报错。所以几何留在 `spec.ts` 的常量里，一处定义、处处引用；
 * 配置只管「用哪一支、打哪个补丁、验证过哪些版本」。
 *
 * 这条与 §3.3-2 的口径冲突已登记（README 第十节），不自行改手册。
 *
 * ## 为什么 `expectedVersions` 默认空
 *
 * 空 = **「我没声明验证过任何版本」**，守卫会判 `unverifiable`。
 * 给一个默认白名单（比如 `'33'`）等于替主人签了字：那个版本可能根本没测过。
 * 与 O-077 的 `root` 默认空、O-079 的三个路径默认空是同一条纪律——
 * **假的安全感比没有更坏**。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关（关掉只拒绝 `plan()`，`spec()` 照常给）。 */
  readonly enable: boolean
  /** 方案分支：`a` = 系统红绿灯（默认），`b` = 自绘。 */
  readonly branch: 'a' | 'b'
  /** 平台：`auto` 走 `process.platform`。 */
  readonly platform: 'auto' | 'macos' | 'windows' | 'linux'
  /** 壳侧补丁文件绝对路径；空 = 判不了。 */
  readonly patchTarget: string
  /** 验证过的 Electron 版本；逗号或空格分隔；空 = 判不了。 */
  readonly expectedVersions: string
  /** 每次判定一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'window'

/** 分支合法值。 */
export const BRANCH_VALUES = Object.freeze(['a', 'b'] as const)

/** 平台合法值。 */
export const PLATFORM_VALUES = Object.freeze(['auto', 'macos', 'windows', 'linux'] as const)

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  branch: 'branch',
  platform: 'platform',
  patchTarget: 'patch-target',
  expectedVersions: 'expected-versions',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '窗口规格开关。关掉后 `plan()` 报 `disabled`，`spec()` 仍可读（规格不是行为）。',
  },
  branch: {
    kind: 'enum',
    default: 'a',
    values: BRANCH_VALUES,
    doc: '`a` = `hiddenInset` + 系统红绿灯（默认，最稳）；`b` = `hidden` + 自绘（仅 macOS，坐标无出处）。',
  },
  platform: {
    kind: 'enum',
    default: 'auto',
    values: PLATFORM_VALUES,
    doc: '`auto` = 跟 `process.platform`。**认不出就是认不出**，不默认成 macOS。',
  },
  patchTarget: {
    kind: 'string',
    default: '',
    doc: '壳侧补丁文件绝对路径（`patch-host.sh` 之类）。**空 = 判不了**（`no-patch-target`）。',
  },
  expectedVersions: {
    kind: 'string',
    default: '',
    doc: '验证过的 Electron 版本，逗号/空格分隔（例：`33,34`）。**空 = 判不了**，不替你签字。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次 `verify()` / `plan()` 一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  branch: 'a',
  platform: 'auto',
  patchTarget: '',
  expectedVersions: '',
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config]),
  ),
)

/** 查表版。 */
const SECTION_MAP: ReadonlyMap<string, keyof Config> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Config])[],
)

/** 交给 O-005 的段声明。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '窗口',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-window',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键。
 * @param raw 原始配置。
 */
export function normalizeUserLayer(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[KEY_MAP.get(key) ?? key] = value
  }
  return out
}

/**
 * 把 O-005 的结果回填成 Config 形状。
 * @param values 解析结果 `values`。
 */
export function valuesToConfigShape(values: unknown): Record<string, unknown> {
  if (!isRecord(values)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[SECTION_MAP.get(key) ?? key] = value
  }
  return out
}

/**
 * 补全配置。**永不抛**。
 *
 * 枚举字段给错时回退默认并计数（不是静默接受）：一个拼错的 `branch: 'B'`
 * 若被当成 `'a'`，用户会以为自己在用 B 案，而实际一直是 A 案。
 * @param value 原始配置。
 * @param onBad 坏条目回调。
 */
export function completeConfig(value: unknown, onBad?: (text: string, kind: string) => void): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const report = (text: string, kind: string): void => {
    if (onBad !== undefined) onBad(text, kind)
  }

  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  const text = (key: keyof Config, fallback: string): string => {
    const given = raw[key]
    if (given === undefined) return fallback
    if (typeof given !== 'string') {
      report(String(given), key)
      return fallback
    }
    return given.trim()
  }

  const branch = (): 'a' | 'b' => {
    const given = raw['branch']
    if (given === undefined) return DEFAULT_CONFIG.branch
    if (given === 'a' || given === 'b') return given
    report(String(given), 'branch')
    return DEFAULT_CONFIG.branch
  }

  const platform = (): Config['platform'] => {
    const given = raw['platform']
    if (given === undefined) return DEFAULT_CONFIG.platform
    if (given === 'auto' || given === 'macos' || given === 'windows' || given === 'linux') return given
    report(String(given), 'platform')
    return DEFAULT_CONFIG.platform
  }

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    branch: branch(),
    platform: platform(),
    patchTarget: text('patchTarget', DEFAULT_CONFIG.patchTarget),
    expectedVersions: text('expectedVersions', DEFAULT_CONFIG.expectedVersions),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（类型/枚举不符被丢弃）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  for (const key of ['patchTarget', 'expectedVersions'] as const) {
    const given = raw[key]
    if (given !== undefined && typeof given !== 'string') drift.push(key)
  }

  const branchGiven = raw['branch']
  if (branchGiven !== undefined && branchGiven !== 'a' && branchGiven !== 'b') drift.push('branch')

  const platformGiven = raw['platform']
  if (
    platformGiven !== undefined &&
    platformGiven !== 'auto' &&
    platformGiven !== 'macos' &&
    platformGiven !== 'windows' &&
    platformGiven !== 'linux'
  ) {
    drift.push('platform')
  }

  return drift
}
