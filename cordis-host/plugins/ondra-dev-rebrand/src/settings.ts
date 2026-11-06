/**
 * O-084 的配置**单一真源**。
 *
 * ## 为什么 `displayName` 默认是空串
 *
 * 显示名的真源在上游 `scripts/product-name.mjs` 的 `PRODUCT_NAME`。
 * 如果本包给一个默认值 `'空谷 Ondra'`，仓库里就出现**第二份**产品名：
 * 上游改一次，这里漂一次，而漂移的表现是「审计说名字没问题，实际菜单还是旧名」。
 *
 * 空串的语义是「**我不知道要改成什么**」，此时 `plan()` 只给一步
 * 「先声明品牌名」，审计把名字相关的检查全部标成判不了。这与 O-077 的 `root` 默认空、
 * O-081 的 `expectedVersions` 默认空是同一条纪律：**假的安全感比没有更坏**。
 *
 * ## 为什么 `scheme` 与 `artifactPrefix` 反而有默认值
 *
 * 这两个不是「要改成什么」，是「**不许被改掉**」的基线。默认值抄的是上游现值
 * （`schemes: ['ondra']`、`artifactName: 'ondra-…'`），用途只有一个：
 * 判断这次改动有没有顺手把它们改了。
 *
 * 它们是**护栏基线**，不是产品真源：上游真改了这两处，这里要同步（README「已知限制」第 3 条）。
 * 两者差别在于「谁拥有这个值」——产品名归上游，护栏基线归本包。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关（关掉只拒绝 `plan()`，`spec()` 照常给）。 */
  readonly enable: boolean
  /** 方案分支：`builder` = 交给 electron-builder 签（默认）；`manual` = 打包后逐层手工重签。 */
  readonly branch: 'builder' | 'manual'
  /** 新显示名（全名，如「空谷 Ondra」）。**空 = 未声明**。 */
  readonly displayName: string
  /** 期望的 bundle id（reverse-DNS）。**空 = 未声明**，此时不判「是否被改」。 */
  readonly bundleId: string
  /** 深链 scheme 基线（不许改）。 */
  readonly scheme: string
  /** 产物文件名前缀基线（不许改）。 */
  readonly artifactPrefix: string
  /** 证书限定名，**不含** `Developer ID Application:` 前缀。空 = 判不了签名身份。 */
  readonly signingIdentity: string
  /** Apple Team ID。空 = 判不了团队。 */
  readonly teamId: string
  /** `manual` 分支的目标 `.app` 绝对路径。空 = 计划里只能写占位符。 */
  readonly appPath: string
  /** 每次判定一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'rebrand'

/** 分支合法值。 */
export const BRANCH_VALUES = Object.freeze(['builder', 'manual'] as const)

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  branch: 'branch',
  displayName: 'display-name',
  bundleId: 'bundle-id',
  scheme: 'scheme',
  artifactPrefix: 'artifact-prefix',
  signingIdentity: 'signing-identity',
  teamId: 'team-id',
  appPath: 'app-path',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '改名规格开关。关掉后 `plan()` 报 `disabled`，`spec()` / `audit()` 仍可用（规格与审计不是行为）。',
  },
  branch: {
    kind: 'enum',
    default: 'builder',
    values: BRANCH_VALUES,
    doc: '`builder` = 交给 electron-builder 的签名链（默认，最稳）；`manual` = 打包后逐层手工重签（仅当必须在打包后改 bundle 名）。',
  },
  displayName: {
    kind: 'string',
    default: '',
    doc: '新显示名全名。**空 = 未声明**：`plan()` 只给「先声明品牌名」一步，不替你编一个名字。',
  },
  bundleId: {
    kind: 'string',
    default: '',
    doc: '期望的 reverse-DNS bundle id。**空 = 判不了**（不判「是否被改」）。改它等于换 App，见不变量 `keep-bundle-id`。',
  },
  scheme: {
    kind: 'string',
    default: 'ondra',
    pattern: '^[a-z][a-z0-9+.-]{1,31}$',
    doc: '深链 scheme 基线，默认抄上游现值。**只用于判「有没有被顺手改掉」**，不是新真源。',
  },
  artifactPrefix: {
    kind: 'string',
    default: 'ondra-',
    doc: '产物文件名前缀基线，默认抄上游现值。只用于判「有没有被顺手改掉」。',
  },
  signingIdentity: {
    kind: 'string',
    default: '',
    doc: '证书限定名：**不含** `Developer ID Application:` 前缀（上游自己拼，带了会被判格式错），但**通常要含团队后缀** `(TEAMID)`——上游是整行严格相等。空 = 判不了签名身份。',
  },
  teamId: {
    kind: 'string',
    default: '',
    doc: 'Apple Team ID（10 位）。空 = 判不了团队。',
  },
  appPath: {
    kind: 'string',
    default: '',
    doc: '`manual` 分支的目标 `.app` 绝对路径。空 = 计划里只能写 `<App>.app` 占位符，命令不能直接照抄。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次 `plan()` / `audit()` 一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  branch: 'builder',
  displayName: '',
  bundleId: '',
  scheme: 'ondra',
  artifactPrefix: 'ondra-',
  signingIdentity: '',
  teamId: '',
  appPath: '',
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
  title: '品牌与重签',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-dev-rebrand',
})

/** reverse-DNS 形状（与上游 `resolveDesktopAppId` 同一条正则）。 */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判一个字符串是不是 reverse-DNS bundle id。
 * @param value 待判字符串。
 */
export function isReverseDns(value: string): boolean {
  return BUNDLE_ID_PATTERN.test(value)
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
 * 枚举给错时回退默认并计数：一个拼错的 `branch: 'Builder'` 若被静默当成 `builder`，
 * 用户会以为自己要走手工重签，而实际一直走的是 builder——两条路的签名结果完全不同。
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

  const branch = (): 'builder' | 'manual' => {
    const given = raw['branch']
    if (given === undefined) return DEFAULT_CONFIG.branch
    if (given === 'builder' || given === 'manual') return given
    report(String(given), 'branch')
    return DEFAULT_CONFIG.branch
  }

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    branch: branch(),
    displayName: text('displayName', DEFAULT_CONFIG.displayName),
    bundleId: text('bundleId', DEFAULT_CONFIG.bundleId),
    scheme: text('scheme', DEFAULT_CONFIG.scheme),
    artifactPrefix: text('artifactPrefix', DEFAULT_CONFIG.artifactPrefix),
    signingIdentity: text('signingIdentity', DEFAULT_CONFIG.signingIdentity),
    teamId: text('teamId', DEFAULT_CONFIG.teamId),
    appPath: text('appPath', DEFAULT_CONFIG.appPath),
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

  for (const key of [
    'displayName',
    'bundleId',
    'scheme',
    'artifactPrefix',
    'signingIdentity',
    'teamId',
    'appPath',
  ] as const) {
    const given = raw[key]
    if (given !== undefined && typeof given !== 'string') drift.push(key)
  }

  const branchGiven = raw['branch']
  if (branchGiven !== undefined && branchGiven !== 'builder' && branchGiven !== 'manual') {
    drift.push('branch')
  }

  return drift
}
