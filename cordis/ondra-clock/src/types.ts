/**
 * O-003 `ondra-clock` 的对外契约。
 *
 * 定位：**全仓唯一的「现在几点」与「今天是哪一天」**。
 * 消费方（03:00 衰减结算、22:00 做梦、02:00 日记、23:00–08:00 静默时段…）
 * 一律经 `ctx.get('ondra-clock')` 取时间，**不得各自 `new Date()`**。
 *
 * 为什么必须收成一个插件：自然日判定只要有一处写错，就会出现「同一天结算两次」
 * 或「跨天漏结算」，而这类错误只在换日那一刻暴露，事后无法从日志看出规律。
 *
 * 本文件只放类型与错误类；纯日历数学在 `time.ts`，接线与定时器在 `index.ts`。
 */

/** 本插件注册的服务键（连字符，非 `ondra:clock`）。全仓唯一归属。 */
export const CLOCK_SERVICE_KEY = 'ondra-clock'

/** 撤销函数：调用即取消定时器，重复调用无副作用。 */
export type Disposer = () => void

/** 时区来源：配置生效，还是配置非法后退回系统时区。 */
export type TimeZoneSource = 'config' | 'system'

/** 自然日的一把「日历切片」：年月日与时分的时区解读结果。 */
export interface CalendarParts {
  /** 年。 */
  readonly year: number
  /** 月，1–12（不是 JS 的 0–11）。 */
  readonly month: number
  /** 日，1–31。 */
  readonly day: number
  /** 时，0–23。 */
  readonly hour: number
  /** 分，0–59。 */
  readonly minute: number
  /** 秒，0–59。 */
  readonly second: number
}

/** 时间服务。 */
export interface ClockService {
  /** 生效时区（IANA 名，例如 `Asia/Shanghai`）。 */
  readonly timeZone: string
  /** 时区来源，供体检面板解释「为什么按这个时区算」。 */
  readonly timeZoneSource: TimeZoneSource
  /** 当前毫秒时间戳。所有「现在」都必须从这里取。 */
  now(): number
  /** 当前时间对应的 `Date`（仅供需要 Date 的第三方 API 使用）。 */
  nowDate(): Date
  /**
   * 把时间戳拆成生效时区的日历字段。
   * @param epoch 毫秒时间戳，省略即现在。
   */
  parts(epoch?: number): CalendarParts
  /**
   * 自然日键，格式 `YYYY-MM-DD`（生效时区）。
   * @param epoch 毫秒时间戳，省略即现在。
   */
  dayKey(epoch?: number): string
  /**
   * 自然日序号：同一自然日内恒定，跨一天严格 +1。
   *
   * 用「日历三元组换算」而不是「毫秒除以一天」，因此**夏令时切换日不会跳号或重复**。
   * 用途：判断「是不是新的一天」「隔了几天」。
   * @param epoch 毫秒时间戳，省略即现在。
   */
  dayNumber(epoch?: number): number
  /**
   * 两个时刻之间相差几个自然日（带方向，`b - a`）。
   * @param a 起点毫秒时间戳。
   * @param b 终点毫秒时间戳。
   */
  daysBetween(a: number, b: number): number
  /**
   * 某个时刻所在自然日的 00:00 时间戳（生效时区）。
   *
   * 夏令时跳过 00:00 的地区会落到当天第一个存在的时刻（通常是 01:00），
   * 不会退回前一天 23:00。
   * @param epoch 毫秒时间戳，省略即现在。
   */
  startOfDay(epoch?: number): number
  /**
   * 一天中的第几分钟（0–1439）。
   * @param epoch 毫秒时间戳，省略即现在。
   */
  minuteOfDay(epoch?: number): number
  /**
   * `HH:MM` 形式的当前时刻文本。
   * @param epoch 毫秒时间戳，省略即现在。
   */
  hhmm(epoch?: number): string
  /**
   * 判断某时刻是否落在时间窗内，支持跨零点（如 `23:00`–`08:00`）。
   *
   * 边界为**左闭右开**：`start` 含、`end` 不含。
   * `start === end` 视为**空窗口**（恒 false），刻意不解释成「整天」——
   * 否则把静默时段误写成 `23:00`–`23:00` 就会变成全天静默，且很难看出来。
   * @param start 起始 `HH:MM`。
   * @param end 结束 `HH:MM`。
   * @param epoch 毫秒时间戳，省略即现在。
   */
  withinWindow(start: string, end: string, epoch?: number): boolean
  /**
   * 按模板格式化时间。支持 `YYYY` / `MM` / `DD` / `HH` / `mm` / `ss` / `SSS`。
   * @param epoch 毫秒时间戳。
   * @param pattern 模板，默认 `YYYY-MM-DD HH:mm:ss`。
   */
  format(epoch: number, pattern?: string): string
  /**
   * 每隔固定间隔执行一次。
   *
   * 底层是 `setInterval`：进程休眠唤醒后只补一次，不会把错过的次数连发。
   * 回调抛错只记日志，不打断后续触发。
   * @param intervalMs 间隔毫秒，最小 1000。
   * @param fn 回调。
   * @returns 撤销函数。
   */
  every(intervalMs: number, fn: () => void): Disposer
  /**
   * 每天到点执行一次（生效时区）。
   *
   * 实现是**轮询比对自然日**，不是「算距下次的毫秒」：跨夏令时不错点、
   * 休眠唤醒能补一次、同一自然日不会重复触发、装载当天已过点不补。
   * @param hhmm 目标 `HH:MM`。
   * @param fn 回调，收到触发时的自然日键。
   * @returns 撤销函数。
   */
  dailyAt(hhmm: string, fn: (dayKey: string) => void): Disposer
  /**
   * 延时执行一次。卸载插件会撤销未触发的任务。
   * @param ms 延时毫秒。
   * @param fn 回调。
   * @returns 撤销函数（未到点前调用即取消）。
   */
  after(ms: number, fn: () => void): Disposer
  /**
   * 距某个时刻过去了多少毫秒（负数表示还没到）。
   * @param epoch 起点毫秒时间戳。
   */
  since(epoch: number): number
}

/** 时间窗或时刻写法不合法。 */
export class ClockFormatError extends Error {
  /** 出错的原文。 */
  readonly raw: string

  constructor(raw: string, detail: string) {
    super('时间写法「' + raw + '」不合法：' + detail)
    this.name = 'ClockFormatError'
    this.raw = raw
  }
}
