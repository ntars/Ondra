/**
 * 凭据读取。**五样东西都不进 `Config`。**
 *
 * ```json
 * {
 *   "corpId": "ww...",
 *   "secret": "换 access_token 用的 Secret",
 *   "openKfId": "wk...",
 *   "token": "回调 Token（仅回调模式）",
 *   "encodingAesKey": "回调加密密钥（仅回调模式，本版不解密）"
 * }
 * ```
 *
 * ## 为什么前三个是必需的、后两个是可选的
 *
 * 拉取式只用得到前三样：换 access_token、拉消息、发消息。
 * `token` 与 `encodingAesKey` 属于**回调模式**——本插件默认不挂回调，
 * 所以它们缺失不算「凭据不全」，只是「你要挂回调时还差这两个」。
 * 把五个一起判成必需，结果是每个只用拉取的人都被迫填两个用不上的字段，
 * 然后开始怀疑自己填错了。
 *
 * ## 为什么不写日志里的原文
 *
 * `corpId` 可以被看见（它出现在每个接口地址里，藏不住），
 * 但 `secret` 一旦进日志就等于泄露。所以这里只提供打码函数，
 * 且打码后仍然能认出「是哪一个」。
 */

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import type { CredentialLoad, CredentialMissing, KfCredentials } from './types.js'

/** 文件权限：只有本人可读写。 */
const FILE_MODE = 0o600

/**
 * 把权限收紧到 0600（只收紧、不放宽）。
 * @param file 文件路径。
 */
function tighten(file: string): boolean {
  try {
    const mode = statSync(file).mode & 0o777
    if ((mode & 0o077) === 0) return false
    chmodSync(file, FILE_MODE)
    return true
  } catch {
    return false
  }
}

/**
 * 读凭据。
 * @param file 凭据路径（空串表示算不出来）。
 */
export function readCredentials(file: string): CredentialLoad {
  if (file.trim() === '') {
    return {
      ok: false,
      missing: 'file',
      detail: '凭据路径算不出来：缺 ondra-path-layout，配置里也没写 credentialFile',
      tightened: false,
    }
  }
  if (!existsSync(file)) {
    return { ok: false, missing: 'file', detail: '凭据文件不存在：' + file, tightened: false }
  }

  const tightened = tighten(file)
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return {
      ok: false,
      missing: 'file',
      detail: '凭据文件读不出来：' + (error instanceof Error ? error.message : String(error)),
      tightened,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return { ok: false, missing: 'json', detail: '凭据文件不是合法 JSON：' + file, tightened }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      missing: 'shape',
      detail: '凭据文件应是对象：{"corpId","secret","openKfId"[,"token","encodingAesKey"]}',
      tightened,
    }
  }

  const raw = parsed as Record<string, unknown>
  const pick = (key: keyof KfCredentials): string =>
    typeof raw[key] === 'string' ? (raw[key] as string).trim() : ''

  const corpId = pick('corpId')
  const secret = pick('secret')
  const openKfId = pick('openKfId')

  const missing: CredentialMissing[] = []
  if (corpId === '') missing.push('corpId')
  if (secret === '') missing.push('secret')
  if (openKfId === '') missing.push('openKfId')

  if (missing.length > 0) {
    return {
      ok: false,
      missing: missing[0],
      detail:
        '凭据缺字段：' +
        missing.join(' / ') +
        '（拉取与发送要三样齐：corpId + secret 换 access_token，openKfId 定位客服号）',
      tightened,
    }
  }

  return {
    ok: true,
    value: { corpId, secret, openKfId, token: pick('token'), encodingAesKey: pick('encodingAesKey') },
    detail: '凭据已读入内存（拉取所需三样齐）',
    tightened,
  }
}

/**
 * 凭据模板（复制即用）。
 * @param file 凭据路径。
 */
export function credentialTemplate(file: string): string {
  return [
    '在 ' + file + ' 写入（权限 0600）：',
    '{"corpId": "<企业 id，ww 开头>", "secret": "<应用的 Secret>", "openKfId": "<客服号 id，wk 开头>", ' +
      '"token": "<回调 Token，仅挂回调时填>", "encodingAesKey": "<回调密钥，仅挂回调时填>"}',
    '注意：secret 是「应用管理 → 自建应用 → Secret」，不是回调 Token；access_token 由本插件自己换，不用填。',
  ].join('\n')
}

/**
 * 打码后的企业 id（日志里认得出是哪个企业，又不足以被冒用）。
 * @param corpId 原文。
 */
export function maskCorpId(corpId: string): string {
  if (corpId.length <= 6) return '****'
  return corpId.slice(0, 4) + '****' + corpId.slice(-2)
}

/**
 * 打码后的客服号 id。
 * @param openKfId 原文。
 */
export function maskKfId(openKfId: string): string {
  if (openKfId.length <= 6) return '****'
  return openKfId.slice(0, 4) + '****' + openKfId.slice(-2)
}
