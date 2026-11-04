/**
 * 报文层：验签、解析、拼回包。**纯函数，不碰网络、不读文件。**
 *
 * ## 为什么手写一个「按标签取值」的解析器，而不引 XML 库
 *
 * 1. 本仓禁装依赖；
 * 2. 真正需要的只有 8 个字段，用 `DOMParser` 反而带来新的问题面（实体展开、DTD）；
 * 3. **XXE**：任何会处理 DTD / 外部实体的解析器，在一个「公网可达、任何人都能 POST」
 *    的入口上都是风险。这里只做正则取标签，**不展开任何实体、不读 DTD**，
 *    并且对含 `<!DOCTYPE` / `<!ENTITY` 的报文直接拒绝（`bad-body`）。
 *
 * ## 验签为什么是「排序后拼起来算 sha1」
 *
 * 手册 §9.11 只写了「sha1 验签」，没有给具体拼法。这里用的是公众号服务器配置的
 * 通行做法：把 `token`、`timestamp`、`nonce` 三个字符串**按字典序排序**后直接拼接，
 * 取 sha1 十六进制小写，与 `signature` 逐字比较。这条口径必须写死在代码里：
 * 它一旦错了，微信后台「提交」就永远提示「配置失败」，而日志里只有一串不相等。
 *
 * **若上游（公众号后台）改了拼法，只需要改 `signatureOf()` 一个函数**，其余不动。
 */

import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { InboundMessage, QueryLike, VerifyOutcome, VerifyReason } from './types.js'

/** 验签允许的时间偏差（毫秒）：10 分钟。微信重试不会超过这个量级。 */
export const MAX_SKEW_MS = 600_000

/**
 * sha1 十六进制小写。
 * @param text 文本。
 */
export function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * 算签名。三者按字典序排序后直接拼接，再取 sha1。
 * @param token 服务器配置里的 Token。
 * @param timestamp 秒级时间戳字符串。
 * @param nonce 随机串。
 */
export function signatureOf(token: string, timestamp: string, nonce: string): string {
  const sorted = [token, timestamp, nonce].sort()
  return sha1Hex(sorted.join(''))
}

/**
 * 定长比较（避免按字符提前返回带来的时间侧信道）。
 *
 * 这里其实没有密钥泄露风险（签名是公开算出来的），但比较函数统一走这一条，
 * 以后有人拿它比较别的敏感串时不会踩坑。
 * @param left 左值。
 * @param right 右值。
 */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 验签。
 *
 * `echostr` 有没有都不影响验签本身——GET 验证与 POST 来信走同一套规则，
 * 区别只在「验完之后回什么」。
 * @param token 服务器配置里的 Token。
 * @param query 请求 query。
 * @param now 现在（毫秒）。
 * @param maxSkewMs 允许的时间偏差。
 */
export function checkSignature(
  token: string,
  query: QueryLike,
  now: number,
  maxSkewMs: number = MAX_SKEW_MS,
): { readonly ok: boolean; readonly reason?: VerifyReason; readonly detail?: string } {
  const signature = query['signature'] ?? ''
  const timestamp = query['timestamp'] ?? ''
  const nonce = query['nonce'] ?? ''
  if (signature === '' || timestamp === '' || nonce === '') {
    return { ok: false, reason: 'missing-params', detail: '缺 signature / timestamp / nonce 之一' }
  }

  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, reason: 'missing-params', detail: 'timestamp 不是正整数秒' }
  }
  // 只在「明显是旧请求」时拒：时钟偏差比攻击更常见，偏差窗口给到 10 分钟。
  if (Math.abs(now - seconds * 1000) > maxSkewMs) {
    return { ok: false, reason: 'stale', detail: 'timestamp 与本地时钟相差超过 ' + Math.round(maxSkewMs / 1000) + ' 秒' }
  }

  const expected = signatureOf(token, timestamp, nonce)
  if (!safeEqual(expected, signature.toLowerCase())) {
    return { ok: false, reason: 'bad-signature', detail: '签名不匹配：Token 与公众号后台不一致，或拼法被上游改了' }
  }
  return { ok: true }
}

/**
 * 取一个标签的值（CDATA 与纯文本两种写法都认）。
 *
 * 不展开实体、不做 DTD（见文件头）。取不到就返回空串，不抛错——
 * 公众号的报文会随消息类型增减字段，缺字段是常态。
 * @param xml 报文。
 * @param tag 标签名（大小写不敏感）。
 */
