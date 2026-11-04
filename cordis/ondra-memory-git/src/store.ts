/**
 * 检查点标签的读写。
 *
 * ## 落点与写法
 *
 * `user/memory-git.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 存什么、不存什么
 *
 * 只存「标签 → 快照 id + 备注 + 时刻」。
 *
 * **不存正文、不存记录快照、不存阶段**。理由与 O-097 那条一样，但这条更要紧：
 * 存正文就等于在本插件里建了第二份记忆副本，而这份副本**不受 O-010 的寿命、
 * 不受 O-017 的删除流程管**——用户点「忘记」时它不会跟着消失，
 * 那就成了「说忘了其实没忘」。这一条足以否掉任何「把正文存下来方便对比」的设计。
 *
 * ## 为什么这个文件丢了不致命
 *
 * 丢了最坏是「检查点标签没了」——但那些快照文件还在 O-009 的目录里，
 * 用 `snapshot.list()` 仍能按时间找到它们。标签只是给人看的名字。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { MAX_TAGS, TAG_RE } from './types.js'
import type { GitState, TagRecord } from './types.js'

/** 存档版本。字段形状变了就 +1，读旧版按缺省补。 */
export const STATE_VERSION = 1

/** 状态文件名（落在 `user/` 区域下）。 */
export const STATE_FILE = 'memory-git.json'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 空状态。 */
export function emptyState(): GitState {
  return Object.freeze({ version: STATE_VERSION, tags: Object.freeze([]) })
}

/**
 * 归一化一条标签记录。任何字段不合规就丢弃整条——
 * 半条记录会让 `checkout()` 指向一个不存在的快照，比没有更糟。
 * @param raw 原始值。
 */
function tagOf(raw: unknown): TagRecord | undefined {
  if (!isRecord(raw)) return undefined
  const label = raw['label']
  const snapshotId = raw['snapshotId']
  if (typeof label !== 'string' || !TAG_RE.test(label)) return undefined
  if (typeof snapshotId !== 'string' || snapshotId.trim() === '') return undefined
  const note = typeof raw['note'] === 'string' ? raw['note'].slice(0, 200) : ''
  const at = raw['at']
  return Object.freeze({
    label,
    snapshotId,
    note,
    at: typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.trunc(at) : 0,
  })
}

/**
 * 归一化一份状态。**任何异常都退化成空状态**，不抛错。
 *
 * 同名标签只留第一条：重复标签会让 `dropTag()` 只删掉一个、另一个留在清单里，
 * 用户会以为「删了还在」。
 * @param raw 原始值。
 */
export function normalizeState(raw: unknown): GitState {
  if (!isRecord(raw)) return emptyState()
  const list = raw['tags']
  const out: TagRecord[] = []
  if (Array.isArray(list)) {
    for (const item of list) {
      const record = tagOf(item)
      if (record === undefined) continue
      if (out.some(existing => existing.label === record.label)) continue
      out.push(record)
      if (out.length >= MAX_TAGS) break
    }
  }
  return Object.freeze({ version: STATE_VERSION, tags: Object.freeze(out) })
}

/**
 * 读状态。文件不存在、坏 JSON、权限不足，一律退化成空状态并返回原因。
 * @param filePath 绝对路径。
 */
export function readState(filePath: string): { readonly state: GitState; readonly issue?: string } {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = isRecord(error) ? error['code'] : undefined
    if (code === 'ENOENT') return { state: emptyState() }
    return { state: emptyState(), issue: '读不到检查点状态：' + String(code ?? '未知错误') }
  }
  if (text.trim() === '') return { state: emptyState() }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { state: emptyState(), issue: '检查点状态不是合法 JSON，已按空状态处理' }
  }
  return { state: normalizeState(parsed) }
}

/**
 * 写状态：临时文件 + `rename` 原子替换。
 * @param filePath 绝对路径。
 * @param state 状态。
 */
export function writeState(filePath: string, state: GitState): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      tags: state.tags.map(tag => ({
        label: tag.label,
        snapshotId: tag.snapshotId,
        note: tag.note,
        at: tag.at,
      })),
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
