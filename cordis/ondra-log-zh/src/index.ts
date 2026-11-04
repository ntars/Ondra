/**
 * O-004 `ondra-log-zh`：中文日志双层 + 4MB×3 轮转 + 单进程写放大保护。
 *
 * 五条必须写清楚的设计（前三条来自手册，后两条来自实现时的真实教训）：
 *
 * 1. **双层各写各的文件**。中文层只收显式 `human()` 的句子，代码层收全仓
 *    `ctx.logger` 的结构化消息。混在一起，用户翻日志第一屏永远是内部噪声。
 *
 * 2. **按大小轮转，不按日期切分**。日期切分在「一天写 200MB」时没有上界；
 *    按大小切能给出确定上界 `4MB × (3+1) = 16MB`。
 *
 * 3. **单进程写放大保护**（手册 §8.3）。同键窗口内只放行第一条，
 *    窗口到期由定时器**主动扫**并补一行「另有 N 条」——
 *    如果只在同键下次出现时才补，错误爆发完就停时那条补充永远写不出来。
 *
 * 4. **同步写**。异步 `appendFile` 在进程崩溃时会丢尾部日志，
 *    而崩溃前最后几行恰恰最有价值。代价是短暂阻塞事件循环，
 *    所以「写放大保护 + 大小缓存」必须同时到位，否则 1000 条/秒会把主线程拖死。
 *
 * 5. **日志插件自己绝不抛错**。exporter 被宿主的 `logger.info()` 同步调用，
 *    这里抛一个 `JSON.stringify` 的循环引用错，会直接冒泡进业务代码。
 *    因此 exporter 整体包 try/catch，失败只累加计数。
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@ntars/cordis'
import { LOG_ZH_SERVICE_KEY } from './types.js'
import type { HumanEntry, LogLevel, LogStats, LogZhService } from './types.js'
import { AmplificationGuard } from './dedupe.js'
import type { DedupeLabel } from './dedupe.js'
import { LEVEL_RANK, dedupeKeyOf, flattenArgs, localStamp, safeStringify } from './format.js'
import { SizeRotator } from './rotate.js'

export type * from './types.js'
// 契约里只有纯类型与一个运行时键，分开导出才不违背「类型导入不得混入运行时值」。
export { LOG_ZH_SERVICE_KEY } from './types.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-log-zh'

/** 单个日志文件的大小上限：4MB。 */
const MAX_FILE_BYTES = 4 * 1024 * 1024
/** 保留的历史文件份数（不含当前文件）。 */
const MAX_ROTATED = 3
/** 写放大保护窗口：1000 毫秒。 */
const SUPPRESS_WINDOW_MS = 1_000
/** 写放大保护的键上限：防「每秒一千种不同的错」把内存吃爆。 */
const MAX_DEDUPE_KEYS = 2_000
/** 连续写盘失败多少次后转仅内存。 */
const MAX_WRITE_FAILURES = 3
/** 仅内存模式下每层保留的行数。 */
const MEMORY_BUFFER_LINES = 500
/** `tailHuman()` 的默认行数。 */
const DEFAULT_TAIL = 200

/**
 * Cordis 的 `LoggerType` 映射到本插件的级别数值（越小越严重）。
 *
 * **必须显式映射，不能假定两者同序**：Cordis 的 `LoggerLevel` 枚举是
 * `ERROR 0 / INFO 1 / WARN 2 / DEBUG 3`——**info 比 warn 还"轻"**，
 * 而本插件（以及所有人的直觉）是 `error < warn < info < debug`。
 * 直接拿 `message.type` 去查本插件的 `LEVEL_RANK` 是正确的，
 * 但若误用 Cordis 的数值去比较，warn 会被当成比 info 更啰嗦而挡掉。
 */
const LEVEL_RANK_OF_CORDIS: Record<string, number> = {
  error: LEVEL_RANK.error,
  warn: LEVEL_RANK.warn,
  info: LEVEL_RANK.info,
  debug: LEVEL_RANK.debug,
}

