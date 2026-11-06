/**
 * O-003 `ondra-clock`：统一时间源与自然日判定。
 *
 * 四个必须写清楚的取舍（每一条都对应一种只在特定时刻才炸的 bug）：
 *
 * 1. **自然日用「日历三元组换算」，不用「毫秒 ÷ 86400000」。**
 *    后者在夏令时切换日会算出同一个日号（23 小时的年份）或直接跳号，
 *    表现为「同一天结算两次」或「今天没结算」。而且毫秒除法算的是 UTC 日，
 *    对 `Asia/Shanghai` 这种 +08:00 时区，每天 08:00 之前都会被算成前一天。
 *
 * 2. **时区默认钉成 `Asia/Shanghai`，但非法配置不拒绝启动。**
 *    系统默认时区会随用户改设置而变，一旦变就把「今天」整体平移，
 *    连带 03:00 结算、22:00 做梦全部错位，所以默认必须确定。
 *    配置写错时退回系统时区 + `error` 日志 + `timeZoneSource='system'`，
 *    让 O-077 体检能看见——比「整插件不注册、下游全拿 undefined」更容易定位。
 *
 * 3. **`dailyAt` 用轮询比对自然日，不算「距下次的毫秒」。**
 *    算毫秒要处理夏令时、系统休眠、进程挂起；轮询只需要回答「现在是不是
 *    跨过了目标点且今天还没跑过」。代价是最多迟一个轮询周期（默认 30 秒）。
 *
 * 4. **不提供 `isDeepNight()`。** 手册里「深夜」有两套定义：能量域是 0–6 点
 *    （§3.3），节奏域是 23:00–06:00（§9.2）。压成一个布尔函数必然误导一半调用方，
 *    所以只给 `withinWindow(start, end)`，窗口由调用方按自己的规范传。
 */

import type { Context } from '@ntars/cordis'
import { CLOCK_SERVICE_KEY } from './types.js'
import type { CalendarParts, ClockService, Disposer, TimeZoneSource } from './types.js'
import {
  calendarIn,
  formatIn,
  isValidTimeZone,
  pad2,
  parseHhmm,
  startOfDayIn,
  toDayNumber,
} from './time.js'

export type * from './types.js'
// 契约里既有纯类型也有运行时值，分开导出才不违背「类型导入不得混入运行时值」。
export { CLOCK_SERVICE_KEY, ClockFormatError } from './types.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-clock'

/** `dailyAt` 的轮询间隔下限：比这更密没有意义，只会白烧 CPU。 */
const MIN_POLL_MS = 5_000
/** `every` 的间隔下限。 */
const MIN_INTERVAL_MS = 1_000
/** 默认时间模板。 */
const DEFAULT_PATTERN = 'YYYY-MM-DD HH:mm:ss'

/**
 * O-001 身份服务的**结构对位**子集：只读日志命名空间根。
 *
 * 不 `import` O-001 源码：那会让两个插件编译期互相绑定（§15.5）。
 */
interface IdentityLike {
  loggerName(feature: string): string
}

/** 配置项：全部有默认值。 */
export interface Config {
  /** IANA 时区名。默认 `Asia/Shanghai`——不跟系统默认走，理由见文件头第 2 条。 */
  readonly timeZone: string
  /** `dailyAt` 的轮询间隔毫秒，默认 30000；低于 5000 按 5000 执行。 */
  readonly pollIntervalMs: number
}

/** 默认配置。 */
const DEFAULT_CONFIG: Config = {
  timeZone: 'Asia/Shanghai',
  pollIntervalMs: 30_000,
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 补全配置。
 * @param value 宿主传入的配置行内容。
 */
function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const tz = raw['timeZone']
  const poll = raw['pollIntervalMs']
  return {
    timeZone: typeof tz === 'string' && tz.trim() !== '' ? tz.trim() : DEFAULT_CONFIG.timeZone,
    pollIntervalMs:
      typeof poll === 'number' && Number.isFinite(poll)
        ? Math.max(MIN_POLL_MS, Math.floor(poll))
        : DEFAULT_CONFIG.pollIntervalMs,
  }
}

/** 取系统时区；取不到就退回 UTC（比空字符串安全）。 */
function systemTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof zone === 'string' && zone.trim() !== '' ? zone : 'UTC'
}

/** 定时器句柄集合与服务的构造结果。 */
interface BuiltClock {
  readonly service: ClockService
  /** 清掉本服务登记过的全部定时器。 */
  readonly disposeTimers: () => void
}

/**
 * 构造时间服务。
 * @param config 已补全的配置。
 * @param timeZone 实际生效时区（可能已被退回系统时区）。
 * @param timeZoneSource 时区来源。
 * @param report 定时器回调抛错时的上报口（只记日志，不外抛）。
 */
