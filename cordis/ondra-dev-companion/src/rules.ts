/**
 * 判定核心（纯函数，**无 IO、无定时器、无副作用**）。
 *
 * ## 为什么「什么时候不说」要写成判据
 *
 * 陪伴类工具的通病是「事件到了就响」：编译失败弹一句、测试通过弹一句、
 * 提交成功再弹一句。响到第三天，人就会把它关掉——而它本来是来陪人的。
 *
 * 所以这里把「不说」做成一等公民：`DevReason` 里有六种安静的理由，
 * 每一种都能被单独查出来。折进一个 `quiet` 之后，「她今天为什么一句话没说」
 * 就再也查不出了。
 *
 * ## 三条容易做反的地方
 *
 * 1. **安静期跟着「还在红」这个状态，不跟着失败时刻的计时器。**
 *    若按计时器算，一次二十秒就修好的失败会把随后那句「绿了呀」一并咽掉——
 *    而那句话正是最该说的。故条件是 `lastOutcome === 'fail'` 且未过安静期。
 * 2. **「绿了」只在前一刻还红着时说。** 从没红过的成功一句都不说：
 *    每跑一次测试都被夸一次，夸就贬值了。
 * 3. **咬住时唯一允许的调门是「先放下」。** 不许说「再试一次」、
 *    不许说「马上就成」——催是索取，劝放下才是陪伴。
 */

import { DEV_EVENT_KINDS } from './types.js'
import type {
  DevCue,
  DevEvent,
  DevEventKind,
  DevOutcome,
  DevPolicy,
  DevReason,
  DevTone,
  DevView,
  ScreenPresenceLike,
} from './types.js'

/**
 * 长任务结束后「还可以应一声」的窗口。
 *
 * 五分钟之外的 `run-end` 不再补一句：一次跑的什么早就忘了，
 * 这时候说「跑完了呢」只会让人一愣。
 */
export const RUN_RECENT_MS = 5 * 60_000

/**
 * 会话内判定状态（**只在内存，不落盘**）。
 *
 * 刻意不落盘：`streak` 与 `firstFailAt` 一旦跨重启保留，就等于相信
 * 「关机前那条错误」和「开机后这条错误」是同一个。宁可重启后重新数——
 * 少说一句的代价，比对着一个不相干的错劝人放下要小得多。
 */
export interface DevMemory {
  /** 最近一次事件时刻；没有事件为 `null`。 */
  readonly lastEventAt: number | null
  /** 最近一次结果。 */
  readonly lastOutcome: DevOutcome
  /** 最近一次失败时刻；没失败过为 `null`。 */
  readonly lastFailAt: number | null
  /** 当前连败序列的起点；不在连败中为 `null`。 */
  readonly firstFailAt: number | null
  /** 当前连续失败次数（同一指纹）。 */
  readonly streak: number
  /** 上一个失败指纹（判等用，**不落盘、不解释、不打日志**）。 */
  readonly lastFingerprint: string | null
  /** 本次会话累计失败次数。 */
  readonly fails: number
  /** 本次会话累计转绿次数。 */
  readonly passes: number
  /** 本次会话累计提交次数。 */
  readonly commits: number
  /** 长任务起点；不在跑为 `null`。 */
  readonly lastRunStart: number | null
  /** 长任务结束时刻；没跑过为 `null`。 */
  readonly lastRunEndAt: number | null
  /** 上一次事件是否是「红转绿」。**只活到下一个事件或一次 ack**。 */
  readonly firstGreen: boolean
  /**
   * 最近一次「先放下」的时刻；没说过或已开新事件为 `null`。
   *
   * 存在的理由：同一条错误上每十分钟说一次「要不要先放下」就成了新的唠叨。
   * 一次卡顿只说一次，直到有**新的事件**进来才算新的一轮。
   */
  readonly lastReleaseAt: number | null
  /** 本次会话接受的事件数。 */
  readonly events: number
}

/**
 * 落盘的那一半（**只有水位与计数**）。
 *
 * 存这些的理由只有一个：重启之后**不要重复说同一句话**。
 * 它们不含任何一次构建、任何一个文件、任何一行代码的信息。
 */
export interface DevLedger {
  /** 最近一次「真的说出去了」的时刻；没说过为 `null`。 */
  readonly lastCueAt: number | null
  /** 最近一次「绿了」的时刻；没说过为 `null`。 */
  readonly lastCelebrateAt: number | null
  /** 各调门累计次数。 */
  readonly tones: Readonly<Record<DevTone, number>>
  /** 重来次数。 */
  readonly resets: number
}

