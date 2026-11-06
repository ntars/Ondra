/**
 * QQ 防封六道闸（手册 §5.3，实测 12 拦截 0 误伤）。
 *
 * 顺序原则：**最便宜、最可能拒绝的放最前**。内容检查只用一次字符串比较，
 * 配额检查要读三个窗口——把贵的放前面，等于每条消息都为了一次必然的拒绝
 * 多做十次计算。
 *
 * | 序 | 闸 | 判据 |
 * |---|---|---|
 * | 1 | 内容闸 | 空 / 超 1800 / 命中正则 |
 * | 2 | 深夜静默 | 00:30–07:30（东八区），**只拦主动发言** |
 * | 3 | 重复去重 | 窗口 30 分钟、最短 4 字 |
 * | 4 | 熔断 | 连续 3 次命中风控 → 全局停发 30 分钟 |
 * | 5 | 退避 | 命中风控后的指数退避 / 连续失败 3 次停 5 分钟 |
 * | 6 | 令牌桶 | 20/分 · 200/时 · 1500/日 |
 * | 7 | 会话冷却 | 群 5 秒 / 私聊 3 秒 |
 *
 * 表里第 4、5 条都在「拒绝」侧，不属于「发送前的修饰」——本插件的
 * `jitterMs` 抖动才是修饰，它只在放行时给出「还需要等多久」。
 *
 * ## 一条刻意的口径：固定窗口，不是滑动窗口
 *
 * 三个令牌桶用「首次命中时刻 + 窗口长度」的固定窗口。滑动窗口要多存
 * 每个请求的时刻数组，内存与落盘都涨一个量级；而 §5.3 的数值本来就是
 * 长期曲线（腾讯看的是日总量），不是「任意 60 秒内绝不超过 20 条」。
 * 代价写进 README：窗口边界处可能双倍突发，所以默认值只用了上限的一半。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from './settings.js'
import type { GateReason, GateVerdict, LogLike } from './types.js'
import { BACKOFF_SECONDS, RISK_CODES, TZ_OFFSET_MIN } from './types.js'

/** 一分钟（毫秒）。 */
const MINUTE_MS = 60_000

/** 一小时（毫秒）。 */
const HOUR_MS = 3_600_000

/** 一天（毫秒）。 */
const DAY_MS = 86_400_000

/** 去重表最多记多少条。超了删最旧的：去重是「防重复」，不是归档。 */
const DEDUPE_CAP = 512

/** 连续失败几次后停发（手册 §5.3-6：连续失败 3 次停 5 分钟）。 */
const FAILURE_STRIKES = 3

/** 一个固定窗口。 */
export interface RateWindow {
  /** 窗口起点（毫秒）。 */
  readonly at: number
  /** 窗口内已用条数。 */
  readonly count: number
}

/** 闸门状态。**必须落盘**：重启清零等于给防封开后门（手册 §5.3-7）。 */
export interface GateState {
  /** 分钟桶。 */
  readonly minute: RateWindow
  /** 小时桶。 */
  readonly hour: RateWindow
  /** 日桶。 */
  readonly day: RateWindow
  /** 每个会话最后一次发送时刻。 */
  readonly lastSend: Readonly<Record<string, number>>
  /** 去重表：指纹 → 最后发送时刻。 */
  readonly dedupe: Readonly<Record<string, number>>
  /** 连续命中风控次数。 */
  readonly strikes: number
  /** 熔断到期时刻（0 表示没熔断）。 */
  readonly circuitUntil: number
  /** 连续失败次数。 */
  readonly failures: number
  /** 停发到期时刻（0 表示没停）。 */
  readonly stopUntil: number
  /** 状态最后更新时刻。 */
  readonly updatedAt: number
}

