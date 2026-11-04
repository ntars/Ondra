/**
 * 凭据读取。**三样都只在文件里，永不进 `Config`、永不进日志。**
 *
 * ## 为什么 `verificationToken` 也算凭据
 *
 * 它是「这条回调是不是飞书发的」的唯一凭据。它不保密到「能冒充应用」的程度，
 * 但泄露之后任何知道回调地址的人都能往这里塞一条伪造的用户消息——
 * 也就是能让「她」对着主人说一段别人写的台词。所以它和其它两样一样存 0600 文件。
 *
 * ## 为什么读到就 `chmod 0600`
 *
 * 用户是自己拿文本编辑器建的这个文件，默认权限通常是 0644——同机的其他账号能读。
 * 「提醒用户去改权限」这件事没人会做；就地收紧一次，比在 README 写三行有用。
 * 收紧失败不阻断（Windows 上没有 POSIX 权限位）。
 */

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import type { CredentialLoad, CredentialMissing, FeishuCredentials } from './types.js'
import { isRecord } from './settings.js'

/**
 * 取一个非空字符串字段。
 * @param record 对象。
 * @param key 字段名。
 */
function textOf(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 读凭据文件。**永不抛错**：任何异常都折算成带原因的 `CredentialLoad`。
 * @param file 绝对路径（空串表示算不出路径）。
 */
export function readCredentials(file: string): CredentialLoad {
  if (file === '') {
    return {
      ok: false,
      missing: 'file',
      detail: '算不出凭据文件路径（缺 ondra-path-layout，且 credentialFile 也没填）',
      permissionTightened: false,
    }
  }
  if (!existsSync(file)) {
    return { ok: false, missing: 'file', detail: '凭据文件不存在：' + file, permissionTightened: false }
  }

  let tightened = false
  try {
    const mode = statSync(file).mode & 0o777
    if ((mode & 0o077) !== 0) {
      chmodSync(file, 0o600)
      tightened = true
    }
  } catch {
    // 权限收紧失败不阻断：Windows 上没有 POSIX 位，读得到就能用。
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, missing: 'json', detail: '凭据文件不是合法 JSON：' + file, permissionTightened: tightened }
  }
  if (!isRecord(parsed)) {
    return { ok: false, missing: 'shape', detail: '凭据文件的顶层不是对象：' + file, permissionTightened: tightened }
  }

  const appId = textOf(parsed, 'appId')
  const appSecret = textOf(parsed, 'appSecret')
  const verificationToken = textOf(parsed, 'verificationToken')

  const missing: CredentialMissing[] = []
  if (appId === '') missing.push('appId')
  if (appSecret === '') missing.push('appSecret')
  if (verificationToken === '') missing.push('verificationToken')

  if (missing.length > 0) {
    return {
      ok: false,
      missing: missing[0] ?? 'shape',
      detail: '凭据缺字段（' + missing.join(' / ') + '）：' + file,
      permissionTightened: tightened,
    }
  }

  const value: FeishuCredentials = Object.freeze({ appId, appSecret, verificationToken })
  return { ok: true, value, detail: '凭据已就绪：' + file, permissionTightened: tightened }
}

/**
 * 生成一份可直接粘贴的凭据模板（**只含占位符，不含任何真实值**）。
 * @param file 目标路径。
 */
export function credentialTemplate(file: string): string {
  const body = {
    appId: 'cli_xxxxxxxxxxxxxxxx',
    appSecret: '填应用的 App Secret',
    verificationToken: '填事件订阅页面的 Verification Token',
  }
  return '请创建 ' + file + '（权限 0600），内容形如：\n' + JSON.stringify(body, null, 2)
}

/**
 * 打码显示 App ID（日志里只露前 6 位与后 4 位）。
 * @param appId 应用 id。
 */
export function maskAppId(appId: string): string {
  if (appId.length <= 12) return appId === '' ? '(空)' : appId.slice(0, 3) + '***'
  return appId.slice(0, 6) + '***' + appId.slice(-4)
}