/** 空判定状态。 */
export function emptyMemory(): DevMemory {
  return {
    lastEventAt: null,
    lastOutcome: 'unknown',
    lastFailAt: null,
    firstFailAt: null,
    streak: 0,
    lastFingerprint: null,
    fails: 0,
    passes: 0,
    commits: 0,
    lastRunStart: null,
    lastRunEndAt: null,
    firstGreen: false,
    lastReleaseAt: null,
    events: 0,
  }
}

/** 空调门台账。 */
export function emptyLedger(): DevLedger {
  return {
    lastCueAt: null,
    lastCelebrateAt: null,
    tones: { quiet: 0, companion: 0, release: 0, celebrate: 0 },
    resets: 0,
  }
}

/** 有限的非负时间戳。 */
function isStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 计数：非有限数或负数归零。 */
function countOf(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num < 0) return 0
  return Math.floor(num)
}

/** 调门计数归一化。 */
function tonesOf(value: unknown): Readonly<Record<DevTone, number>> {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    quiet: countOf(raw.quiet),
    companion: countOf(raw.companion),
    release: countOf(raw.release),
    celebrate: countOf(raw.celebrate),
  }
}

/** 台账归一化。**任何畸形输入都退化成空台账，绝不抛。** */
export function normalizeLedger(value: unknown): DevLedger {
  if (value === null || typeof value !== 'object') return emptyLedger()
  const raw = value as Record<string, unknown>
  return {
    lastCueAt: isStamp(raw.lastCueAt) ? raw.lastCueAt : null,
    lastCelebrateAt: isStamp(raw.lastCelebrateAt) ? raw.lastCelebrateAt : null,
    tones: tonesOf(raw.tones),
    resets: countOf(raw.resets),
  }
}

/** 事件类型归一化。**不在闭集里返回 `null`**，不就近归并。 */
export function normalizeKind(value: unknown): DevEventKind | null {
  if (typeof value !== 'string') return null
  const hit = DEV_EVENT_KINDS.find((item) => item === value)
  return hit === undefined ? null : hit
}

/** 结果归一化。不在闭集里一律 `unknown`。 */
export function normalizeOutcome(value: unknown): DevOutcome {
  if (value === 'pass' || value === 'fail') return value
  return 'unknown'
}

/**
 * 解析一个事件。类型不在闭集或时刻不合法就返回 `null`（调用方抛 `bad-request`）。
 * @param value 任意输入。
 * @param fallbackAt 缺省时刻。
 * @returns 合法事件或 `null`。
 */
export function readEvent(value: unknown, fallbackAt: number): DevEvent | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const kind = normalizeKind(raw.kind)
  if (kind === null) return null
  const at = raw.at === undefined ? fallbackAt : raw.at
  if (!isStamp(at)) return null
  const fingerprint = typeof raw.fingerprint === 'string' && raw.fingerprint !== ''
    ? raw.fingerprint
    : undefined
  return { kind, outcome: normalizeOutcome(raw.outcome), fingerprint, at }
}

/**
 * 应用一个事件。
 *
 * 「同一个错」的判等：给了指纹就按指纹比；**没给指纹只能按连败算**
 * （`same = true`）。因为「分不清」时宁可早点劝人放下，也不能在
 * 同一条错误上催第四次「再试一次」。
 * @param memory 旧判定状态。
 * @param event 事件。
 * @param at 时刻。
 * @returns 新判定状态。
 */
export function applyEvent(memory: DevMemory, event: DevEvent, at: number): DevMemory {
  // 任何新事件都算「新的一轮」：把上一轮的「先放下」标记清掉，
  // 否则同一条错误上只允许劝一次，而人可能已经重启过一轮尝试。
  const base: DevMemory = { ...memory, lastReleaseAt: null }

  switch (event.kind) {
    case 'build-start':
    case 'run-start':
      return {
        ...base,
        lastEventAt: at,
        lastRunStart: at,
        lastOutcome: 'unknown',
        firstGreen: false,
        events: memory.events + 1,
      }

    case 'build-end':
    case 'test-end': {
      const outcome = event.outcome === undefined ? 'unknown' : event.outcome
      if (outcome === 'fail') {
        const hasFp = event.fingerprint !== undefined
        const same = hasFp ? memory.lastFingerprint === event.fingerprint : true
        const streak = same ? memory.streak + 1 : 1
        return {
          ...base,
          lastEventAt: at,
          lastOutcome: 'fail',
          lastFailAt: at,
          firstFailAt: streak === 1 ? at : (memory.firstFailAt === null ? at : memory.firstFailAt),
          streak,
          lastFingerprint: hasFp ? (event.fingerprint ?? null) : null,
          fails: memory.fails + 1,
          firstGreen: false,
          events: memory.events + 1,
        }
      }
      if (outcome === 'pass') {
        return {
          ...base,
          lastEventAt: at,
          lastOutcome: 'pass',
          // 「红转绿」只在前面还红着时为真：从没红过的成功不值得一句夸奖。
          firstGreen: memory.streak > 0,
          streak: 0,
          firstFailAt: null,
          lastFingerprint: null,
          passes: memory.passes + 1,
          events: memory.events + 1,
        }
      }
      return {
        ...base,
        lastEventAt: at,
        lastOutcome: 'unknown',
        firstGreen: false,
        events: memory.events + 1,
      }
    }

    case 'run-end':
      return {
        ...base,
        lastEventAt: at,
        lastRunStart: null,
        lastRunEndAt: at,
        lastOutcome: 'unknown',
        firstGreen: false,
        events: memory.events + 1,
      }

    case 'commit':
      return {
        ...base,
        lastEventAt: at,
        commits: memory.commits + 1,
        lastOutcome: 'unknown',
        firstGreen: false,
        events: memory.events + 1,
      }

    default:
      // 闭集之外到不了这里（`readEvent` 已挡），保留兜底是为了将来加类型时不会静默吞掉。
      return memory
  }
}