/** 一次判定的入参。 */
export interface GateInput {
  /** 正文。 */
  readonly text: string
  /** 会话 id（冷却与去重用）。 */
  readonly conversationId: string
  /** 私聊还是群（冷却时长不同）。 */
  readonly kind: 'private' | 'group'
  /** 是否主动发言（决定深夜静默是否生效）。 */
  readonly active: boolean
}

/** 构造依赖。 */
export interface GateDeps {
  /** 配置。 */
  readonly settings: Config
  /** 时钟。 */
  readonly now: () => number
  /** 日志。 */
  readonly log: LogLike
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 一个字符串的稳定指纹（djb2，36 进制）。
 *
 * 只需要「同一条消息两次投递得到同一个值」。**不需要密码学强度**：
 * 用 sha256 会让每条消息多一次异步调用，而去重表本来就只在内存与本地文件里。
 * @param text 原文。
 */
export function hashOf(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * 东八区的「当天第几分钟」。
 *
 * 不用 `toLocaleString`：那依赖运行环境的时区数据库与系统设置，
 * 同一个时间戳在不同机器上会给出不同结果——而静默时段判错，
 * 表现就是「凌晨三点她突然说话」。
 * @param epoch 毫秒时间戳。
 */
export function minuteOfDay(epoch: number): number {
  const shifted = epoch + TZ_OFFSET_MIN * MINUTE_MS
  const withinDay = ((shifted % DAY_MS) + DAY_MS) % DAY_MS
  return Math.floor(withinDay / MINUTE_MS)
}

/**
 * 判断某一刻是否落在静默区间。
 * @param epoch 毫秒时间戳。
 * @param start 开始（当天第几分钟）。
 * @param end 结束（当天第几分钟）。
 */
export function inQuietHours(epoch: number, start: number, end: number): boolean {
  if (start === end) return false
  const minutes = minuteOfDay(epoch)
  if (start < end) return minutes >= start && minutes < end
  // 跨零点：22:00–06:00 这种。
  return minutes >= start || minutes < end
}

/** 空窗口。 */
function emptyWindow(at: number): RateWindow {
  return { at, count: 0 }
}

/**
 * 滚动固定窗口：过了窗长就从「现在」重开一格。
 * @param window 原窗口。
 * @param span 窗长（毫秒）。
 * @param now 现在。
 */
function rollWindow(window: RateWindow, span: number, now: number): RateWindow {
  if (now - window.at >= span || now < window.at) return emptyWindow(now)
  return window
}

/**
 * 把任意输入读成合法状态。**用于读盘后的清洗**：文件可能是人改的。
 * @param raw 原始值。
 * @param now 现在（用于兜底时间戳）。
 */
export function parseGateState(raw: unknown, now: number): GateState {
  const source = isRecord(raw) ? raw : {}
  const windowOf = (value: unknown, at: number): RateWindow => {
    if (!isRecord(value)) return emptyWindow(at)
    const rawAt = value['at']
    const rawCount = value['count']
    const count = typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount > 0 ? Math.trunc(rawCount) : 0
    if (typeof rawAt !== 'number' || !Number.isFinite(rawAt)) return emptyWindow(at)
    return { at: rawAt, count }
  }
  const mapOf = (value: unknown): Record<string, number> => {
    if (!isRecord(value)) return {}
    const out: Record<string, number> = {}
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'number' && Number.isFinite(item)) out[key] = item
    }
    return out
  }
  const numOf = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

  return {
    minute: windowOf(source['minute'], now),
    hour: windowOf(source['hour'], now),
    day: windowOf(source['day'], now),
    lastSend: mapOf(source['lastSend']),
    dedupe: mapOf(source['dedupe']),
    strikes: numOf(source['strikes']),
    circuitUntil: numOf(source['circuitUntil']),
    failures: numOf(source['failures']),
    stopUntil: numOf(source['stopUntil']),
    updatedAt: numOf(source['updatedAt']),
  }
}

/**
 * 把状态写下去（原子写，0600）。**永不抛错**。
 * @param path 文件路径；空串表示不落盘。
 * @param state 状态。
 * @param log 日志。
 * @returns 是否写成功。
 */
