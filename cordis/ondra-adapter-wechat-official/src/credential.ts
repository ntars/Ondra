/**
 * 凭据读取。**三样东西都不进 `Config`。**
 *
 * ```json
 * { "appId": "...", "appSecret": "...", "token": "..." }
 * ```
 *
 * - `token` 是公众号后台「服务器配置」里的 Token，验签用；
 * - `appId` / `appSecret` 换来 access_token，发客服消息用。
 *
 * 三样都不出现在日志里、不进「当前配置」、不随配置导出。
 * 缺哪一样就报哪一样（`missing`），而不是笼统说「配置不对」——
 * 后者会让人把三样都改一遍。
 */

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import type { CredentialLoad, CredentialMissing, WechatCredentials } from './types.js'

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
      permissionTightened: false,
    }
  }
  if (!existsSync(file)) {
    return { ok: false, missing: 'file', detail: '凭据文件不存在：' + file, permissionTightened: false }
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
      permissionTightened: tightened,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return { ok: false, missing: 'json', detail: '凭据文件不是合法 JSON：' + file, permissionTightened: tightened }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, missing: 'shape', detail: '凭据文件应是对象：{"appId","appSecret","token"}', permissionTightened: tightened }
  }

  const raw = parsed as Record<string, unknown>
  const pick = (key: keyof WechatCredentials): string =>
    typeof raw[key] === 'string' ? (raw[key] as string).trim() : ''

  const appId = pick('appId')
  const appSecret = pick('appSecret')
  const token = pick('token')

  const missing: CredentialMissing[] = []
  if (appId === '') missing.push('appId')
  if (appSecret === '') missing.push('appSecret')
  if (token === '') missing.push('token')

  if (missing.length > 0) {
    return {
      ok: false,
      missing: missing[0],
      detail: '凭据缺字段：' + missing.join(' / ') + '（三个都要：token 验签，appId+appSecret 发客服消息）',
      permissionTightened: tightened,
    }
  }

  return {
    ok: true,
    value: { appId, appSecret, token },
    detail: '凭据已读入内存（三样齐）',
    permissionTightened: tightened,
  }
}

/**
 * 凭据模板（复制即用）。
 * @param file 凭据路径。
 */
export function credentialTemplate(file: string): string {
  return [
    '在 ' + file + ' 写入（权限 0600）：',
    '{"appId": "<公众号 AppID>", "appSecret": "<公众号 AppSecret>", "token": "<服务器配置里的 Token>"}',
    '注意：token 是「服务器配置 → Token」那一栏，不是 access_token；access_token 由本插件自己换，不用填。',
  ].join('\n')
}

/**
 * 打码后的 AppID（日志里认得出是哪个号，又不足以被冒用）。
 * @param appId 原文。
 */
export function maskAppId(appId: string): string {
  if (appId.length <= 6) return '****'
  return appId.slice(0, 4) + '****' + appId.slice(-2)
}
