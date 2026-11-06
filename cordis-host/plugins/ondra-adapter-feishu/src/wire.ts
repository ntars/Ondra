/**
 * 报文解析：JSON → header（元信息）→ event.message（正文）。
 *
 * ## 飞书事件体的三个坑（每一个都不报错，只是「她不回话」）
 *
 * 1. **`content` 是字符串，不是对象**。文本消息的正文长这样：
 *    `"content": "{\"text\":\"你好\"}"`——要**二次 `JSON.parse`**。
 *    直接当对象读会得到 `undefined`，而整条事件结构完全合法。
 * 2. **群里正文带 `@_user_1` 占位符**。它是给渲染器用的，不是用户说的话。
 *    不剥就会把「@_user_1 在吗」整句塞给模型，而模型会把它当成某种标记去解释。
 * 3. **`token` 有两处**：v2 在 `header.token`，老版本在顶层 `token`。
 *    只认一处会让另一半部署形态的验签永远失败。
 *
 * ## 加密体一律拒
 *
 * master-plan §9.11 明写「`encryptKey` 不支持加密体」。既然解不了，就**如实拒**：
 * 假装解了会得到一串乱码被当成用户的话；静默接受会得到「她永远不回」。
 * 拒的方式是 400 + 原因，让开发者在后台「事件订阅」页上当场看到失败。
 */

import type { ChatType, InboundMessage } from './types.js'
import { isRecord } from './settings.js'

/** 判空字符串。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 安全 `JSON.parse`：坏 JSON 返回 `null`，不抛。
 * @param text 原始文本。
 */
export function parseJson(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return isRecord(parsed) ? parsed : null
}

/**
 * 报文是不是加密体（`{"encrypt": "..."}`）。
 * @param payload 解析后的对象。
 */
export function isEncrypted(payload: Record<string, unknown>): boolean {
  return typeof payload['encrypt'] === 'string' && payload['encrypt'] !== ''
}

/**
 * 取 `url_verification` 的 challenge。
 *
 * 只认 `type === 'url_verification'` 且 `challenge` 是非空字符串的报文；
 * 其余返回 `null`。challenge 必须**原样回**（不能 trim、不能重编码）。
 * @param payload 解析后的对象。
 */
export function challengeOf(payload: Record<string, unknown>): string | null {
  if (textOf(payload['type']) !== 'url_verification') return null
  const challenge = payload['challenge']
  return typeof challenge === 'string' && challenge !== '' ? challenge : null
}

/**
 * 这条回调是不是「地址验证」（`url_verification`）。
 *
 * 判据比 `challengeOf` 宽一格：只要 `type` 是 `url_verification` 就算。
 * 为什么不让入口去判 `challenge` 在不在：`challenge` 为空也是一次**失败的验证请求**，
 * 应该走 `verify()` 回 400 让人在后台看见「验证失败」，而不是落进事件分支被静默收下。
 * @param payload 解析后的对象。
 */
export function isVerification(payload: Record<string, unknown>): boolean {
  return textOf(payload['type']) === 'url_verification' || challengeOf(payload) !== null
}

/** 事件元信息。 */
export interface EventHeader {
  /** 事件类型（如 `im.message.receive_v1`）。 */
  readonly eventType: string
  /** 事件 id（**去重主键**：飞书重投时它不变）。 */
  readonly eventId: string
  /** 事件创建时间（毫秒；缺失为 0）。 */
  readonly createdAt: number
  /** 校验 token。 */
  readonly token: string
  /** 应用 id。 */
  readonly appId: string
}

/**
 * 取事件元信息。
 *
 * `token` 优先 `header.token`，缺失时退到顶层 `token`（老版本形态）。
 * @param payload 解析后的对象。
 */
export function headerOf(payload: Record<string, unknown>): EventHeader {
  // 显式标注类型：`isRecord(...) ? payload['header'] : {}` 会被推断成
  // `Record<string, unknown> | {}`，而在 `{}` 那一支上取下标是 noImplicitAny 错误。
  const header: Record<string, unknown> = isRecord(payload['header']) ? payload['header'] : {}
  const created = Number(textOf(header['create_time']))
  const token = textOf(header['token'])
  return {
    eventType: textOf(header['event_type']),
    eventId: textOf(header['event_id']),
    createdAt: Number.isFinite(created) && created > 0 ? created : 0,
    // 只取一次：写两遍会在将来某次改动里悄悄分叉。
    token: token !== '' ? token : textOf(payload['token']),
    appId: textOf(header['app_id']),
  }
}

