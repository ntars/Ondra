/**
 * 报文解析。**纯函数，不碰网络、不碰文件。**
 *
 * ## 一份 Outgoing 报文长什么样
 *
 * ```json
 * {
 *   "conversationId": "cid…==",
 *   "conversationType": "1",
 *   "msgId": "msg…",
 *   "senderId": "$:LWCP_v1:$…",
 *   "senderStaffId": "manager1234",
 *   "senderNick": "张三",
 *   "text": {"content": " 你好"},
 *   "isInAtList": true,
 *   "sessionWebhook": "https://oapi.dingtalk.com/robot/sendBySession?session=…",
 *   "sessionWebhookExpiredTime": 1613635652738,
 *   "createAt": 1613632648088,
 *   "robotCode": "ding…",
 *   "msgtype": "text"
 * }
 * ```
 *
 * 这份形状来自钉钉开放平台公开文档，**仓内无副本、未实跑**。所以解析一律
 * 「有就用、没有就退化」，绝不因为多一个字段或少了 `senderStaffId` 就整条失败：
 * 外部联系人没有 `staffId`，那条消息仍然该被回答。
 *
 * ## 正文前的 @ 是「指代记号」，不是她说的话
 *
 * 群里 @ 机器人时，`text.content` 形如 `" @机器人名字 你好"`——开头一段是
 * 平台加的。`stripLeadingMentions()` **只剥开头连续的 @ 片段**，
 * 中间与结尾的 `@名字` 一个都不动：「@小王 你看这个」里的「小王」是意思的一部分。
 * 剥完为空（只 @ 了她、没说话）时不回答，标 `unsupported`。
 *
 * ## 为什么会话键是 `conversationId` 而不是 `senderId`
 *
 * 群里 `senderId` 是**那个人**，`conversationId` 是**那个群**。用 `senderId`
 * 做会话键，同一群里的十个人会被当成十个独立会话——她会分别记十份上下文，
 * 而群里看起来是「她忘了刚才谁说了什么」。
 */

import { createHash } from 'node:crypto'
import type { ConversationKind, InboundMessage } from './types.js'

/**
 * 解析 JSON 文本。
 * @param text 原始报文。
 */
export function parseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    const value = JSON.parse(trimmed) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

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
 * 读一个数字字段（钉钉有把数字发成字符串的形态，两个都认）。
 * @param raw 对象。
 * @param key 键名。
 */
function numberOf(raw: Record<string, unknown>, key: string): number {
  const value = raw[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) return Number(value)
  return 0
}

/**
 * 把 `conversationType` 归一成私聊/群。
 *
 * `'1'` 单聊、`'2'` 群聊；认不出的一律按**单聊**处理——
 * 判成群会让 `mentionRequired` 生效（见 O-055 能力声明），而判成单聊至少还回一句。
 * @param raw 对象。
 */
function kindOf(raw: Record<string, unknown>): ConversationKind {
  const given = textOf(raw, 'conversationType')
  return given === '2' ? 'group' : 'private'
}

/**
 * 剥掉正文开头连续的 @ 片段。
 *
 * 只剥开头：中间与结尾的 `@名字` 是用户真打的，属于意思的一部分。
 * 全角空格（`\u3000`）也算分隔符——钉钉群聊里它常出现在 @ 与正文之间。
 * @param text 原始正文。
 */
export function stripLeadingMentions(text: string): string {
  let rest = text
  // 最多剥 3 段：正常只有一段，多的那段要么是用户自己 @ 了别人，要么是脏数据。
  for (let index = 0; index < 3; index += 1) {
    const trimmed = rest.replace(/^[\s\u3000]+/, '')
    if (!trimmed.startsWith('@')) {
      rest = trimmed
      break
    }
    const at = trimmed.indexOf('@')
    const afterAt = trimmed.slice(at + 1)
    const boundary = afterAt.search(/[\s\u3000]/)
    if (boundary < 0) {
      // 整段都是 `@名字`，没有正文。
      rest = ''
      return rest.trim()
    }
    rest = afterAt.slice(boundary)
  }
  return rest.trim()
}

/**
 * 一条消息的去重键。
 *
 * 正常就是 `msgId`。**没有 `msgId` 时不能静默放行**：那会让「同一条被重投两次」
 * 变成「她答了两遍」。退化成「谁 + 何时 + 说了什么」的哈希——
 * 同样的内容在同一毫秒重复出现，本来也该当重复。
 * @param message 已解析的来信。
 */
export function dedupeKeyOf(message: InboundMessage): string {
  if (message.messageId !== '') return message.messageId
  return (
    'h-' +
    createHash('sha1')
      .update([message.senderId, String(message.createdAt), message.text].join('\u0000'), 'utf8')
      .digest('hex')
      .slice(0, 24)
  )
}

/**
 * 解析一条来信。**认不出必需字段就回 null**（不猜）。
 * @param raw 已解析的报文。
 * @param at 收到时刻（毫秒）。
 */
export function inboundOf(raw: Record<string, unknown>, at: number): InboundMessage | null {
  const conversationId = textOf(raw, 'conversationId')
  if (conversationId === '') return null

  const holder = raw['text']
  const body =
    typeof holder === 'object' && holder !== null && !Array.isArray(holder)
      ? textOf(holder as Record<string, unknown>, 'content')
      : ''

  const createdAt = numberOf(raw, 'createAt')
  const kind = kindOf(raw)
  const inAtList = raw['isInAtList'] === true

  return {
    conversationId,
    kind,
    senderStaffId: textOf(raw, 'senderStaffId'),
    senderId: textOf(raw, 'senderId'),
    senderNick: textOf(raw, 'senderNick'),
    // **只在群里 / 明确在 @ 名单里才剥前缀。** 私聊里用户手打一句「@你 在吗」，
    // 那个「@你」是他说的话的一部分；无条件剥会把主语吃掉。
    text: kind === 'group' || inAtList ? stripLeadingMentions(body) : body.trim(),
    inAtList,
    messageId: textOf(raw, 'msgId'),
    sessionWebhook: textOf(raw, 'sessionWebhook'),
    sessionExpiredAt: numberOf(raw, 'sessionWebhookExpiredTime'),
    createdAt: createdAt > 0 ? createdAt : at,
  }
}

/**
 * 报文的消息类型（只处理 `text`）。
 * @param raw 已解析的报文。
 */
export function msgTypeOf(raw: Record<string, unknown>): string {
  return textOf(raw, 'msgtype')
}

/**
 * 报文里的 robotCode（每条都会带；凭据缺失时用它兜底主动接口）。
 * @param raw 已解析的报文。
 */
export function robotCodeOf(raw: Record<string, unknown>): string {
  return textOf(raw, 'robotCode')
}

/**
 * 请求头归一化成小写的「单值」表。
 *
 * Node 的 `req.headers` 值可能是数组（同名头出现多次）。取**第一个**：
 * 验签只认一个 `sign`，多个的形态本身就说明中间有东西在改包。
 * @param headers 原始请求头。
 */
export function normalizeHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase()
    if (typeof value === 'string') {
      out[name] = value
      continue
    }
    if (Array.isArray(value)) {
      // 取第一个：验签只认一个 `sign`，多个的形态本身就说明中间有东西在改包。
      // 不写 `value[0] ?? ''`——`string[]` 的下标在关闭 noUncheckedIndexedAccess 时
      // 类型就是 `string`，`??` 的右操作数会被判成不可达。
      const first = value.length > 0 ? value[0] : ''
      if (typeof first === 'string') out[name] = first
    }
  }
  return out
}
