/**
 * 游标存档。
 *
 * ## 只存游标，不存正文
 *
 * 存档里只有两样东西：**每个群读到哪一刻**、**哪些指纹已经读过**。
 * 群聊原文一个字都不落盘。理由很直白：那是别人说的话，落在磁盘上就是一份
 * 没人同意的语料，而补读的价值只在「这一两天」。重启后靠通道重推补齐，
 * 丢一次补读好过留一份不该留的原文。
 *
 * ## 为什么不用临时文件覆写正文
 *
 * 与 O-044 同一套写法（0600 + 临时文件 + rename）。直接覆写会在断电时留下
 * 半截 JSON，症状是「重启后游标归零」→ 她会把已经说过的积压**再说一遍**，
 * 而且不报任何错。
 *
 * ## 键里的冒号
 *
 * `group:123456` / `private:789` 里的冒号是**内存与存档键的分隔符**，
 * 不是服务键。服务键 `ondra-climb` 没有冒号，符合 `^[a-z][a-z0-9_-]{1,63}$`。
 * 两件事分开看，避免有人照着这里把服务键写成 `ondra:climb`。
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ChatKind } from './types.js'

/** 存档版本。读到不认识的版本按空存档处理，不猜迁移。 */
export const STATE_VERSION = 1

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 一个群最多记多少个已读指纹。 */
export const SEEN_PER_GROUP = 64

/** 最多记多少个群。超出时留最近读过的。 */
export const GROUPS_MAX = 64

/** 一个群的游标。 */
export interface GroupCursor {
  /** 读到的时刻（**不含**）：比它早的一律不再补；同一毫秒的另几条靠指纹判。 */
  readonly lastSeenAt: number
  /** 已读指纹（只保留最近若干条）。 */
  readonly seenIds: readonly string[]
}

/** 一份存档。 */
export interface ClimbState {
  /** 版本。 */
  readonly version: number
  /** 按 `种类:群号` 存的游标。 */
  readonly groups: Readonly<Record<string, GroupCursor>>
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读一个非负时刻。 */
function stampOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

/** 拼一个内部键。**只在内存与存档里用**。 */
export function keyOf(chatKind: ChatKind, groupId: string): string {
  return `${chatKind}:${groupId}`
}

/** 拆一个内部键。拆不出返回 `undefined`。 */
export function splitKey(key: string): { readonly chatKind: ChatKind; readonly groupId: string } | undefined {
  const at = key.indexOf(':')
  if (at <= 0) return undefined
  const kind = key.slice(0, at)
  const groupId = key.slice(at + 1)
  if (groupId === '') return undefined
  if (kind !== 'group' && kind !== 'private') return undefined
  return { chatKind: kind, groupId }
}

/** 空存档。 */
export function emptyState(): ClimbState {
  return Object.freeze({ version: STATE_VERSION, groups: Object.freeze({}) })
}

/**
 * 把任意读到的值归一化成存档。**永不抛错**。
 *
 * 版本不认识就按空存档处理：硬迁移一份猜出来的游标，比清零更危险——
 * 清零最多让她多补一遍，猜错会让游标停在一个谁也不知道的位置。
 * @param raw 原始值。
 */
export function normalizeState(raw: unknown): ClimbState {
  if (!isRecord(raw)) return emptyState()
  if (stampOf(raw['version']) !== STATE_VERSION) return emptyState()

  const groupsRaw = raw['groups']
  if (!isRecord(groupsRaw)) return emptyState()

  const entries: [string, GroupCursor][] = []
  for (const [key, value] of Object.entries(groupsRaw)) {
    if (splitKey(key) === undefined) continue
    if (!isRecord(value)) continue
    const lastSeenAt = stampOf(value['lastSeenAt'])
    const seenRaw = value['seenIds']
    const seen: string[] = []
    if (Array.isArray(seenRaw)) {
      for (const id of seenRaw) {
        if (typeof id === 'string' && id !== '') seen.push(id.slice(0, 32))
        if (seen.length >= SEEN_PER_GROUP) break
      }
    }
    entries.push([key, Object.freeze({ lastSeenAt, seenIds: Object.freeze(seen) })])
  }

  // 只留最近读过的若干群：存档不能无界增长。
  entries.sort((left, right) => right[1].lastSeenAt - left[1].lastSeenAt)
  const kept = entries.slice(0, GROUPS_MAX)
  return Object.freeze({
    version: STATE_VERSION,
    groups: Object.freeze(Object.fromEntries(kept)),
  })
}

/**
 * 读存档。文件不存在或读不出来都返回空存档。**永不抛错**。
 * @param file 绝对路径。
 */
export function readState(file: string): ClimbState {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return emptyState()
  }
  try {
    return normalizeState(JSON.parse(text) as unknown)
  } catch {
    return emptyState()
  }
}

/**
 * 写存档（0600 + 临时文件 + rename）。**永不抛错**。
 * @param file 绝对路径。
 * @param state 存档。
 * @returns 是否写成功。
 */
export function writeState(file: string, state: ClimbState): boolean {
  const tmp = `${file}${TMP_SUFFIX}`
  try {
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      // 权限收紧失败不影响数据正确性：日志里会由调用方报一次。
    }
    return true
  } catch {
    return false
  }
}