function createService(
  config: Config,
  timeZone: string,
  timeZoneSource: TimeZoneSource,
  report: (error: unknown) => void,
): BuiltClock {
  /** 定时器清单：全部登记，卸载时统一清。 */
  const timers = new Set<ReturnType<typeof setTimeout>>()

  /** 登记一个定时器，返回撤销函数。 */
  const track = (handle: ReturnType<typeof setTimeout>): Disposer => {
    timers.add(handle)
    return () => {
      clearInterval(handle)
      clearTimeout(handle)
      timers.delete(handle)
    }
  }

  /** 回调统一包一层 try/catch：一个坏回调不能拖死整条时间线。 */
  const guard = (fn: () => void): (() => void) => {
    return () => {
      try {
        fn()
      } catch (error) {
        report(error)
      }
    }
  }

  const service: ClockService = {
    timeZone,
    timeZoneSource,
    now(): number {
      return Date.now()
    },
    nowDate(): Date {
      return new Date(Date.now())
    },
    parts(epoch?: number): CalendarParts {
      return calendarIn(epoch ?? Date.now(), timeZone)
    },
    dayKey(epoch?: number): string {
      const p = calendarIn(epoch ?? Date.now(), timeZone)
      return String(p.year) + '-' + pad2(p.month) + '-' + pad2(p.day)
    },
    dayNumber(epoch?: number): number {
      return toDayNumber(calendarIn(epoch ?? Date.now(), timeZone))
    },
    daysBetween(a: number, b: number): number {
      return toDayNumber(calendarIn(b, timeZone)) - toDayNumber(calendarIn(a, timeZone))
    },
    startOfDay(epoch?: number): number {
      return startOfDayIn(epoch ?? Date.now(), timeZone)
    },
    minuteOfDay(epoch?: number): number {
      const p = calendarIn(epoch ?? Date.now(), timeZone)
      return p.hour * 60 + p.minute
    },
    hhmm(epoch?: number): string {
      const p = calendarIn(epoch ?? Date.now(), timeZone)
      return pad2(p.hour) + ':' + pad2(p.minute)
    },
    withinWindow(start: string, end: string, epoch?: number): boolean {
      const from = parseHhmm(start)
      const to = parseHhmm(end)
      // 相等视为空窗口：宁可「没拦住」，也不要因为手滑写成 23:00–23:00 就全天静默。
      if (from === to) return false
      const current = service.minuteOfDay(epoch)
      if (from < to) return current >= from && current < to
      // 跨零点：23:00–08:00 这类，取并集。
      return current >= from || current < to
    },
    format(epoch: number, pattern?: string): string {
      return formatIn(epoch, timeZone, pattern ?? DEFAULT_PATTERN)
    },
    every(intervalMs: number, fn: () => void): Disposer {
      const period = Math.max(MIN_INTERVAL_MS, Math.floor(intervalMs))
      const handle = setInterval(guard(fn), period)
      return track(handle)
    },
    dailyAt(hhmm: string, fn: (dayKey: string) => void): Disposer {
      const targetMinute = parseHhmm(hhmm)
      const mountedParts = calendarIn(Date.now(), timeZone)
      const mountedDay = toDayNumber(mountedParts)
      /**
       * 装载当天若目标点已过，**不补跑**。
       *
       * 理由：补跑会让「02:00 日记」在中午启动时突然写一篇，而 02:00 那一刻的
       * 真实上下文已经不在了。宁可错过，不可造假——这是本插件唯一一处
       * 「故意不补偿」的地方，休眠唤醒仍会补一次。
       */
      const skipMountDay = mountedParts.hour * 60 + mountedParts.minute >= targetMinute
      /** 上次触发过的自然日号；-1 表示从未触发。 */
      let lastFiredDay = -1

      const tick = () => {
        const at = Date.now()
        const p = calendarIn(at, timeZone)
        const today = toDayNumber(p)
        if (p.hour * 60 + p.minute < targetMinute) return
        if (lastFiredDay === today) return
        if (today === mountedDay && skipMountDay) {
          lastFiredDay = today
          return
        }
        lastFiredDay = today
        fn(service.dayKey(at))
      }

      const handle = setInterval(guard(tick), config.pollIntervalMs)
      return track(handle)
    },
    after(ms: number, fn: () => void): Disposer {
      const handle = setTimeout(guard(fn), Math.max(0, Math.floor(ms)))
      return track(handle)
    },
    since(epoch: number): number {
      return Date.now() - epoch
    },
  }

  return {
    service,
    disposeTimers(): void {
      for (const handle of timers) {
        clearInterval(handle)
        clearTimeout(handle)
      }
      timers.clear()
    },
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 时间服务；未装载 O-003 时为 undefined。 */
    'ondra-clock'?: ClockService
  }
}

/**
 * Cordis 入口：注册时间服务，并把定时器纳入 effect 生命周期。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Config): void {
  const complete = completeConfig(config)
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('clock') : 'ondra.clock')

  let timeZone = complete.timeZone
  let timeZoneSource: TimeZoneSource = 'config'
  if (!isValidTimeZone(timeZone)) {
    const fallback = systemTimeZone()
    log.error(
      '时区「%s」不是合法的 IANA 时区名，已退回系统时区「%s」；请尽快修正配置',
      timeZone,
      fallback,
    )
    timeZone = fallback
    timeZoneSource = 'system'
  }

  const built = createService(complete, timeZone, timeZoneSource, (error: unknown) => {
    log.error('定时任务回调抛错（已忽略，不影响后续触发）：%s', error instanceof Error ? error.message : String(error))
  })
  const service = built.service

  ctx.effect(
    () => {
      const removeService = ctx.provide(CLOCK_SERVICE_KEY, service)
      return () => {
        // 先清定时器再撤服务：定时器回调里可能还要读时间。
        built.disposeTimers()
        removeService()
      }
    },
    'ondra-clock: 注册时间服务',
  )

  log.info(
    '时间服务就绪：时区 %s（来源 %s），今天 %s（日号 %d），现在 %s',
    service.timeZone,
    service.timeZoneSource,
    service.dayKey(),
    service.dayNumber(),
    service.hhmm(),
  )
  if (timeZoneSource === 'system') {
    log.warn('当前按系统时区计算自然日；跨时区部署时请确认结算时刻符合预期')
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
      if (!isValidTimeZone(complete.timeZone)) {
        issues.push({ message: '配置项 timeZone「' + complete.timeZone + '」不是合法的 IANA 时区名' })
      }
      if (issues.length > 0) return { issues }
      return { value: complete }
    },
  },
}
