/**
 * 凭据读取。**只读文件，不进 `Config`，永不进日志。**
 *
 * ## 为什么只有 `appSecret` 是必需的
 *
 * 验签用它，收信靠它——没有它整条通道不成立。而 `appKey` 与 `robotCode`
 * 只属于「主动接口」这一条出口：缺了它们，`sessionWebhook` 照样能把话发出去。
 * 把它们做成必需项，会让「只想在群聊里被 @ 时回一句」的用户也必须去配一堆
 * 他用不到的东西——那是把可选能力伪装成门槛。
 *
 * ## 为什么读到就 `chmod 0600`
 *
 * 用户手抄一个 JSON 文件时，umask 常常是 022，落盘就是 0644——同机任何进程都能读。
 * 这里不做「警告一下就完事」：文件属于用户、权限是这次读取顺手就能改对的，
 * 改完再读一次才叫真的收紧了。`permissionTightened` 会报到日志与面板。
 *
 * ## 为什么用同步 IO
 *
 * 凭据只在装载期与 `reload()` 读，一次几十字节。异步化换来的是一个
 * 「配置读完了但凭据还没到」的中间态——那时 `available` 说什么都不对。
 */

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import type { CredentialLoad, DingTalkCredentials } from './types.js'

/** 凭据文件允许的最大字节数：64KB。再大就不是凭据了，是放错文件。 */
export const CREDENTIAL_MAX_BYTES = 64 * 1024

/** 权限过宽的照片位（组可读、其他可读、组可写、其他可写）。 */
const LOOSE_BITS = 0o077

/**
 * 读一个字符串字段，**去空白但保留内部空格**。
 * @param raw 对象。
 * @param key 键名。
 */
function textOf(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 掩码：只留前 4 位，其余用 `***`。
 *
 * 前 4 位够让人确认「填的是这一把」，又不足以复原。
 * 空串回 `（空）`，免得日志里出现一个让人以为漏打印的空格。
 * @param value 密钥。
 */
export function maskSecret(value: string): string {
  const text = value.trim()
  if (text === '') return '（空）'
  if (text.length <= 4) return '***'
  return text.slice(0, 4) + '***'
}

/**
 * 读凭据。**永不抛错**，任何异常都折成 `ok=false` + 一句说明。
 * @param file 凭据文件绝对路径（空串表示算不出来）。
 */
export function readCredentials(file: string): CredentialLoad {
  if (file === '') {
    return {
      ok: false,
      missing: 'file',
      detail: '算不出凭据文件路径：ondra-path-layout 未装载，且 credentialFile 也没填',
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
    if ((mode & LOOSE_BITS) !== 0) {
      chmodSync(file, 0o600)
      tightened = true
    }
  } catch {
    // 改不动权限（不是属主）不该阻断读——但会在说明里体现为「没收紧」。
  }

  let text: string
  try {
    const size = statSync(file).size
    if (size > CREDENTIAL_MAX_BYTES) {
      return {
        ok: false,
        missing: 'json',
        detail: '凭据文件过大（' + String(size) + ' 字节）：确认没把别的东西写进来',
        permissionTightened: tightened,
      }
    }
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
    return {
      ok: false,
      missing: 'json',
      detail: '凭据文件不是合法 JSON：' + file,
      permissionTightened: tightened,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      missing: 'shape',
      detail: '凭据文件的顶层必须是对象：' + file,
      permissionTightened: tightened,
    }
  }

  const raw = parsed as Record<string, unknown>
  const value: DingTalkCredentials = {
    appKey: textOf(raw, 'appKey'),
    appSecret: textOf(raw, 'appSecret'),
    robotCode: textOf(raw, 'robotCode'),
  }

  if (value.appSecret === '') {
    return {
      ok: false,
      missing: 'appSecret',
      detail: '凭据里缺 appSecret（验签要用它，没有它这条通道收不到消息）：' + file,
      permissionTightened: tightened,
    }
  }

  return { ok: true, value, detail: '凭据已就绪：' + file, permissionTightened: tightened }
}

/**
 * 给一份可直接抄的模板（只在日志里提示，不写文件）。
 * @param file 凭据文件路径。
 */
export function credentialTemplate(file: string): string {
  return (
    '凭据模板（写进 ' +
    file +
    '，权限 0600）：{"appSecret":"应用的 AppSecret","appKey":"应用的 AppKey（只走主动接口才需要）","robotCode":"机器人的 robotCode（同上）"}'
  )
}

/**
 * 主动接口这条出口就绪了吗（`appKey` 与 `robotCode` 都在）。
 * @param value 凭据值。
 */
export function activeReadyOf(value: DingTalkCredentials | undefined): boolean {
  if (value === undefined) return false
  return value.appKey !== '' && value.robotCode !== ''
}
