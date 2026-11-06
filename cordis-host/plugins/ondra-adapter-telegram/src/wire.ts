/**
 * 报文解析。**纯函数，不碰网络、不碰文件。**
 *
 * ## 一条 `Update` 长什么样
 *
 * ```json
 * {
 *   "update_id": 918273645,
 *   "message": {
 *     "message_id": 42,
 *     "from": {"id": 12345678, "is_bot": false, "first_name": "A", "username": "a"},
 *     "chat": {"id": -1001234567890, "type": "supergroup"},
 *     "date": 1699999999,
 *     "text": "@my_bot 你好",
 *     "entities": [{"type": "mention", "offset": 0, "length": 7}]
 *   }
 * }
 * ```
 *
 * 这份形状来自 Telegram Bot API 公开文档，**仓内无副本、未实跑**。
 * 解析一律「有就用、没有就退化」，绝不因为少了 `username` 或 `entities` 就整条失败。
 *
 * ## 三种 `chat.type` 只映射成两种
 *
 * `private` → 私聊；`group` / `supergroup` → 群；`channel` 与其余 → **丢弃**。
 * 频道里的消息不该有「回一句」这回事，把它当群回会让一个只读频道突然开口。
 *
 * ## 群里的「被 @」要认两种证据
 *
 * 1. `entities` 里有 `mention`（用户打了 `@my_bot`）；
 * 2. `entities` 里有 `bot_command`（`/start` 这类命令，平台视为对机器人说的）。
 *
 * 光看正文里有没有 `@` 不够：「@小王 你看这个」里的 `@` 与机器人无关。
 * 而只认 `text.includes(botUsername)` 又会漏掉 `/start`。
 *
 * ## 为什么去重键是 `update_id` 而不是 `message_id`
 *
 * `offset` 的语义是「`update_id` 以前的都收过了」，所以去重与游标必须用同一个
 * 坐标系。用 `message_id` 做键会在「同一条消息被编辑」时产生新 id、
 * 而在「不同会话恰好同号」时撞车。
 */

import type { ConversationKind, InboundMessage, UpdateView } from './types.js'

/**
 * 读一个字符串字段。
 * @param raw 对象。
 * @param key 键名。
 */
function textOf(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 读一个数字字段（允许数字形态的字符串）。
 * @param raw 对象。
 * @param key 键名。
 */
function numberOf(raw: Record<string, unknown>, key: string): number {
  const value = raw[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d{1,20}$/.test(value)) return Number(value)
  return 0
}

/**
 * 判一个值是不是普通对象。
 * @param value 任意值。
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * 把 `chat.type` 映射成私聊/群。频道与认不出的返回 `null`（丢弃）。
 * @param raw 消息对象。
 */
export function kindOf(raw: Record<string, unknown>): ConversationKind | null {
  const chat = asRecord(raw['chat'])
  if (chat === null) return null
  const type = textOf(chat, 'type')
  if (type === 'private') return 'private'
  if (type === 'group' || type === 'supergroup') return 'group'
  return null
}

/**
 * 判这条消息有没有对机器人说。
 *
 * @param raw 消息对象。
 * @param botUsername 机器人用户名（不带 `@`；空串表示不知道，此时只认 entities）。
 */
export function mentionedOf(raw: Record<string, unknown>, botUsername: string): boolean {
  const entities = raw['entities']
  if (Array.isArray(entities)) {
    for (const item of entities) {
      const entity = asRecord(item)
      if (entity === null) continue
      const type = textOf(entity, 'type')
      if (type === 'mention' || type === 'bot_command') return true
    }
  }
  if (botUsername === '') return false
  const text = textOf(raw, 'text')
  return text.toLowerCase().includes('@' + botUsername.toLowerCase())
}

/**
 * 去重键。
 *
 * 正常就是 `update_id`（与 offset 同一个坐标系）。**缺 `update_id` 的更新不该被
 * 静默放行**：那会让「同一条被拉两次」变成「她答了两遍」。退化成聊天号 + 消息号。
 * @param message 已解析的来信。
 */
export function dedupeKeyOf(message: InboundMessage): string {
  if (message.updateId > 0) return 'u:' + String(message.updateId)
  return 'm:' + String(message.chatId) + ':' + String(message.messageId)
}

/**
 * 解析一条更新。**不是消息（编辑、回调查询、成员变动…）或认不出必需字段就回 null。**
 * @param update 一条更新。
 * @param botUsername 机器人用户名（可空）。
 */
export function inboundOf(update: UpdateView, botUsername: string): InboundMessage | null {
  const raw = update.raw
  const message = asRecord(raw['message'])
  if (message === null) return null

  const kind = kindOf(message)
  if (kind === null) return null

  const chat = asRecord(message['chat'])
  if (chat === null) return null
  const chatId = numberOf(chat, 'id')
  if (chatId === 0) return null

  const from = asRecord(message['from'])
  const text = textOf(message, 'text')
  const messageId = numberOf(message, 'message_id')
  const seconds = numberOf(message, 'date')

  return {
    updateId: update.updateId,
    chatId,
    kind,
    senderId: from === null ? '' : textOf(from, 'id'),
    senderUsername: from === null ? '' : textOf(from, 'username'),
    text,
    mentioned: mentionedOf(message, botUsername),
    messageId,
    // Telegram 的 `date` 是秒。乘 1000 只在这里做一次——别处再用就是第二份换算。
    createdAt: seconds > 0 ? seconds * 1000 : 0,
  }
}

/**
 * 这条更新的发信人是不是机器人（自己或别的 bot）。是就丢弃。
 * @param update 一条更新。
 */
export function fromBotOf(update: UpdateView): boolean {
  const message = asRecord(update.raw['message'])
  if (message === null) return false
  const from = asRecord(message['from'])
  if (from === null) return false
  return from['is_bot'] === true
}
