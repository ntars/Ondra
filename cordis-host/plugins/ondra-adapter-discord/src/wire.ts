/**
 * 事件解析。**纯函数，不碰网络、不碰文件。**
 *
 * ## 一条网关事件长什么样（按公开文档写，仓内无副本、未实跑）
 *
 * ```json
 * {
 *   "op": 0,
 *   "s": 42,
 *   "t": "MESSAGE_CREATE",
 *   "d": {
 *     "id": "1111111111111111111",
 *     "channel_id": "2222222222222222222",
 *     "guild_id": "3333333333333333333",
 *     "author": {"id": "4444444444444444444", "username": "a", "bot": false},
 *     "content": "你好",
 *     "mentions": [{"id": "5555555555555555555"}],
 *     "timestamp": "2026-11-02T12:00:00.000000+00:00"
 *   }
 * }
 * ```
 *
 * 本仓检索 `MESSAGE_CREATE` / `HELLO` / `RESUME` / `op_code` / `intents` /
 * `gateway.discord` **全部 0 命中**（手册无 Discord 专章，只有一个社群链接）。
 * 所以解析一律「有就用、没有就退化」，**绝不因为少了 `guild_id` 或 `mentions`
 * 就整条失败**——字段名猜错时，失败形态应当是一条都不回（可见），
 * 而不是时好时坏（不可见）。
 *
 * ## 为什么只认 `MESSAGE_CREATE`
 *
 * 网关会把「编辑、删除、表情回应、打字中」全都推过来（虽然默认 intents 下
 * 大部分不会）。本包只回答「新消息」：
 *
 * - `MESSAGE_UPDATE`（编辑）**不答**：一次编辑会变成第二次回答，
 *   而用户只是在改错别字；
 * - 表情回应、打字中更不该触发回答。
 *
 * ## 「被 @」认两种证据
 *
 * 1. 结构化：`mentions[]` 里有机器人的 id（最可靠）；
 * 2. 文本里出现 `<@id>` 或 `<@!id>`（旧版客户端/移动端的提及格式）。
 *
 * 只认正文里的 `@` 不够——那可能是「@小王 你看这个」；只认 `mentions` 又会在
 * 端口实现方没补全该字段时漏判，所以两条都要。
 *
 * ## 时间戳为什么允许解析失败
 *
 * `timestamp` 是 ISO8601 字符串（带微秒与偏移）。解析失败回 0，
 * **不阻断**——时刻只用于日志与排序，而丢一条消息比时刻不准严重得多。
 */

import type { ConversationKind, InboundMessage, IngestReason } from './types.js'

/** 只认这一种事件名。 */
export const MESSAGE_EVENT = 'MESSAGE_CREATE'

/**
 * 判一个值是不是普通对象。
 * @param value 任意值。
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * 读一个字符串字段（雪花 id 有时是数字，一并收）。
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
 * 从事件里取事件名。
 *
 * 兼容两种喂法：`{ t: 'MESSAGE_CREATE', d: {...} }`（网关原样）与
 * `{ type: 'MESSAGE_CREATE', data: {...} }`（部分端口实现把它拆过一层）。
 * 两种都认，因为**端口实现方的形状不由本插件决定**。
 * @param raw 原始事件。
 */
export function eventNameOf(raw: Record<string, unknown>): string {
  const name = textOf(raw, 't')
  if (name !== '') return name
  return textOf(raw, 'type')
}

/**
 * 从事件里取负载。
 * @param raw 原始事件。
 */
export function payloadOf(raw: Record<string, unknown>): Record<string, unknown> | null {
  const direct = asRecord(raw['d'])
  if (direct !== null) return direct
  return asRecord(raw['data'])
}

/**
 * 会话类型。有 `guild_id` → 群；没有 → 私聊（DM）。
 * @param payload 事件负载。
 */
export function kindOf(payload: Record<string, unknown>): ConversationKind {
  return textOf(payload, 'guild_id') === '' ? 'private' : 'group'
}

/**
 * 判这条有没有对机器人说。
 * @param payload 事件负载。
 * @param botUserId 机器人 id（空串表示不知道，此时只认文本形态）。
 */