/**
 * 记一次「真的说出口了」，顺手关掉只该生效一次的标记。
 *
 * 这是**唯一会推进判定状态的方法**（`cue()` 永远只读）。分两条：
 *
 * - `celebrate` 关掉 `firstGreen`。不关的话，冷却一过它会为同一次转绿再说一遍——
 *   而那句「绿了呀」说第二遍就成了敷衍。
 * - `release` 记下时刻。同一条错误上只劝一次「先放下」，否则每十分钟劝一次，
 *   劝本身就变成了新的压力源。
 * @param memory 判定状态。
 * @param tone 说出去的调门。
 * @param at 时刻。
 * @returns 新判定状态。
 */
export function applyAck(memory: DevMemory, tone: DevTone, at: number): DevMemory {
  if (tone === 'celebrate') return { ...memory, firstGreen: false }
  if (tone === 'release') return { ...memory, lastReleaseAt: at }
  return memory
}

/**
 * 在场门。返回挡住出声的原因；没挡住为 `null`。
 *
 * **服务缺席（`null`）不算「读不到」**：单装本插件时必须能说话，
 * 否则「没装感知插件」就等于「永远闭嘴」——那是把可选依赖做成了硬开关。
 * @param presence O-109 的视图；缺席为 `null`。
 * @returns 挡住的原因。
 */
export function presenceGate(
  presence: ScreenPresenceLike | null,
): 'meeting' | 'absent' | 'unreadable-presence' | null {
  if (presence === null) return null
  // 开会最优先：它比「人不在了」更该闭嘴，也更容易被误判成「在看东西」。
  if (presence.category === 'meeting') return 'meeting'
  if (presence.state === 'idle') return 'absent'
  // 读不到时闭嘴：不知道场合就不要开口，这条比「多说一句总没坏处」要紧。
  if (presence.state === 'unknown') return 'unreadable-presence'
  return null
}

/** 三句台词。**一句数字都没有，一句评价进度的都没有。** */
export const SAY: Readonly<Record<'celebrate' | 'release' | 'companion', string>> = Object.freeze({
  celebrate: '绿了呀，主人真行。',
  release: '这个错咬得有点久了，要不要先放下，喝口水再回来。',
  companion: '跑完了呢，先伸个手吧。',
})

/** 恒定五条禁令。**每一档都在，连闭嘴时也照样给。** */
export const MUST_NOT: readonly string[] = Object.freeze([
  '不报任何数字：失败几次、跑了多久、改了几行，一律不说（§12.1 禁报数铁律）。',
  '不催「再试一次」「马上就成」：尤其在同一条错误上，催是索取。',
  '不读代码、不读 diff、不点评实现：这不是代码审查，代码也不是我们的东西。',
  '失败后还没修好的那一段安静期里，一个字都不说。',
  '开会中、人不在、在场读不到时，一律闭嘴。',
])

/** 原因 → 一句中文说明（不含数字）。 */
const WHY: Readonly<Record<DevReason, string>> = Object.freeze({
  disabled: '开关关着。',
  'no-events': '还没有任何事件，没什么可接的。',
  meeting: '在开会，一个字都不说。',
  absent: '人不在，说了没人听。',
  'unreadable-presence': '不知道场合，就不开口。',
  'just-failed': '还红着，人在改，这时候任何一句都是干扰。',
  cooling: '刚说过，再说一句就显得敷衍。',
  'nothing-new': '没有值得开口的新情况。',
  stuck: '同一个错咬久了，该说的不是「再试一次」。',
  'first-green': '前面还红着，现在绿了，这句值得说。',
  'run-done': '长任务跑完了，应一声。',
})

