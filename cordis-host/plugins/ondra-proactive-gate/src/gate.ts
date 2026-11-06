/**
 * 闸序编排（**纯判定，不碰磁盘、不碰 ctx**）。
 *
 * ## 执行顺序不是手册的编号顺序
 *
 * §5.3 给了八条，但其中第 7 条是「状态必须持久化」、第 8 条是「挡不住的局限」——
 * 它们不是闸。真正的闸是六条（内容 / 深夜 / 去重 / 令牌桶 / 冷却 / 抖动退避），
 * 加上 §5.5 的三道（静默时段 / 每日预算 / `min_idle_seconds`），一共九道。
 *
 * 手册对顺序只给了一句原则：**「最便宜/最可能拒绝的放最前」**。
 * 按这句排，实际顺序是：
 *
 * ```
 * policy（总开关/静音/群聊红线）→ circuit（熔断/退避/失败暂停）
 * → content（正则）→ quiet（两次整数比较）→ budget（两次比较）
 * → idle（一次比较）→ cooldown（一次查表）→ duplicate（遍历 ≤200 条）
 * → bucket（三次窗口统计）
 * ```
 *
 * 唯一「不便宜」的 `duplicate` 放在后面：它要遍历一小时窗口里的全部正文，
 * 而前面的闸几乎都是布尔。**顺序只影响性能，不影响结论**——九道闸都是
 * 「任一不过即拒」，没有「后一道能救前一道」的关系。
 *
 * ## 拦下的三种后果是刻意的
 *
 * | 闸 | 后果 | 为什么不是另一种 |
 * |---|---|---|
 * | 总开关 / 静音 / 群聊红线 / 内容红线 / 今日额度 / 重复 / 日速率 | `drop` | 不可挽回。重排只会在半小时后再说一遍同样的话 |
 * | 静默时段 / 空闲阈值 / 会话冷却 / 分·时速率 / 退避 | `defer` | 时间到了自然该说。丢掉等于「攒了一晚的话全扔了」 |
 * | 熔断 | `drop` + `stopUntil` | 被盯上时唯一正确的做法是完全闭嘴，不是「等 30 分钟再说」 |
 */

import { cooldownDeferMs, findDuplicate, hourDeferMs, minuteDeferMs } from './bucket.js'
import { blockedHit, isEmptyText, normalizeForMatch, sameText } from './content.js'
import type { Config as GateConfig } from './settings.js'
import {
  formatHhmm,
  inWindow,
  minutesToMs,
  minutesToWindowEnd,
  parseHhmm,
  silentDaysOf,
} from './window.js'
import type {
  BudgetView,
  GateAction,
  GateCode,
  GateName,
  GateRequest,
  GateState,
  GateVerdict,
} from './types.js'

/** 判定入参。 */
export interface GateInput {
  /** 配置。 */
  readonly settings: GateConfig
  /** 当前状态（只读）。 */
  readonly state: GateState
  /** 请求。 */
  readonly request: GateRequest
  /** 判定时刻。 */
  readonly at: number
  /** 当前分钟（0–1439，来自 O-003 或本机时区）。 */
  readonly minuteOfDay: number
  /** 当日键。 */
  readonly dayKey: string
}

/**
 * 算今日预算。
 *
 * 「连续沉默 ≥3 天减半、≥7 天归零」是 §9.3 的原话。减半取 **floor**：
 * 3 的一半是 1.5，向下取整成 1。宁可少说一句——多说的那半句正好落在
 * 用户最不想被打扰的那天。
 * @param settings 配置。
 * @param state 状态。
 * @param request 请求（可覆盖额度与沉默天数）。
 * @param at 时刻。
 * @param dayKey 当日键。
 */
export function budgetOf(
  settings: GateConfig,
  state: GateState,
  request: GateRequest,
  at: number,
  dayKey: string,
): BudgetView {
  const override = request.dailyQuota
  const fromCaller = typeof override === 'number' && Number.isFinite(override)
  const base = fromCaller ? Math.max(0, Math.trunc(override)) : settings.dailyQuota

  const givenDays = request.silentDays
  const silentDays =
    typeof givenDays === 'number' && Number.isFinite(givenDays)
      ? Math.max(0, Math.trunc(givenDays))
      : silentDaysOf(at, state.lastUserAt)

  const quota = silentDays >= 7 ? 0 : silentDays >= 3 ? Math.floor(base / 2) : base
  const used = state.dayKey === dayKey ? state.dayCount : 0

  return Object.freeze({
    dayKey,
    quota,
    used,
    remaining: Math.max(0, quota - used),
    silentDays,
    source: fromCaller ? 'caller' : 'config',
  })
}