export function writeGateState(path: string, state: GateState, log: LogLike): boolean {
  if (path === '') return false
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = path + '.tmp'
    writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
    chmodSync(path, 0o600)
    return true
  } catch {
    log.warn('防封状态写盘失败：重启后计数会清零（等于给防封开后门）')
    return false
  }
}

/**
 * 读状态。文件不存在或读不动时返回空状态（**并提示一次**——
 * 「本来就没有」与「读不出来」不同，但都不该阻断启动）。
 * @param path 文件路径。
 * @param now 现在。
 * @param log 日志。
 */
export function readGateState(path: string, now: number, log: LogLike): GateState {
  if (path === '') return parseGateState(null, now)
  try {
    const text = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    return parseGateState(parsed, now)
  } catch {
    // 第一次启动时文件本来就不存在，不值得 warn；但要说一句，方便对拍
    // 「重启后是不是真的读到了上一次的计数」。
    log.debug?.('防封状态读不出来（首次启动属正常），按空状态启动：%s', path)
    return parseGateState(null, now)
  }
}

/** 闸门。 */
export class Gate {
  private readonly settings: Config
  private readonly now: () => number
  private readonly log: LogLike
  private readonly patterns: readonly RegExp[]
  private state: GateState
  private warnedPatterns = false

  /**
   * @param deps 依赖。
   * @param initial 初值（通常来自落盘）。
   */
  constructor(deps: GateDeps, initial?: GateState) {
    this.settings = deps.settings
    this.now = deps.now
    this.log = deps.log
    this.patterns = compilePatterns(deps.settings.blockPatterns)
    this.state = initial ?? parseGateState(null, this.now())
  }

  /** 当前状态（只读拷贝）。 */
  snapshot(): GateState {
    return this.state
  }

  /** 是否处于熔断。 */
  circuitOpen(): boolean {
    return this.now() < this.state.circuitUntil
  }

  /**
   * 判一条能不能发。**不改状态**（放行后由 `commit()` 记账）。
   * @param input 入参。
   */
  check(input: GateInput): GateVerdict {
    const now = this.now()

    // 1. 内容闸 —— 最便宜。
    const text = input.text
    if (text.trim() === '') {
      return verdict(false, 'empty', 0, '没有正文')
    }
    if (text.length > this.settings.contentMaxLen) {
      return verdict(
        false,
        'too-long',
        0,
        '正文 ' + String(text.length) + ' 字，超过内容闸 ' + String(this.settings.contentMaxLen) + ' 字',
      )
    }
    if (this.patterns.length > 0) {
      for (const pattern of this.patterns) {
        if (pattern.test(text)) {
          return verdict(false, 'blocked-content', 0, '命中内容闸：' + pattern.source)
        }
      }
    }

    // 2. 深夜静默 —— 只拦主动发言。
    if (this.settings.quietEnabled && input.active) {
      const start = toMinutes(this.settings.quietStart)
      const end = toMinutes(this.settings.quietEnd)
      if (inQuietHours(now, start, end)) {
        return verdict(false, 'quiet-hours', 0, '现在是静默时段，主动发言一律不发（被叫照回）')
      }
    }

    // 3. 重复去重 —— 先于配额：重复消息不该占额度。
    const dedupeKey = this.dedupeKeyOf(input)
    if (dedupeKey !== '') {
      const last = this.state.dedupe[dedupeKey]
      if (last !== undefined && now - last < this.settings.dedupeWindowMs) {
        return verdict(false, 'duplicate', 0, '同一句话刚发过（窗口 ' + String(this.settings.dedupeWindowMs) + 'ms）')
      }
    }

    // 4. 熔断 —— 被盯上时唯一正确的做法是完全闭嘴。
    if (now < this.state.circuitUntil) {
      return verdict(
        false,
        'circuit-open',
        0,
        '熔断中，还有 ' + String(Math.ceil((this.state.circuitUntil - now) / 1000)) + ' 秒',
      )
    }

    // 5. 退避 / 停发。
    if (now < this.state.stopUntil) {
      return verdict(
        false,
        'backing-off',
        this.state.stopUntil - now,
        '停发中，还有 ' + String(Math.ceil((this.state.stopUntil - now) / 1000)) + ' 秒',
      )
    }

    // 6. 令牌桶。
    const rateHit = this.rateLimitHit(now)
    if (rateHit !== '') {
      return verdict(false, 'rate-limited', 0, rateHit)
    }

    // 7. 会话冷却。
    const lastSend = this.state.lastSend[input.conversationId]
    const cooldown =
      input.kind === 'group' ? this.settings.cooldownGroupMs : this.settings.cooldownPrivateMs
    if (lastSend !== undefined) {
      const elapsed = now - lastSend
      if (elapsed >= 0 && elapsed < cooldown) {
        return verdict(false, 'cooling', cooldown - elapsed, '会话冷却中，还有 ' + String(cooldown - elapsed) + 'ms')
      }
    }

    // 放行。抖动是「发送前随机等」，不是拒绝。
    const delayMs =
      this.settings.jitterMs > 0 ? Math.floor(Math.random() * (this.settings.jitterMs + 1)) : 0
    return verdict(true, 'allow', delayMs, '放行')
  }

