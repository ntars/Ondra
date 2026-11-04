/**
 * 六道闸（手册 §5.3）。**纯计算 + 一份可落盘的状态，不发消息、不碰网络。**
 *
 * ## 顺序为什么是「内容 → 深夜 → 去重 → 熔断 → 停发 → 令牌桶 → 冷却」
 *
 * 手册 §5.3 的原话是「最便宜/最可能拒绝的放最前」，它给的编号是
 * 内容(1) → 深夜(2) → 去重(3) → 令牌桶(4) → 冷却(5) → 抖动/退避/熔断(6)。
 * 这里把**熔断与停发提到令牌桶之前**，只改了这一处，理由是可观测性：
 *
 * - 熔断中每放一条都会被风控再打一次脸，而「拒」与「放」在计数上不该继续累计；
 * - 若把熔断放在计数之后，用户会看到「配额用完了」而不是「她被盯上了」，
 *   这两句对应完全不同的处置（等一小时 vs 立刻闭嘴）。
 *
 * 同一处口径与 O-058 保持一致：两个 QQ 通道对同一份手册的读法必须一样，
 * 否则「换个通道她的脾气就变了」。
 *
 * ## 为什么阈值抄两遍不算双真源
 *
 * 真源是**手册 §5.3 的数值**，`FIELD_SPECS` 是它在每个通道里的落地副本。
 * 每个通道必须能独立调紧（一个通道被风控不该拖累另一个），
 * 所以两份 `Config` 各有一组数，但**状态、计时器、随机源一概不共享**（§16.2-5）。
 */

import type { GateReason, GateVerdict } from './types.js'
import { RISK_CODES, TZ_OFFSET_MIN } from './types.js'

/** 风控码集合。**由 `RISK_CODES` 派生**，不手抄第二份码表。 */
const RISK_CODES_SET: ReadonlySet<string> = new Set(RISK_CODES.map(code => code.trim()))

/** 一个固定窗口的计数器。 */
export interface RateWindow {
  /** 窗口起点（毫秒）。 */
  start: number
  /** 窗口内已用次数。 */
  count: number
}

/** 去重表里的一条。 */
export interface SeenEntry {
  /** 正文指纹。 */
  hash: string
  /** 见到它的时刻（毫秒）。 */
  at: number
}

/** 闸门状态（可落盘，字段全部可选以便兼容旧文件）。 */
export interface GateState {
  /** 每分钟窗口。 */
  minute: RateWindow
  /** 每小时窗口。 */
  hour: RateWindow
  /** 每天窗口。 */
  day: RateWindow
  /** 各会话最后一次放行时刻。 */
  cooldown: Record<string, number>
  /** 去重表。 */
  seen: SeenEntry[]
  /** 连续命中风控次数。 */
  strikes: number
  /** 熔断到什么时候（毫秒时间戳，0 = 未熔断）。 */
  circuitUntil: number
  /** 连续失败次数。 */
  failures: number
  /** 停发到什么时候（毫秒时间戳，0 = 未停发）。 */
  failureStopUntil: number
  /** 退避阶梯下标。 */
  backoffIndex: number
}

/** 闸门依赖。 */
export interface GateDeps {
  /** 只取闸门用得到的那几个配置项（避免把整个 Config 拖进来）。 */
  readonly settings: {
    readonly contentMaxLen: number
    readonly blockPatterns: readonly string[]
    readonly quietEnabled: boolean
    readonly quietStart: string
    readonly quietEnd: string
    readonly dedupeWindowMs: number
    readonly dedupeMinLen: number
    readonly perMinute: number
    readonly perHour: number
    readonly perDay: number
    readonly cooldownGroupMs: number
    readonly cooldownPrivateMs: number
    readonly jitterMs: number
    readonly circuitStrikes: number
    readonly circuitCooldownMs: number
    readonly failureStopMs: number
  }
  /** 时间源。 */
  now(): number
  /** 随机源（0–1），抖动与概率用。 */
  random(): number
  /** 初始状态。 */
  state: GateState
  /** 状态变了（落盘节流由调用方管）。 */
  onChange?(): void
}

/** 闸门输入。 */
export interface GateInput {
  /** 会话 id。 */
  readonly conversationId: string
  /** 私聊还是群。 */
  readonly kind: 'private' | 'group'
  /** 正文。 */
  readonly text: string
  /** 触发方式。`active` 是主动发言，会被深夜静默拦。 */
  readonly trigger: 'message' | 'mention' | 'keyword' | 'active'
  /** 时刻。 */
  readonly at?: number
}

/** 去重表上限：再多也只是内存里的垃圾。 */
export const SEEN_LIMIT = 512

