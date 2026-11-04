/**
 * 判定：一条消息该不该处置。**纯函数，没有任何状态**。
 *
 * 状态（占用、队列、去重表）全在 `service.ts`。这样拆的理由很实际：
 * 判定是本插件唯一一处"业务规则"，它必须能被单独推演与对拍；
 * 一旦和 Map 混在一起，任何规则调整都要先猜"是不是队列影响了结果"。
 *
 * ## 闸门顺序：最便宜、最可能拒绝的放前（手册 §5.3 的顺序原则）
 *
 * | 顺序 | 闸门 | 为什么在这个位置 |
 * |---|---|---|
 * | 1 | 总开关 | 关掉了就没有后面所有判断的意义 |
 * | 2 | 自己发的 | 最便宜的防回声；放在白名单前，因为白名单管的是别人 |
 * | 3 | 白名单 | 拒绝比放行更该先说清楚（这是配置错误，不是闲聊） |
 * | 4 | 空消息 | 只发了图不算空；不判会出现"她对着空气回一句" |
 * | 5 | 群聊主动 | 红线，恒拒（§5.7），与时间/额度无关 |
 * | 6 | 私聊 | 唯一会「叫醒」的分支 |
 * | 7 | 群聊点名 / 关键词 / 其他 | 回，但不叫醒 |
 *
 * ## 私聊优先于「群里点名」这条为什么不能反过来
 *
 * 不冲突：`kind` 是互斥的枚举，两个分支永远只有一个成立。
 * 把私聊写在前，是因为它的动作更强（`wake`），而强动作应该更早被看到。
 */

import type { Config } from './settings.js'
import type { ConversationKind, RouteAction, RouteInput, RouteReason, Trigger } from './types.js'
import { isConversationKind, isTrigger } from './types.js'

/** 判定结果。**只有四种动作**：排队是「占位失败」的产物，不是判定结论。 */
export interface Verdict {
  readonly action: Extract<RouteAction, 'wake' | 'reply' | 'ignore' | 'deny'>
  readonly reason: RouteReason
}

/**
 * 取会话形态，非法值**按群聊处理**。
 *
 * 这个方向是刻意选的：认不出来时按群聊走 = 不叫醒她 = 最坏情况是
 * 「少回一条」；按私聊走 = 把一条群消息当成私聊来信 = 「她突然在群里
 * 被叫起来说话」，而节制红线的代价是不可逆的（举报、封号）。
 * @param value 待判的值。
 */
export function kindOf(value: unknown): ConversationKind {
  return isConversationKind(value) ? value : 'group'
}

/**
 * 取触发方式，非法值按普通来信处理。
 * @param value 待判的值。
 */
export function triggerOf(value: unknown): Trigger {
  return isTrigger(value) ? value : 'message'
}

/**
 * 正文是否为空（既没有字也没有附件）。
 * @param input 入参。
 */
export function isEmpty(input: RouteInput): boolean {
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  return text === '' && input.hasAttachment !== true
}

/**
 * 判定一条消息。
 * @param input 入站消息。
 * @param settings 已补全的配置。
 */
export function decideRoute(input: RouteInput, settings: Config): Verdict {
  // 1. 总开关。
  if (!settings.enable) return { action: 'ignore', reason: 'disabled' }

  // 2. 自己发的（防回声）。放在白名单前：白名单管的是别人。
  if (input.self === true) return { action: 'ignore', reason: 'self-echo' }

  // 3. 白名单。`undefined` 表示适配器没做白名单，由配置决定放不放。
  if (input.whitelisted === false) return { action: 'deny', reason: 'not-whitelisted' }
  if (input.whitelisted === undefined && settings.strictWhitelist) {
    return { action: 'deny', reason: 'not-whitelisted' }
  }

  // 4. 空消息。
  if (isEmpty(input)) return { action: 'ignore', reason: 'empty' }

  const kind = kindOf(input.kind)
  const trigger = triggerOf(input.trigger)

  // 5. 群聊永不主动（手册 §5.7 节制红线，**没有开关**）。
  if (kind === 'group' && trigger === 'active') {
    return { action: 'ignore', reason: 'group-active-ignored' }
  }

  // 6. 私聊：唯一会「叫醒」的分支。私聊里出现群专属触发按普通来信处理，
  //    不因为适配器填错一个枚举就让用户的消息没人管。
  if (kind === 'private') return { action: 'wake', reason: 'private-message' }

  // 7. 群聊：点名必回；关键词看配置；其余不处置。
  if (trigger === 'mention') return { action: 'reply', reason: 'group-mentioned' }
  if (trigger === 'keyword') {
    return settings.replyOnKeyword
      ? { action: 'reply', reason: 'group-keyword' }
      : { action: 'ignore', reason: 'group-not-addressed' }
  }
  return { action: 'ignore', reason: 'group-not-addressed' }
}
