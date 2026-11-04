/**
 * 配置的**单一真源**。
 *
 * 手册 §3.3-2 要求「每个参数有合理默认值」，O-005 要求「默认值真源归声明方」。
 * 两条合起来只有一种写法能同时满足：**一张声明表，三处消费**——
 *
 * ```
 *        FIELD_SPECS（唯一真源）
 *        ├─→ DEFAULT_CONFIG      运行期默认值
 *        ├─→ SectionDecl.fields  交给 O-005 做四层合并与来源追溯
 *        └─→ completeConfig()    没有 O-005 时的本地校验
 * ```
 *
 * 反过来做（默认值写一份在 `DEFAULT_CONFIG`、再抄一份给 O-005）就会出现
 * O-005 那轮已经裁定过的双真源问题：两边一漂移，界面显示值与实际生效值必然分叉，
 * 而且**没有报错**。
 *
 * 本插件**没有密钥字段**：`credentialRef` 存的是环境变量名（引用），不是密钥值。
 * 手册 §6 全局禁令 6 是「密钥绝不写进配置文件」，所以这里连 `secret: true` 都不该出现。
 */

import { CREDENTIAL_REF_RE, NAME_RE } from './types.js'
import type { FieldSpecLike, SectionDeclLike, SourceIssue, SourceSpec } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检项 4 按集合比对）。 */
export interface Config {
  /**
   * 模型来源清单（在线 API / 本地 / 免费）。
   *
   * 默认空：`provider` 路由键由用户装了什么适配器决定，编一个出来就是假开关
   * （§17-6 不做假开关）。清单为空时服务照常注册，`resolve()` 返回 `no-source`。
   */
  readonly sources: readonly SourceSpec[]
  /** 首块超时毫秒：从发请求到第一个块。默认 20000（本地大模型加载慢，可按来源覆盖）。 */
  readonly timeoutMs: number
  /** 块间隔超时毫秒：两个块之间最长能等多久。默认 60000。 */
  readonly idleTimeoutMs: number
  /** 每条来源的最大尝试次数（含首次）。默认 2；夹在 1–5。 */
  readonly maxAttempts: number
  /** 重试退避基数毫秒。默认 500。 */
  readonly backoffMs: number
  /** 重试退避上限毫秒。默认 8000。 */
  readonly maxBackoffMs: number
  /**
   * 可重试的上游机器码。
   *
   * 默认值与上游 `llm` 包的 `DEFAULT_RETRYABLE_CODES` **逐字一致**
   * （`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`）。
   * 刻意不自己另起一套：两套可重试码意味着「同一个错误，走 agent loop 会重试、
   * 走网关不会重试」，这种不一致只能靠事后翻日志发现。
   */
  readonly retryableCodes: readonly string[]
  /** 是否允许跨来源降级。默认 `true`。 */
  readonly allowFallback: boolean
  /** 是否做凭据存在性预检。默认 `true`；关掉等于把「密钥没配」交给上游报 `AUTH`。 */
  readonly checkCredential: boolean
}

/** 空来源清单（冻结，避免被下游 push）。 */
const NO_SOURCES: readonly SourceSpec[] = Object.freeze([])

/** 上游默认可重试码（照抄，不另立一套）。 */
const DEFAULT_RETRYABLE_CODES: readonly string[] = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
] as const)