  /**
   * 记账：一条真的发出去了。
   * @param input 入参。
   */
  commit(input: GateInput): void {
    const now = this.now()
    const minute = rollWindow(this.state.minute, MINUTE_MS, now)
    const hour = rollWindow(this.state.hour, HOUR_MS, now)
    const day = rollWindow(this.state.day, DAY_MS, now)

    const lastSend: Record<string, number> = { ...this.state.lastSend }
    lastSend[input.conversationId] = now

    const dedupe: Record<string, number> = { ...this.state.dedupe }
    const key = this.dedupeKeyOf(input)
    if (key !== '') dedupe[key] = now

    this.state = {
      minute: { at: minute.at, count: minute.count + 1 },
      hour: { at: hour.at, count: hour.count + 1 },
      day: { at: day.at, count: day.count + 1 },
      lastSend: pruneMap(lastSend, now - HOUR_MS, 256),
      dedupe: pruneMap(dedupe, now - 2 * this.settings.dedupeWindowMs, DEDUPE_CAP),
      strikes: this.state.strikes,
      circuitUntil: this.state.circuitUntil,
      failures: this.state.failures,
      stopUntil: this.state.stopUntil,
      updatedAt: now,
    }
  }

  /**
   * 记一次发送结果。风控码与普通失败走两条路：
   * 风控 → 退避阶梯 + 累计熔断；普通失败 → 连续 3 次停 5 分钟。
   * @param ok 是否成功。
   * @param code 平台错误码（可选）。
   */
  noteResult(ok: boolean, code?: string): void {
    const now = this.now()
    if (ok) {
      this.state = { ...this.state, strikes: 0, failures: 0, updatedAt: now }
      return
    }

    const isRisk = code !== undefined && RISK_CODES.includes(code)
    if (isRisk) {
      const strikes = this.state.strikes + 1
      const ladder = BACKOFF_SECONDS[Math.min(strikes - 1, BACKOFF_SECONDS.length - 1)] ?? 30
      const circuitUntil =
        strikes >= this.settings.circuitStrikes ? now + this.settings.circuitCooldownMs : this.state.circuitUntil
      this.state = {
        ...this.state,
        strikes: strikes >= this.settings.circuitStrikes ? 0 : strikes,
        circuitUntil,
        stopUntil: Math.max(this.state.stopUntil, now + ladder * 1000),
        updatedAt: now,
      }
      if (circuitUntil > now && strikes >= this.settings.circuitStrikes) {
        this.log.error(
          '连续 %d 次命中风控码 %s：全局停发 %d 分钟。被盯上时唯一正确的做法是完全闭嘴',
          strikes,
          code,
          Math.round(this.settings.circuitCooldownMs / 60_000),
        )
      }
      return
    }

    const failures = this.state.failures + 1
    this.state = {
      ...this.state,
      failures,
      stopUntil:
        failures >= FAILURE_STRIKES ? now + this.settings.failureStopMs : this.state.stopUntil,
      updatedAt: now,
    }
    if (failures >= FAILURE_STRIKES) {
      this.log.warn(
        '连续 %d 次发送失败：停发 %d 秒再试（错误码 %s）',
        failures,
        Math.round(this.settings.failureStopMs / 1000),
        code ?? '无',
      )
    }
  }