/**
 * 传给 Cordis `Exporter.levels.default` 的阈值。
 *
 * 固定 `3`（Cordis `LoggerLevel.DEBUG`，即放行最多的一档）：过滤权**全部收回本插件内部**。
 * 理由是 `Exporter.levels` 只能表达一个单点阈值（`targetLevel < level` 就丢），
 * 既表达不了「只要 warn 和 error」这种集合，又因为 Cordis 的 `INFO=1 / WARN=2`
 * 顺序与直觉相反，任何映射表都会在某一档错手。
 */
const CORDIS_PASS_ALL_LEVEL = 3

/** 配置项：全部有默认值。 */
export interface Config {
  /** 日志目录绝对路径。留空则问 `path-layout`；相对路径会被忽略。 */
  readonly logDir: string
  /** 中文层文件名。 */
  readonly humanFileName: string
  /** 代码层文件名。 */
  readonly codeFileName: string
  /** 单文件大小上限（字节），默认 4MB。 */
  readonly maxFileBytes: number
  /** 保留的历史份数，默认 3（连同当前文件共 4 份）。 */
  readonly maxRotated: number
  /** 代码层最低级别：低于此级别不写代码层。 */
  readonly codeLevel: LogLevel
  /** 是否把全仓 `ctx.logger` 的消息接进代码层。 */
  readonly bridgeLogger: boolean
  /** 是否开启写放大保护。 */
  readonly dedupe: boolean
}

/** 默认配置。 */
const DEFAULT_CONFIG: Config = {
  logDir: '',
  humanFileName: 'ondra.log',
  codeFileName: 'ondra-code.log',
  maxFileBytes: MAX_FILE_BYTES,
  maxRotated: MAX_ROTATED,
  codeLevel: 'info',
  bridgeLogger: true,
  dedupe: true,
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 补全配置。 */
function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const str = (key: keyof Config, fallback: string): string => {
    const v = raw[key]
    return typeof v === 'string' ? v : fallback
  }
  const num = (key: keyof Config, fallback: number): number => {
    const v = raw[key]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
  }
  const bool = (key: keyof Config, fallback: boolean): boolean => {
    const v = raw[key]
    return typeof v === 'boolean' ? v : fallback
  }
  const rawLevel = raw['codeLevel']
  const level: LogLevel =
    rawLevel === 'error' || rawLevel === 'warn' || rawLevel === 'info' || rawLevel === 'debug'
      ? rawLevel
      : DEFAULT_CONFIG.codeLevel

  return {
    logDir: str('logDir', DEFAULT_CONFIG.logDir).trim(),
    humanFileName: str('humanFileName', DEFAULT_CONFIG.humanFileName),
    codeFileName: str('codeFileName', DEFAULT_CONFIG.codeFileName),
    maxFileBytes: num('maxFileBytes', DEFAULT_CONFIG.maxFileBytes),
    maxRotated: num('maxRotated', DEFAULT_CONFIG.maxRotated),
    codeLevel: level,
    bridgeLogger: bool('bridgeLogger', DEFAULT_CONFIG.bridgeLogger),
    dedupe: bool('dedupe', DEFAULT_CONFIG.dedupe),
  }
}

/** O-002 路径服务的结构对位子集：只要「确保 logs 目录存在」。 */
interface PathLayoutLike {
  ensure(area: 'logs', ...segments: string[]): string
}

/** O-003 时间服务的结构对位子集：只要格式化。 */
interface ClockLike {
  format(epoch: number, pattern?: string): string
}

/** O-001 身份服务的结构对位子集：只要日志命名空间根。 */
interface IdentityLike {
  loggerName(feature: string): string
}

/** 宿主日志消息（只声明本插件用到的字段）。 */
interface LoggerMessage {
  readonly ts: number
  readonly type: string
  readonly name: string
  readonly args: readonly unknown[]
}

