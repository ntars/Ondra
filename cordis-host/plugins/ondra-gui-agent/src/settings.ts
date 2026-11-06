/**
 * 配置的**单一真源**（O-005 的段声明也从这里派生）。
 *
 * ## 出厂值为什么这么保守
 *
 * 1. `enable=false`：§16.3 端侧默认全关。
 * 2. `enabledTools=['observe']`：**开箱只允许看，不允许动**。
 *    打开一个「能替你点鼠标」的插件，第一步应该是让它先看见屏幕，
 *    而不是直接给它一只会点「确认支付」的手。
 * 3. `appAllowList=[]`：**空 = 一个都不许**。这不是「忘配了」，是一个明确的默认：
 *    白名单的意义就是「你没点名的不许动」。空数组时每次判定回 `app-not-allowed`，
 *    并在装载日志里写清「先加 App 再开」——不留「看起来开了、其实什么都不做」的假象。
 * 4. `maxRisk='high'`：允许的最高风险。设成 `low` 就等于「只许点、不许打字」，
 *    设成 `readonly` 就是「只许看」。
 * 5. `confirmThreshold='high'`：风险 ≥ high（打字、按键）必须人确认。
 *
 * ## 为什么危险区用归一化矩形
 *
 * 像素矩形换一台机器就错位。错位的后果是「黑名单拦不到该拦的地方」——
 * 而用户看到的仍然是「我配了黑名单」，这比拦错更难发现。
 *
 * 出厂三条是「所有窗口都长在那」的三个区域，不是产品审美：
 * 菜单栏、窗口左上红绿灯、Dock。它们一旦被点，后果与「点错一个按钮」不是一个量级
 * （退出/关闭/切走），所以连「低风险点击」也不许落在里面。
 */

import type { FieldSpecLike, RiskLevel, SectionDeclLike, ToolKey, ZoneSpec } from './types.js'
import {
  ACT_TIMEOUT_MS,
  AUDIT_KEEP,
  AUDIT_KEEP_CEIL,
  BUDGET_CEIL,
  CONFIRM_TTL_CEIL,
  CONFIRM_TTL_MS,
  DAILY_BUDGET,
  INTERVAL_CEIL,
  NAME_RE,
  OBSERVATION_TTL_MS,
  OBSERVE_TIMEOUT_MS,
  STEP_INTERVAL_MS,
  TEXT_CEIL,
  TEXT_MAX,
  TIMEOUT_CEIL,
  TIMEOUT_FLOOR,
  TOOL_KEYS,
  TTL_CEIL,
} from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应（自检按集合双向比对）。 */
export interface Config {
  /** 总开关（默认关）。 */
  readonly enable: boolean
  /** 开着的能力。 */
  readonly enabledTools: readonly ToolKey[]
  /** 允许的最高风险。 */
  readonly maxRisk: RiskLevel
  /** 需要人确认的风险阈值。 */
  readonly confirmThreshold: RiskLevel
  /** App 白名单（空 = 全拒）。 */
  readonly appAllowList: readonly string[]
  /** 危险区（归一化矩形）。 */
  readonly dangerZones: readonly ZoneSpec[]
  /** 是否启用表单红线。 */
  readonly formRedLine: boolean
  /** 观察有效期（毫秒）。 */
  readonly observationTtlMs: number
  /** 两次动作的最小间隔（毫秒）。 */
  readonly stepIntervalMs: number
  /** 每日动作预算（次）。 */
  readonly dailyBudget: number
  /** 确认票有效期（毫秒）。 */
  readonly confirmTtlMs: number
  /** 观察超时（毫秒）。 */
  readonly observeTimeoutMs: number
  /** 执行超时（毫秒）。 */
  readonly actTimeoutMs: number
  /** 单次输入字符上限。 */
  readonly textMax: number
  /** 审计内存保留条数。 */
  readonly auditKeep: number
  /** 是否把审计写文件。 */
  readonly auditFile: boolean
  /** 每次判定打一行日志（**不含坐标与正文**）。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4（小写连字符、无冒号）。 */
export const CONFIG_SECTION_ID = 'gui-agent'

/**
 * 出厂危险区。
 *
 * 三个都是「屏幕边缘的固定区域」，与窗口内容无关，因此不会误伤正常按钮。
 * 用户换机器后需要按自己的布局调，README 限制 5 说明了怎么调。
 */
const ZONE_DEFAULTS: readonly ZoneSpec[] = [
  { id: 'menu-bar', x: 0, y: 0, w: 1, h: 0.03 },
  { id: 'window-controls', x: 0, y: 0.03, w: 0.06, h: 0.05 },
  { id: 'dock', x: 0, y: 0.94, w: 1, h: 0.06 },
]

/** 冻结后的危险区（对外只读）。 */
export const DEFAULT_ZONES: readonly ZoneSpec[] = Object.freeze(ZONE_DEFAULTS)

/** 出厂开着的工具：**只有观察**。 */
export const DEFAULT_TOOLS: readonly ToolKey[] = Object.freeze(['observe'])

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  enabledTools: 'enabled-tools',
  maxRisk: 'max-risk',
  confirmThreshold: 'confirm-threshold',
  appAllowList: 'app-allow-list',
  dangerZones: 'danger-zones',
  formRedLine: 'form-red-line',
  observationTtlMs: 'observation-ttl-ms',
  stepIntervalMs: 'step-interval-ms',
  dailyBudget: 'daily-budget',
  confirmTtlMs: 'confirm-ttl-ms',
  observeTimeoutMs: 'observe-timeout-ms',
  actTimeoutMs: 'act-timeout-ms',
  textMax: 'text-max',
  auditKeep: 'audit-keep',
  auditFile: 'audit-file',
  verbose: 'verbose',
})

