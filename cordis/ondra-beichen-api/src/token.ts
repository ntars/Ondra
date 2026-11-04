/**
 * v1 令牌的签名与验签 —— **纯函数，不碰 ctx、不读盘、不联网**。
 *
 * 单独成文件的理由：这是整个入口链路里唯一「算错了也照样跑」的一段。
 * 签错了，页面依然能开、302 依然会跳，只是跳到的地方邀请码缺失；
 * 验错了，用户点按钮会看到 410。两者都不会抛异常，所以必须能脱离宿主
 * 单独核对——README 里的自检向量就是为此准备的。
 *
 * ## 格式（逐字对应 `docs/website.md`）
 *
 * ```
 * master   = sha256(MASTER_SECRET)
 * 分钟密钥  = HMAC-SHA256(master, "beichen-entry-v1|<分钟序号>")
 * token    = v1.<分钟序号>.<过期毫秒>.<12 字节 nonce>.<签名前 22 字符>
 * ```
 *
 * 三处文档没写死、由本实现决定的细节（写在这里，免得将来对不上）：
 *
 * 1. **nonce 用 base64url 无填充编码**，12 字节 → 16 个字符；
 * 2. **签名对 `v1.<分钟>.<过期>.<nonce>` 整段原文做 HMAC-SHA256**，
 *    再 base64url 无填充编码 → 43 个字符，**取前 22 个**；
 * 3. **验签用令牌自带的分钟序号重算密钥**，不要求它等于当前分钟——
 *    否则跨过整分钟的那一秒，刚铸出的币就废了。
 *
 * ## 为什么签名只取前 22 字符
 *
 * 43 个字符里前 22 个已经携带 132 位熵，穷举不可行；而短签名让 URL 更短，
 * 边缘日志里也不会出现一长串。代价是理论强度从 256 位降到 132 位，
 * 对「防止改参数」这个目标绰绰有余。
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import {
  KEY_PURPOSE,
  MAX_TOKEN_LENGTH,
  TOKEN_VERSION,
  type IssuedToken,
  type VerifyFailure,
  type VerifyResult,
} from './types.js'

/** 一分钟的毫秒数。 */
const MINUTE_MS = 60_000
/** nonce 字节数。 */
const NONCE_BYTES = 12
/** 签名保留的字符数。 */
const SIGNATURE_CHARS = 22
/** 分钟序号允许偏离当前时间的最大分钟数（含令牌自身有效期余量）。 */
const MAX_MINUTE_SKEW = 24 * 60

/** base64url 无填充编码。 */
function toBase64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

/**
 * 主密钥派生：`sha256(MASTER_SECRET)`。
 *
 * 为什么先哈希一层而不是直接拿原文当 HMAC 密钥：原文长度由用户决定，
 * 短口令直接当密钥会把强度压到口令水平；先过一次 sha256 至少保证 256 位。
 * @param secret 用户配置的主密钥原文。
 * @returns 32 字节派生密钥。
 */
export function deriveMaster(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/**
 * 分钟密钥：`HMAC-SHA256(master, "beichen-entry-v1|<分钟序号>")`。
 * @param master `deriveMaster` 的输出。
 * @param minute 分钟序号（`Math.floor(epochMs / 60000)`）。
 * @returns 32 字节分钟密钥。
 */
export function deriveMinuteKey(master: Buffer, minute: number): Buffer {
  return createHmac('sha256', master).update(`${KEY_PURPOSE}|${minute}`, 'utf8').digest()
}

/** 当前分钟序号。 */
export function minuteOf(epochMs: number): number {
  return Math.floor(epochMs / MINUTE_MS)
}

/**
 * 算签名段（22 个 base64url 字符）。
 * @param minuteKey 分钟密钥。
 * @param body 签名原文 `v1.<分钟>.<过期>.<nonce>`。
 * @returns 签名段。
 */
export function signBody(minuteKey: Buffer, body: string): string {
  const digest = createHmac('sha256', minuteKey).update(body, 'utf8').digest()
  return toBase64Url(digest).slice(0, SIGNATURE_CHARS)
}

/**
 * 签一枚令牌。
 * @param secret 主密钥原文。
 * @param now 签发时刻（毫秒）。
 * @param ttlMinutes 有效期（分钟），必须为正整数。
 * @param nonce 12 字节随机数；省略则现场生成（测试时可注入固定值）。
 * @returns 令牌与元数据。
 */
export function signToken(
  secret: string,
  now: number,
  ttlMinutes: number,
  nonce: Buffer = randomBytes(NONCE_BYTES),
): IssuedToken {
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`nonce 必须是 ${NONCE_BYTES} 字节，收到 ${nonce.length} 字节`)
  }
  const minute = minuteOf(now)
  const expiresAt = now + ttlMinutes * MINUTE_MS
  const nonceText = toBase64Url(nonce)
  const body = `${TOKEN_VERSION}.${minute}.${expiresAt}.${nonceText}`
  const signature = signBody(deriveMinuteKey(deriveMaster(secret), minute), body)
  return { token: `${body}.${signature}`, minute, expiresAt }
}