/**
 * 剥掉群聊里的 `@_user_N` 占位符。
 *
 * 只剥占位符，不剥用户真的打出来的 `@名字`：前者是平台生成的记号，
 * 后者是用户的意思（「@小王 你看」里的「小王」不能丢）。
 * @param text 原始正文。
 */
export function stripMentions(text: string): string {
  return text
    .replace(/@_user_\d+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * 数一下被 @ 了几次（占位符个数）。
 * @param text 原始正文。
 */
export function countMentions(text: string): number {
  const matched = text.match(/@_user_\d+/g)
  return matched === null ? 0 : matched.length
}

/**
 * 从 `content` 里取正文。
 *
 * `content` 是**字符串**（里面还有一层 JSON）。有些形态会直接给对象，
 * 两种都认；取不到给空串。
 * @param content `message.content`。
 */
export function contentTextOf(content: unknown): string {
  if (typeof content === 'string') {
    const parsed = parseJson(content)
    if (parsed === null) return ''
    return textOf(parsed['text'])
  }
  if (isRecord(content)) return textOf(content['text'])
  return ''
}

/**
 * 解析一条来信（只认消息事件）。
 *
 * 返回 `null` 表示「这不是一条可回答的消息」——由调用方决定原因码。
 * 名字刻意不叫 `messageOf`：适配器里已经有一个取错误文本的 `messageOf`，
 * 同名会让 `export` 处直接撞名（TS 报重复导出，而单文件读起来毫无问题）。
 * @param payload 解析后的对象。
 * @param now 现在（毫秒）。
 */
export function inboundOf(payload: Record<string, unknown>, now: number): InboundMessage | null {
  const header = headerOf(payload)
  if (header.eventType !== 'im.message.receive_v1') return null

  const event = isRecord(payload['event']) ? payload['event'] : null
  if (event === null) return null
  const message = isRecord(event['message']) ? event['message'] : null
  if (message === null) return null

  const chatId = textOf(message['chat_id'])
  if (chatId === '') return null

  const rawText = contentTextOf(message['content'])
  const chatTypeValue = textOf(message['chat_type'])
  const chatType: ChatType = chatTypeValue === 'group' ? 'group' : 'p2p'

  const sender = isRecord(event['sender']) ? event['sender'] : null
  const senderIds = sender !== null && isRecord(sender['sender_id']) ? sender['sender_id'] : null

  const created = Number(textOf(message['create_time']))
  const createdAt = Number.isFinite(created) && created > 0 ? created : header.createdAt > 0 ? header.createdAt : now

  return {
    chatId,
    chatType,
    senderId: senderIds === null ? '' : textOf(senderIds['open_id']),
    senderUserId: senderIds === null ? '' : textOf(senderIds['user_id']),
    msgType: textOf(message['message_type']),
    text: stripMentions(rawText),
    mentions: countMentions(rawText),
    messageId: textOf(message['message_id']),
    eventId: header.eventId,
    createdAt,
  }
}

/**
 * 去重键。
 *
 * **`event_id` 是主键**：飞书重投时它是同一个，`message_id` 也是，
 * 但前者在「同一条消息的多个事件」里更稳定。没有 `event_id` 时退到消息 id + 会话，
 * 再没有就用「会话 + 时间 + 正文」指纹。
 * @param message 来信。
 */
export function dedupeKeyOf(message: InboundMessage): string {
  if (message.eventId !== '') return 'ev:' + message.eventId
  if (message.messageId !== '') return 'msg:' + message.messageId
  return 'sig:' + [message.chatId, String(message.createdAt), message.text].join('|')
}

/**
 * 拼 `url_verification` 的响应体。**challenge 原样回**（只做 JSON 转义）。
 * @param challenge 平台给的字符串。
 */
export function buildChallenge(challenge: string): string {
  return JSON.stringify({ challenge })
}
