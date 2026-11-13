/**
 * 配置的**单一真源**。
 *
 * ## 为什么只有六个字段
 *
 * 台账给这一项十二个字（合规告知 / 风控三层提醒 / 出站清单），手册里对应的
 * 只有 §9.4 的一段隐私口径、§5.7 的四条节制红线、§8.7 的三档审批。这些原文里
 * **没有一个可调参数**，只有口径。所以本包只留「用户真会想改的六件事」：
 *
 * | 字段 | 为什么它必须在配置里 |
 * |---|---|
 * | `enable` | 关掉本包 = 不做告知与确认（红线仍拦），这是明确选择，不是隐藏行为 |
 * | `approvalMode` | §8.7 明写是「全局配置项」，与 privacy / startup-check 同级 |
 * | `strictHosts` | 目标主机不在声明里时：拒（默认）还是只问一次 |
 * | `scanSecrets` | 敏感片段扫描对长文本有开销，也确有误报（哈希值） |
 * | `consentTtlMs` | 同意有效期；`0` = 永不过期（有人会想要） |
 * | `verbose` | 每次评估一行日志，排查时才开 |
 *
 * ## 默认值全部取「安全侧」，没有一个是我拍的数
 *
 * - `enable: true`：手册 §9.4 把「出站前提示」写成产品承诺，默认关掉等于默认不守承诺；
 * - `approvalMode: 'auto'`：§8.7 的中间档（低风险直过、高风险确认），既不像
 *   `supervised` 那样每次都弹，也不像 `full` 那样免审批；
 * - `strictHosts: true`：一条声明写着「发往 api.deepseek.com」却发去别处，是 bug
 *   或事故，不是用户偏好；默认拒，用户真需要时显式放开；
 * - `scanSecrets: true`：拦密钥出域是 master-plan §6 禁令 6 的直接要求。
 *
 * 唯一一个「工程取值」是 `consentTtlMs` 的 30 天——手册没给数字，已登记待裁决。
 */

import type { ApprovalMode, FieldSpecLike, SectionDeclLike } from './types.js'
import { APPROVAL_MODES, CONSENT_TTL_MS } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 分级自动审批档位（§8.7）。 */
  readonly approvalMode: ApprovalMode
  /** 目标主机不在声明清单里时直接拒。 */
  readonly strictHosts: boolean
  /** 扫敏感片段。 */
  readonly scanSecrets: boolean
  /** 同意有效期（毫秒）；`0` = 不过期。 */
  readonly consentTtlMs: number
  /** 每次评估一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'privacy'

/** 同意有效期上界：一年。 */
export const TTL_MAX_MS = 365 * 24 * 60 * 60 * 1000

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  approvalMode: 'approval-mode',
  strictHosts: 'strict-hosts',
  scanSecrets: 'scan-secrets',
  consentTtlMs: 'consent-ttl-ms',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '隐私闸门。关掉 = 不做告知与确认；**红线仍然拦**（密钥出域、未声明主机）。',
  },
  approvalMode: {
    kind: 'enum',
    default: 'auto',
    values: APPROVAL_MODES,
    doc: '分级自动审批：`supervised` 每个高风险都问 / `auto` 低风险直过、高风险问 / `full` 免审批但要求开沙箱写边界（§8.7）。',
  },
  strictHosts: {
    kind: 'boolean',
    default: true,
    doc: '目标主机不在声明清单里时直接拒。关掉只是「问一次」，不是「放行」。',
  },
  scanSecrets: {
    kind: 'boolean',
    default: true,
    doc: '扫待发样本里的密钥形状片段。会误报长哈希值，误报时可关。',
  },
  consentTtlMs: {
    kind: 'number',
    default: CONSENT_TTL_MS,
    min: 0,
    max: TTL_MAX_MS,
    advancedOnly: true,
    doc: '同意有效期（毫秒），`0` = 永不过期。默认 30 天。',
    unit: '毫秒',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次评估一行日志（**不回显样本内容**）。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  approvalMode: 'auto',
  strictHosts: true,
  scanSecrets: true,
  consentTtlMs: CONSENT_TTL_MS,
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
  title: '隐私与出站',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-privacy',
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
 * 认一个档位。
 * @param value 原始值。
 */
export function approvalModeOf(value: unknown): ApprovalMode | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  return APPROVAL_MODES.find(mode => mode === text)
}

/**
 * 夹一个整数。
 * @param value 待夹值。
 * @param fallback 回退值。
 * @param min 下界。
 * @param max 上界。
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 补全并夹紧配置。**永不抛错**。
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

  let approvalMode: ApprovalMode = DEFAULT_CONFIG.approvalMode
  const givenMode = raw['approvalMode']
  if (givenMode !== undefined) {
    const hit = approvalModeOf(givenMode)
    if (hit === undefined) report(String(givenMode), 'approvalMode')
    else approvalMode = hit
  }

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    approvalMode,
    strictHosts: bool('strictHosts', DEFAULT_CONFIG.strictHosts),
    scanSecrets: bool('scanSecrets', DEFAULT_CONFIG.scanSecrets),
    consentTtlMs: clampInt(raw['consentTtlMs'], DEFAULT_CONFIG.consentTtlMs, 0, TTL_MAX_MS),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const givenMode = raw['approvalMode']
  if (givenMode !== undefined && approvalModeOf(givenMode) === undefined) drift.push('approvalMode')

  const givenTtl = raw['consentTtlMs']
  if (givenTtl !== undefined) {
    if (
      typeof givenTtl !== 'number' ||
      !Number.isFinite(givenTtl) ||
      givenTtl < 0 ||
      givenTtl > TTL_MAX_MS
    ) {
      drift.push('consentTtlMs')
    }
  }

  return drift
}
