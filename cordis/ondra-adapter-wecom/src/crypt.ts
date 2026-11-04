/**
 * WXBizMsgCrypt 的**只解不封**版本（`node:crypto`，零依赖）。
 *
 * 手册 master-plan §9.11 把企业微信的鉴权列写成「**自实现** WXBizMsgCrypt（AES-256-CBC）」——
 * 它是那张表里唯一一个被点名「自实现」的鉴权项，所以这个文件必须逐字节正确。
 * 它属于 §12.1 第 3 条允许的情形（协议编解码），而 `node:crypto` 是内建模块，
 * 不构成「新增依赖」，故不需要「临时引入 + 替换计划」。
 *
 * ## 帧格式（协议本身，不是我们的选择）
 *
 * ```
 * 明文帧 = 随机 16 字节 ‖ 4 字节大端(msg_len) ‖ msg ‖ receiveid
 * 填充   = PKCS#7，块长 **32**（不是 AES 的 16）
 * 密文   = AES-256-CBC(key, iv=key[0..16]) 后 base64
 * 签名   = sha1( sort([token, timestamp, nonce, encrypt]).join('') ) 十六进制小写
 * ```
 *
 * ## 三个必须自己写对的点（写错都不报错，只是「回调验证一直不过」）
 *
 * 1. **`setAutoPadding(false)`**。AES 的块长是 16，而企业微信的 PKCS#7 块长是 32。
 *    若让 Node 自己去填充，它按 16 去剥，会把明文末尾几个真字节当成填充吃掉——
 *    解出来的 XML 会缺一小截，报错位置却在 XML 解析器里。
 * 2. **填充长度必须逐字节校验**。只信最后一个字节、不校验其余字节，等于允许
 *    「填充被篡改」的报文通过，解出来的是一段乱码，而我们会把它当正文发给模型。
 * 3. **`receiveid` 必须与自己的 `corpId` 逐字相同**。这是协议里唯一的「这条消息是不是给我的」
 *    的证明；不校验，任何拿到同一 Token 的第三方回调都能塞进来。
 */

import { Buffer } from 'node:buffer'
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import {
  AES_BLOCK_BYTES,
  AES_KEY_BYTES,
  AES_KEY_CHARS,
  FRAME_PREFIX_BYTES,
  PKCS7_BLOCK_BYTES,
} from './types.js'

/** 解密失败的原因（闭集）。 */
export type CryptFailure =
  | 'bad-encoding-key'
  | 'bad-cipher'
  | 'bad-padding'
  | 'bad-frame'
  | 'corp-mismatch'

/** 解密结果。 */
export interface DecryptOutcome {
  /** 是否成功。 */
  readonly ok: boolean
  /** 明文（成功时）。 */
  readonly text?: string
  /** 失败原因。 */
  readonly reason?: CryptFailure
  /** 一句中文说明（不含明文）。 */
  readonly detail?: string
}

/** sha1 十六进制小写。 */
export function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/**
 * 定长比较，避免按字符提前返回带来的时间侧信道。
 *
 * 签名本身不是秘密（谁都能算），但比较函数统一走这一条：
 * 以后有人拿它比 Token 或 Secret 时不会踩坑。
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
 * 算回调签名。四项**按字典序排序**后直接拼接再取 sha1。
 *
 * 排序用的是 JS 默认的 UTF-16 码元序；企业微信的 Token 与 nonce 都是 ASCII，
 * 此时与逐字节序一致。含非 ASCII 字符的 Token 会出现与三方实现不一致的排序——
 * 已写进 README 的已知限制（Token 请只用 ASCII）。
 * @param token 回调配置里的 Token。
 * @param timestamp 秒级时间戳字符串。
 * @param nonce 随机串。
 * @param encrypt 密文（GET 验证时是 `echostr`）。
 */
export function signatureOf(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const sorted = [token, timestamp, nonce, encrypt].sort()
  return sha1Hex(sorted.join(''))
}

/**
 * 解 EncodingAESKey → 32 字节密钥。
 *
 * 规则是「43 个字符 + 补一个 `=` 再 base64 解」。**先校验字符集再解**：
 * `Buffer.from(x, 'base64')` 遇到非法字符会静默跳过，长度校验也可能"碰巧通过"，
 * 于是拿到一把错密钥，现象是解密出一段乱码而不是报错。
 * @param encodingAESKey 43 个字符的密钥串。
 */
export function decodeAesKey(encodingAESKey: string): Buffer | null {
  const text = encodingAESKey.trim()
  if (text.length !== AES_KEY_CHARS) return null
  if (!/^[A-Za-z0-9+/]+$/.test(text)) return null
  const key = Buffer.from(text + '=', 'base64')
  if (key.length !== AES_KEY_BYTES) return null
  return key
}

