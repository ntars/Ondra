/**
 * 凭据读取与**脱敏**。**只读文件，不进 `Config`，永不进日志。**
 *
 * ## 与 Telegram 的脱敏对象不同，值得单开一节
 *
 * Telegram 把 token 拼在 **URL 路径**里（`/bot<token>/getUpdates`），所以那里
 * 脱敏对象是「地址」。Discord 把 token 放在 **`Authorization: Bot <token>`** 头里，
 * URL 是干净的——所以「日志里没有 URL 就安全」这个直觉在这里**失效**。
 *
 * 会漏的三条路径：
 *
 * 1. 有人把整个 `init`（含 headers）序列化进日志或错误串；
 * 2. 平台在错误体里回显认证头（少见但要防）；
 * 3. `fetch` 抛的错在某些实现里会带上请求摘要。
 *
 * 所以 `redactToken()` 认两种形态：`Bot <token>`（真正的头形态）与非空的
 * 「看起来像 token」的独立长串。前者是主路径，后者是兜底——
 * **两个正则都写明在注释里**，下一任维护者能看懂为什么是两条。
 *
 * ## 为什么读到就 `chmod 0600`
 *
 * 用户手抄 JSON 时 umask 常是 022，落盘就是 0644，同机任何进程都能读。
 * Bot token 拿到就等于拿到这个机器人（能读写所有它被邀请的频道），
 * 改权限是顺手就能做对的事。
 */

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import type { CredentialLoad, DiscordCredentials } from './types.js'

/** 凭据文件允许的最大字节数：64KB。再大就不是凭据了，是放错文件。 */
export const CREDENTIAL_MAX_BYTES = 64 * 1024

/** 权限过宽的照片位（组可读、其他可读、组可写、其他可写）。 */
const LOOSE_BITS = 0o077

/**
 * token 的形状。
 *
 * Discord 的 bot token 是三段 base64url 用 `.` 连接：
 * `<base64url>.<base64url>.<base64url>`，总长 59–120 字符。
 * 用宽松量词而不是死磕精确长度：形状校验的目的是拦住「填了别的东西」，
 * 不是替平台校验格式；拦过严会把一次平台改版变成「凭据永远不合法」。
 */
export const TOKEN_RE = /^[A-Za-z0-9_-]{20,80}\.[A-Za-z0-9_-]{5,20}\.[A-Za-z0-9_-]{20,80}$/

/** 脱敏主路径：`Bot <token>` 头形态。 */
const BOT_HEADER_RE = /Bot\s+[A-Za-z0-9_-]{20,80}\.[A-Za-z0-9_-]{5,20}\.[A-Za-z0-9_-]{20,80}/g

/** 脱敏兜底：任何裸的 token 形态（没带 `Bot ` 前缀时）。 */
const BARE_TOKEN_RE = /[A-Za-z0-9_-]{20,80}\.[A-Za-z0-9_-]{5,20}\.[A-Za-z0-9_-]{20,80}/g

/**
 * 把字符串里的 token 换成 `Bot ***` / `***`。**幂等**。
 *
 * 先换带前缀的（保留「这里是一个 Bot 头」这个结构信息），再换裸的。
 * 顺序不能反：反了之后第一正则再也匹配不到 `Bot `，日志里就只剩一堆 `***`
 * 而看不出那原本是个认证头。
 * @param text 任意可能含 token 的字符串。
 */
export function redactToken(text: string): string {
  return text.replace(BOT_HEADER_RE, 'Bot ***').replace(BARE_TOKEN_RE, '***')
}

/**
 * 令牌掩码：只留第一段前 6 位，其余打码。
 * @param token 原始 token。
 */
export function maskToken(token: string): string {
  const text = token.trim()
  if (text === '') return '（空）'
  const dot = text.indexOf('.')
  if (dot <= 0) return '***'
  return text.slice(0, Math.min(dot, 6)) + '…***'
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
      detail: '凭据里缺 token（Discord 开发者后台 Bot → Reset Token 得到的三段式串）：' + file,
      permissionTightened: tightened,
    }
  }
  if (!TOKEN_RE.test(token)) {
    return {
      ok: false,
      missing: 'token',
      detail:
        'token 形状不对（应为三段用点连接：`<20+ 字符>.<5+ 字符>.<20+ 字符>`）。' +
        '若你填的是 Client Secret 或 Public Key，那不是 token：' + file,
      permissionTightened: tightened,
    }
  }

  const value: DiscordCredentials = { token, username: textOf(raw, 'username') }
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
    '，权限 0600）：{"token":"<三段式 bot token>","username":"bot 用户名（可空，只用于日志）"}。' +
    '注意：Client ID / Client Secret / Public Key 都不是 token，填错的症状是 WS 立刻 4004。'
  )
}
