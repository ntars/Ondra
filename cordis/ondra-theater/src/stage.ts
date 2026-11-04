/**
 * 场次调度核心（**纯函数，无 IO、无定时器、无台词**）。
 *
 * ## 一句话
 *
 * 拿到「现在场上有谁、已经说了几句、上一句是谁说的」，返回
 * 「下一句该谁说、这一句是什么意图、最多几句、哪些事不许做」。
 *
 * ## 为什么做成纯函数
 *
 * 调度的错都是**顺序错**：同一人连说两句、跳过一个人、少说一轮、该散没散。
 * 这类错在带 IO 的实现里要靠日志才看得见，在这里可以直接对着「座位 + 计数」摆出来。
 * 所以本模块只做三件事：**算下一个座位、算收束、拼一张不含台词的票**。
 *
 * ## 两个「不」
 *
 * - **不生成台词。** 返回的 `TurnPlan` 里只有意图与约束，没有一个字段能放句子。
 * - **不自己推进。** `nextTurnOf()` 是纯读；真正的推进只在 `advanceStage()` 里发生，
 *   且必须由「话已经说出去了」的一方调用。外壳随便轮询 `next()` 都不会多算一句。
 */

import { MAX_ROLES, MIN_ROLES, MUST_NOT, ROLE_ID_RE, TheaterError } from './types.js'
import type {
  CloseReason,
  NextResult,
  RoleInput,
  Seat,
  StagePolicy,
  TheaterView,
  TurnIntent,
  TurnPlan,
} from './types.js'

/**
 * 一场的内部状态。**不落盘**：场次是一次性的，重启即散场。
 *
 * 字段全部是「时刻 / 计数 / id」，没有一句内容——存档能不能还原台词，
 * 是「剧场」与「剧本」的分界线。
 */
export interface Stage {
  /** 场次 id。 */
  readonly sceneId: string
  /** 场次标签；没给为 `null`。 */
  readonly label: string | null
  /** 座位（顺序即发言顺序）。 */
  readonly seats: readonly Seat[]
  /** 已说几句。 */
  readonly turnCount: number
  /** 上一句是谁说的；还没人说话为 `null`。 */
  readonly lastSpeakerId: string | null
  /** 开场时刻。 */
  readonly openedAt: number
  /** 上一句（或开场）的时刻。冷场判据只认它。 */
  readonly lastAt: number
  /** 已收场的原因；还开着为 `null`。 */
  readonly closedReason: CloseReason | null
}

/** 开场用的已补全入参（名字已解析成座位）。 */
export interface OpenInput {
  /** 场次 id。 */
  readonly sceneId: string
  /** 场次标签。 */
  readonly label: string | null
  /** 座位。 */
  readonly seats: readonly Seat[]
}

/** 意图 → 一句说明（**不是台词**）。 */
const INTENT_NOTE: Readonly<Record<TurnIntent, string>> = Object.freeze({
  open: '本场第一句：把场子立起来，不交代背景',
  respond: '接上一位的话头，别另起一件事',
  bridge: '一轮说完了：换口气，不要总结上一轮',
  close: '本场最后一句：收尾，不承诺下一场',
})

/** 收场原因 → 一句中文（日志与快照共用）。 */
const REASON_NOTE: Readonly<Record<CloseReason, string>> = Object.freeze({
  'rounds-reached': '轮数到顶：该说的都说完了，再演就是重复',
  dispersed: '冷场：太久没人接，这一场已经被别的事打断',
  manual: '调用方收场',
})

/**
 * 取收场原因的中文说明。
 * @param reason 收场原因。
 * @returns 一句中文。
 */
export function closeNoteOf(reason: CloseReason): string {
  return REASON_NOTE[reason]
}

/**
 * 校验并规整开场角色。**只做形状与人数**，名字解析在服务里（那要问 O-021）。
 * @param value 任意入参。
 * @param maxRoles 生效的人数上限（≤ 4）。
 * @returns 角色列表（顺序保留）。
 */
