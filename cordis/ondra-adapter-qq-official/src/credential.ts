/**
 * 凭据读取：**只从 `user/channels/qq-official.json` 读，不从配置读**。
 *
 * ## 为什么不放进 `Config`
 *
 * 配置会被面板导出、会被打进问题反馈、会出现在日志的「当前配置」里。
 * `clientSecret` 等价于密码，落进任何一份导出物都是一次泄漏。
 * 手册 §16.2-2 也写死了「凭据落 `user/channels/<channel-id>.json`（0600）」。
 *
 * 旧项目踩过的坑正好相反（master-plan §9.12）：界面上填的是 `token`，
 * 源码实际读的是 `appId` + `clientSecret`，于是「界面填了但连不上」。
 * 这里把字段名写在错误提示里，填错一次就能看见。
 *
 * ## 为什么要 chmod
 *
 * 用户手工 `echo` 出来的文件通常是 0644——同机任何用户都能读到密码。
 * 读到权限过宽就地收紧到 0600 并提示一次，比只报警告有效。
 */

import { chmodSync, readFileSync, statSync } from 'node:fs'
import type { CredentialLoad, LogLike, QqCredentials } from './types.js'

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 凭据文件应该长什么样（日志与 README 共用这一份说明）。
 * @param path 文件路径。
 */
export function credentialTemplate(path: string): string {
  return '在 ' + path + ' 写入 {"appId":"你的AppID","clientSecret":"你的ClientSecret"}，并把权限设为 0600'
}

/**
 * 读凭据。**永不抛错**。
 * @param path 凭据文件绝对路径；空串表示「路径还没解析出来」。
 * @param log 日志。
 */
export function loadCredentials(path: string, log: LogLike): CredentialLoad {
  if (path === '') {
    return {
      ok: false,
      reason: 'missing',
      detail: '凭据路径还没解析出来（缺 ondra-path-layout，且配置里也没写 credentialFile）',
      permissionTightened: false,
    }
  }

  let mode = 0
  try {
    const stat = statSync(path)
    if (!stat.isFile()) {
      return {
        ok: false,
        reason: 'missing',
        detail: path + ' 不是普通文件',
        permissionTightened: false,
      }
    }
    mode = stat.mode
  } catch {
    return {
      ok: false,
      reason: 'missing',
      detail: '找不到凭据文件：' + credentialTemplate(path),
      permissionTightened: false,
    }
  }

  // 权限过宽就地收紧。不算致命：读得到就先用，但要说出来。
  let tightened = false
  if ((mode & 0o077) !== 0) {
    try {
      chmodSync(path, 0o600)
      tightened = true
      log.warn('凭据文件权限过宽（同机其他用户可读），已收紧为 0600：%s', path)
    } catch {
      log.warn('凭据文件权限过宽且无法收紧（请手工 chmod 600）：%s', path)
    }
  }

  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {
      ok: false,
      reason: 'bad-perm',
      detail: '凭据文件存在但读不出来：' + path,
      permissionTightened: tightened,
    }
  }

  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      ok: false,
      reason: 'bad-json',
      detail: '凭据文件不是合法 JSON：' + path,
      permissionTightened: tightened,
    }
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: 'bad-shape',
      detail: '凭据文件必须是一个对象：' + credentialTemplate(path),
      permissionTightened: tightened,
    }
  }

  const appId = typeof parsed['appId'] === 'string' ? parsed['appId'].trim() : ''
  const clientSecret =
    typeof parsed['clientSecret'] === 'string' ? parsed['clientSecret'].trim() : ''

  if (appId === '' || clientSecret === '') {
    // 刻意把「缺哪个字段」说出来：旧项目就是因为字段名对不上而永远连不上。
    const missing: string[] = []
    if (appId === '') missing.push('appId')
    if (clientSecret === '') missing.push('clientSecret')
    return {
      ok: false,
      reason: 'bad-shape',
      detail: '凭据缺少字段：' + missing.join(' / ') + '。' + credentialTemplate(path),
      permissionTightened: tightened,
    }
  }

  const value: QqCredentials = Object.freeze({ appId, clientSecret })
  return {
    ok: true,
    value,
    detail: '凭据就绪（appId ' + maskAppId(appId) + '）',
    permissionTightened: tightened,
  }
}

/**
 * 把 appId 打码成日志里能认出来的样子。
 *
 * 只露首尾各 2 位：排障时要能确认「是不是这个机器人」，
 * 但完整 appId 与 secret 一起出现，就足以被人拿去试。
 * @param appId 原始 appId。
 */
export function maskAppId(appId: string): string {
  if (appId.length <= 4) return '****'
  return appId.slice(0, 2) + '****' + appId.slice(-2)
}