/**
 * 字段声明表 —— **本插件全部默认值的唯一存放处**。
 *
 * 顺序即界面渲染顺序。`advancedOnly` 只做数据标记，渲染归 O-092。
 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  sources: {
    kind: 'json',
    default: NO_SOURCES,
    advancedOnly: true,
    doc: '模型来源清单。每条形如 { id, kind, provider, model, priority }；provider 必须是上游已注册的路由键。',
  },
  timeoutMs: {
    kind: 'number',
    default: 20000,
    min: 1000,
    max: 600000,
    doc: '首块超时（毫秒）：从发请求到第一个块。本地大模型首次加载可能超过 20 秒，按来源单独调大。',
  },
  idleTimeoutMs: {
    kind: 'number',
    default: 60000,
    min: 1000,
    max: 600000,
    doc: '块间隔超时（毫秒）：两个块之间最长能等多久。流式回复的总时长不可预测，所以卡间隔而不是卡总时长。',
  },
  maxAttempts: {
    kind: 'number',
    default: 2,
    min: 1,
    max: 5,
    doc: '每条来源的最大尝试次数（含首次）。已经吐过字的请求不会重试，这个数字只管首块之前。',
  },
  backoffMs: {
    kind: 'number',
    default: 500,
    min: 0,
    max: 10000,
    doc: '重试退避基数（毫秒），按 2 的幂递增并加对称抖动。',
  },
  maxBackoffMs: {
    kind: 'number',
    default: 8000,
    min: 0,
    max: 60000,
    doc: '重试退避上限（毫秒）。',
  },
  retryableCodes: {
    kind: 'json',
    default: DEFAULT_RETRYABLE_CODES,
    advancedOnly: true,
    doc: '可重试的上游机器码。默认与上游 llm 包一致：EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT。',
  },
  allowFallback: {
    kind: 'boolean',
    default: true,
    doc: '首块之前，一条来源彻底失败后是否换下一条来源继续试。',
  },
  checkCredential: {
    kind: 'boolean',
    default: true,
    doc: '是否在做请求前先检查凭据引用能不能解析。关掉后密钥缺失会表现为上游的 AUTH 错误。',
  },
} as const)

/** 从声明表取默认值。 */
function specOf(key: keyof Config): FieldSpecLike {
  return FIELD_SPECS[key]
}

/** 默认配置。**由声明表派生**，不手写第二份。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  sources: NO_SOURCES,
  timeoutMs: specOf('timeoutMs').default as number,
  idleTimeoutMs: specOf('idleTimeoutMs').default as number,
  maxAttempts: specOf('maxAttempts').default as number,
  backoffMs: specOf('backoffMs').default as number,
  maxBackoffMs: specOf('maxBackoffMs').default as number,
  retryableCodes: DEFAULT_RETRYABLE_CODES,
  allowFallback: specOf('allowFallback').default as boolean,
  checkCredential: specOf('checkCredential').default as boolean,
})

/** 段键。与插件名一致，符合 §8.4。 */
export const CONFIG_SECTION_ID = 'llm-gateway'

/**
 * Config 键（camelCase）→ 段字段键（kebab-case）的**唯一映射**。
 *
 * 为什么必须有两套名字：§8.4 的硬约束是「配置键必须匹配 `^[a-z][a-z0-9_-]{1,63}$`」，
 * 大写字母不在里面；而 Cordis 的插件实例配置历来是 camelCase（`cordis.yml` 里就长这样，
 * O-001~O-009 全部如此）。于是同一份配置在两个命名空间里必须有两个合法名字。
 *
 * **这条映射就是「两个名字其实是一个东西」的唯一凭据**：
 * - 反向（kebab → camel）由 `SECTION_KEYS` 提供，必须**双向唯一**，
 *   否则两个 Config 字段会抢同一个段字段，表现为「改 A 生效在 B 上」；
 * - 段声明、用户层归一化、解析结果回填三处全部走这张表，不另抄。
 *
 * 用户写哪个名字都认：`timeoutMs` 与 `timeout-ms` 等价（`normalizeUserLayer` 归一化）。
 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  sources: 'sources',
  timeoutMs: 'timeout-ms',
  idleTimeoutMs: 'idle-timeout-ms',
  maxAttempts: 'max-attempts',
  backoffMs: 'backoff-ms',
  maxBackoffMs: 'max-backoff-ms',
  retryableCodes: 'retryable-codes',
  allowFallback: 'allow-fallback',
  checkCredential: 'check-credential',
})

/** 段字段键（kebab）→ Config 键（camel）。由 `KEY_PAIRS` 反向生成，不手写。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生，不复制。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '模型网关',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-llm-gateway',
})

/**
 * 把用户层归一化成段字段键（kebab）。
 *
 * 认两种写法，且**未知键原样保留**——交给 O-005 报 `unknown-field`，
 * 而不是在这里悄悄吞掉（「我填了怎么没生效」正是要避免的那类静默失败）。
 * @param raw 原始配置对象。
 * @returns 键已归一化的普通对象。
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
 * @returns Config 形状的普通对象。
 */