/** 导出器形状（对齐 cordis `Exporter`，只声明用到的字段）。 */
interface LoggerExporter {
  readonly levels?: Record<string, number>
  export(message: LoggerMessage): void
}

/** 服务的构造结果：对外只给 `service`，其余留给插件内部。 */
interface BuiltLog {
  readonly service: LogZhService
  /** 扫到期窗口并补写汇总。 */
  readonly sweep: (at: number) => void
  /** 接全仓 logger 的旁路导出器。 */
  readonly exporter: LoggerExporter
}

/**
 * 构造日志服务。
 * @param config 已补全的配置。
 * @param logDir 已确定的日志目录（空串表示仅内存）。
 * @param stamp 时间戳格式化函数（优先来自 `ondra-clock`）。
 * @param onDegrade 降级为仅内存时的一次性通知。
 */
function createService(
  config: Config,
  logDir: string,
  stamp: (epoch: number) => string,
  onDegrade: (reason: string) => void,
): BuiltLog {
  const humanPath = logDir === '' ? '' : join(logDir, config.humanFileName)
  const codePath = logDir === '' ? '' : join(logDir, config.codeFileName)
  const rotator = new SizeRotator({ maxBytes: config.maxFileBytes, maxRotated: config.maxRotated })
  const guard = new AmplificationGuard(SUPPRESS_WINDOW_MS, MAX_DEDUPE_KEYS)

  let humanLines = 0
  let codeLines = 0
  let droppedLines = 0
  let failures = 0
  let memoryOnly = logDir === ''
  const humanBuffer: string[] = []
  const codeBuffer: string[] = []

  /** 把一行放进环形缓冲（两层共用同一个上限）。 */
  function remember(buffer: string[], line: string): void {
    buffer.push(line)
    if (buffer.length > MEMORY_BUFFER_LINES) buffer.shift()
  }

  /** 写盘失败后的统一处理：计数、进内存、连续失败则降级。 */
  function handleFailure(line: string, buffer: string[]): void {
    failures += 1
    droppedLines += 1
    remember(buffer, line)
    if (failures >= MAX_WRITE_FAILURES && !memoryOnly) {
      memoryOnly = true
      onDegrade('连续 ' + String(failures) + ' 次写盘失败')
    }
  }

  /** 写中文层一行。 */
  function writeHuman(line: string): void {
    humanLines += 1
    if (memoryOnly) {
      remember(humanBuffer, line)
      return
    }
    try {
      rotator.append(humanPath, line + '\n')
      failures = 0
    } catch {
      handleFailure(line, humanBuffer)
    }
  }

  /** 写代码层一行。 */
  function writeCode(line: string): void {
    codeLines += 1
    if (memoryOnly) {
      remember(codeBuffer, line)
      return
    }
    try {
      rotator.append(codePath, line + '\n')
      failures = 0
    } catch {
      handleFailure(line, codeBuffer)
    }
  }

  /** 补写「另有 N 条」：中文层触发时同时给代码层留一份。 */
  function writeSummary(summary: { label: DedupeLabel; suppressed: number }, at: number): void {
    const line =
      stamp(at) + ' ' + summary.label.prefix +
      '另有 ' + String(summary.suppressed) + ' 条相同内容已折叠（写放大保护，窗口 1 秒）'
    writeCode(line)
    if (summary.label.layer === 'human') writeHuman(line)
  }

  const service: LogZhService = {
    human(entry: HumanEntry): void {
      const now = Date.now()
      const feature = entry.feature ?? 'app'
      const label: DedupeLabel = {
        layer: 'human',
        prefix: entry.level.toUpperCase() + ' [' + feature + '] ',
      }
      // 中文层只对 error / warn 去重：info 是「谁产生谁负责」的业务叙述，
      // 折叠掉会让人误以为事件没发生。
      if (config.dedupe && LEVEL_RANK[entry.level] <= LEVEL_RANK['warn']) {
        const key = 'h|' + entry.level + '|' + feature + '|' + dedupeKeyOf(entry.message)
        if (!guard.hit(key, now, label)) return
      }
      const detail = entry.detail ? ' | ' + safeStringify(entry.detail) : ''
      writeHuman(stamp(now) + ' ' + label.prefix + entry.message + detail)
      if (LEVEL_RANK[entry.level] <= LEVEL_RANK[config.codeLevel]) {
        writeCode(stamp(now) + ' ' + label.prefix + entry.message)
      }
    },
    info(message: string, feature?: string): void {
      service.human({ level: 'info', message, feature })
    },
    warn(message: string, feature?: string): void {
      service.human({ level: 'warn', message, feature })
    },
    error(message: string, feature?: string): void {
      service.human({ level: 'error', message, feature })
    },
    debug(message: string, detail?: Record<string, unknown>): void {
      service.human({ level: 'debug', message, feature: 'debug', detail })
    },
    stats(): LogStats {
      return {
        humanLines,
        codeLines,
        droppedLines,
        // 只统计已结算的窗口；当前窗口内的计数要等 sweep 才落账，属刻意取舍。
        suppressedLines: guard.suppressed,
        memoryOnly,
        humanPath,
        codePath,
      }
    },
    tailHuman(limit = DEFAULT_TAIL): readonly string[] {
      const count = Math.max(1, Math.floor(limit))
      if (memoryOnly || humanPath === '') return humanBuffer.slice(-count)
      try {
        const lines = readFileSync(humanPath, 'utf8').split('\n')
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        return lines.slice(-count)
      } catch {
        return humanBuffer.slice(-count)
      }
    },
  }

  const exporter: LoggerExporter = {
    // 用「放行全部」的阈值，真正的级别过滤在 export 内部按本插件自己的表做。
    levels: { default: CORDIS_PASS_ALL_LEVEL },
    export(message: LoggerMessage): void {
      // 日志插件绝不能把错误抛回业务代码：整体兜住。
      try {
        const rank = LEVEL_RANK_OF_CORDIS[message.type]
        if (rank === undefined) return
        // 低于配置级别的不写（`codeLevel='warn'` 时 info/debug 到此为止）。
        if (rank > LEVEL_RANK[config.codeLevel]) return
        const prefix = message.type.toUpperCase() + ' [' + message.name + '] '
        const text = flattenArgs(message.args)
        if (config.dedupe) {
          const key = 'c|' + message.type + '|' + message.name + '|' + dedupeKeyOf(text)
          if (!guard.hit(key, message.ts, { layer: 'code', prefix })) return
        }
        writeCode(stamp(message.ts) + ' ' + prefix + text)
      } catch {
        // 静默：日志失败不能反过来影响调用方。
      }
    },
  }

  return {
    service,
    exporter,
    sweep(at: number): void {
      for (const summary of guard.sweep(at)) writeSummary(summary, at)
    },
  }
}

