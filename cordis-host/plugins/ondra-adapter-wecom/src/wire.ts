/**
 * 报文解析：query → 信封 → 明文 XML → 一条来信。
 *
 * ## 为什么自己写一个「只认标签」的解析器
 *
 * 企业微信的报文是一层薄 XML（十几个标量字段，没有嵌套、没有命名空间）。
 * 为了它引入一个 XML 库，代价是供应链与体积；而 `DOMParser` 在 Node 里不存在。
 * 所以这里只做「按标签取文本」：**不展开实体、不处理 DTD**——
 * 带 `<!DOCTYPE` / `<!ENTITY` 的报文一律拒（见 `hasDtd`）。
 *
 * ## 只接受加密回调
 *
 * 后台不填 EncodingAESKey 时，企业微信发的是**明文 XML**。本插件不认：
 * 明文模式没有 `msg_signature`，也就是说**任何知道回调地址的人都能伪造一条来信**。
 * 与其写一条「看起来能跑、其实谁都能塞话」的分支，不如明确拒掉并告诉人去填密钥。
 */

import type { InboundMessage, QueryLike } from './types.js'

/**
 * 取一个标签的文本（CDATA 与纯文本两种写法都认）。
 *
 * 取不到返回空串，不抛错——企业微信的报文会随消息类型增减字段，缺字段是常态。
 * @param xml 报文。
 * @param tag 标签名。
 */
export function extractTag(xml: string, tag: string): string {
  const pattern = new RegExp(
    '<' + tag + '>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</' + tag + '>',
    'i',
  )
  const matched = pattern.exec(xml)
  if (matched === null) return ''
  const cdata = matched[1]
  if (cdata !== undefined) return cdata
  return (matched[2] ?? '').trim()
}

/**
 * 报文是否带 DTD / 实体声明。
 *
 * 本插件不解析实体，留一条「别人构造的报文走我们没验证过的路径」的口子没有收益。
 * @param xml 报文。
 */
export function hasDtd(xml: string): boolean {
  return /<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)
}

/**
 * 解析 query 串。
 *
 * 相对路径也能被 `URL` 解析：基址只用来凑一个合法 URL，不会被访问。
 * @param url 请求 URL（可能只有路径）。
 */
export function parseQuery(url: string | undefined): QueryLike {
  const out: Record<string, string> = {}
  if (url === undefined || url === '') return out
  try {
    const parsed = new URL(url, 'http://localhost')
    for (const [key, value] of parsed.searchParams.entries()) out[key] = value
  } catch {
    // URL 坏掉就当没有 query：验签会以「缺字段」拒掉，不会静默通过。
  }
  return out
}

/** 信封（加密回调的外层）。 */
export interface Envelope {
  /** 密文。 */
  readonly encrypt: string
  /**
   * 信封里的 AgentID（可能为空）。
   *
   * 刻意**不收 `ToUserName`**：信封是明文、未签名，里面的企业 id 是对方写的字，
   * 不能当证据。真正证明「这条消息是给本企业的」只有一个地方——解密后帧尾的 `receiveid`。
   */
  readonly agentId: string
}

/**
 * 取加密回调的信封。
 *
 * 没有 `<Encrypt>` 就是明文模式（或根本不是本产品的回调）→ 返回 `null`，
 * 调用方按 `bad-body` 拒，并把「请填 EncodingAESKey」写进日志。
 * @param xml 原始报文。
 */
export function parseEnvelope(xml: string): Envelope | null {
  if (xml.trim() === '' || hasDtd(xml)) return null
  const encrypt = extractTag(xml, 'Encrypt')
  if (encrypt.trim() === '') return null
  return { encrypt: encrypt.trim(), agentId: extractTag(xml, 'AgentID') }
}

/**
 * 解析一条明文来信。
 *
 * 只认「有发信人 + 有类型」的报文，其余返回 `null`。
 * `CreateTime` 缺失时退回 `now`，而不是 0——0 会让去重键退化成一堆撞码。
 * @param xml 解密后的明文 XML。
 * @param now 现在（毫秒）。
 */
export function parseInbound(xml: string, now: number): InboundMessage | null {
  if (xml.trim() === '' || hasDtd(xml)) return null

  const userId = extractTag(xml, 'FromUserName')
  const msgType = extractTag(xml, 'MsgType')
  if (userId === '' || msgType === '') return null

  const seconds = Number(extractTag(xml, 'CreateTime'))
  const createdAt = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : now

  return {
    userId,
    corpId: extractTag(xml, 'ToUserName'),
    msgType,
    text: extractTag(xml, 'Content'),
    msgId: extractTag(xml, 'MsgId'),
    event: extractTag(xml, 'Event'),
    eventKey: extractTag(xml, 'EventKey'),
    createdAt,
  }
}

/**
 * 去重键。
 *
 * 优先用平台 `MsgId`；事件消息没有 `MsgId`，就退到「来源 + 时间 + 事件名 + 正文」的
 * 指纹——同一秒同一个人的同一个事件重试，指纹相同，能被认出来。
 * @param message 来信。
 */
export function dedupeKeyOf(message: InboundMessage): string {
  if (message.msgId !== '') return 'id:' + message.msgId
  const parts = [message.userId, String(message.createdAt), message.msgType, message.event, message.eventKey, message.text]
  return 'sig:' + parts.join('|')
}