export function valuesToConfigShape(values: unknown): Record<string, unknown> {
  if (!isRecord(values)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[SECTION_KEYS[key] ?? key] = value
  }
  return out
}

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 夹一个数字。 */
function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 补全一条来源声明；不合法返回 `undefined` + 一条问题。 */
function completeSource(raw: unknown, index: number): { spec?: SourceSpec; issue?: SourceIssue } {
  if (!isRecord(raw)) {
    return { issue: { code: 'not-object', message: `第 ${index + 1} 条来源不是对象，已跳过` } }
  }
  const id = raw['id']
  if (typeof id !== 'string' || !NAME_RE.test(id)) {
    return {
      issue: {
        code: 'bad-id',
        message: `第 ${index + 1} 条来源的 id 必须是匹配 ^[a-z][a-z0-9_-]{1,63}$ 的小写串，已跳过`,
      },
    }
  }
  const kindRaw = raw['kind']
  const kind = kindRaw === 'local' || kindRaw === 'free' || kindRaw === 'remote' ? kindRaw : 'remote'
  if (kindRaw !== undefined && kindRaw !== kind) {
    return { issue: { id, code: 'bad-kind', message: `来源 ${id} 的 kind 只能是 remote / local / free，已跳过` } }
  }
  const provider = raw['provider']
  if (typeof provider !== 'string' || provider.trim() === '') {
    return { issue: { id, code: 'bad-provider', message: `来源 ${id} 缺少 provider（上游路由键），已跳过` } }
  }
  const model = raw['model']
  if (typeof model !== 'string' || model.trim() === '') {
    return { issue: { id, code: 'bad-model', message: `来源 ${id} 缺少 model，已跳过` } }
  }
  const priorityRaw = raw['priority']
  let priority = 100
  if (priorityRaw !== undefined) {
    if (typeof priorityRaw !== 'number' || !Number.isFinite(priorityRaw)) {
      return { issue: { id, code: 'bad-priority', message: `来源 ${id} 的 priority 必须是数字，已跳过` } }
    }
    priority = Math.trunc(priorityRaw)
  }
  const credentialRaw = raw['credentialRef']
  let credentialRef: string | undefined
  if (credentialRaw !== undefined && credentialRaw !== '') {
    if (typeof credentialRaw !== 'string' || !CREDENTIAL_REF_RE.test(credentialRaw)) {
      return {
        issue: {
          id,
          code: 'bad-credential-ref',
          message: `来源 ${id} 的 credentialRef 必须是环境变量名（字母或下划线开头），且只能是名字不能是密钥值，已跳过`,
        },
      }
    }
    credentialRef = credentialRaw
  }
  const timeoutRaw = raw['timeoutMs']
  let timeoutMs: number | undefined
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== 'number' || !Number.isFinite(timeoutRaw)) {
      return { issue: { id, code: 'bad-timeout', message: `来源 ${id} 的 timeoutMs 必须是数字，已跳过` } }
    }
    timeoutMs = Math.min(600000, Math.max(1000, Math.trunc(timeoutRaw)))
  }
  const idleRaw = raw['idleTimeoutMs']
  let idleTimeoutMs: number | undefined
  if (idleRaw !== undefined) {
    if (typeof idleRaw !== 'number' || !Number.isFinite(idleRaw)) {
      return { issue: { id, code: 'bad-timeout', message: `来源 ${id} 的 idleTimeoutMs 必须是数字，已跳过` } }
    }
    idleTimeoutMs = Math.min(600000, Math.max(1000, Math.trunc(idleRaw)))
  }
  const attemptsRaw = raw['maxAttempts']
  let maxAttempts: number | undefined
  if (attemptsRaw !== undefined) {
    if (typeof attemptsRaw !== 'number' || !Number.isFinite(attemptsRaw)) {
      return { issue: { id, code: 'bad-attempts', message: `来源 ${id} 的 maxAttempts 必须是数字，已跳过` } }
    }
    maxAttempts = Math.min(5, Math.max(1, Math.trunc(attemptsRaw)))
  }
  const enabled = raw['enabled'] === undefined ? true : raw['enabled'] === true
  return {
    spec: Object.freeze({
      id,
      kind,
      provider: provider.trim(),
      model: model.trim(),
      priority,
      credentialRef,
      timeoutMs,
      idleTimeoutMs,
      maxAttempts,
      enabled,
    }),
  }
}