/**
 * 让定时器不阻止进程退出。
 *
 * 不直接用 `handle.unref()`：该属性只在 Node 的 Timeout 上存在，
 * 在浏览器/Worker 环境里 `setInterval` 返回数字，直接调用会抛错。
 * @param handle 定时器句柄。
 */
function unrefTimer(handle: ReturnType<typeof setInterval>): void {
  const maybe = handle as unknown as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
}

declare module '@ntars/cordis' {
  interface Context {
    /** 中文日志服务；未装载 O-004 时为 undefined。 */
    'ondra-log-zh'?: LogZhService
  }
}

/**
 * Cordis 入口：确定日志目录、注册服务、桥接全仓 logger、启动折叠汇总定时器。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Config): void {
  const complete = completeConfig(config)
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('log-zh') : 'ondra.log-zh')

  // 路径解析：配置优先，其次问 path-layout（软依赖，缺席则退内存模式）。
  let logDir = ''
  if (complete.logDir !== '') {
    if (isAbsolute(complete.logDir)) {
      logDir = complete.logDir
    } else {
      log.warn('配置的日志目录「%s」不是绝对路径，已忽略并改用数据目录', complete.logDir)
    }
  }
  if (logDir === '') {
    const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
    if (!layout) {
      log.warn('未装载 ondra-path-layout，日志转仅内存模式（重启即丢）')
    } else {
      try {
        logDir = layout.ensure('logs')
      } catch (error) {
        log.warn(
          '日志目录创建失败，转仅内存模式：%s',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  // 时间戳：优先用产品统一时间源；缺席才退回进程本地时区。
  const clock = ctx.get('ondra-clock') as ClockLike | undefined
  const stamp = clock ? (epoch: number): string => clock.format(epoch) : localStamp
  if (!clock) {
    log.warn('未装载 ondra-clock，日志时间戳改用进程本地时区')
  }

  const built = createService(complete, logDir, stamp, (reason: string) => {
    log.error('日志写入已降级为仅内存：%s；请检查磁盘空间与目录权限', reason)
  })
  const service = built.service

  ctx.effect(
    () => {
      const removeService = ctx.provide(LOG_ZH_SERVICE_KEY, service)
      // 桥接全仓 logger：exporter() 自带 ctx.effect，随本 fiber 卸载。
      const removeExporter = complete.bridgeLogger
        ? ctx.logger.exporter(built.exporter)
        : () => {}
      // 折叠汇总定时器：每秒扫一次到期窗口，把「另有 N 条」补出去。
      const sweepTimer = setInterval(() => {
        try {
          built.sweep(Date.now())
        } catch {
          // 汇总失败不影响主流程。
        }
      }, SUPPRESS_WINDOW_MS)
      unrefTimer(sweepTimer)
      return () => {
        clearInterval(sweepTimer)
        removeExporter()
        removeService()
      }
    },
    'ondra-log-zh: 注册日志服务',
  )

  const stats = service.stats()
  log.info(
    '中文日志服务就绪：目录 %s，单文件上限 %d MB，保留 %d 份历史',
    stats.memoryOnly ? '（仅内存）' : logDir,
    Math.round(complete.maxFileBytes / (1024 * 1024)),
    complete.maxRotated,
  )
  if (stats.memoryOnly) {
    log.warn('当前为仅内存模式：日志不会落盘，重启即丢；请检查数据目录权限或 path-layout 是否装载')
  }
  if (!complete.dedupe) {
    log.warn('dedupe=false：关闭了写放大保护，同一错误高频重复时会持续写盘')
  }
}

/**
 * 配置校验器（标准 schema 形状）。
 * 不引 `@ntars/schemastery`：本轮禁止装依赖，手写校验更可控。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: Config } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      const complete = completeConfig(value)
      const issues: { message: string }[] = []
      if (complete.maxFileBytes < 64 * 1024) {
        issues.push({ message: '配置项 maxFileBytes 不得小于 65536（64KB）' })
      }
      if (complete.maxRotated < 1) {
        issues.push({ message: '配置项 maxRotated 不得小于 1' })
      }
      for (const field of ['humanFileName', 'codeFileName'] as const) {
        const fileName = complete[field]
        if (fileName.trim() === '' || fileName.includes('/') || fileName.includes('\\')) {
          issues.push({ message: '配置项 ' + field + ' 必须是纯文件名' })
        }
      }
      if (complete.humanFileName === complete.codeFileName) {
        issues.push({ message: '中文层与代码层不能同名，否则两层日志会互相覆盖' })
      }
      if (complete.logDir !== '' && !isAbsolute(complete.logDir)) {
        issues.push({ message: '配置项 logDir 必须是绝对路径或留空' })
      }
      if (issues.length > 0) return { issues }
      return { value: complete }
    },
  },
}
