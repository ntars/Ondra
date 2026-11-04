/**
 * 二次确认档案。**这是唯一能让人「知情地打开」一个高危通道的机制。**
 *
 * ## 为什么不是一个 `confirmed: true` 的布尔
 *
 * 一个布尔值回答不了三个问题：**什么时候确认的、谁确认的、确认了什么**。
 * 出事时（账号被风控、消息发给了不该发的人）需要能翻到一条记录：
 * 「2026-11-02 18:40，写了『我知道会封号，用小号』」。
 * 所以档案里必须有 `at` 与 `note`，且 `note` 至少 4 个字——
 * 逼着人说清确认的对象，而不是点一下「我同意」。
 *
 * ## 撤销也是写，不是删
 *
 * 撤销时把档案改成 `confirmed: false` 并**留下撤销时刻与说明**，
 * 而不是删文件。删文件会让「他曾经确认过又撤回」这段历史消失，
 * 而下一次「文件不存在」就会和「从没确认过」混为一谈。
 *
 * ## 原子写
 *
 * 写到一半断电留下半截 JSON，下次启动就是「确认丢了」，
 * 而用户以为是自己没点成功，于是又点一次——每次都写一遍，永远丢。
 * 所以临时文件 + rename。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConfirmLoad, ConfirmRecord } from './types.js'
import { CONFIRM_NOTE_MIN } from './types.js'

/** 文件权限：只有本人可读写。 */
const FILE_MODE = 0o600

/** 目录权限。 */
const DIR_MODE = 0o700

/** 空档案。 */
export function emptyRecord(): ConfirmRecord {
  return { confirmed: false, at: 0, note: '' }
}

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
 * 读确认档案。
 *
 * 文件不存在 → 空档案（不是错误：第一次装本来就没有）；
 * 文件坏了 → 空档案，并让 `detail` 说清楚它坏了。**坏档案一律按「未确认」处理**：
 * 这种时候倾向于「不开」，代价只是多点一次。
 * @param file 档案路径。
 */
export function readConfirmRecord(file: string): ConfirmLoad {
  if (file.trim() === '') {
    return { record: emptyRecord(), exists: false, detail: '确认档案路径算不出来（缺 ondra-path-layout 且配置没写 confirm-file）' }
  }
  if (!existsSync(file)) {
    return { record: emptyRecord(), exists: false, detail: '还没有确认档案：' + file }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return { record: emptyRecord(), exists: true, detail: '确认档案不是合法 JSON（按「未确认」处理）：' + file }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { record: emptyRecord(), exists: true, detail: '确认档案形状不对（按「未确认」处理）：' + file }
  }

  const raw = parsed as Record<string, unknown>
  const confirmed = raw['confirmed'] === true
  const at = typeof raw['at'] === 'number' && Number.isFinite(raw['at']) ? raw['at'] : 0
  const note = typeof raw['note'] === 'string' ? raw['note'] : ''
  const record: ConfirmRecord = { confirmed, at, note }
  return {
    record,
    exists: true,
    detail: confirmed ? '确认档案有效' : '确认档案写着「未确认」',
  }
}

/**
 * 写一份档案（原子写，0600）。
 * @param file 档案路径。
 * @param payload 要写的对象。
 */
function writeRecord(file: string, payload: Record<string, unknown>): { readonly ok: boolean; readonly detail: string } {
  if (file.trim() === '') return { ok: false, detail: '确认档案路径为空，写不进去' }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE })
    const temporary = file + '.tmp'
    writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', { mode: FILE_MODE })
    renameSync(temporary, file)
    tighten(file)
    return { ok: true, detail: '确认档案已写入：' + file }
  } catch (error) {
    return { ok: false, detail: '确认档案写入失败：' + (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * 确认。
 * @param file 档案路径。
 * @param note 说明（≥ 4 字）。
 * @param at 时刻（毫秒）。
 */
export function writeConfirmRecord(
  file: string,
  note: string,
  at: number,
): { readonly ok: boolean; readonly detail: string } {
  const text = note.trim()
  if (text.length < CONFIRM_NOTE_MIN) {
    return {
      ok: false,
      detail: '确认说明太短（至少 ' + CONFIRM_NOTE_MIN + ' 个字）：确认必须是「说清楚确认了什么」，不是点一下',
    }
  }
  return writeRecord(file, { confirmed: true, at, note: text })
}

/**
 * 撤销确认。
 *
 * 写 `confirmed:false` 并保留撤销时刻与说明——**不删文件**，
 * 让「确认过又撤回」与「从没确认过」在档案上留下区别。
 * @param file 档案路径。
 * @param note 撤销说明（可空）。
 * @param at 时刻（毫秒）。
 */
export function revokeConfirmRecord(
  file: string,
  note: string,
  at: number,
): { readonly ok: boolean; readonly detail: string } {
  const text = note.trim()
  return writeRecord(file, {
    confirmed: false,
    at: 0,
    note: '',
    revokedAt: at,
    revokedNote: text,
  })
}

/**
 * 档案模板（复制即用）。
 * @param file 档案路径。
 */
export function confirmTemplate(file: string): string {
  return [
    '确认档案要写在 ' + file + '（权限 0600），形如：',
    '{"confirmed": true, "at": 1730000000000, "note": "知道有封号风险，用小号跑"}',
    '注意：写这个文件**还不够**，配置里还要 confirmed: true（双闸门，缺一不可）。',
    '撤销请用面板的「撤销确认」：它会把 confirmed 改成 false 并留下撤销记录，而不是删文件。',
  ].join('\n')
}
