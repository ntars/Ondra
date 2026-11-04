/**
 * O-083 的配置**单一真源**。
 *
 * ## 为什么区间是配置而不是常量
 *
 * `9060–9079` 只出现在台账与 master-plan §5，手册里 0 命中（手册只有 `--port 0`）。
 * 一个「环境约定」写死成常量，换一台机器的防火墙策略就得改源码。所以它是默认值。
 *
 * ## 为什么默认分支是 `system` 而不是 `fixed`
 *
 * §14.2「默认选最稳的那个分支」。让内核分配几乎不可能撞号；固定区间在 20 个号
 * 全被占时**真的没有号**，而那个坏形态是「装了、启动了、连不上」。
 * 反过来 `system` 的代价只是「端口号每次不同」，那是运维层面的不便利，不是故障。
 *
 * ## 为什么不开放「保留端口」
 *
 * 保留 = 本包自己 `listen` 着不放 = 子进程就绑不上了。这不是「更保险」，
 * 这是把要交出去的号攥在手里。所以接口里没有 `hold()`，只有 `probe` 与 `assign`。
 */

import type { FieldSpecLike, PortBranch, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。关掉后 `pick()` 直接拒绝。 */
  readonly enable: boolean
  /** 默认分支。 */
  readonly branch: PortBranch
  /** 固定区间下界（含）。台账值 9060。 */
  readonly rangeStart: number
  /** 固定区间上界（含）。台账值 9079。 */
  readonly rangeEnd: number
  /** 绑定地址。**只接受回环**，其它值一律拒绝而不是「帮你改成回环」。 */
  readonly host: string
  /** 单次绑定探测的超时。 */
  readonly probeTimeoutMs: number
  /** 固定分支最多试几个号（防一次扫 6 万个号把事件循环堵住）。 */
  readonly maxScan: number
  /** 账本里一个号的存活时长；过期允许再次发出。 */
  readonly ledgerTtlMs: number
  /** 每次挑号一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'port-picker'

/** 台账给的区间下界。 */
export const DEFAULT_RANGE_START = 9060

/** 台账给的区间上界。 */
export const DEFAULT_RANGE_END = 9079

/** 默认绑定地址：回环字面量（不是 `localhost`，避免解析成 ::1 的意外）。 */
export const DEFAULT_HOST = '127.0.0.1'

/** 默认探测超时：300ms。回环绑定要么立刻成、要么立刻 EADDRINUSE，不需要更久。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 300

/** 默认最多扫 64 个号。台账区间只有 20 个，64 足够且不会长时间占着事件循环。 */
export const DEFAULT_MAX_SCAN = 64

/** 默认账本 TTL：2 分钟。够一次启动链路用，过期就让号重新可用。 */
export const DEFAULT_LEDGER_TTL_MS = 120_000

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  branch: 'branch',
  rangeStart: 'range-start',
  rangeEnd: 'range-end',
  host: 'host',
  probeTimeoutMs: 'probe-timeout-ms',
  maxScan: 'max-scan',
  ledgerTtlMs: 'ledger-ttl-ms',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '挑端口开关。关掉后 `pick()` 返回 `disabled`，账本仍可读。',
  },
  branch: {
    kind: 'enum',
    default: 'system',
    values: Object.freeze(['system', 'fixed']),
    doc: '`system` 让内核分配（等价 `--port 0`，最稳）；`fixed` 在区间里扫（白名单/防火墙需要固定端口时用）。',
  },
  rangeStart: {
    kind: 'number',
    default: DEFAULT_RANGE_START,
    min: 1024,
    max: 65535,
    advancedOnly: true,
    doc: '固定区间下界。小于 1024 需要特权，本包直接拒绝而不是「试试看」。',
  },
  rangeEnd: {
    kind: 'number',
    default: DEFAULT_RANGE_END,
    min: 1024,
    max: 65535,
    advancedOnly: true,
    doc: '固定区间上界（含）。下界大于上界时报 `bad-range`，**不自动交换**。',
  },
  host: {
    kind: 'string',
    default: DEFAULT_HOST,
    advancedOnly: true,
    doc: '绑定地址，只接受回环（`127.0.0.0/8` / `::1` / `localhost`）。`0.0.0.0` 一律拒绝。',
  },
  probeTimeoutMs: {
    kind: 'number',
    default: DEFAULT_PROBE_TIMEOUT_MS,
    min: 50,
    max: 10_000,
    advancedOnly: true,
    doc: '单次绑定探测超时。超时按「不可用」处理，不重试。',
  },
  maxScan: {
    kind: 'number',
    default: DEFAULT_MAX_SCAN,
    min: 1,
    max: 1024,
    advancedOnly: true,
    doc: '固定分支最多试几个号。防一次扫 6 万个号把事件循环堵住。',
  },
  ledgerTtlMs: {
    kind: 'number',
    default: DEFAULT_LEDGER_TTL_MS,
    min: 1000,
    max: 3_600_000,
    advancedOnly: true,
    doc: '账本里一个号的存活时长。过期允许再次发出（账本不是锁，见 README）。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次挑号一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  branch: 'system',
  rangeStart: DEFAULT_RANGE_START,
  rangeEnd: DEFAULT_RANGE_END,
  host: DEFAULT_HOST,
  probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
  maxScan: DEFAULT_MAX_SCAN,
  ledgerTtlMs: DEFAULT_LEDGER_TTL_MS,
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
  title: '端口挑选',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-port-picker',
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
 * 分支取值收窄。认不出的**回退默认**而不是抛：一个拼错的分支名不该让整个插件装不上。
 * @param value 原始值。
 */
function branchOf(value: unknown): PortBranch {
  return value === 'fixed' ? 'fixed' : 'system'
}

/**
 * 补全并夹紧配置。**永不抛**。
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

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    branch: branchOf(raw['branch']),
    rangeStart: clampInt(raw['rangeStart'], DEFAULT_CONFIG.rangeStart, 1024, 65535),
    rangeEnd: clampInt(raw['rangeEnd'], DEFAULT_CONFIG.rangeEnd, 1024, 65535),
    host: text('host', DEFAULT_CONFIG.host),
    probeTimeoutMs: clampInt(raw['probeTimeoutMs'], DEFAULT_CONFIG.probeTimeoutMs, 50, 10_000),
    maxScan: clampInt(raw['maxScan'], DEFAULT_CONFIG.maxScan, 1, 1024),
    ledgerTtlMs: clampInt(raw['ledgerTtlMs'], DEFAULT_CONFIG.ledgerTtlMs, 1000, 3_600_000),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（类型不对被丢弃）。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  if (raw['host'] !== undefined && typeof raw['host'] !== 'string') drift.push('host')
  if (raw['branch'] !== undefined && raw['branch'] !== 'system' && raw['branch'] !== 'fixed') {
    drift.push('branch')
  }

  for (const key of ['rangeStart', 'rangeEnd', 'probeTimeoutMs', 'maxScan', 'ledgerTtlMs'] as const) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given)) drift.push(key)
  }

  return drift
}