/** 空状态。 */
export function emptyGateState(now: number): GateState {
  return {
    minute: { start: now, count: 0 },
    hour: { start: now, count: 0 },
    day: { start: now, count: 0 },
    cooldown: {},
    seen: [],
    strikes: 0,
    circuitUntil: 0,
    failures: 0,
    failureStopUntil: 0,
    backoffIndex: 0,
  }
}

/**
 * 正文指纹（djb2，8 位十六进制）。
 *
 * 为什么不用整段正文：去重表要长期留在内存与磁盘里，存原文等于
 * 在状态文件里留一份聊天记录。指纹够用——碰撞概率对「同会话窗口内」这个场景可忽略。
 * @param text 正文。
 */
export function hashOf(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 「东八区当天第几分钟」。
 * @param atMs 毫秒时间戳。
 */
export function minuteOfDay(atMs: number): number {
  const shifted = atMs + TZ_OFFSET_MIN * 60_000
  const mins = Math.floor((shifted % 86_400_000) / 60_000)
  return mins < 0 ? mins + 1440 : mins
}

/**
 * 是否落在静默时段（左闭右开，支持跨零点）。
 *
 * `start === end` 判为**空窗口**而不是「全天」：O-003 已裁定同一条口径，
 * 两处必须一致，否则「把开始和结束填成一样」在一个插件里是静音、在另一个里是全静默。
 * @param minute 当天第几分钟。
 * @param start 起始 `HH:MM`。
 * @param end 结束 `HH:MM`。
 */
export function inQuietHours(minute: number, start: string, end: string): boolean {
  const from = toMinute(start)
  const to = toMinute(end)
  if (from === null || to === null) return false
  if (from === to) return false
  if (from < to) return minute >= from && minute < to
  return minute >= from || minute < to
}

/**
 * `HH:MM` → 分钟。
 * @param text 文本。
 */
function toMinute(text: string): number | null {
  const matched = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(text)
  if (matched === null) return null
  return Number(matched[1]) * 60 + Number(matched[2])
}

/**
 * 固定窗口是否还能再用一次。
 *
 * 固定窗口会在边界处双倍突发（00:59 与 01:00 各用满一次配额），
 * 这是它的已知缺陷。缓解方式是默认值只用到上半区（20 而不是 60），
 * 而不是换成滑动窗口——滑动窗口要在状态里存一串时间戳，落盘与比对都更脆。
 * @param window 当前窗口。
 * @param now 现在。
 * @param limit 上限。
 * @param spanMs 窗口长度（毫秒）。
 */
export function windowAllows(
  window: RateWindow,
  now: number,
  limit: number,
  spanMs: number,
): { readonly allow: boolean; readonly next: RateWindow } {
  const expired = now - window.start >= spanMs || window.start > now
  const base: RateWindow = expired ? { start: now, count: 0 } : window
  if (base.count >= limit) return { allow: false, next: base }
  return { allow: true, next: base }
}

/**
 * 把落盘状态解析回来。**坏字段逐个回退，不整份丢弃。**
 *
 * 整份丢弃的后果很具体：一次手改坏一个括号，重启就把「熔断中」忘了，
 * 而这正是防封最怕的「重启绕过」。
 * @param value 原始值。
 * @param now 现在。
 */
export function parseGateState(value: unknown, now: number): GateState {
  const base = emptyGateState(now)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return base
  const raw = value as Record<string, unknown>

  const window = (key: string): RateWindow => {
    const given = raw[key]
    if (typeof given !== 'object' || given === null) return { start: now, count: 0 }
    const item = given as Record<string, unknown>
    const start = typeof item['start'] === 'number' && Number.isFinite(item['start']) ? item['start'] : now
    const count = typeof item['count'] === 'number' && Number.isFinite(item['count']) ? Math.max(0, item['count']) : 0
    return { start, count }
  }
  const num = (key: string, fallback: number): number => {
    const given = raw[key]
    return typeof given === 'number' && Number.isFinite(given) ? given : fallback
  }

  const cooldown: Record<string, number> = {}
  const givenCooldown = raw['cooldown']
  if (typeof givenCooldown === 'object' && givenCooldown !== null) {
    for (const [key, item] of Object.entries(givenCooldown as Record<string, unknown>)) {
      if (typeof item === 'number' && Number.isFinite(item)) cooldown[key] = item
    }
  }

  const seen: SeenEntry[] = []
  const givenSeen = raw['seen']
  if (Array.isArray(givenSeen)) {
    for (const item of givenSeen) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      if (typeof entry['hash'] !== 'string') continue
      if (typeof entry['at'] !== 'number' || !Number.isFinite(entry['at'])) continue
      seen.push({ hash: entry['hash'], at: entry['at'] })
    }
  }

  return {
    minute: window('minute'),
    hour: window('hour'),
    day: window('day'),
    cooldown,
    seen: seen.slice(-SEEN_LIMIT),
    strikes: Math.max(0, num('strikes', 0)),
    circuitUntil: num('circuitUntil', 0),
    failures: Math.max(0, num('failures', 0)),
    failureStopUntil: num('failureStopUntil', 0),
    backoffIndex: Math.max(0, num('backoffIndex', 0)),
  }
}