export function extractTag(xml: string, tag: string): string {
  const pattern = new RegExp(
    '<' + tag + '>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</' + tag + '>',
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
 * 含这两个东西的报文一律拒：本插件不解析实体，留着它只会让「别人构造的报文」
 * 有机会走一条我们没验证过的路径。
 * @param xml 报文。
 */
export function hasDtd(xml: string): boolean {
  return /<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)
}

/**
 * 解析一条来信。
 *
 * 只认「有发信人 + 有类型」的报文；其余返回 `null`（调用方回 `bad-body`）。
 * `CreateTime` 缺失时退回 `now`，而不是 0——0 会让 48 小时窗口直接判定为过期。
 * @param xml 报文。
 * @param now 现在（毫秒）。
 */
export function parseInbound(xml: string, now: number): InboundMessage | null {
  if (xml.trim() === '') return null
  if (hasDtd(xml)) return null

  const openId = extractTag(xml, 'FromUserName')
  const msgType = extractTag(xml, 'MsgType')
  if (openId === '' || msgType === '') return null

  const createdSeconds = Number(extractTag(xml, 'CreateTime'))
  const createdAt =
    Number.isFinite(createdSeconds) && createdSeconds > 0 ? createdSeconds * 1000 : now

  return {
    openId,
    accountId: extractTag(xml, 'ToUserName'),
    msgType,
    text: extractTag(xml, 'Content'),
    msgId: extractTag(xml, 'MsgId'),
    event: extractTag(xml, 'Event'),
    eventKey: extractTag(xml, 'EventKey'),
    createdAt,
  }
}

/**
 * CDATA 安全化。
 *
 * 正文里出现 `]]>` 会**提前闭合 CDATA**，后面半句话被当成标记——回包整个坏掉，
 * 微信侧表现为「没收到回复」。拆成两段 CDATA 是唯一正确写法。
 * @param text 原文。
 */
export function cdata(text: string): string {
  return '<![CDATA[' + text.split(']]>').join(']]]]><![CDATA[>') + ']]>'
}

/**
 * 拼一条被动回复的 XML。
 *
 * 注意两个方向：回包的 `ToUserName` 是**发信人**，`FromUserName` 是**公众号**。
 * 写反了微信不会报错，只是那条回复永远不会出现在对话里。
 * @param toOpenId 收信人（原发信人 openid）。
 * @param fromAccountId 公众号原始 id（原报文的 `ToUserName`）。
 * @param text 正文（已切好）。
 * @param atSec 秒级时间戳。
 */
export function buildTextReply(toOpenId: string, fromAccountId: string, text: string, atSec: number): string {
  return (
    '<xml>' +
    '<ToUserName>' + cdata(toOpenId) + '</ToUserName>' +
    '<FromUserName>' + cdata(fromAccountId) + '</FromUserName>' +
    '<CreateTime>' + Math.trunc(atSec) + '</CreateTime>' +
    '<MsgType>' + cdata('text') + '</MsgType>' +
    '<Content>' + cdata(text) + '</Content>' +
    '</xml>'
  )
}

/**
 * 处理一个 GET 验证请求。
 * @param token 服务器配置里的 Token（空串表示凭据没读到）。
 * @param enabled 通道开关。
 * @param query 请求 query。
 * @param now 现在（毫秒）。
 * @param maxSkewMs 允许的时间偏差。
 */
export function verifyRequest(
  token: string,
  enabled: boolean,
  query: QueryLike,
  now: number,
  maxSkewMs: number = MAX_SKEW_MS,
): VerifyOutcome {
  if (!enabled) {
    return { ok: false, http: 404, body: 'disabled', contentType: 'text/plain; charset=utf-8', reason: 'disabled', detail: '通道未启用' }
  }
  if (token === '') {
    return {
      ok: false,
      http: 500,
      body: 'no-credentials',
      contentType: 'text/plain; charset=utf-8',
      reason: 'no-credentials',
      detail: '凭据未读到，无法验签',
    }
  }
  const checked = checkSignature(token, query, now, maxSkewMs)
  if (!checked.ok) {
    // 401 而不是 200：让微信后台当场显示「配置失败」，而不是静静地把消息丢掉。
    return {
      ok: false,
      http: 401,
      body: 'bad-signature',
      contentType: 'text/plain; charset=utf-8',
      reason: checked.reason ?? 'bad-signature',
      detail: checked.detail,
    }
  }
  const echo = query['echostr'] ?? ''
  return { ok: true, http: 200, body: echo, contentType: 'text/plain; charset=utf-8' }
}