/**
 * 解开一段密文，取出消息正文。
 * @param key 32 字节密钥（由 `decodeAesKey` 得到）。
 * @param encryptBase64 `Encrypt`（或 `echostr`）字段原文。
 * @param receiveId 期望的接收方 id（企业微信自建应用填 `corpId`）。
 */
export function decryptFrame(key: Buffer, encryptBase64: string, receiveId: string): DecryptOutcome {
  const trimmed = encryptBase64.trim()
  if (trimmed === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return { ok: false, reason: 'bad-cipher', detail: '密文不是标准 base64' }
  }
  const cipher = Buffer.from(trimmed, 'base64')
  if (cipher.length === 0 || cipher.length % AES_BLOCK_BYTES !== 0) {
    return { ok: false, reason: 'bad-cipher', detail: '密文长度不是 ' + AES_BLOCK_BYTES + ' 的整数倍' }
  }

  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, AES_BLOCK_BYTES))
    // 这一行是本文件最关键的一行：企业微信的填充块长是 32，交给 Node 按 16 剥就会吃掉真字节。
    decipher.setAutoPadding(false)
    plain = Buffer.concat([decipher.update(cipher), decipher.final()])
  } catch {
    return { ok: false, reason: 'bad-cipher', detail: 'AES 解密失败（密钥与 EncodingAESKey 不一致）' }
  }
  if (plain.length < PKCS7_BLOCK_BYTES) {
    return { ok: false, reason: 'bad-frame', detail: '解出的帧太短（' + plain.length + ' 字节）' }
  }

  const padLength = plain[plain.length - 1]
  if (padLength < 1 || padLength > PKCS7_BLOCK_BYTES || padLength > plain.length) {
    return { ok: false, reason: 'bad-padding', detail: '填充长度非法（' + padLength + '）' }
  }
  for (let index = plain.length - padLength; index < plain.length; index += 1) {
    if (plain[index] !== padLength) {
      return { ok: false, reason: 'bad-padding', detail: '填充字节不一致（报文被截断或密钥不对）' }
    }
  }

  const frame = plain.subarray(0, plain.length - padLength)
  if (frame.length < FRAME_PREFIX_BYTES) {
    return { ok: false, reason: 'bad-frame', detail: '帧头不足 ' + FRAME_PREFIX_BYTES + ' 字节' }
  }
  const msgLength = frame.readUInt32BE(16)
  if (FRAME_PREFIX_BYTES + msgLength > frame.length) {
    return { ok: false, reason: 'bad-frame', detail: '帧内长度 ' + msgLength + ' 超出实际长度' }
  }

  const text = frame.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + msgLength).toString('utf8')
  const tail = frame.subarray(FRAME_PREFIX_BYTES + msgLength).toString('utf8')
  if (receiveId !== '' && tail !== receiveId) {
    return {
      ok: false,
      reason: 'corp-mismatch',
      detail: '帧尾的接收方是「' + tail + '」，与本企业 corpId 不一致',
    }
  }
  return { ok: true, text }
}

/**
 * 验签 + 解密一步到位（回调最常见的那条路径）。
 * @param token 回调配置里的 Token。
 * @param encodingAESKey 43 字符密钥串。
 * @param query 请求 query。
 * @param field 带密文的字段名（GET 验证是 `echostr`，POST 是 envelope 里的 `Encrypt`）。
 * @param receiveId 期望的接收方 id。
 */
export function openPayload(
  token: string,
  encodingAESKey: string,
  query: Readonly<Record<string, string | undefined>>,
  field: string,
  receiveId: string,
): DecryptOutcome & { readonly signatureOk: boolean } {
  const signature = (query['msg_signature'] ?? '').toLowerCase()
  const timestamp = query['timestamp'] ?? ''
  const nonce = query['nonce'] ?? ''
  if (signature === '' || timestamp === '' || nonce === '' || field === '') {
    return {
      ok: false,
      signatureOk: false,
      reason: 'bad-cipher',
      detail: '缺 msg_signature / timestamp / nonce / 密文字段之一',
    }
  }

  const expected = signatureOf(token, timestamp, nonce, field)
  if (!safeEqual(expected, signature)) {
    return { ok: false, signatureOk: false, reason: 'bad-cipher', detail: '签名不匹配（Token 与后台不一致）' }
  }

  const key = decodeAesKey(encodingAESKey)
  if (key === null) {
    return {
      ok: false,
      signatureOk: true,
      reason: 'bad-encoding-key',
      detail: 'EncodingAESKey 解不出 32 字节密钥（应为 43 个 base64 字符）',
    }
  }
  const opened = decryptFrame(key, field, receiveId)
  return { ...opened, signatureOk: true }
}
