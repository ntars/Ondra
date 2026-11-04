/**
 * 凭据与二次确认档案。**两样东西都不进 `Config`。**
 *
 * ## 为什么 token 不进配置
 *
 * 配置会被导出、会被打进反馈包、会出现在「当前配置」这类日志里。
 * 一个能接管你 QQ 号的 token 出现在任何一份可分享的文件里，都不是小事故。
 * 所以：只从 `user/channels/qq-napcat.json`（0600）读，读完也不留在字段里，
 * 传输实现自己拿着用。
 *
 * ## 为什么二次确认要「存下来」
 *
 * 手册 §16.2-6 要求高危通道「二次确认独立存档，不与合规通道混在一张开关列表里」。
 * 存成文件的另一个好处是可追溯：出事后能回答「什么时候、谁、确认了什么」，
 * 而不是只剩一个 `confirmed: true` 的布尔。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConfirmRecord, CredentialLoad } from './types.js'

/** 文件权限：只有本人可读写。 */
const FILE_MODE = 0o600

/** 目录权限：只有本人可进入。 */
const DIR_MODE = 0o700

/**
 * 把文件权限收紧到 0600（本来就合规的不动）。
 *
 * 只收紧、不放宽：用户自己设过更严的权限（如 0400），这里不该替他放开。
 * @param filePath 文件路径。
 * @returns 是否真的改过权限。
 */
function tighten(filePath: string): boolean {
  try {
    const mode = statSync(filePath).mode & 0o777
    // 组与其他人的任何位都算过宽。
    if ((mode & 0o077) === 0) return false
    chmodSync(filePath, FILE_MODE)
    return true
  } catch {
    return false
  }
}

/**
 * 读 access token。
 * @param filePath 凭据文件路径（空串表示路径算不出来）。
 */
export function readToken(filePath: string): CredentialLoad {
  if (filePath.trim() === '') {
    return {
      ok: false,
      reason: 'missing',
      detail: '凭据路径算不出来：缺 ondra-path-layout，配置里也没写 tokenFile',
      permissionTightened: false,
    }
  }
  if (!existsSync(filePath)) {
    return {
      ok: false,
      reason: 'missing',
      detail: '凭据文件不存在：' + filePath,
      permissionTightened: false,
    }
  }

  const tightened = tighten(filePath)
  let text = ''
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    return {
      ok: false,
      reason: 'bad-perm',
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
      reason: 'bad-json',
      detail: '凭据文件不是合法 JSON：' + filePath,
      permissionTightened: tightened,
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'bad-shape',
      detail: '凭据文件应是一个对象，形如 {"token": "..."}',
      permissionTightened: tightened,
    }
  }
  const token = (parsed as Record<string, unknown>)['token']
  if (typeof token !== 'string' || token.trim() === '') {
    return {
      ok: false,
      reason: 'empty-token',
      detail: '凭据文件里没有 token，或 token 是空串',
      permissionTightened: tightened,
    }
  }

  return {
    ok: true,
    value: { token: token.trim() },
    detail: '凭据已读入内存；NapCat 侧的 token 必须与它逐字一致',
    permissionTightened: tightened,
  }
}

/**
 * 凭据文件模板（复制即用，注释说明两端怎么对）。
 * @param filePath 凭据路径（只用于在模板里写清位置）。
 */
export function credentialTemplate(filePath: string): string {
  return [
    '在 ' + filePath + ' 写入下面这一行（文件权限必须是 0600）：',
    '{"token": "<与 NapCat 里「WebSocket 服务端」的 token 逐字一致>"}',
    '注意：这个 token 是**本端**（插件）要求 NapCat 出示的凭据，不是 QQ 密码。',
  ].join('\n')
}

/**
 * 打码后的 token（日志用）。
 * @param token 原文。
 */
export function maskToken(token: string): string {
  if (token.length <= 4) return '****'
  return token.slice(0, 2) + '****' + token.slice(-2)
}

/** 空档案。 */
export function emptyConfirmRecord(): ConfirmRecord {
  return { confirmed: false, at: 0, note: '' }
}

/**
 * 读二次确认档案。
 *
 * 文件不存在 → 空档案（不是错误：第一次装本来就没有）；
 * 文件坏了 → 也回空档案，并让 `detail` 说清楚它坏了。
 * @param filePath 档案路径。
 */
export function readConfirmRecord(filePath: string): { readonly record: ConfirmRecord; readonly detail: string } {
  if (filePath.trim() === '') return { record: emptyConfirmRecord(), detail: '确认档案路径为空' }
  if (!existsSync(filePath)) return { record: emptyConfirmRecord(), detail: '还没有确认档案：' + filePath }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch {
    return { record: emptyConfirmRecord(), detail: '确认档案不是合法 JSON（按「未确认」处理）：' + filePath }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { record: emptyConfirmRecord(), detail: '确认档案形状不对（按「未确认」处理）' }
  }
  const raw = parsed as Record<string, unknown>
  const confirmed = raw['confirmed'] === true
  const at = typeof raw['at'] === 'number' && Number.isFinite(raw['at']) ? raw['at'] : 0
  const note = typeof raw['note'] === 'string' ? raw['note'] : ''
  return { record: { confirmed, at, note }, detail: confirmed ? '确认档案有效' : '确认档案写着「未确认」' }
}

/**
 * 写二次确认档案（临时文件 + rename 原子写，0600）。
 *
 * 原子写不是为了好看：写到一半断电留下半截 JSON，下次启动就是「确认丢了」，
 * 而用户会以为是自己没点成功，然后又点一次——每次都写一遍，永远丢。
 * @param filePath 档案路径。
 * @param note 确认说明（≥4 字，逼着人写清确认了什么）。
 * @param at 时刻（毫秒）。
 */
export function writeConfirmRecord(
  filePath: string,
  note: string,
  at: number,
): { readonly ok: boolean; readonly detail: string } {
  const text = note.trim()
  if (text.length < 4) {
    return { ok: false, detail: '确认说明太短（至少 4 个字）：确认必须是「说清楚确认了什么」，不是点一下' }
  }
  if (filePath.trim() === '') return { ok: false, detail: '确认档案路径为空，写不进去' }

  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: DIR_MODE })
    const temporary = filePath + '.tmp'
    writeFileSync(temporary, JSON.stringify({ confirmed: true, at, note: text }, null, 2) + '\n', {
      mode: FILE_MODE,
    })
    renameSync(temporary, filePath)
    tighten(filePath)
    return { ok: true, detail: '确认档案已写入：' + filePath }
  } catch (error) {
    return {
      ok: false,
      detail: '确认档案写入失败：' + (error instanceof Error ? error.message : String(error)),
    }
  }
}