/** 一条拒绝结论。 */
function reject(reason: GateReason): GateVerdict {
  // 显式标注局部变量：直接 `Object.freeze({...})` 会把 `decision` 推断成 `string`，
  // 与闭集对不上（O-055 踩过这条，这里不重犯）。
  const verdict: GateVerdict = Object.freeze({ decision: 'reject', reason, delayMs: 0 })
  return verdict
}

/** 六道闸。 */
export class Gate {
  private state: GateState
  private readonly deps: GateDeps
  private readonly patterns: readonly RegExp[]

  constructor(deps: GateDeps) {
    this.deps = deps
    this.state = deps.state
    // 配置层已保证每条正则都能编译；这里再兜一层，坏的那条丢掉而不是整表失效。
    const compiled: RegExp[] = []
    for (const text of deps.settings.blockPatterns) {
      try {
        compiled.push(new RegExp(text))
      } catch {
        // 丢掉一条坏正则，其余继续生效。
      }
    }
    this.patterns = Object.freeze(compiled)
  }

  /** 当前状态快照（落盘用，深拷贝一层，外面改了不影响内部）。 */
  snapshot(): GateState {
    return {
      minute: { ...this.state.minute },
      hour: { ...this.state.hour },
      day: { ...this.state.day },
      cooldown: { ...this.state.cooldown },
      seen: this.state.seen.map(entry => ({ ...entry })),
      strikes: this.state.strikes,
      circuitUntil: this.state.circuitUntil,
      failures: this.state.failures,
      failureStopUntil: this.state.failureStopUntil,
      backoffIndex: this.state.backoffIndex,
    }
  }

  /** 只读地看一眼熔断与停发。 */
  view(): { readonly strikes: number; readonly circuitUntil: number; readonly failureStopUntil: number } {
    return {
      strikes: this.state.strikes,
      circuitUntil: this.state.circuitUntil,
      failureStopUntil: this.state.failureStopUntil,
    }
  }

  /**
   * 判定一条能不能发。**不改状态**（计数在 `commit()` 里扣）。
   *
   * 分成两半是为了让「判定」可以被反复调用而不产生副作用：
   * 同一个回合里调用方可能要判两次（先判主动、再判回复），扣两次配额就错了。
   * @param input 输入。
   */
  evaluate(input: GateInput): GateVerdict {
    const now = input.at ?? this.deps.now()
    const text = input.text.trim()

    // ① 内容闸
    if (text === '') return reject('empty')
    if (text.length > this.deps.settings.contentMaxLen) return reject('too-long')
    for (const pattern of this.patterns) {
      if (pattern.test(text)) return reject('blocked-content')
    }

    // ② 深夜静默：只拦主动发言。被叫要照回——凌晨三点有人跟她说话，她回一句不是机器人特征。
    if (
      this.deps.settings.quietEnabled &&
      input.trigger === 'active' &&
      inQuietHours(minuteOfDay(now), this.deps.settings.quietStart, this.deps.settings.quietEnd)
    ) {
      return reject('quiet')
    }

    // ③ 重复去重：短回复不参与（人类会重复说「嗯」）。
    if (text.length >= this.deps.settings.dedupeMinLen) {
      const hash = hashOf(text)
      const window = this.deps.settings.dedupeWindowMs
      for (const entry of this.state.seen) {
        if (entry.hash !== hash) continue
        if (now - entry.at < window) return reject('duplicate')
      }
    }

    // ④ 熔断（全局）：被盯上时唯一正确的做法是完全闭嘴。
    if (this.state.circuitUntil > now) return reject('circuit')

    // ⑤ 连续失败停发
    if (this.state.failureStopUntil > now) return reject('failure-stop')

    // ⑥ 令牌桶三层
    const minute = windowAllows(this.state.minute, now, this.deps.settings.perMinute, 60_000)
    if (!minute.allow) return reject('rate-minute')
    const hour = windowAllows(this.state.hour, now, this.deps.settings.perHour, 3_600_000)
    if (!hour.allow) return reject('rate-hour')
    const day = windowAllows(this.state.day, now, this.deps.settings.perDay, 86_400_000)
    if (!day.allow) return reject('rate-day')

    // ⑦ 会话冷却
    const last = this.state.cooldown[input.conversationId]
    const cooldown =
      input.kind === 'group' ? this.deps.settings.cooldownGroupMs : this.deps.settings.cooldownPrivateMs
    if (last !== undefined && now - last < cooldown) return reject('cooldown')

    // 放行：带一个抖动。固定节奏本身就是自动化特征。
    const jitter = this.deps.settings.jitterMs
    const delayMs = jitter <= 0 ? 0 : Math.floor(this.deps.random() * (jitter + 1))
    const verdict: GateVerdict = Object.freeze({ decision: 'allow', reason: 'ok', delayMs })
    return verdict
  }

