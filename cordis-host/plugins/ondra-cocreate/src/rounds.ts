/**
 * 纯轮次状态机：把「现在轮到谁、第几版、还剩几版」变成一次可读的推进。
 *
 * **本文件没有 IO、没有 `Date`、没有定时器、没有随机数。** 所有时刻都由调用方传进来，
 * 于是同一串操作在任何时候重放都得到同一份进度——这是它可被静态复核的前提。
 *
 * ## 水位与账目必须分开记（本文件最容易写错的地方）
 *
 * - `edition` 是**水位**：已经交出去几版，决定「还剩几版、是不是该收束」；
 * - `rounds` 是**账目**：真的交接了几次（立题、出稿、提意见都算一次）。
 *
 * 两者**刻意不同步**：一轮意见交接结束后 `rounds` 加一而 `edition` 不动。
 * 把两者合并成一个数字，就会得出「意见也算一版」——那等于允许两个人靠互相点评
 * 把版数耗完，最后一版反而没空改。
 *
 * ## 为什么上限按版数算，不按发言次数算
 *
 * 发言次数谁都能刷：问一句答一句就翻一轮，硬上限立刻变成软提醒。
 * 版数是硬的——它只在**真的交出一版**时才加一，谁也刷不出来。
 *
 * ## 为什么会有一个 `closing` 阶段
 *
 * 最后一版被点评完，`handoff()` 不能直接把它推进到 `closed`：那一步等于「点评完就算完了」，
 * 而「完了」必须由人问出口（「这版算定稿吗」）。所以先落到 `closing`——
 * 「只许收束，不许再改」，把最后一步逼到 `close()` 上。
 *
 * ## 为什么状态只在内存
 *
 * 共创是一次对话之内的事。落盘只会得到一种更坏的局面：下一个进程读到「第 3 版」，
 * 却不知道前 3 版做过什么，然后对着一个自己没见过的稿子收束。
 * 代价是进程重启后轮次清零——这一条写在 README 已知限制里，不藏着。
 */

import type { CocreateSnapshot, Party, Phase, RoundKind } from './types.js'

/** 会话状态。**只有计数与时刻**，一个字的目标、备注、正文都不放。 */
export interface SessionState {
  /** 当前阶段。 */
  readonly phase: Phase
  /** 会话开始时刻。 */
  readonly openedAt: number | null
  /** 收束时刻。 */
  readonly closedAt: number | null
  /** 水位：已交出的版数。 */
  readonly edition: number
  /** 账目：已完成的交接次数。 */
  readonly rounds: number
  /** 目标字符数（**长度而不是原文**）。 */
  readonly goalChars: number
  /** 最近一次交接时刻。 */
  readonly lastHandoffAt: number | null
}

/** 推进失败的原因。与错误码同名，由服务层翻译成中文并抛 `CocreateError`。 */
export type StepFail = 'no-session' | 'already-done' | 'round-cap'

/** 推进结果。**纯数据**，调用方一眼能看完。 */
export type StepResult =
  | {
      /** 成功。 */
      readonly ok: true
      /** 新状态。 */
      readonly state: SessionState
      /** 刚刚兑现的那一拍。 */
      readonly fulfilled: RoundKind
    }
  | {
      /** 失败。 */
      readonly ok: false
      /** 失败原因。 */
      readonly fail: StepFail
    }

/** 空状态（没开过）。 */
export function idleState(): SessionState {
  return Object.freeze({
    phase: 'idle',
    openedAt: null,
    closedAt: null,
    edition: 0,
    rounds: 0,
    goalChars: 0,
    lastHandoffAt: null,
  })
}

/**
 * 立一次题。**旧会话的版数与账目一律清零**：换题就是换一次共创，
 * 留着上一个题的版号只会让「第 2 版」指两个不同的东西。
 * @param at 时刻。
 * @param goalChars 目标字符数（只记长度）。
 */
export function startState(at: number, goalChars: number): SessionState {
  return Object.freeze({
    phase: 'brief',
    openedAt: at,
    closedAt: null,
    edition: 0,
    rounds: 0,
    goalChars,
    lastHandoffAt: null,
  })
}