  /**
   * 去重键。短消息不参与去重（人类真的会说两遍「嗯」）。
   * @param input 入参。
   */
  private dedupeKeyOf(input: GateInput): string {
    if (input.text.length < this.settings.dedupeMinLen) return ''
    return input.conversationId + '|' + hashOf(input.text)
  }

  /**
   * 令牌桶命中说明。
   * @param now 现在。
   * @returns 空串表示没超。
   */
  private rateLimitHit(now: number): string {
    const minute = rollWindow(this.state.minute, MINUTE_MS, now)
    if (minute.count >= this.settings.perMinute) {
      return '每分钟上限 ' + String(this.settings.perMinute) + ' 条已用完'
    }
    const hour = rollWindow(this.state.hour, HOUR_MS, now)
    if (hour.count >= this.settings.perHour) {
      return '每小时上限 ' + String(this.settings.perHour) + ' 条已用完'
    }
    const day = rollWindow(this.state.day, DAY_MS, now)
    if (day.count >= this.settings.perDay) {
      return '每天上限 ' + String(this.settings.perDay) + ' 条已用完'
    }
    return ''
  }

  /** 坏正则提示（只提示一次）。 */
  warnPatternsOnce(): void {
    if (this.warnedPatterns) return
    this.warnedPatterns = true
    if (this.settings.blockPatterns.length === 0) {
      this.log.info('内容闸正则为空：只拦「太长」与「空正文」。手册未给三类正则在原文，未编造')
    }
  }
}

/**
 * 造一个结论。
 * @param allow 是否放行。
 * @param reason 原因。
 * @param delayMs 需要等待的毫秒数。
 * @param detail 说明。
 */
function verdict(allow: boolean, reason: GateReason, delayMs: number, detail: string): GateVerdict {
  return { allow, reason, delayMs, detail }
}

/**
 * 把 `HH:MM` 读成分钟数。调用方已保证格式（配置层校验过）。
 * @param text 文本。
 */
function toMinutes(text: string): number {
  const matched = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(text)
  if (matched === null) return 0
  return Number(matched[1]) * 60 + Number(matched[2])
}

/**
 * 丢掉过旧项并限长。
 * @param source 原表。
 * @param cutoff 早于此时刻的条目丢掉。
 * @param cap 上限。
 */
function pruneMap(
  source: Readonly<Record<string, number>>,
  cutoff: number,
  cap: number,
): Readonly<Record<string, number>> {
  const entries = Object.entries(source).filter(([, at]) => at >= cutoff)
  entries.sort((left, right) => right[1] - left[1])
  const kept = entries.slice(0, cap)
  return Object.freeze(Object.fromEntries(kept))
}

/**
 * 编译内容闸正则。坏正则逐条丢弃（不整表失效）。
 * @param patterns 原文。
 */
function compilePatterns(patterns: readonly string[]): readonly RegExp[] {
  const out: RegExp[] = []
  for (const text of patterns) {
    try {
      out.push(new RegExp(text))
    } catch {
      // 配置层已经滤过一遍，这里只是双保险：真的坏了也不能让整张表失效。
    }
  }
  return out
}
