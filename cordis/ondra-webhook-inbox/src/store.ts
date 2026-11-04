/**
 * 收件箱存档的读写。
 *
 * ## 落点与写法
 *
 * `user/webhook-inbox.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 存什么、不存什么
 *
 * 存：队列（id / 源 / 类型 / 优先级 / 摘要 / 时刻 / 序号）、去重表（指纹 + 首次时刻）、
 * 最近一小时的投递时刻（做额度用）。
 *
 * **不存原文、正文、请求体、请求头、URL 参数、签名。** 这条不是克制，是定义：
 * 一个「事件播报收件箱」如果留着请求体，它就成了一个没有任何人审计过的日志库，
 * 而里面装的是 webhook 带进来的一切。
 *
 * 读盘时**逐字段重建**，陌生键一律不复制：手工改过的存档里塞进一个 `body` 字段，
 * 也不会被读回来。这道防线很土，但它是唯一一道不依赖「所有人都不犯错」的防线。
 *
 * ## 丢了会怎样
 *
 * 下次启动时收件箱是空的，去重表也是空的。代价是「重启前的几条事件不会补播」，
 * 以及「重启前播过的事件可能被重播一次」。两者都只发生一次，且都可解释。
 * **刻意不做冗余副本**：把队列在别处再存一遍，等于让「箱子里有什么」有两个真源。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { STATE_VERSION } from './types.js'
import type { InboxItem } from './types.js'
import { normalizePriority } from './priority.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 摘要读盘时的硬上限。比配置上限宽，只用来挡住明显异常的旧档。 */
const SUMMARY_HARD_LIMIT = 512

/** 投递时刻最多保留多少条。额度窗口只需最近一小时，多留只是给时钟回拨留余量。 */
export const ACK_STAMPS_CAP = 64

/** 去重表的一条。 */
export interface FingerprintEntry {
  /** 指纹（等于条目 id）。 */
  readonly fp: string
  /** 第一次见到它的时刻（去重窗从这里算起，不因重复上报延长）。 */
  readonly firstAt: number
}

/** 存档形状。 */
export interface InboxState {
  /** 入箱序号水位。 */
  readonly seq: number
  /** 队列。 */
  readonly items: readonly InboxItem[]
  /** 去重表。 */
  readonly fingerprints: readonly FingerprintEntry[]
  /** 最近确认投递的时刻。 */
  readonly ackedAt: readonly number[]
}

/** 读盘结果。 */
export interface LoadResult {
  /** 状态（读不到就是空状态）。 */
  readonly state: InboxState
  /** 是否是**首次**读（文件原本不存在）。 */
  readonly fresh: boolean
  /** 读失败原因（中文）；读成功或文件不存在为 `undefined`。 */
  readonly issue?: string
}

/** 空状态。 */
export function emptyState(): InboxState {
  return Object.freeze({ seq: 0, items: Object.freeze([]), fingerprints: Object.freeze([]), ackedAt: Object.freeze([]) })
}

/** 判空对象（本文件只用于读盘校验，故不导出到公共契约）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取一个长度受限的字符串；不合格返回 `null`。 */
function asText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > limit) return null
  return text
}

/** 取一个正的有限时刻；不合格返回 `null`。 */
function asStamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.trunc(value)
}

/**
 * 重建一条队列条目。**逐字段白名单**。
 * @param value 任意值。
 */
function normalizeItem(value: unknown): InboxItem | null {
  if (!isRecord(value)) return null
  const id = asText(value.id, 64)
  const source = asText(value.source, 64)
  const type = asText(value.type, 64)
  const at = asStamp(value.at)
  if (id === null || source === null || type === null || at === null) return null
  const summaryRaw = typeof value.summary === 'string' ? value.summary : ''
  return Object.freeze({
    id,
    source,
    type,
    priority: normalizePriority(value.priority),
    summary: summaryRaw.slice(0, SUMMARY_HARD_LIMIT),
    at,
    seq: typeof value.seq === 'number' && Number.isFinite(value.seq) ? Math.trunc(value.seq) : 0,
  })
}

/**
 * 重建存档。**永不抛错**：坏字段逐条丢掉，能救几条算几条。
 *
 * 版本不一致时整档丢弃：结构变过之后，旧字段的语义只能靠猜，而猜错的代价是
 * 「播了一条不该播的」或「播了两遍」。
 * @param value 任意值（通常来自 `JSON.parse`）。
 */
export function normalizeState(value: unknown): InboxState {
  if (!isRecord(value)) return emptyState()
  if (value.version !== STATE_VERSION) return emptyState()

  const items: InboxItem[] = []
  const rawItems = Array.isArray(value.items) ? value.items : []
  for (const raw of rawItems) {
    const item = normalizeItem(raw)
    if (item !== null) items.push(item)
  }

  const fingerprints: FingerprintEntry[] = []
  const rawFps = Array.isArray(value.fingerprints) ? value.fingerprints : []
  for (const raw of rawFps) {
    if (!isRecord(raw)) continue
    const fp = asText(raw.fp, 64)
    const firstAt = asStamp(raw.firstAt)
    if (fp === null || firstAt === null) continue
    fingerprints.push(Object.freeze({ fp, firstAt }))
  }

  const ackedAt: number[] = []
  const rawAcks = Array.isArray(value.ackedAt) ? value.ackedAt : []
  for (const raw of rawAcks) {
    const stamp = asStamp(raw)
    if (stamp !== null) ackedAt.push(stamp)
  }

  const seq = typeof value.seq === 'number' && Number.isFinite(value.seq) && value.seq > 0 ? Math.trunc(value.seq) : 0

  return Object.freeze({
    seq,
    items: Object.freeze(items),
    fingerprints: Object.freeze(fingerprints),
    ackedAt: Object.freeze(ackedAt.slice(-ACK_STAMPS_CAP)),
  })
}

/**
 * 从磁盘读状态。**永不抛错。**
 * @param filePath 绝对路径；`undefined` 表示只在内存。
 */
export function readState(filePath: string | undefined): LoadResult {
  if (filePath === undefined) return { state: emptyState(), fresh: true }
  let text: string
  try {
    text = readFileSync(filePath, { encoding: 'utf8' })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { state: emptyState(), fresh: true }
    return {
      state: emptyState(),
      fresh: false,
      issue: '读不到收件箱存档：' + String(code ?? '未知错误'),
    }
  }
  if (text.trim() === '') return { state: emptyState(), fresh: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      state: emptyState(),
      fresh: false,
      issue: '收件箱存档不是合法 JSON，已按空箱处理',
    }
  }
  return { state: normalizeState(parsed), fresh: false }
}

/**
 * 写状态：临时文件 + `rename` 原子替换。
 *
 * 字段逐个写出，**不用展开运算符**：展开会把将来新增的字段悄悄写进盘，
 * 而「存了什么」必须是一眼能读完的一份清单。
 * @param filePath 绝对路径。
 * @param state 状态。
 */
export function writeState(filePath: string, state: InboxState): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      seq: state.seq,
      items: state.items.map(item => ({
        id: item.id,
        source: item.source,
        type: item.type,
        priority: item.priority,
        summary: item.summary,
        at: item.at,
        seq: item.seq,
      })),
      fingerprints: state.fingerprints.map(entry => ({ fp: entry.fp, firstAt: entry.firstAt })),
      ackedAt: state.ackedAt,
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
