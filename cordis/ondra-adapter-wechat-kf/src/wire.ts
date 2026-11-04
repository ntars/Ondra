/**
 * 回调侧的收信工具：sha1 验签 + query 解析。
 *
 * ## 只有挂了回调才会走到这里
 *
 * 拉取式不需要任何人打进来。所以本文件是**可选路径**，不是主链路——
 * 但一旦用户填了 `callbackPath`，这就是唯一的门：不验签等于把
 * 「谁都能让她说话」这个口子开在公网上。
 *
 * ## 验签公式（企业微信 / 微信客服公开文档）
 *
 * ```
 * signature = sha1(sort([token, timestamp, nonce]).join(''))
 * ```
 *
 * 三个值按**字典序**排序后直接拼，中间不加分隔符——加不加分隔符会让
 * 「合法请求」被判成非法，而这个现象只在你真的收到第一条消息时才会发现。
 *
 * ## 为什么还要判时间
 *
 * 只验签名的话，一条被截获的合法请求可以**永久重放**（签名永远对）。
 * 所以另判 `timestamp` 与本地时间的偏差，超过 5 分钟直接判 `stale`。
 * 这不是防重放的全部（真正的重放防护要记 nonce），但它挡住了
 * 「昨天那条请求今天再发一遍」这种最常见的版本。
 */

import { createHash } from 'node:crypto'
import type { QueryLike, VerifyOutcome, VerifyReason } from './types.js'
import { MAX_SKEW_MS } from './types.js'

/**
 * 十六进制 sha1。
 * @param text 原文。
 */
export function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * 算签名。
 * @param token 回调 Token。
 * @param timestamp 时间戳（秒，字符串原样）。
 * @param nonce 随机串。
 */
export function signatureOf(token: string, timestamp: string, nonce: string): string {
  return sha1Hex([token, timestamp, nonce].sort().join(''))
}

/**
 * 定长比较，避免「比到第一个不同就返回」泄露位置信息。
 *
 * 本地回环场景下这条几乎不重要，但验签函数将来会被别的通道复用，
 * 那时它是公网入口，写法就得现在就对。
 * @param left 左值。
 * @param right 右值。
 */
export function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return diff === 0
}

/**
 * 解析 query 串。
 * @param url 请求 URL（可能只有路径）。
 */
export function parseQuery(url: string | undefined): QueryLike {
  const out: Record<string, string> = {}
  if (url === undefined || url === '') return out
  try {
    // 相对路径也能被 URL 解析：基址只用来凑一个合法 URL，不会被访问。
    const parsed = new URL(url, 'http://localhost')
    for (const [key, value] of parsed.searchParams.entries()) out[key] = value
  } catch {
    // URL 坏掉就当没有 query：验签会以 missing-params 拒掉，不会静默通过。
  }
  return out
}

/**
 * 验一次回调请求。
 *
 * 判序：有没有 Token → 参数齐不齐 → 时间新不新 → 签名对不对。
 * **签名的判定放最后**：前三个都能给出一句「你该去改哪里」的提示，
 * 而「签名不对」本身没有信息量（可能只是 Token 抄错了）。
 * @param query 请求 query。
 * @param token 回调 Token（空串 = 没配）。
 * @param now 当前时刻（毫秒）。
 */
export function checkSignature(query: QueryLike, token: string, now: number): VerifyOutcome {
  const fail = (reason: VerifyReason, detail: string): VerifyOutcome => ({
    ok: false,
    http: 403,
    body: detail,
    contentType: 'text/plain; charset=utf-8',
    reason,
    detail,
  })

  if (token.trim() === '') {
    return fail('no-token', '凭据里没有回调 token：挂回调必须先填它，否则谁来都能冒充平台')
  }

  const signature = query['msg_signature'] ?? query['signature'] ?? ''
  const timestamp = query['timestamp'] ?? ''
  const nonce = query['nonce'] ?? ''
  if (signature === '' || timestamp === '' || nonce === '') {
    return fail('missing-params', '回调参数不全：需要 signature / timestamp / nonce（缺一个都判失败）')
  }

  const seconds = Number.parseInt(timestamp, 10)
  if (Number.isFinite(seconds)) {
    const skew = Math.abs(now - seconds * 1000)
    if (skew > MAX_SKEW_MS) {
      return fail('stale', '回调时间戳与本地相差超过 5 分钟：可能是重放，也可能是本机时钟不准')
    }
  }

  const expected = signatureOf(token, timestamp, nonce)
  if (!safeEqual(expected, signature.toLowerCase())) {
    return fail('bad-signature', '签名不匹配：最常见的原因是 Token 与平台后台那一栏不一致')
  }

  // 平台「提交」时会带 echostr，要求原样回纯文本（不带任何外壳）。
  const echo = query['echostr'] ?? ''
  return {
    ok: true,
    http: 200,
    body: echo,
    contentType: 'text/plain; charset=utf-8',
    detail: echo === '' ? '验签通过（事件推送）' : '验签通过（回 echostr）',
  }
}
