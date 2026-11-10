/**
 * O-080 的配置**单一真源**。
 *
 * ## `maxRestarts` 为什么默认 1
 *
 * 台账原话「重启 1 次」。这个数字不是拍脑袋：上游 `SubprocessRuntime` 的 disposal 会
 * 终止所有托管进程，所以「父在」是常态；一次崩溃多半是偶发（OOM、端口瞬占），
 * 第二次崩溃就是配置错或二进制坏。**第二次重试的价值接近 0，代价是无限重启烧 CPU**。
 *
 * 所以 `maxRestarts: 1` 是上限而不是起点：超过就 `crash-limit`，界面能看见，人再决定。
 *
 * ## `stateDir` 为什么默认空
 *
 * 空 = 交给 O-002 的 `user/process-host`。写死 `~/.ondra/...` 就等于绕过路径真源，
 * 换个数据根（`$ONDRA_HOME`）时这里会指向一个没人管的旧目录——O-002 存在就是为了
 * 让这种路径只出现一次。
 *
 * ## `writePidFile` 为什么默认 true 却可能什么都不写
 *
 * pidfile 是外部工具（脚本、监控、用户自己 `cat`）的通用契约，值得有。
 * 但**上游不暴露 pid**，所以这个开关的语义是「拿得到就写」：拿不到时
 * 既不建空文件、也不写 0，只打一行 `pidfile-skipped`。
 * 建一个内容是假 pid 的文件，比没有这个文件坏得多——读它的脚本会去杀一个无关进程。
 */

import type { FieldSpecLike, SectionDeclLike } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 最多重启几次（台账值 1）。 */
  readonly maxRestarts: number
  /** 重启前等多久。 */
  readonly restartDelayMs: number
  /** 存活不足这个时长算「秒退」，只用于话术判定，不额外放宽预算。 */
  readonly minUptimeMs: number
  /** 终止宽限期，交给上游 provider 的终止程序。 */
  readonly graceMs: number
  /** `stop()` 等静默的上限；超时如实报 `confirmed: false`。 */
  readonly stopTimeoutMs: number
  /** 状态文件目录；空 = `user/process-host`。 */
  readonly stateDir: string
  /** 默认工作目录；空 = 宿主工作目录。 */
  readonly cwd: string
  /** 拿得到 pid 时写 `<name>.pid`。 */
  readonly writePidFile: boolean
  /** 收集器内存上限（每流）。 */
  readonly collectBytes: number
  /** 每次状态变化一行日志。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'process-host'

/** 默认重启上限。台账原话「重启 1 次」。 */
export const DEFAULT_MAX_RESTARTS = 1

/** 默认重启延迟：1.5 秒，够端口释放，也不至于让人以为卡住。 */
export const DEFAULT_RESTART_DELAY_MS = 1500

/** 默认「秒退」判据：5 秒。 */
export const DEFAULT_MIN_UPTIME_MS = 5000

/** 默认终止宽限期：3 秒（上游要求正有限值）。 */
export const DEFAULT_GRACE_MS = 3000

/** 默认等静默上限：8 秒（比宽限期长，留出 provider 分阶段终止的余量）。 */
export const DEFAULT_STOP_TIMEOUT_MS = 8000

