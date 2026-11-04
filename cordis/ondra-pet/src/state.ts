/**
 * 状态机：迁移表与几个纯判定。
 *
 * ## 为什么单独一个文件
 *
 * `service.ts` 要同时处理「闸门判定」与「异步桥调用」，两件事混在一个 200 行的类里，
 * 状态迁移会退化成散落的 `this.state = 'running'`。把迁移收成一张表以后，
 * 「能不能从 A 到 B」只有一处答案——这正是 O-074 的 `PET_TRANSITIONS` 存在的意义。
 *
 * ## 一条刻意的规则：`running → running` 不是合法迁移
 *
 * 「再叫一次」不是「更新参数」，是**第二只窗口**。手册 §6.2 的痛点原话是
 * 「桌宠版、QQ 版、微信版本质是 3 种不同插件，并不是同一只鱼」——同一台机器上
 * 出现两只桌宠，等于把这个痛点搬进桌面。所以第二次 `summon()` 走
 * `already-running` 拒绝，而不是「重启一只」。
 */

import { PET_TRANSITIONS } from './types.js'
import type { PetState } from './types.js'

/** 状态的中文说明（面板用）。表本身对联合类型穷举，漏一个 TS 就报。 */
export const STATE_LABELS: Readonly<Record<PetState, string>> = Object.freeze({
  idle: '还没叫过',
  starting: '正在起窗口',
  running: '在桌面上',
  stopping: '正在收',
  stopped: '已收起',
  failed: '起失败了',
})

/**
 * 能不能从 `from` 迁到 `to`。
 * @param from 当前状态。
 * @param to 目标状态。
 */
export function canTransition(from: PetState, to: PetState): boolean {
  return PET_TRANSITIONS[from].includes(to)
}

/** 是否处在过渡态（此时不接受新指令，避免重入）。 */
export function isBusy(state: PetState): boolean {
  return state === 'starting' || state === 'stopping'
}

/** 是否有一只在桌面上。 */
export function isRunning(state: PetState): boolean {
  return state === 'running'
}

/**
 * 状态的一句话描述。
 * @param state 状态。
 */
export function describeState(state: PetState): string {
  return STATE_LABELS[state]
}