/**
 * 兑现当前这一拍。
 *
 * 转移表（`maxEditions` 只影响 `review` 之后落到哪）：
 *
 * | 当前 | 兑现后 | 说明 |
 * |---|---|---|
 * | `brief` | `make` | 目标说清了，该动手 |
 * | `make` | `review`（`edition` +1） | 交出一版，必须让对方看一眼 |
 * | `review` | `make` 或 `closing` | 还有版数就改，用尽就只能收束 |
 * | `closing` | 拒绝 | 版数用尽，只许 `close()` |
 * | `closed` | 拒绝 | 已经收束 |
 * @param state 旧状态。
 * @param at 时刻。
 * @param maxEditions 版数硬上限。
 */
export function handoffState(state: SessionState, at: number, maxEditions: number): StepResult {
  switch (state.phase) {
    case 'idle':
      return { ok: false, fail: 'no-session' }
    case 'closed':
      return { ok: false, fail: 'already-done' }
    case 'closing':
      // 版数用尽之后的任何交接都是在拖，而拖正是硬上限要拦的东西。
      return { ok: false, fail: 'round-cap' }
    case 'brief':
      return {
        ok: true,
        state: Object.freeze({
          ...state,
          phase: 'make' as Phase,
          rounds: state.rounds + 1,
          lastHandoffAt: at,
        }),
        fulfilled: 'brief',
      }
    case 'make': {
      if (state.edition >= maxEditions) return { ok: false, fail: 'round-cap' }
      return {
        ok: true,
        state: Object.freeze({
          ...state,
          phase: 'review' as Phase,
          edition: state.edition + 1,
          rounds: state.rounds + 1,
          lastHandoffAt: at,
        }),
        fulfilled: 'make',
      }
    }
    case 'review': {
      // 这一版已经是最后一版：不再给「make」的口子，逼到收束上。
      const next: Phase = state.edition >= maxEditions ? 'closing' : 'make'
      return {
        ok: true,
        state: Object.freeze({
          ...state,
          phase: next,
          rounds: state.rounds + 1,
          lastHandoffAt: at,
        }),
        fulfilled: 'review',
      }
    }
  }
}

/** 收束结果。 */
export type CloseResult =
  | { readonly ok: true; readonly state: SessionState; readonly changed: boolean }
  | { readonly ok: false; readonly fail: 'no-session' }

/**
 * 收束。**幂等**：已经收束过的再收一次不报错（`changed` 为假）。
 *
 * 幂等是刻意的：外壳在重连、重渲染、恢复会话时都可能重放一次 `close()`，
 * 那时报 `already-done` 只会让人以为共创坏了，而实际上它早就好好结束了。
 * @param state 旧状态。
 * @param at 时刻。
 */
export function closeState(state: SessionState, at: number): CloseResult {
  if (state.phase === 'idle') return { ok: false, fail: 'no-session' }
  if (state.phase === 'closed') return { ok: true, state, changed: false }
  return {
    ok: true,
    state: Object.freeze({ ...state, phase: 'closed' as Phase, closedAt: at }),
    changed: true,
  }
}

/** 这一阶段轮谁开口。`idle` / `closed` 没人开口。 */
export function ownerOf(phase: Phase): Party | null {
  switch (phase) {
    case 'brief':
    case 'review':
    case 'closing':
      // 立题、点评、收束都是提出方的活；动手方只出稿与改稿。
      return 'author'
    case 'make':
      return 'maker'
    case 'idle':
    case 'closed':
      return null
  }
}

/** 这一阶段对应哪一拍。`closing` 算收束拍（催着问那句定稿）。 */
export function kindOf(phase: Phase): RoundKind | null {
  switch (phase) {
    case 'brief':
      return 'brief'
    case 'make':
      return 'make'
    case 'review':
      return 'review'
    case 'closing':
      return 'close'
    case 'idle':
    case 'closed':
      return null
  }
}

/**
 * 组装只读快照。
 * @param state 状态。
 * @param maxEditions 版数硬上限。
 */
export function snapshotOf(state: SessionState, maxEditions: number): CocreateSnapshot {
  const active = state.phase !== 'idle' && state.phase !== 'closed'
  return Object.freeze({
    active,
    phase: state.phase,
    owner: ownerOf(state.phase),
    edition: state.edition,
    maxEditions,
    editionsLeft: Math.max(0, maxEditions - state.edition),
    rounds: state.rounds,
    closing: state.phase === 'closing',
    openedAt: state.openedAt,
    closedAt: state.closedAt,
    goalChars: state.goalChars,
    lastHandoffAt: state.lastHandoffAt,
    // 字面量 false：本插件永不宣布定稿。
    final: false as const,
  })
}