export function readRoles(value: unknown, maxRoles: number): readonly RoleInput[] {
  if (!Array.isArray(value)) {
    throw new TheaterError('bad-request', '开场必须给 roles 数组')
  }
  if (value.length < MIN_ROLES) {
    throw new TheaterError(
      'too-few-roles',
      // 说明为什么不是「先演着看看」：单人场在第一条裁决下最多只能说一句。
      `角色不足：至少 ${MIN_ROLES} 人。一个人不是剧场，是独白——单人场最多只能说一句`,
    )
  }
  // 上限取「配置压低后的值」与硬天花板的较小者，配置写大也越不过 4。
  const cap = Math.min(maxRoles, MAX_ROLES)
  if (value.length > cap) {
    throw new TheaterError(
      'too-many-roles',
      // 说明为什么拒绝而不是排队：排队会让第五个人在若干轮之后突然开口。
      `角色超员：${value.length} 人，上限 ${cap} 人。当场拒绝，不排队——排队会让多出来的人在若干轮之后突然开口`,
    )
  }

  const seen = new Set<string>()
  const out: RoleInput[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') {
      throw new TheaterError('bad-request', '角色必须是 { id, name? } 对象')
    }
    const source = item as Record<string, unknown>
    const id = typeof source.id === 'string' ? source.id.trim() : ''
    if (!ROLE_ID_RE.test(id)) {
      throw new TheaterError(
        'bad-request',
        `角色 id 不合法（要求 ${ROLE_ID_RE.source}，且不含空格与路径分隔符）：${JSON.stringify(source.id)}`,
      )
    }
    if (seen.has(id)) {
      // 同一个 id 坐两个座位，轮转就会变成他一个人的独白，而且看起来像「两个人」。
      throw new TheaterError('duplicate-role', `角色 id 重复：${id}。同一个人不能坐两个座位`)
    }
    seen.add(id)
    const name = typeof source.name === 'string' ? source.name.trim() : ''
    out.push(name.length > 0 ? { id, name } : { id })
  }
  return out
}

/**
 * 开场：把座位定死。
 * @param input 已补全的入参。
 * @param now 开场时刻。
 * @returns 新场次。
 */
export function openStage(input: OpenInput, now: number): Stage {
  return {
    sceneId: input.sceneId,
    label: input.label,
    seats: input.seats,
    turnCount: 0,
    lastSpeakerId: null,
    openedAt: now,
    lastAt: now,
    closedReason: null,
  }
}

/**
 * 算下一位说话的人。
 *
 * 顺序是**座位环**，且永远跳过刚说过的那一位。座位数至少 2（`MIN_ROLES`），
 * 因此「下一个」永远不会回到上一位——第一条裁决在这里是结构性的，不靠判断。
 * @param stage 场次。
 * @returns 下一位的座位。
 */
export function nextSpeakerOf(stage: Stage): Seat {
  if (stage.lastSpeakerId === null) return stage.seats[0]
  const index = stage.seats.findIndex((seat) => seat.id === stage.lastSpeakerId)
  const next = index < 0 ? 0 : (index + 1) % stage.seats.length
  return stage.seats[next]
}

/**
 * 判断这一场是否该收场。**两条判据，任一命中即收。**
 *
 * 1. 轮数到顶（`turnCount >= maxRounds × 座位数`）——硬上限，不看时间。
 * 2. 冷场（距上一句或开场超过 `disperseMs`）——时间判据，不看轮数。
 *
 * 刻意不看「话题说完了没有」：那需要读懂内容，而本模块连台词都不碰。
 * @param stage 场次。
 * @param policy 判定口径。
 * @param now 当前时刻。
 * @returns 收场原因；不该收为 `null`。
 */
export function stopReasonOf(stage: Stage, policy: StagePolicy, now: number): CloseReason | null {
  if (stage.closedReason !== null) return stage.closedReason
  if (stage.turnCount >= policy.maxRounds * stage.seats.length) return 'rounds-reached'
  if (now - stage.lastAt >= policy.disperseMs) return 'dispersed'
  return null
}

/** 算这一句的意图：收尾 > 开场 > 过渡 > 接话，顺序即优先级。 */
function intentOf(turnCount: number, seats: number, closesAfter: boolean): TurnIntent {
  if (closesAfter) return 'close'
  if (turnCount === 0) return 'open'
  // 座位说满一轮之后的第一句是「过渡」：不总结上一轮，只换个口气。
  if (turnCount % seats === 0) return 'bridge'
  return 'respond'
}

/**
 * 出下一句的调度票。**纯读**：不改 `stage`、不写任何状态。
 * @param stage 场次。
 * @param policy 判定口径。
 * @param now 当前时刻。
 * @returns 三种结果之一（该说 / 该收 / 已收）。
 */
