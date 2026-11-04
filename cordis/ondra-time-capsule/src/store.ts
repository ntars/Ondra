/**
 * 胶囊存档的读写。
 *
 * ## 落点与写法
 *
 * `user/time-capsule.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 存什么、不存什么
 *
 * 存：`id` / 标题 / 正文 / 开封日 / 写入时刻 / 开启时刻 / 记忆 id。
 *
 * **开启成功后正文必须置空。** 这一条是「不做第二份正文」的落地方式：
 * 打开之后真源在 O-010，本地若还留着一份，用户点「忘记」时它不会跟着消失，
 * 那就成了「说忘了其实没忘」（与 O-099 同一条理由）。
 *
 * ## 为什么这个文件丢了比记忆库丢了好一些
 *
 * 它只装「还没开封的信」。丢了的后果是「信没了」——这确实糟，
 * 但反过来把正文同时写进记忆库来「保险」，就等于封存期从一开始就失效了。
 * 权衡后选「单一副本」：宁可丢，不可泄。README §8 已如实写进限制。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { CAPSULE_ID_RE, MAX_TITLE_CHARS, STATE_VERSION } from './types.js'
import type { CapsuleArchive, CapsuleRecord } from './types.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限正数或 0。 */
function stampOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.trunc(value)
}

/** 空存档。 */
export function emptyArchive(): CapsuleArchive {
  return Object.freeze({ version: STATE_VERSION, capsules: Object.freeze([]) })
}

/**
 * 归一化一条记录。**任何关键字段不合规就丢弃整条**——
 * 半条记录比没有更糟：它会在清单里显示一颗永远开不了、也删不掉的胶囊。
 * @param raw 原始值。
 */
function recordOf(raw: unknown): CapsuleRecord | undefined {
  if (!isRecord(raw)) return undefined
  const id = raw['id']
  if (typeof id !== 'string' || !CAPSULE_ID_RE.test(id)) return undefined

  const openAt = stampOf(raw['openAt'])
  if (openAt <= 0) return undefined

  const createdAt = stampOf(raw['createdAt'])
  if (createdAt <= 0) return undefined

  const text = typeof raw['text'] === 'string' ? raw['text'] : ''
  const openedAt = stampOf(raw['openedAt'])
  const factIdRaw = raw['factId']
  const factId = typeof factIdRaw === 'string' && factIdRaw.trim() !== '' ? factIdRaw : null

  // 已开启却没有记忆 id、正文也空了：这颗胶囊既读不到正文，也指不到记忆。
  // 留着只会在清单里显示一行「已开封（内容去向不明）」——不如直接丢。
  if (openedAt > 0 && factId === null && text === '') return undefined

  const title = typeof raw['title'] === 'string' ? raw['title'].slice(0, MAX_TITLE_CHARS) : ''

  return Object.freeze({ id, title, text, openAt, createdAt, openedAt, factId })
}

/**
 * 归一化整份存档。**任何异常都退化成空存档**，不抛错。
 * @param raw 原始值。
 */
export function normalizeArchive(raw: unknown): CapsuleArchive {
  if (!isRecord(raw)) return emptyArchive()
  const list = raw['capsules']
  if (!Array.isArray(list)) return emptyArchive()

  const seen = new Set<string>()
  const capsules: CapsuleRecord[] = []
  for (const item of list) {
    const record = recordOf(item)
    if (record === undefined) continue
    if (seen.has(record.id)) continue
    seen.add(record.id)
    capsules.push(record)
  }
  return Object.freeze({ version: STATE_VERSION, capsules: Object.freeze(capsules) })
}

/** 读盘结果。 */
export interface LoadResult {
  /** 存档（读不到就是空）。 */
  readonly archive: CapsuleArchive
  /** 是否是**首次**读（文件原本不存在）。 */
  readonly fresh: boolean
  /** 读失败原因（中文）；读成功或文件不存在为 `undefined`。 */
  readonly issue?: string
}

/**
 * 从磁盘读存档。**永不抛错。**
 * @param filePath 绝对路径；`undefined` 表示只在内存。
 */
export function readArchive(filePath: string | undefined): LoadResult {
  if (filePath === undefined) return { archive: emptyArchive(), fresh: true }
  let text: string
  try {
    text = readFileSync(filePath, { encoding: 'utf8' })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { archive: emptyArchive(), fresh: true }
    return { archive: emptyArchive(), fresh: false, issue: '读不到胶囊存档：' + String(code ?? '未知错误') }
  }
  if (text.trim() === '') return { archive: emptyArchive(), fresh: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { archive: emptyArchive(), fresh: false, issue: '胶囊存档不是合法 JSON，已按空存档处理' }
  }
  return { archive: normalizeArchive(parsed), fresh: false }
}

/**
 * 写存档：临时文件 + `rename` 原子替换。
 * @param filePath 绝对路径。
 * @param archive 存档。
 */
export function writeArchive(filePath: string, archive: CapsuleArchive): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      capsules: archive.capsules.map(capsule => ({
        id: capsule.id,
        title: capsule.title,
        text: capsule.text,
        openAt: capsule.openAt,
        createdAt: capsule.createdAt,
        openedAt: capsule.openedAt,
        factId: capsule.factId,
      })),
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