/** 查表版（`Map.get` 天然带 `undefined`，避免 `Record` 下标的类型陷阱）。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— **本插件全部默认值的唯一存放处**。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '图形界面自动化开关。默认关：装上就能替你点鼠标，那是事故不是功能。',
  },
  enabledTools: {
    kind: 'json',
    default: DEFAULT_TOOLS,
    doc: '开着的能力：observe / click / type / key。**出厂只有 observe**——先让它看见，再决定给不给手。',
  },
  maxRisk: {
    kind: 'enum',
    default: 'high',
    values: Object.freeze(['readonly', 'low', 'high']),
    doc: '允许的最高风险：readonly 只许看 / low 只许点 / high 允许打字与按键。',
  },
  confirmThreshold: {
    kind: 'enum',
    default: 'high',
    values: Object.freeze(['low', 'high']),
    doc: '需要人确认的风险阈值。默认 high：打字、按键必须有人点头。',
  },
  appAllowList: {
    kind: 'json',
    default: Object.freeze([] as readonly string[]),
    doc: 'App 白名单（按前台应用名，不区分大小写）。**空 = 一个都不许**——没点名的不许动。',
  },
  dangerZones: {
    kind: 'json',
    default: DEFAULT_ZONES,
    doc: '危险区（归一化 0–1 矩形）。命中即拦，连低风险点击也不许。出厂三条：菜单栏 / 窗口左上红绿灯 / Dock。',
  },
  formRedLine: {
    kind: 'boolean',
    default: true,
    doc: '表单红线：检测到已填表单立即收手。关掉它等于允许在别人填了一半的表单上继续操作。',
  },
  observationTtlMs: {
    kind: 'number',
    default: OBSERVATION_TTL_MS,
    min: TIMEOUT_FLOOR,
    max: TTL_CEIL,
    advancedOnly: true,
    doc: '观察有效期（毫秒）。过期就必须重新看一眼再决定——拿旧截图按坐标点会点到别处。',
  },
  stepIntervalMs: {
    kind: 'number',
    default: STEP_INTERVAL_MS,
    min: 0,
    max: INTERVAL_CEIL,
    advancedOnly: true,
    doc: '两次真实动作的最小间隔（毫秒）。防连点风暴。0 = 不限。',
  },
  dailyBudget: {
    kind: 'number',
    default: DAILY_BUDGET,
    min: 1,
    max: BUDGET_CEIL,
    advancedOnly: true,
    doc: '每日动作预算（次）。§9.11 指出旧实现这项「只有注释」，本包做成真计数。',
  },
  confirmTtlMs: {
    kind: 'number',
    default: CONFIRM_TTL_MS,
    min: TIMEOUT_FLOOR,
    max: CONFIRM_TTL_CEIL,
    advancedOnly: true,
    doc: '确认票有效期（毫秒）。过期作废：三分钟前点的头不该替三分钟后的动作用。',
  },
  observeTimeoutMs: {
    kind: 'number',
    default: OBSERVE_TIMEOUT_MS,
    min: TIMEOUT_FLOOR,
    max: TIMEOUT_CEIL,
    advancedOnly: true,
    doc: '观察超时（毫秒）。截屏与取前台都是本地操作，5 秒足够。',
  },
  actTimeoutMs: {
    kind: 'number',
    default: ACT_TIMEOUT_MS,
    min: TIMEOUT_FLOOR,
    max: TIMEOUT_CEIL,
    advancedOnly: true,
    doc: '执行超时（毫秒）。给到 10 秒是因为首次触发辅助功能授权会弹系统对话框。',
  },
  textMax: {
    kind: 'number',
    default: TEXT_MAX,
    min: 1,
    max: TEXT_CEIL,
    doc: '单次输入的字符上限。再长的内容该走粘贴或脚本，不该一个字一个字敲。',
  },
  auditKeep: {
    kind: 'number',
    default: AUDIT_KEEP,
    min: 1,
    max: AUDIT_KEEP_CEIL,
    advancedOnly: true,
    doc: '审计在内存里保留的条数（倒序查询用）。落盘不受这个上限约束。',
  },
  auditFile: {
    kind: 'boolean',
    default: true,
    doc: '审计是否落盘到 user/gui-audit.jsonl（0600）。关掉只在内存，重启即失。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次判定打一行日志（**不含坐标与正文**，只记动作、风险与原因码）。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值（自检比对两份表）。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  enabledTools: DEFAULT_TOOLS,
  maxRisk: 'high',
  confirmThreshold: 'high',
  appAllowList: Object.freeze([] as readonly string[]),
  dangerZones: DEFAULT_ZONES,
  formRedLine: true,
  observationTtlMs: OBSERVATION_TTL_MS,
  stepIntervalMs: STEP_INTERVAL_MS,
  dailyBudget: DAILY_BUDGET,
  confirmTtlMs: CONFIRM_TTL_MS,
  observeTimeoutMs: OBSERVE_TIMEOUT_MS,
  actTimeoutMs: ACT_TIMEOUT_MS,
  textMax: TEXT_MAX,
  auditKeep: AUDIT_KEEP,
  auditFile: true,
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 查表版。 */
const SECTION_MAP: ReadonlyMap<string, keyof Config> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Config])[],
)