/** 查一次会话表（不用 `??`：无 `noUncheckedIndexedAccess` 时右操作数不可达）。 */
function lastOf(table: Readonly<Record<string, number>>, key: string): number {
  const value = table[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 判定上下文：输入 + 已算好的预算（**只算一次**，不在每条结论里重算）。 */
interface Judge {
  readonly input: GateInput
  readonly budget: BudgetView
}

/** 造一条结论。 */
function make(
  judge: Judge,
  action: GateAction,
  gate: GateName,
  code: GateCode,
  detail: string,
  deferMs = 0,
): GateVerdict {
  const { input, budget } = judge
  return {
    allowed: action === 'send',
    action,
    gate,
    code,
    detail,
    deferMs: action === 'defer' ? Math.max(1, deferMs) : 0,
    jitterMs: action === 'send' ? input.settings.jitterMs : 0,
    stopUntil: input.state.openUntil > input.at ? input.state.openUntil : 0,
    budget,
    at: input.at,
  }
}

/**
 * 静默窗口判定。
 *
 * 两个窗口**用途不同**，不是同一个数的两种写法：
 *
 * - 产品静默 `23:00–08:00`（§9.3）：不打扰。**只拦主动**——用户凌晨说话她该回。
 * - 防封深夜 `00:30–07:30`（§5.3-2）：机器人特征。**拦主动与回话，不拦被叫**。
 *
 * 两个窗口叠加时取**较长的等待**：只取较短的那个会让调用方在第一个窗口结束时
 * 立刻重试，然后被第二个窗口再拦一次，多一次无意义的调度。
 * @param judge 判定上下文。
 */
function checkQuiet(judge: Judge): GateVerdict | undefined {
  const { settings, request } = judge.input
  const minute = judge.input.minuteOfDay
  const isActive = request.reason === 'active'

  let wait = 0
  let code: GateCode | undefined
  let detail = ''

  const quietStart = parseHhmm(settings.quietStart)
  const quietEnd = parseHhmm(settings.quietEnd)
  if (
    isActive &&
    quietStart !== undefined &&
    quietEnd !== undefined &&
    inWindow(minute, quietStart, quietEnd)
  ) {
    wait = minutesToWindowEnd(minute, quietEnd)
    code = 'quiet-hours'
    detail =
      '现在是产品静默时段（' +
      formatHhmm(quietStart) +
      '–' +
      formatHhmm(quietEnd) +
      '），主动消息等到 ' +
      formatHhmm(quietEnd) +
      ' 之后'
  }

  const banStart = parseHhmm(settings.antiBanQuietStart)
  const banEnd = parseHhmm(settings.antiBanQuietEnd)
  if (
    request.reason !== 'mention' &&
    banStart !== undefined &&
    banEnd !== undefined &&
    inWindow(minute, banStart, banEnd)
  ) {
    const banWait = minutesToWindowEnd(minute, banEnd)
    if (banWait > wait) {
      wait = banWait
      code = 'anti-ban-quiet'
      detail =
        '现在是防封深夜窗口（' +
        formatHhmm(banStart) +
        '–' +
        formatHhmm(banEnd) +
        '）：凌晨主动发言是极强机器人特征'
    }
  }

  if (code === undefined) return undefined
  return make(judge, 'defer', 'quiet', code, detail, minutesToMs(wait))
}

/**
 * 熔断 / 退避 / 失败暂停。
 *
 * 三者共用 `circuit` 这道闸，但后果不同：熔断是 `drop`（闭嘴），
 * 退避与失败暂停是 `defer`（等一会儿再试）。
 * @param judge 判定上下文。
 */
function checkCircuit(judge: Judge): GateVerdict | undefined {
  const { state, at } = judge.input
  if (state.openUntil > at) {
    return make(
      judge,
      'drop',
      'circuit',
      'circuit-open',
      '熔断中：连续风控命中，全局停发到 ' + new Date(state.openUntil).toLocaleString('zh-CN'),
    )
  }
  if (state.retryUntil > at) {
    return make(
      judge,
      'defer',
      'circuit',
      'backoff',
      '风控退避中：还要等 ' + String(Math.ceil((state.retryUntil - at) / 1000)) + ' 秒',
      state.retryUntil - at,
    )
  }
  if (state.failUntil > at) {
    return make(
      judge,
      'defer',
      'circuit',
      'fail-pause',
      '连续发送失败后的暂停：还要等 ' + String(Math.ceil((state.failUntil - at) / 1000)) + ' 秒',
      state.failUntil - at,
    )
  }
  return undefined
}

/**
 * 判定一次投递。
 * @param input 入参。
 */
export function evaluate(input: GateInput): GateVerdict {
  const { settings, state, request, at } = input
  const judge: Judge = { input, budget: budgetOf(settings, state, request, at, input.dayKey) }
  const budget = judge.budget

  // 1. 总开关。
  if (!settings.enable) {
    return make(judge, 'drop', 'policy', 'disabled', '门控已关闭（enable=false）')
  }

  // 2. 一键静音。**drop 不是 defer**：静音是人的决定，
  //    改成 defer 会让调用方在解除静音那一刻把攒下的话一次说出来。
  if (state.mutedUntil > at) {
    return make(
      judge,
      'drop',
      'policy',
      'muted',
      '一键静音中（到 ' + new Date(state.mutedUntil).toLocaleString('zh-CN') + '）',
    )
  }

  // 3. 熔断 / 退避 / 失败暂停。
  const circuit = checkCircuit(judge)
  if (circuit !== undefined) return circuit

  // 4. 群聊红线（§5.7）。**无开关**：这是合规章节级红线，不是偏好。
  if ((request.kind ?? 'private') === 'group' && request.reason === 'active') {
    return make(judge, 'drop', 'policy', 'group-silent', '群里不主动说话（§5.7 红线，无开关）')
  }

  // 5. 内容闸。
  if (isEmptyText(request.text)) {
    return make(judge, 'drop', 'content', 'content-empty', '正文为空：发出去就是一条空气泡')
  }
  if (request.text.length > settings.hardMaxLen) {
    return make(
      judge,
      'drop',
      'content',
      'content-too-long',
      '正文 ' + String(request.text.length) + ' 字，超过硬上限 ' + String(settings.hardMaxLen) + ' 字',
    )
  }
  const hit = blockedHit(request.text, settings.blockWords)
  if (hit !== undefined) {
    return make(
      judge,
      'drop',
      'content',
      'content-blocked',
      '内容命中' + hit.label + '红线（「' + hit.matched + '」）：这几类是硬扣号不是限流',
    )
  }

  // 6. 静默时段。
  const quiet = checkQuiet(judge)
  if (quiet !== undefined) return quiet

  // 7. 每日主动预算。只算主动——回话不是「主动打扰」。
  if (request.reason === 'active' && budget.remaining <= 0) {
    const decay =
      budget.silentDays >= 3 ? '，已连续 ' + String(budget.silentDays) + ' 天没说话而衰减' : ''
    return make(
      judge,
      'drop',
      'budget',
      'budget-exhausted',
      '今日主动额度用完了（' +
        String(budget.used) +
        '/' +
        String(budget.quota) +
        decay +
        '）',
    )
  }

  // 8. 空闲阈值（§5.5 `min_idle_seconds`）：用户刚说完话就别插嘴。
  const idle = request.idleMinutes
  if (request.reason === 'active' && typeof idle === 'number' && Number.isFinite(idle)) {
    if (idle < settings.idleMinutes) {
      const need = settings.idleMinutes - idle
      return make(
        judge,
        'defer',
        'idle',
        'session-busy',
        '目标会话才安静 ' + String(Math.max(0, Math.round(idle))) + ' 分钟，还要 ' + String(Math.ceil(need)) + ' 分钟',
        minutesToMs(need),
      )
    }
  }

  // 9. 同会话冷却。
  const conversationId = request.conversationId
  if (conversationId !== undefined && conversationId !== '') {
    const cooldown =
      (request.kind ?? 'private') === 'group' ? settings.groupCooldownMs : settings.privateCooldownMs
    const wait = cooldownDeferMs(lastOf(state.lastByConversation, conversationId), at, cooldown)
    if (wait > 0) {
      return make(
        judge,
        'defer',
        'cooldown',
        'cooldown',
        '同会话冷却中：还要 ' + String(Math.ceil(wait / 1000)) + ' 秒',
        wait,
      )
    }
  }

  // 10. 重复去重。短于 `dedupeMinLen` 不参与——「嗯」「好」「?」本来就会重复。
  const normalized = normalizeForMatch(request.text)
  if (settings.dedupeMinLen > 0 && normalized.length >= settings.dedupeMinLen) {
    const dup = findDuplicate(state.sent, request.text, at, settings.dedupeMinutes * 60_000, sameText)
    if (dup !== undefined) {
      return make(
        judge,
        'drop',
        'duplicate',
        'duplicate',
        '最近 ' + String(settings.dedupeMinutes) + ' 分钟内已经说过同一句话',
      )
    }
  }

  // 11. 令牌桶三层。
  const minuteWait = minuteDeferMs(state.sent, at, settings.perMinute)
  if (minuteWait > 0) {
    return make(
      judge,
      'defer',
      'bucket',
      'bucket-minute',
      '每分钟上限 ' + String(settings.perMinute) + ' 条已满：还要 ' + String(Math.ceil(minuteWait / 1000)) + ' 秒',
      minuteWait,
    )
  }
  const hourWait = hourDeferMs(state.sent, at, settings.perHour)
  if (hourWait > 0) {
    return make(
      judge,
      'defer',
      'bucket',
      'bucket-hour',
      '每小时上限 ' + String(settings.perHour) + ' 条已满：还要 ' + String(Math.ceil(hourWait / 60_000)) + ' 分钟',
      hourWait,
    )
  }
  const daySent = state.dayKey === input.dayKey ? state.daySent : 0
  if (daySent >= settings.perDay) {
    return make(
      judge,
      'drop',
      'bucket',
      'bucket-day',
      '每日上限 ' + String(settings.perDay) + ' 条已满：今天不再发',
    )
  }

  // 12. 放行。
  return make(
    judge,
    'send',
    'pass',
    'ok',
    '放行（今日主动 ' +
      String(budget.used) +
      '/' +
      String(budget.quota) +
      '，抖动上限 ' +
      String(settings.jitterMs) +
      'ms）',
  )
}
