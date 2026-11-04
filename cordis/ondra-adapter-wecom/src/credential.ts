/**
 * 凭据读取。**五样都只在文件里，永不进 `Config`、永不进日志。**
 *
 * ## 为什么凭据不能放配置
 *
 * 配置会被导出、会被打进反馈包、会出现在「当前配置」面板与日志里。
 * 一个 `secret` 出现在那里，等于把它交给了每一个看过截图的人。
 * 所以路径可以配（`credentialFile`），**值不行**。
 *
 * ## 为什么读到就 `chmod 0600`
 *
 * 用户是自己拿文本编辑器建的这个文件，默认权限通常是 0644——同机的其他账号能读。
 * 「提醒用户去改权限」这件事没人会做；就地收紧一次，比在 README 写三行有用。
 * 收紧失败不阻断（只 warn）：Windows 上没有 POSIX 权限位，不能因此让通道不可用。
 */

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import type { CredentialLoad, CredentialMissing, WecomCredentials } from './types.js'
import { AES_KEY_CHARS } from './types.js'
import { isRecord } from './settings.js'

/**
 * 把可能是字符串的 AgentId 读成正整数。
 *
 * 表单里填的永远是字符串，而「填了 `abc`」这种错必须有明确原因，
 * 不能悄悄变成 `NaN` 再在发消息时炸。
 * @param value 原始值。
 */
function agentIdOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.trunc(value)
    return rounded > 0 ? rounded : null
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '' || !/^\d+$/.test(text)) return null
    const parsed = Number(text)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

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
    return {
      ok: false,
      missing: 'file',
      detail: '凭据文件不存在：' + file,
      permissionTightened: false,
    }
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
    return {
      ok: false,
      missing: 'json',
      detail: '凭据文件不是合法 JSON：' + file,
      permissionTightened: tightened,
    }
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      missing: 'shape',
      detail: '凭据文件的顶层不是对象：' + file,
      permissionTightened: tightened,
    }
  }

  const corpId = textOf(parsed, 'corpId')
  const secret = textOf(parsed, 'secret')
  const token = textOf(parsed, 'token')
  const encodingAESKey = textOf(parsed, 'encodingAESKey')
  const agentId = agentIdOf(parsed['agentId'])

  const missing: CredentialMissing[] = []
  if (corpId === '') missing.push('corpId')
  if (agentId === null) missing.push('agentId')
  if (secret === '') missing.push('secret')
  if (token === '') missing.push('token')
  if (encodingAESKey === '') missing.push('encodingAESKey')

  if (missing.length > 0) {
    return {
      ok: false,
      missing: missing[0] ?? 'shape',
      detail: '凭据缺字段（' + missing.join(' / ') + '）：' + file,
      permissionTightened: tightened,
    }
  }
  if (encodingAESKey.length !== AES_KEY_CHARS) {
    // 长度错是最常见的一种：少复制一个字符。它会让解密全线失败，
    // 而现象只是「回调一直验证不通过」——所以必须单独说清楚。
    return {
      ok: false,
      missing: 'encodingAESKey',
      detail: 'EncodingAESKey 应为 ' + AES_KEY_CHARS + ' 个字符，实际 ' + encodingAESKey.length + ' 个：' + file,
      permissionTightened: tightened,
    }
  }

  const value: WecomCredentials = Object.freeze({
    corpId,
    agentId: agentId === null ? 0 : agentId,
    secret,
    token,
    encodingAESKey,
  })
  return { ok: true, value, detail: '凭据已就绪：' + file, permissionTightened: tightened }
}

/**
 * 生成一份可直接粘贴的凭据模板（**只含占位符，不含任何真实值**）。
 * @param file 目标路径。
 */
export function credentialTemplate(file: string): string {
  const body = {
    corpId: 'ww0000000000000000',
    agentId: 1000002,
    secret: '填自建应用的 Secret',
    token: '填接收消息服务器配置里的 Token',
    encodingAESKey: '填 43 个字符的 EncodingAESKey',
  }
  return '请创建 ' + file + '（权限 0600），内容形如：\n' + JSON.stringify(body, null, 2)
}

/**
 * 打码显示企业 ID（日志里只露前 4 位与后 4 位）。
 * @param corpId 企业 ID。
 */
export function maskCorpId(corpId: string): string {
  if (corpId.length <= 10) return corpId === '' ? '(空)' : corpId.slice(0, 2) + '***'
  return corpId.slice(0, 4) + '***' + corpId.slice(-4)
}