/** 默认每流收集上限：64 KiB，只留诊断尾巴。 */
export const DEFAULT_COLLECT_BYTES = 64 * 1024

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  maxRestarts: 'max-restarts',
  restartDelayMs: 'restart-delay-ms',
  minUptimeMs: 'min-uptime-ms',
  graceMs: 'grace-ms',
  stopTimeoutMs: 'stop-timeout-ms',
  stateDir: 'state-dir',
  cwd: 'cwd',
  writePidFile: 'write-pid-file',
  collectBytes: 'collect-bytes',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: true,
    doc: '托管开关。关掉后 `start()` 直接拒绝，`stop()` 仍可收拾已在跑的东西。',
  },
  maxRestarts: {
    kind: 'number',
    default: DEFAULT_MAX_RESTARTS,
    min: 0,
    max: 5,
    doc: '最多重启几次。台账值 1；0 = 崩了就不管。第二次重试的价值接近 0。',
  },
  restartDelayMs: {
    kind: 'number',
    default: DEFAULT_RESTART_DELAY_MS,
    min: 0,
    max: 60_000,
    advancedOnly: true,
    doc: '重启前等待，给端口与文件锁留出释放时间。',
  },
  minUptimeMs: {
    kind: 'number',
    default: DEFAULT_MIN_UPTIME_MS,
    min: 0,
    max: 600_000,
    advancedOnly: true,
    doc: '存活不足此时长算「秒退」，只影响话术（`crash-limit` 的 detail），不放宽重启预算。',
  },
  graceMs: {
    kind: 'number',
    default: DEFAULT_GRACE_MS,
    min: 1,
    max: 120_000,
    advancedOnly: true,
    doc: '终止宽限期，交给上游 provider 的终止程序（TERM→KILL 的分阶段由它决定）。',
  },
  stopTimeoutMs: {
    kind: 'number',
    default: DEFAULT_STOP_TIMEOUT_MS,
    min: 100,
    max: 300_000,
    advancedOnly: true,
    doc: '`stop()` 等静默的上限。超时如实报 `confirmed: false`，不假装停了。',
  },
  stateDir: {
    kind: 'string',
    default: '',
    doc: '状态文件目录。空 = `user/process-host`（走 O-002，0600）。',
  },
  cwd: {
    kind: 'string',
    default: '',
    doc: '默认工作目录。空 = 宿主工作目录（上游要求调用方显式给，本包不猜项目路径）。',
  },
  writePidFile: {
    kind: 'boolean',
    default: true,
    advancedOnly: true,
    doc: '拿得到 pid 时写 `<name>.pid`。**拿不到就不建文件**——假 pid 会让读它的脚本去杀无关进程。',
  },
  collectBytes: {
    kind: 'number',
    default: DEFAULT_COLLECT_BYTES,
    min: 1024,
    max: 4 * 1024 * 1024,
    advancedOnly: true,
    doc: '每流收集上限（字节）。只留诊断尾巴，输出不进日志。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次状态变化一行日志。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: true,
  maxRestarts: DEFAULT_MAX_RESTARTS,
  restartDelayMs: DEFAULT_RESTART_DELAY_MS,
  minUptimeMs: DEFAULT_MIN_UPTIME_MS,
  graceMs: DEFAULT_GRACE_MS,
  stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
  stateDir: '',
  cwd: '',
  writePidFile: true,
  collectBytes: DEFAULT_COLLECT_BYTES,
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
  title: '进程托管',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-process-host',
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
    maxRestarts: clampInt(raw['maxRestarts'], DEFAULT_CONFIG.maxRestarts, 0, 5),
    restartDelayMs: clampInt(raw['restartDelayMs'], DEFAULT_CONFIG.restartDelayMs, 0, 60_000),
    minUptimeMs: clampInt(raw['minUptimeMs'], DEFAULT_CONFIG.minUptimeMs, 0, 600_000),
    graceMs: clampInt(raw['graceMs'], DEFAULT_CONFIG.graceMs, 1, 120_000),
    stopTimeoutMs: clampInt(raw['stopTimeoutMs'], DEFAULT_CONFIG.stopTimeoutMs, 100, 300_000),
    stateDir: text('stateDir', DEFAULT_CONFIG.stateDir),
    cwd: text('cwd', DEFAULT_CONFIG.cwd),
    writePidFile: bool('writePidFile', DEFAULT_CONFIG.writePidFile),
    collectBytes: clampInt(raw['collectBytes'], DEFAULT_CONFIG.collectBytes, 1024, 4 * 1024 * 1024),
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

  for (const key of ['stateDir', 'cwd'] as const) {
    const given = raw[key]
    if (given !== undefined && typeof given !== 'string') drift.push(key)
  }

  for (const key of ['maxRestarts', 'restartDelayMs', 'minUptimeMs', 'graceMs', 'stopTimeoutMs', 'collectBytes'] as const) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given)) drift.push(key)
  }

  return drift
}