/**
 * 定长比较两个字符串，长度不同直接判否（`timingSafeEqual` 要求等长）。
 * @param left 左值。
 * @param right 右值。
 * @returns 是否逐字节相等。
 */
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 正整数校验（拒绝 `1.5`、`-1`、`1e999` 这类写法）。 */
function isPositiveInt(text: string): boolean {
  if (text.length === 0 || text.length > 16) return false
  for (const char of text) {
    if (char < '0' || char > '9') return false
  }
  return Number(text) > 0
}

/**
 * 验一枚令牌。
 * @param secret 主密钥原文。
 * @param token 待验令牌。
 * @param now 校验时刻（毫秒），默认当前时间。
 * @param ttlMinutes 用于计算「分钟序号漂移上限」的有效期。
 * @returns 验签结果。
 */
export function verifyToken(
  secret: string,
  token: string,
  now: number = Date.now(),
  ttlMinutes = 30,
): VerifyResult {
  if (token.length === 0) return { ok: false, reason: 'empty' }
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' }

  const parts = token.split('.')
  if (parts.length !== 5) return { ok: false, reason: 'malformed' }
  const [version, minuteText, expiryText, nonceText, signature] = parts as [string, string, string, string, string]

  if (version !== TOKEN_VERSION) return { ok: false, reason: 'bad-version' }
  if (!isPositiveInt(minuteText)) return { ok: false, reason: 'bad-minute' }
  if (!isPositiveInt(expiryText)) return { ok: false, reason: 'bad-expiry' }
  if (nonceText.length !== 16) return { ok: false, reason: 'bad-nonce' }
  if (signature.length !== SIGNATURE_CHARS) return { ok: false, reason: 'bad-signature' }

  const minute = Number(minuteText)
  const expiresAt = Number(expiryText)

  if (expiresAt <= now) return { ok: false, reason: 'expired' }

  // 分钟序号不能离当前太远：既挡住「把过期时间改到十年后」的伪造尝试，
  // 也挡住旧格式令牌在换签法后被当成合法。
  const currentMinute = minuteOf(now)
  const skewMinutes = Math.abs(currentMinute - minute)
  if (skewMinutes > Math.max(MAX_MINUTE_SKEW, ttlMinutes + 2)) {
    return { ok: false, reason: 'stale-minute' }
  }

  const body = `${version}.${minuteText}.${expiryText}.${nonceText}`
  const expected = signBody(deriveMinuteKey(deriveMaster(secret), minute), body)
  if (!safeEqual(expected, signature)) return { ok: false, reason: 'mismatch' }

  return { ok: true, minute, expiresAt }
}

/**
 * 把失败原因翻成人话，给失效页用。
 * @param reason 机器原因。
 * @returns 一句可直接展示给用户的中文。
 */
export function explainFailure(reason: VerifyFailure): string {
  switch (reason) {
    case 'empty':
      return '入口链接是空的，请回到应用里重新点一次「去注册」。'
    case 'malformed':
    case 'bad-version':
    case 'bad-minute':
    case 'bad-expiry':
    case 'bad-nonce':
    case 'bad-signature':
      return '入口链接不完整，可能复制时少了字符。请回到应用里重新点一次。'
    case 'expired':
      return '入口已过期（默认 30 分钟）。请回到应用里重新点一次「去注册」。'
    case 'stale-minute':
      return '入口的签发时间对不上，可能是电脑时钟被调整过。请校准时间后重试。'
    case 'mismatch':
      return '入口签名不匹配。这个链接要么被改过，要么不是本机签发的。'
  }
}
