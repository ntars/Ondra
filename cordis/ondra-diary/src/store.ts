/**
 * 日记的**文件层**：只做「路径、存在、读、写、列」五件事，不含任何业务判断。
 *
 * ## 三条不可省的细节
 *
 * 1. **原子写**：先写 `*.tmp` 再 `rename`。日记是「每天只有一次机会」的东西，
 *    中途断电留下半个 md，第二天看门狗只看「文件在不在」——文件在、内容是半句，
 *    这一天就永远补不回来了。rename 在同一个文件系统上是原子的，要么旧要么新。
 * 2. **0600**：手册 §9.4「日记等私人数据本地化」。目录走 `path-layout.ensure`（0700），
 *    文件自己 chmod——`writeFileSync` 的 `mode` 只在**新建**时生效，
 *    覆盖已有文件时权限位不会被重置，所以写完必须再收紧一次。
 * 3. **文件名只认自然日键**：`isSafeDayKey()` 先拦，防止 `../` 这类名字被拼进路径。
 *    这是唯一一处「外部字符串进路径」的地方，拦在这里就够了。
 */

import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSafeDayKey } from './markdown.js'
import { DIARY_DIR, DIARY_EXT } from './types.js'
import type { DiaryRef, DiarySource, LogLike, PathLike } from './types.js'

/** 私有文件权限：仅本人可读写。 */
const FILE_MODE = 0o600

/** 列表上限：界面一次最多显示这么多篇（再多也没人翻）。 */
export const LIST_LIMIT = 50

/** 一篇读出来的原始内容。 */
export interface RawDoc {
  /** 文件内容。 */
  readonly text: string
  /** 文件修改时间（毫秒）。 */
  readonly mtime: number
}

/** 文件层的依赖。全部用取值函数：上游晚装载能自愈，早卸载立刻反映。 */
export interface DiaryStoreDeps {
  /** 路径服务。 */
  readonly path: () => PathLike | undefined
  /** 日志。 */
  readonly log: LogLike
}

/**
 * 日记文件仓库。
 *
 * 刻意**不缓存**「哪个文件存在」：判断一次 `existsSync` 是微秒级，
 * 而缓存过期一次就会写出两篇（第二篇覆盖第一篇）或漏写一天。
 */
export class DiaryFileStore {
  private readonly deps: DiaryStoreDeps
  /** 目录是否已确认可写（只用于少打几次日志，不参与判断）。 */
  private dirChecked = false

  constructor(deps: DiaryStoreDeps) {
    this.deps = deps
  }

  /** 是否具备落盘条件（路径服务在位）。 */
  get ready(): boolean {
    return this.deps.path() !== undefined
  }

  /**
   * 某天的文件路径。**不创建、不检查**；路径服务缺席时返回空串。
   * @param dayKey 自然日键。
   */
  pathOf(dayKey: string): string {
    const path = this.deps.path()
    if (path === undefined) return ''
    return path.fileIn('user', DIARY_DIR, `${dayKey}${DIARY_EXT}`)
  }

  /**
   * 确保目录存在（0700）。失败只记一次日志，返回是否可用。
   */
  ensureDir(): boolean {
    const path = this.deps.path()
    if (path === undefined) return false
    try {
      path.ensure('user', DIARY_DIR)
      this.dirChecked = true
      return true
    } catch (error) {
      if (!this.dirChecked) {
        this.dirChecked = true
        this.deps.log.warn(
          '日记目录不可用（%s）：日记只能留在内存里，重启即消失',
          error instanceof Error ? error.message : String(error),
        )
      }
      return false
    }
  }

  /**
   * 某天是否已有日记。名字非法一律 false（不抛）。
   * @param dayKey 自然日键。
   */
  exists(dayKey: string): boolean {
    if (!isSafeDayKey(dayKey)) return false
    const file = this.pathOf(dayKey)
    if (file === '') return false
    try {
      return existsSync(file)
    } catch {
      return false
    }
  }

  /**
   * 读某天的日记原文。
   * @param dayKey 自然日键。
   */
  read(dayKey: string): RawDoc | undefined {
    if (!isSafeDayKey(dayKey)) return undefined
    const file = this.pathOf(dayKey)
    if (file === '') return undefined
    try {
      const text = readFileSync(file, 'utf8')
      const mtime = statSync(file).mtimeMs
      return { text, mtime }
    } catch (error) {
      this.deps.log.warn('读 %s 失败：%s', dayKey, error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /**
   * 原子写一篇日记。**失败返回 false，不抛。**
   * @param dayKey 自然日键。
   * @param doc 完整文件内容。
   */
  write(dayKey: string, doc: string): boolean {
    if (!isSafeDayKey(dayKey)) return false
    if (!this.ensureDir()) return false
    const file = this.pathOf(dayKey)
    if (file === '') return false
    // 临时文件带上 pid：万一有两个进程同时写同一天，至少不会互相截断对方的临时文件。
    const tmp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, doc, { encoding: 'utf8', mode: FILE_MODE })
      renameSync(tmp, file)
      chmodSync(file, FILE_MODE)
      return true
    } catch (error) {
      this.deps.log.warn('写 %s 失败：%s', dayKey, error instanceof Error ? error.message : String(error))
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // 清理临时文件失败不影响结论：真正的失败已经在上面记过了。
      }
      return false
    }
  }

  /**
   * 列出最近的日记（日期倒序）。
   * @param limit 最多几篇。
   */
  list(limit = 20): readonly DiaryRef[] {
    const path = this.deps.path()
    if (path === undefined) return []
    let dir: string
    let names: string[]
    try {
      // 目录只取一次：`ensure()` 会真去建目录，循环里每篇都调一次等于每篇一次 IO。
      dir = path.ensure('user', DIARY_DIR)
      names = readdirSync(dir)
    } catch {
      return []
    }
    const dayKeys = names
      .filter(name => name.endsWith(DIARY_EXT))
      .map(name => name.slice(0, -DIARY_EXT.length))
      .filter(isSafeDayKey)
      .sort()
      .reverse()
      .slice(0, Math.min(Math.max(limit, 0), LIST_LIMIT))

    const out: DiaryRef[] = []
    for (const dayKey of dayKeys) {
      const file = join(dir, `${dayKey}${DIARY_EXT}`)
      try {
        const stat = statSync(file)
        const text = readFileSync(file, 'utf8')
        // 列表只需要「正文多长、是谁写的」，解析成本与文件大小同级，一篇几 KB。
        const meta = /chars=(\d+)\s+at=\d+/.exec(text.slice(-200))
        const source: DiarySource = /source=template/.test(text.slice(-200)) ? 'template' : 'model'
        out.push({
          dayKey,
          path: file,
          chars: meta === null ? 0 : Number(meta[1]),
          source,
          mtime: stat.mtimeMs,
        })
      } catch {
        // 单篇读不动就跳过它，不让一篇坏文件把整个列表清空。
      }
    }
    return out
  }
}