/** 交给 O-005 的段声明。字段表由 `FIELD_SPECS` + `KEY_PAIRS` 派生（不手写第二份）。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '图形界面操作',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-gui-agent',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键（kebab）。
 * @param raw 原始配置对象。
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
 * 把 O-005 的解析结果（kebab 键）回填成 Config 形状（camel 键）。
 * @param values 解析结果的 `values`。
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
 * 夹一个整数。
 * @param value 待夹的值。
 * @param fallback 非法时的回退值。
 * @param min 下界。
 * @param max 上界。
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 归一化能力名单。
 *
 * 三种写法都认：能力键（`click`）、工具名（`gui-click`）。旧配置里若写成
 * `gui.click` 也接受读入——但**只接受读入**，不向外发布（点号不匹配 §8.4）。
 * @param value 原始值。
 * @param onBad 被丢弃条目的回调。
 */
function normalizeTools(value: unknown, onBad: (text: string) => void): readonly ToolKey[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: ToolKey[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim().toLowerCase()
    if (text === '') continue
    const bare = text.startsWith('gui.')
      ? text.slice('gui.'.length)
      : text.startsWith('gui-')
        ? text.slice('gui-'.length)
        : text
    const key = TOOL_KEYS.find(candidate => candidate === bare)
    if (key === undefined) {
      onBad(item)
      continue
    }
    if (!out.includes(key)) out.push(key)
  }
  return Object.freeze(out)
}

/**
 * 归一化 App 白名单。
 *
 * 只做「去空白 + 去重 + 长度闸」。**不解析路径、不做通配**：
 * 通配符一旦写错（`Safari*` 变成「所有以 Safari 开头的进程」）就扩大了权限面，
 * 而扩展权限的代价远大于少配一个 App。
 * @param value 原始值。
 * @param onBad 被丢弃条目的回调。
 */
function normalizeApps(value: unknown, onBad: (text: string) => void): readonly string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    if (text.length > 64 || text.includes('/') || text.includes('..')) {
      onBad(item)
      continue
    }
    const lower = text.toLowerCase()
    if (!out.some(existing => existing.toLowerCase() === lower)) out.push(text)
  }
  return Object.freeze(out)
}

/**
 * 归一化危险区。
 *
 * 四条硬校验：`id` 合规、四个数都在 0–1、`w`/`h` 都 > 0、`x+w` 与 `y+h` 不越界。
 * 越界的矩形会被**丢掉**而不是夹紧——夹紧会让「我配了个很大的区域」变成
 * 「我配了个刚好没盖住目标的小区域」，而面板上看起来一模一样。
 * @param value 原始值。
 * @param onBad 被丢弃条目的回调。
 */
function normalizeZones(value: unknown, onBad: (text: string) => void): readonly ZoneSpec[] {
  if (!Array.isArray(value)) return DEFAULT_ZONES
  const out: ZoneSpec[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      onBad(String(item))
      continue
    }
    const id = item['id']
    const x = item['x']
    const y = item['y']
    const w = item['w']
    const h = item['h']
    if (typeof id !== 'string' || !NAME_RE.test(id)) {
      onBad(String(id))
      continue
    }
    if (!isUnit(x) || !isUnit(y) || !isUnit(w) || !isUnit(h)) {
      onBad(id)
      continue
    }
    if (w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) {
      onBad(id)
      continue
    }
    if (out.some(existing => existing.id === id)) {
      onBad(id)
      continue
    }
    out.push({ id, x, y, w, h })
  }
  // 显式给了空数组就是「没有危险区」——那是用户的选择，不替他加回出厂三条。
  return Object.freeze(out)
}