/** 造一句静默。 */
function quietCue(reason: DevReason): DevCue {
  return {
    tone: 'quiet',
    say: null,
    mustNot: MUST_NOT,
    suggestBreak: false,
    reason,
    note: WHY[reason],
  }
}

/** 冷却判定：`last` 为 `null` 时永远算冷却结束。 */
function cooled(last: number | null, cooldownMs: number, now: number): boolean {
  if (last === null) return true
  return now - last >= cooldownMs
}

/**
 * 出声判定。
 *
 * 判定顺序（顺序本身就是纪律，改动前先读一遍上面三条「容易做反」）：
 * 开关 → 在场门 → 有没有事件 → 还在红且未过安静期 → 咬住了 → 红转绿 →
 * 长任务刚结束 → 什么都不说。
 * @param memory 判定状态。
 * @param ledger 台账。
 * @param policy 口径。
 * @param now 现在。
 * @param presence O-109 视图或 `null`。
 * @param enabled 总开关。
 * @returns 一句话或一句静默。
 */
export function decide(
  memory: DevMemory,
  ledger: DevLedger,
  policy: DevPolicy,
  now: number,
  presence: ScreenPresenceLike | null,
  enabled: boolean,
): DevCue {
  if (!enabled) return quietCue('disabled')

  if (policy.respectPresence) {
    const gate = presenceGate(presence)
    if (gate !== null) return quietCue(gate)
  }

  if (memory.lastEventAt === null) return quietCue('no-events')

  // 安静期只压「还没修好」的那一段。修好了就不再压——否则一次快速修复
  // 会把随后那句「绿了呀」一并吞掉，而那正是最该说的。
  if (
    memory.lastOutcome === 'fail' &&
    memory.lastFailAt !== null &&
    now - memory.lastFailAt < policy.quietAfterFailMs
  ) {
    return quietCue('just-failed')
  }

  if (
    memory.streak >= policy.stuckFails &&
    memory.firstFailAt !== null &&
    now - memory.firstFailAt >= policy.stuckSpanMs &&
    // 同一轮卡顿只劝一次：劝到第三次，「要不要先放下」自己就成了压力。
    memory.lastReleaseAt === null
  ) {
    if (!cooled(ledger.lastCueAt, policy.cueCooldownMs, now)) return quietCue('cooling')
    return {
      tone: 'release',
      say: SAY.release,
      mustNot: MUST_NOT,
      suggestBreak: true,
      reason: 'stuck',
      note: WHY.stuck,
    }
  }

  if (memory.firstGreen) {
    // 「绿了」不吃出声冷却，只吃自己的冷却：它时间敏感，被冷却吞掉就浪费了一次修复。
    if (!cooled(ledger.lastCelebrateAt, policy.celebrateCooldownMs, now)) return quietCue('cooling')
    return {
      tone: 'celebrate',
      say: SAY.celebrate,
      mustNot: MUST_NOT,
      suggestBreak: false,
      reason: 'first-green',
      note: WHY['first-green'],
    }
  }

  if (
    memory.lastRunEndAt !== null &&
    now - memory.lastRunEndAt <= RUN_RECENT_MS &&
    memory.lastOutcome === 'unknown'
  ) {
    if (!cooled(ledger.lastCueAt, policy.cueCooldownMs, now)) return quietCue('cooling')
    return {
      tone: 'companion',
      say: SAY.companion,
      mustNot: MUST_NOT,
      suggestBreak: false,
      reason: 'run-done',
      note: WHY['run-done'],
    }
  }

  return quietCue('nothing-new')
}

/**
 * 只读视图。
 * @param memory 判定状态。
 * @param ledger 台账。
 * @param policy 口径。
 * @param now 现在。
 * @param presence O-109 视图或 `null`。
 * @param stored 台账是否真的落盘。
 * @returns 视图。
 */
export function viewOf(
  memory: DevMemory,
  ledger: DevLedger,
  policy: DevPolicy,
  now: number,
  presence: ScreenPresenceLike | null,
  stored: boolean,
): DevView {
  const blocked = policy.respectPresence ? presenceGate(presence) : null
  const stuck =
    memory.streak >= policy.stuckFails &&
    memory.firstFailAt !== null &&
    now - memory.firstFailAt >= policy.stuckSpanMs

  let cues = 0
  for (const tone of ['companion', 'release', 'celebrate'] as const) {
    cues += ledger.tones[tone]
  }

  return {
    lastOutcome: memory.lastOutcome,
    streak: memory.streak,
    fails: memory.fails,
    passes: memory.passes,
    commits: memory.commits,
    quietMs: memory.lastFailAt === null ? null : Math.max(0, now - memory.lastFailAt),
    stuck,
    blockedByPresence: blocked,
    cues,
    stored,
  }
}
