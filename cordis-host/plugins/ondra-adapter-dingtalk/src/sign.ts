/**
 * 验签。**纯函数 + `node:crypto`，不碰网络、不碰文件。**
 *
 * ## 算法（公开文档口径）
 *
 * ```
 * stringToSign = timestamp + "\n" + appSecret
 * sign         = base64(HMAC-SHA256(stringToSign, key = appSecret))
 * ```
 *
 * 注意**两边都是同一个 `appSecret`**：它既是消息内容的一部分，又是密钥。
 * 这与「用密钥签消息」的常规写法不同，抄错就会出现「永远验不过」——
 * 而且因为签名是一串 base64，肉眼完全看不出错在哪。
 *
 * ## 为什么时间戳必须自己判
 *
 * 只验签名不验时间，等于把「一次泄漏的签名」变成「永久通行证」：
 * 抓到一条回调的 header，可以无限次重放。所以要求 `|now - timestamp| ≤ signSkewMs`，
 * 默认 1 小时。判在**验签之前**：时间都不对的请求不必去算 HMAC。
 *
 * ## 为什么签名比对要 `timingSafeEqual`
 *
 * 普通 `===` 在第一个不同的字节就返回，比较耗时会随「前缀猜对多少」变化。
 * 对本地单用户产品来说风险很小，但这是一行代码的成本，没有不做的理由。
 * 长度不等时 `timingSafeEqual` 会抛，所以先判长度。
 *
 * ## 为什么接受「空格当成加号」的签名
 *
 * base64 里的 `+` 经某些代理/网关会被转成空格。只在 header 里出现时不该发生，
 * 但它发生时的症状是「签名随机失败、同一台机器时好时坏」，极难查。
 * 多试一次把空格换回 `+` 的形态，成本为零；这不放宽安全性——
 * 换出来的仍然必须与真实签名逐字节相等。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SignInput, SignReason, SignVerdict } from './types.js'

/**
 * 算一个签名（给测试与自检用；生产路径只需要 `verifySign`）。
 * @param timestamp 时间戳字符串。
 * @param appSecret 应用密钥。
 */
export function signOf(timestamp: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(timestamp + '\n' + appSecret, 'utf8').digest('base64')
}

/**
 * 定长比较两个 base64 签名。
 * @param given 收到的签名。
 * @param expected 算出来的签名。
 */
function safeEqual(given: string, expected: string): boolean {
  const left = Buffer.from(given, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 判一条请求的签名。
 * @param input 两个请求头。
 * @param appSecret 应用密钥。
 * @param now 当前时刻（毫秒）。
 * @param skewMs 允许的时间偏差（毫秒）。
 */
export function verifySign(input: SignInput, appSecret: string, now: number, skewMs: number): SignVerdict {
  const timestamp = input.timestamp.trim()
  const sign = input.sign.trim()

  if (timestamp === '' || sign === '') {
    return {
      ok: false,
      reason: 'missing-header',
      detail: '缺 timestamp 或 sign 头：后台「加签」开关打开后，钉钉每条回调都会带这两个头',
    }
  }

  // 时间戳是毫秒字符串。带小数点或指数的都不认——那不是钉钉发的。
  if (!/^\d{1,16}$/.test(timestamp)) {
    return { ok: false, reason: 'bad-timestamp', detail: 'timestamp 不是纯数字：' + timestamp.slice(0, 24) }
  }
  const at = Number(timestamp)
  if (!Number.isFinite(at) || at <= 0) {
    return { ok: false, reason: 'bad-timestamp', detail: 'timestamp 不可解析' }
  }

  const skew = Math.abs(now - at)
  if (skew > skewMs) {
    return {
      ok: false,
      reason: 'skew',
      detail:
        '时间戳差了 ' +
        String(Math.round(skew / 1000)) +
        ' 秒，超过容差 ' +
        String(Math.round(skewMs / 1000)) +
        ' 秒：检查本机时钟，或调大 signSkewMs',
    }
  }

  const expected = signOf(timestamp, appSecret)
  if (safeEqual(sign, expected)) return { ok: true, reason: 'ok', detail: '签名通过' }

  // 代理把 `+` 转成空格的情形（见文件头最后一段）。
  const restored = sign.replace(/ /g, '+')
  if (restored !== sign && safeEqual(restored, expected)) {
    return { ok: true, reason: 'ok', detail: '签名通过（签名里的空格已还原成加号）' }
  }

  return {
    ok: false,
    reason: 'bad-sign',
    detail: '签名不匹配：多半是 appSecret 填的不是这个机器人的（Sign 里出现空格也看这里）',
  }
}

/**
 * 把验签原因翻成一句人话（日志与面板用）。
 * @param reason 原因码。
 */
export function signReasonText(reason: SignReason): string {
  switch (reason) {
    case 'ok':
      return '签名通过'
    case 'missing-header':
      return '缺验签头'
    case 'bad-timestamp':
      return '时间戳格式不对'
    case 'skew':
      return '时间戳超出容差'
    case 'bad-sign':
      return '签名不匹配'
    default:
      return '未知验签结果'
  }
}