  /**
   * 扣账：放行之后调用一次。
   *
   * 只在「真的要发了」的时候调用——判定通过但发送被别的层拦下（比如没有传输实现），
   * 那次不该扣配额，否则一个装错的通道会把自己的配额吃光。
   * @param input 输入。
   */
  commit(input: GateInput): void {
    const now = input.at ?? this.deps.now()
    const text = input.text.trim()

    // 用 `windowAllows` 只为「必要时翻页」这一件事：上限传 `MAX_SAFE_INTEGER`，
    // 它就不会拒绝，只会在窗口过期时把 start 推到现在。翻页逻辑只有一份。
    const minute = windowAllows(this.state.minute, now, Number.MAX_SAFE_INTEGER, 60_000)
    this.state.minute = { start: minute.next.start, count: minute.next.count + 1 }
    const hour = windowAllows(this.state.hour, now, Number.MAX_SAFE_INTEGER, 3_600_000)
    this.state.hour = { start: hour.next.start, count: hour.next.count + 1 }
    const day = windowAllows(this.state.day, now, Number.MAX_SAFE_INTEGER, 86_400_000)
    this.state.day = { start: day.next.start, count: day.next.count + 1 }

    this.state.cooldown[input.conversationId] = now

    if (text.length >= this.deps.settings.dedupeMinLen) {
      this.state.seen.push({ hash: hashOf(text), at: now })
      // 按时间裁到上限：去重表不是账本，留最早的没有意义。
      if (this.state.seen.length > SEEN_LIMIT) {
        this.state.seen = this.state.seen.slice(-SEEN_LIMIT)
      }
    }
    this.deps.onChange?.()
  }

  /**
   * 记一次发送结果。
   * @param code 平台错误码；空表示成功。
   * @param riskCodes 风控码表（命中即视为「被盯上」）。
   */
  record(code: string | undefined): void {
    const now = this.deps.now()
    if (code === undefined) {
      // 成功就把连续失败清零，但**不清 strikes**：风控计数要等熔断窗口自然过期，
      // 否则「发成一条就把前账抹了」，三次命中永远凑不齐。
      this.state.failures = 0
      this.state.backoffIndex = 0
      this.deps.onChange?.()
      return
    }

    if (isRiskCode(code)) {
      this.state.strikes += 1
      if (this.state.strikes >= this.deps.settings.circuitStrikes) {
        this.state.circuitUntil = now + this.deps.settings.circuitCooldownMs
        // 熔断开始就把 strikes 归零：否则窗口一过立刻又熔断，等于永久停发。
        this.state.strikes = 0
      }
      this.state.failures += 1
    } else {
      this.state.failures += 1
      if (this.state.failures >= 3) {
        this.state.failureStopUntil = now + this.deps.settings.failureStopMs
        this.state.failures = 0
      }
    }
    this.state.backoffIndex = Math.min(this.state.backoffIndex + 1, 5)
    this.deps.onChange?.()
  }

  /**
   * 下一次重试该等多久（毫秒）。
   *
   * 指数阶梯 [30,60,120,300,600,1800] 秒；线性退避等于持续挑衅（手册 §5.3-6）。
   * 熔断与停发优先：它们比退避更「大」，返回剩余时间即可。
   */
  backoffMs(): number {
    const now = this.deps.now()
    if (this.state.circuitUntil > now) return this.state.circuitUntil - now
    if (this.state.failureStopUntil > now) return this.state.failureStopUntil - now
    const ladder = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000]
    const index = Math.min(this.state.backoffIndex, ladder.length - 1)
    return ladder[index]
  }
}

/**
 * 是否是风控码。码表来自手册 §5.3-6。
 * @param code 平台错误码。
 */
export function isRiskCode(code: string): boolean {
  return RISK_CODES_SET.has(code.trim())
}