/**
 * 判「0–1 的数」。
 * @param value 待判值。
 */
function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * 归一化风险等级。
 *
 * `blocked` **不是合法值**：把它当上限等于「什么都拦」，那是关掉插件的另一种写法，
 * 而配置里写着「high → blocked」会让人以为自己在放开而不是收紧。
 * @param value 原始值。
 * @param fallback 非法时的回退值。
 */
function normalizeRisk(value: unknown, fallback: RiskLevel): RiskLevel {
  if (value === 'readonly' || value === 'low' || value === 'high') return value
  return fallback
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 * @param onBad 有坏条目时的回调。
 */
export function completeConfig(value: unknown, onBad?: (text: string, kind: string) => void): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const report = (text: string, kind: string): void => {
    if (onBad !== undefined) onBad(text, kind)
  }

  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  // 三个 json 字段都遵守同一条：**缺失才用出厂值，显式给空就是空**。
  const tools =
    raw['enabledTools'] === undefined
      ? DEFAULT_TOOLS
      : normalizeTools(raw['enabledTools'], text => report(text, 'enabledTools'))
  const apps =
    raw['appAllowList'] === undefined
      ? DEFAULT_CONFIG.appAllowList
      : normalizeApps(raw['appAllowList'], text => report(text, 'appAllowList'))
  const zones =
    raw['dangerZones'] === undefined
      ? DEFAULT_ZONES
      : normalizeZones(raw['dangerZones'], text => report(text, 'dangerZones'))

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    enabledTools: tools,
    // `blocked` 不是合法上限：把它当上限等于「什么都拦」，那是关掉插件的另一种写法。
    maxRisk: normalizeRisk(raw['maxRisk'], DEFAULT_CONFIG.maxRisk),
    confirmThreshold: normalizeRisk(raw['confirmThreshold'], DEFAULT_CONFIG.confirmThreshold),
    appAllowList: apps,
    dangerZones: zones,
    formRedLine: bool('formRedLine', DEFAULT_CONFIG.formRedLine),
    observationTtlMs: clampInt(
      raw['observationTtlMs'],
      DEFAULT_CONFIG.observationTtlMs,
      TIMEOUT_FLOOR,
      TTL_CEIL,
    ),
    stepIntervalMs: clampInt(raw['stepIntervalMs'], DEFAULT_CONFIG.stepIntervalMs, 0, INTERVAL_CEIL),
    dailyBudget: clampInt(raw['dailyBudget'], DEFAULT_CONFIG.dailyBudget, 1, BUDGET_CEIL),
    confirmTtlMs: clampInt(raw['confirmTtlMs'], DEFAULT_CONFIG.confirmTtlMs, TIMEOUT_FLOOR, CONFIRM_TTL_CEIL),
    observeTimeoutMs: clampInt(
      raw['observeTimeoutMs'],
      DEFAULT_CONFIG.observeTimeoutMs,
      TIMEOUT_FLOOR,
      TIMEOUT_CEIL,
    ),
    actTimeoutMs: clampInt(raw['actTimeoutMs'], DEFAULT_CONFIG.actTimeoutMs, TIMEOUT_FLOOR, TIMEOUT_CEIL),
    textMax: clampInt(raw['textMax'], DEFAULT_CONFIG.textMax, 1, TEXT_CEIL),
    auditKeep: clampInt(raw['auditKeep'], DEFAULT_CONFIG.auditKeep, 1, AUDIT_KEEP_CEIL),
    auditFile: bool('auditFile', DEFAULT_CONFIG.auditFile),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（越界被夹紧、坏条目被丢、上限不合法）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['observationTtlMs', TIMEOUT_FLOOR, TTL_CEIL],
    ['stepIntervalMs', 0, INTERVAL_CEIL],
    ['dailyBudget', 1, BUDGET_CEIL],
    ['confirmTtlMs', TIMEOUT_FLOOR, CONFIRM_TTL_CEIL],
    ['observeTimeoutMs', TIMEOUT_FLOOR, TIMEOUT_CEIL],
    ['actTimeoutMs', TIMEOUT_FLOOR, TIMEOUT_CEIL],
    ['textMax', 1, TEXT_CEIL],
    ['auditKeep', 1, AUDIT_KEEP_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) {
      drift.push(key)
    }
  }

  const riskOk = (given: unknown): boolean => given === 'readonly' || given === 'low' || given === 'high'
  if (raw['maxRisk'] !== undefined && !riskOk(raw['maxRisk'])) drift.push('maxRisk')
  if (raw['confirmThreshold'] !== undefined && !riskOk(raw['confirmThreshold'])) drift.push('confirmThreshold')

  return drift
}
