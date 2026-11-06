/**
 * 凭据读取与**脱敏**。**只读文件，不进 `Config`，永不进日志。**
 *
 * ## token 在 URL 里，所以脱敏是一等公民
 *
 * Telegram 的鉴权方式是把 token 拼进路径：`/bot<token>/getUpdates`。
 * 这带来一个别处没有的风险：**任何字符串里出现 URL，就可能出现 token**。
 *
 * 常见的三种泄漏路径：
 *
 * 1. `fetch` 抛错时 `error.message` 常带上完整 URL（`Failed to parse URL from https://api.telegram.org/bot123:AA…/getUpdates`）；
 * 2. 面板/日志里打印「正在请求 <url>」；
 * 3. 把上游的 `description` 原样拼进自己的错误串。
 *
 * 所以 `redactToken()` 不是「顺手做一下」，而是本包唯一的出口：**凡带 URL 的
 * 字符串，进日志前一律过它**。它按正则替换整段 `bot<数字>:<字母数字_-串>`，
 * 不依赖前缀长度，也不依赖调用方记得哪一段是密钥。
 *
 * ## 为什么读到就 `chmod 0600`
 *
 * 用户手抄一个 JSON 时 umask 常常是 022，落盘就是 0644——同机任何进程都能读。
 * 这个 token 既能收也能发，泄漏等于把机器人交出去。改权限是顺手就能做对的事。
 */

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import type { CredentialLoad, TelegramCredentials } from './types.js'

/** 凭据文件允许的最大字节数：64KB。再大就不是凭据了，是放错文件。 */
export const CREDENTIAL_MAX_BYTES = 64 * 1024

/** 权限过宽的照片位（组可读、其他可读、组可写、其他可写）。 */
const LOOSE_BITS = 0o077

/**
 * token 的形状：`<bot_id 数字>:<35 字符 [A-Za-z0-9_-]>`。
 *
 * 用宽松一点的量词（30–64）而不是死磕 35：形状校验的目的是拦住「填了别的东西」，
 * 不是替 Telegram 校验格式。拦过严会把一次平台改版变成「凭据永远不合法」。
 */
export const TOKEN_RE = /^\d{5,20}:[A-Za-z0-9_-]{30,64}$/

/** 脱敏用的匹配式：`bot` 后面跟 token。 */
const TOKEN_IN_URL_RE = /bot\d{5,20}:[A-Za-z0-9_-]{30,64}/g

/**
 * 把字符串里的 token 换成 `bot***`。**幂等**。
 *
 * 只替换 `bot<id>:<secret>` 这一段，保留其余部分（便于对照是哪条接口出的错）。
 * @param text 任意可能含 token 的字符串。
 */
export function redactToken(text: string): string {
  return text.replace(TOKEN_IN_URL_RE, 'bot***')
}

/**
 * 令牌掩码：只留 id 段，密钥段换成 `***`。
 * @param token 原始 token。
 */
export function maskToken(token: string): string {
  const text = token.trim()
  if (text === '') return '（空）'
  const colon = text.indexOf(':')
  if (colon <= 0) return '***'
  return text.slice(0, colon) + ':***'
}

/**
 * 读一个字符串字段。
 * @param raw 对象。
 * @param key 键名。
 */
function textOf(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 读凭据。**永不抛错**，任何异常都折成 `ok=false` + 一句说明（其中不含 token）。
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
    return { ok: false, missing: 'file', detail: '凭据文件不存在：' + file, permissionTightened: false }
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
      detail: '凭据文件读不出来：' + redactToken(error instanceof Error ? error.message : String(error)),
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
    return { ok: false, missing: 'shape', detail: '凭据文件的顶层必须是对象：' + file, permissionTightened: tightened }
  }

  const raw = parsed as Record<string, unknown>
  const token = textOf(raw, 'token')
  if (token === '') {
    return {
      ok: false,
      missing: 'token',
      detail: '凭据里缺 token（BotFather 给的那串 `<数字>:<字母数字>`）：' + file,
      permissionTightened: tightened,
    }
  }
  if (!TOKEN_RE.test(token)) {
    return {
      ok: false,
      missing: 'token',
      detail: 'token 形状不对（应为 `<数字>:<30 位以上字母数字_-`）：' + file,
      permissionTightened: tightened,
    }
  }

  const value: TelegramCredentials = { token, username: textOf(raw, 'username') }
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
    '，权限 0600）：{"token":"123456789:AA…（BotFather 给的那串）","username":"bot 用户名（可空，只用于日志）"}'
  )
}