export function mentionedOf(payload: Record<string, unknown>, botUserId: string): boolean {
  const mentions = payload['mentions']
  if (Array.isArray(mentions) && botUserId !== '') {
    for (const item of mentions) {
      const mention = asRecord(item)
      if (mention === null) continue
      if (textOf(mention, 'id') === botUserId) return true
    }
  }
  if (botUserId === '') {
    // 不知道自己的 id 时，退一步：正文里只要出现提及语法就算。
    // 这会把「@别人」也算成提及——**宁可多回一句，也别在她的群里当哑巴**，
    // 且该分支只在 `me()` 还没跑过时生效。
    return /<@!?\d{1,20}>/.test(textOf(payload, 'content'))
  }
  const content = textOf(payload, 'content')
  return content.includes('<@' + botUserId + '>') || content.includes('<@!' + botUserId + '>')
}

/**
 * 解析 `timestamp`。失败回 0（**不阻断**）。
 * @param payload 事件负载。
 */
export function createdAtOf(payload: Record<string, unknown>): number {
  const text = textOf(payload, 'timestamp')
  if (text === '') return 0
  const value = Date.parse(text)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 这条是不是机器人自己（或别的 bot）发的。
 *
 * 少了这一条，两个 bot 会互相刷；而 `author.bot` 字段在端口实现方
 * 没透传时会是 `undefined`——那种情况只能靠 `botUserId` 比对（见 `inboundOf`）。
 * @param payload 事件负载。
 */
export function fromBotOf(payload: Record<string, unknown>): boolean {
  const author = asRecord(payload['author'])
  if (author === null) return false
  return author['bot'] === true
}

/**
 * 发信人 id。
 * @param payload 事件负载。
 */
export function authorIdOf(payload: Record<string, unknown>): string {
  const author = asRecord(payload['author'])
  if (author === null) return ''
  return textOf(author, 'id')
}

/**
 * 解析一条 `MESSAGE_CREATE`。
 *
 * 返回 `null` 表示「这不是一条能回答的消息」（不是消息事件 / 缺必需 id /
 * 是机器人发的）。**调用方靠 `null` 决定不答，不靠猜。**
 * @param raw 原始事件。
 * @param botUserId 机器人 id（空串表示还不知道）。
 */
export function inboundOf(raw: Record<string, unknown>, botUserId: string): InboundMessage | null {
  return explainOf(raw, botUserId).message
}

/** 解析结论：要么给出理由，要么给出消息。二者不同时出现。 */
export interface ParseOutcome {
  /** 不答的理由；`accepted` 表示解析成功。 */
  readonly reason: IngestReason
  /** 解析出的来信（理由不是 `accepted` 时为 `null`）。 */
  readonly message: InboundMessage | null
}

/**
 * 解析并**给出为什么**。
 *
 * `inboundOf()` 只回「有没有」，这一个回「为什么没有」。
 * 两者刻意分开：内部判定只需要前者，而 `ingest()` 的返回值要给面板看，
 * 「不是消息」与「是她自己发的」在排查时导向完全相反的方向。
 * @param raw 原始事件。
 * @param botUserId 机器人 id（空串表示还不知道）。
 */
export function explainOf(raw: Record<string, unknown>, botUserId: string): ParseOutcome {
  if (eventNameOf(raw) !== MESSAGE_EVENT) return { reason: 'not-message', message: null }

  const payload = payloadOf(raw)
  if (payload === null) return { reason: 'not-message', message: null }

  const messageId = textOf(payload, 'id')
  if (messageId === '') return { reason: 'bad-id', message: null }

  const channelId = textOf(payload, 'channel_id')
  if (channelId === '') return { reason: 'bad-id', message: null }

  // 平台说这是 bot（含自己）→ 不答。`botUserId` 比对是第二条路：
  // 有些端口实现不透传 `author.bot`，只看它会把「她自己的消息」当用户消息回。
  if (fromBotOf(payload)) return { reason: 'self', message: null }
  const senderId = authorIdOf(payload)
  if (botUserId !== '' && senderId === botUserId) return { reason: 'self', message: null }

  const author = asRecord(payload['author'])

  return {
    reason: 'accepted',
    message: {
      messageId,
      channelId,
      guildId: textOf(payload, 'guild_id'),
      kind: kindOf(payload),
      senderId,
      senderUsername: author === null ? '' : textOf(author, 'username'),
      text: textOf(payload, 'content'),
      mentioned: mentionedOf(payload, botUserId),
      createdAt: createdAtOf(payload),
    },
  }
}