/**
 * 解析来源清单。**逐条丢弃**：一条写错不该让整张清单作废
 * （与 O-005「错层单独丢弃」同口径，理由也一样——一处笔误不该让全部设置回出厂）。
 * @param raw 原始值。
 * @returns 已按优先级排序的清单 + 问题列表。
 */
export function parseSources(raw: unknown): { sources: readonly SourceSpec[]; issues: readonly SourceIssue[] } {
  if (raw === undefined) return { sources: NO_SOURCES, issues: [] }
  if (!Array.isArray(raw)) {
    return { sources: NO_SOURCES, issues: [{ code: 'not-array', message: 'sources 必须是数组，已按空清单处理' }] }
  }
  const issues: SourceIssue[] = []
  const kept: SourceSpec[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const { spec, issue } = completeSource(entry, index)
    if (issue !== undefined) {
      issues.push(issue)
      return
    }
    if (spec === undefined) return
    if (seen.has(spec.id)) {
      issues.push({ id: spec.id, code: 'duplicate-id', message: `来源 id ${spec.id} 重复，后一条已跳过` })
      return
    }
    seen.add(spec.id)
    kept.push(spec)
  })
  // 稳定排序：priority 小的在前，同值保持书写顺序（`Array#sort` 在 ES2019 起稳定）。
  kept.sort((left, right) => left.priority - right.priority)
  return { sources: Object.freeze(kept), issues: Object.freeze(issues) }
}

/**
 * 补全并夹紧配置。**永不抛错**：非法值一律回退默认值。
 * @param value 原始配置。
 * @returns 补全后的配置 + 来源问题。
 */
export function completeConfig(value: unknown): { config: Config; issues: readonly SourceIssue[] } {
  const raw = isRecord(value) ? value : {}
  const parsed = parseSources(raw['sources'])
  const codesRaw = raw['retryableCodes']
  let retryableCodes: readonly string[] = DEFAULT_RETRYABLE_CODES
  if (Array.isArray(codesRaw)) {
    const codes = codesRaw.filter((code): code is string => typeof code === 'string' && code.trim() !== '')
    // 空数组是有意义的（「一次都别重试」），所以只判「不是数组」，不判「过滤后为空」。
    retryableCodes = Object.freeze(codes.map(code => code.trim().toUpperCase()))
  }
  const config: Config = Object.freeze({
    sources: parsed.sources,
    timeoutMs: clampNumber(raw['timeoutMs'], DEFAULT_CONFIG.timeoutMs, 1000, 600000),
    idleTimeoutMs: clampNumber(raw['idleTimeoutMs'], DEFAULT_CONFIG.idleTimeoutMs, 1000, 600000),
    maxAttempts: clampNumber(raw['maxAttempts'], DEFAULT_CONFIG.maxAttempts, 1, 5),
    backoffMs: clampNumber(raw['backoffMs'], DEFAULT_CONFIG.backoffMs, 0, 10000),
    maxBackoffMs: clampNumber(raw['maxBackoffMs'], DEFAULT_CONFIG.maxBackoffMs, 0, 60000),
    retryableCodes,
    allowFallback: raw['allowFallback'] === undefined ? DEFAULT_CONFIG.allowFallback : raw['allowFallback'] === true,
    checkCredential:
      raw['checkCredential'] === undefined ? DEFAULT_CONFIG.checkCredential : raw['checkCredential'] === true,
  })
  return { config, issues: parsed.issues }
}