export function nextTurnOf(stage: Stage, policy: StagePolicy, now: number): NextResult {
  if (stage.closedReason !== null) {
    return {
      kind: 'closed',
      reason: stage.closedReason,
      note: `本场已收场（${REASON_NOTE[stage.closedReason]}）`,
    }
  }

  const stop = stopReasonOf(stage, policy, now)
  if (stop !== null) {
    // 该散但还没 close：**不由一次读代劳收场**，把决定交回调用方。
    return { kind: 'should-close', reason: stop, note: REASON_NOTE[stop] }
  }

  const seats = stage.seats.length
  const speaker = nextSpeakerOf(stage)
  const maxTurns = policy.maxRounds * seats
  const remainingTurns = maxTurns - stage.turnCount - 1
  const closesAfter = remainingTurns <= 0
  const intent = intentOf(stage.turnCount, seats, closesAfter)

  const plan: TurnPlan = {
    sceneId: stage.sceneId,
    turn: stage.turnCount + 1,
    round: Math.floor(stage.turnCount / seats) + 1,
    seat: speaker.seat,
    speakerId: speaker.id,
    speakerName: speaker.name,
    intent,
    // 收尾句夹到 1 句：最后一句多说是最常见的「收不住」。
    maxSentences: closesAfter ? 1 : policy.maxSentences,
    // 恒定四条：每一句都带，不看意图、不看轮次、不做成配置。
    mustNot: MUST_NOT,
    closesAfter,
    remainingTurns: Math.max(0, remainingTurns),
    note: INTENT_NOTE[intent],
  }
  return { kind: 'turn', plan }
}

/**
 * 记一句「已说」，把游标推到下一位。
 *
 * 调用前服务必须已经确认「还没到收束条件」——迟到的 `advance` 会先被收场，
 * 不会让冷场之后又续上一句。
 * @param stage 场次。
 * @param policy 判定口径。
 * @param speakerId 调用方声称说话的角色；给了就校验。
 * @param now 时刻。
 * @returns 新场次与被触发的收场原因。
 */
export function advanceStage(
  stage: Stage,
  policy: StagePolicy,
  speakerId: string | undefined,
  now: number,
): { readonly stage: Stage; readonly closed: CloseReason | null } {
  if (stage.closedReason !== null) {
    throw new TheaterError('closed', `本场已收场（${REASON_NOTE[stage.closedReason]}），不能再记一句`)
  }

  const expected = nextSpeakerOf(stage)
  if (speakerId !== undefined && speakerId !== expected.id) {
    // 记错人会直接导致同一个人连说两句，而这种错只在三人以上时出现，很难发现。
    throw new TheaterError(
      'bad-request',
      `记错人：这一句该 ${expected.id} 说，不接受 ${speakerId} 的记账`,
      `expected=${expected.id} actual=${speakerId}`,
    )
  }

  const next: Stage = {
    ...stage,
    turnCount: stage.turnCount + 1,
    lastSpeakerId: expected.id,
    lastAt: now,
  }
  const stop = stopReasonOf(next, policy, now)
  // 刚说完不可能立刻冷场（`lastAt` 就是 `now`），因此这里只可能是「轮数到顶」。
  if (stop === null || stop === 'dispersed') return { stage: next, closed: null }
  return { stage: { ...next, closedReason: stop }, closed: stop }
}

/**
 * 收场。**唯一能让座位上的人离开的方法。**
 * @param stage 场次。
 * @param reason 收场原因。
 * @returns 已收场的场次。
 */
export function closeStage(stage: Stage, reason: CloseReason): Stage {
  if (stage.closedReason !== null) {
    throw new TheaterError('closed', `本场已收场（${REASON_NOTE[stage.closedReason]}）`)
  }
  return { ...stage, closedReason: reason }
}

/**
 * 出快照。**纯读**。
 * @param stage 场次；没有为 `null`。
 * @param policy 判定口径。
 * @param now 当前时刻。
 * @returns 快照；没有场为 `null`。
 */
export function viewOf(
  stage: Stage | null,
  policy: StagePolicy,
  now: number,
): TheaterView | null {
  if (stage === null) return null
  const seats = stage.seats.length
  const maxTurns = policy.maxRounds * seats
  const stop = stopReasonOf(stage, policy, now)
  const closed = stage.closedReason !== null
  return {
    open: !closed,
    sceneId: stage.sceneId,
    label: stage.label,
    seats: stage.seats,
    round: Math.min(policy.maxRounds, Math.floor(stage.turnCount / seats) + 1),
    turns: stage.turnCount,
    maxTurns,
    remainingTurns: Math.max(0, maxTurns - stage.turnCount),
    lastSpeakerId: stage.lastSpeakerId,
    nextSpeakerId: closed ? null : nextSpeakerOf(stage).id,
    idleMs: Math.max(0, now - stage.lastAt),
    shouldClose: stop !== null,
    shouldCloseBecause: stop,
    closedReason: stage.closedReason,
  }
}
