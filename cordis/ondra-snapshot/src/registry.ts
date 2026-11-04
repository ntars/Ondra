/**
 * 快照文件的命名与轮转。
 *
 * 这一层是纯文件操作，不碰 SQL、不碰存储端口——**只认目录里的文件**。
 * 这样即使数据库整个打不开，界面仍然能列出「我手上有哪些备份」。
 *
 * 命名规则：`ondra-YYYYMMDDTHHmmssZ-NN.db`
 *
 * - 时间戳用 **UTC**：本地时间会随夏令时、时区修改而回退，一退排序就乱，
 *   而「哪份最新」正是恢复时唯一要看的东西；
 * - 秒级时间戳 + 两位序号：同一秒内连做两份不会互相覆盖
 *   （`VACUUM INTO` 遇到已存在文件会报错，不覆盖，所以名字必须自己保证唯一）；
 * - 固定前缀 `ondra-`：轮转只动自己命名的文件，用户手工放进来的 `.db` 一概不碰。
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { SNAPSHOT_NAME_RE } from './types.js'

/** 文件名形状直接取 `types.ts` 的那一份——**绝不在两个文件里各写一遍**，
 * 否则「哪份是真规则」迟早分叉，而分叉的表现是「轮转删错文件」。 */
const NAME_RE = SNAPSHOT_NAME_RE

/** 两位补零。 */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * 把毫秒时间戳格式化成 UTC 的 `YYYYMMDDTHHmmssZ`。
 * @param ms 毫秒时间戳。
 */
export function formatStamp(ms: number): string {
  const date = new Date(ms)
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`
  const time = `${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}`
  return `${day}T${time}Z`
}

/**
 * 从文件名解析创建时间。
 * @param fileName 文件名。
 * @returns 毫秒时间戳；不符合命名规则时为 null。
 */
export function parseStamp(fileName: string): number | null {
  const matched = NAME_RE.exec(fileName)
  if (matched === null) return null
  const [, day, time] = matched
  if (day === undefined || time === undefined) return null
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(4, 6))
  const date = Number(day.slice(6, 8))
  const hour = Number(time.slice(0, 2))
  const minute = Number(time.slice(2, 4))
  const second = Number(time.slice(4, 6))
  const ms = Date.UTC(year, month - 1, date, hour, minute, second)
  return Number.isFinite(ms) ? ms : null
}

/** 目录里的一个快照文件（还没被组装成 `SnapshotRecord`）。 */
export interface SnapshotFile {
  /** 文件名。 */
  readonly fileName: string
  /** 标识（文件名去扩展名）。 */
  readonly id: string
  /** 创建时间（毫秒）。 */
  readonly createdAtMs: number
  /** 字节数。 */
  readonly sizeBytes: number
}

/**
 * 列目录里符合命名规则的文件，按新→旧排序。
 *
 * 目录不存在时返回空数组而不是抛错：首次启动时目录还没建，
 * 「一份备份都没有」是正常状态，不该让整个统计接口炸掉。
 * @param dir 快照目录绝对路径。
 */
export function listSnapshotFiles(dir: string): SnapshotFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files: SnapshotFile[] = []
  for (const fileName of names) {
    const createdAtMs = parseStamp(fileName)
    if (createdAtMs === null) continue
    try {
      const stat = statSync(`${dir}/${fileName}`)
      if (!stat.isFile()) continue
      files.push({
        fileName,
        id: fileName.slice(0, -3),
        createdAtMs,
        sizeBytes: stat.size,
      })
    } catch {
      // 读不到就跳过：可能是正在被删除，或权限变了。列表少一项比整页报错好。
    }
  }
  files.sort((left, right) => {
    if (right.createdAtMs !== left.createdAtMs) return right.createdAtMs - left.createdAtMs
    return right.fileName.localeCompare(left.fileName)
  })
  return files
}

/**
 * 生成一个当前目录里不冲突的文件名。
 *
 * 不用 `Date.now()` 的时间戳直接当唯一键：同一秒内连做两份会撞名，
 * 而 `VACUUM INTO` 撞名是报错不是覆盖——那会让「备份」变成一次可见的失败。
 * @param dir 快照目录。
 * @param ms 时间戳。
 */
export function nextFileName(dir: string, ms: number): string {
  const stamp = formatStamp(ms)
  for (let seq = 1; seq <= 99; seq += 1) {
    const candidate = `ondra-${stamp}-${pad(seq, 2)}.db`
    try {
      statSync(`${dir}/${candidate}`)
    } catch {
      return candidate
    }
  }
  // 同一秒内 99 份：这已经说明有东西在死循环里调 create()，报错比继续造文件好。
  throw new Error(`同一秒内已存在 99 份快照（${stamp}），拒绝继续创建`)
}

/**
 * 删除一个文件，失败不抛。
 * @param filePath 绝对路径。
 * @returns 是否真的删掉了。
 */
export function removeFile(filePath: string): boolean {
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}
