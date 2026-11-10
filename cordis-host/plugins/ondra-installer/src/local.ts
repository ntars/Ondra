/**
 * 三个本地端口：读源、写目标、探运行环境。
 *
 * ## 为什么端口化
 *
 * 安装是**唯一会写用户目录**的能力。把「读哪、写哪」做成端口，意义不是「方便测试」
 * （本轮不跑测试），而是：**让写动作只有一个入口**。所有落盘都经过 `FileSink`，
 * 于是「有没有绕过临时文件直接写目标」这种问题，看一眼这个文件就能答。
 *
 * ## 临时文件为什么与目标同目录
 *
 * `rename` 只在**同一文件系统**内原子。放到 `/tmp` 再 rename 到目标，跨卷时会退化成
 * 「复制 + 删除」，中间那段时间目标文件是不存在的——一次崩溃就留下空文件。
 * 所以临时文件永远 `dest + '.tmp-…'`，与目标同目录。
 *
 * ## `freeBytes` 为什么返回 `null`
 *
 * Node 没有跨平台查剩余空间的 API（`statfs` 要 `node:fs` 的实验接口或原生模块）。
 * 本包禁装依赖，所以如实返回 `null` = 「判不了」，而不是编一个数字。
 * 宁可少一条检查，也不要一条会误报的检查。
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ComponentSource, FileSink, RuntimeProbe } from './types.js'
import { isSafeRelative } from './manifest.js'

/** 临时文件序号：同一进程内两个组件同名时也不会撞。 */
let sequence = 0

/**
 * 本地读源：在 `sourceDir` 里按相对文件名找组件。
 *
 * 路径关在 `sourceDir` 里：`isSafeRelative` 已经挡掉 `..`、绝对路径、反斜杠，
 * 所以 `join` 之后不可能逃出目录。
 */
export class LocalSource implements ComponentSource {
  readonly #dir: string

  /**
   * @param dir 来源目录绝对路径。
   */
  constructor(dir: string) {
    this.#dir = dir
  }

  /** 来源目录。 */
  get dir(): string {
    return this.#dir
  }

  /**
   * 定位。
   * @param file 相对文件名。
   */
  locate(file: string): string | null {
    if (!isSafeRelative(file)) return null
    const abs = join(this.#dir, file)
    try {
      return statSync(abs).isFile() ? abs : null
    } catch {
      return null
    }
  }
}

/** 本地写目标。 */
export class LocalSink implements FileSink {
  /** 确保目录存在（0700）。 */
  ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  /**
   * 复制出一个临时文件。
   * @param dest 目标绝对路径。
   * @param sourcePath 来源绝对路径。
   */
  writeTemp(dest: string, sourcePath: string, exec: boolean): string {
    sequence += 1
    const temp = `${dest}.tmp-${String(process.pid)}-${String(sequence)}`
    copyFileSync(sourcePath, temp)
    // 权限由清单的 `exec` 决定，不由来源文件的 mode 决定：来源可能是 0777 的下载物，
    // 照抄会把一个数据文件变成可执行。反过来，node 二进制不给执行位就装了个废的。
    chmodSync(temp, exec ? 0o755 : 0o600)
    return temp
  }

  /**
   * 临时 → 目标（原子）。
   * @param temp 临时路径。
   * @param dest 目标路径。
   */
  commit(temp: string, dest: string): void {
    renameSync(temp, dest)
  }

  /** 存在？ */
  exists(dest: string): boolean {
    return existsSync(dest)
  }

  /** 删（只用于删本包自己写的临时文件）。 */
  remove(path: string): void {
    rmSync(path, { force: true })
  }
}

/** 运行环境探针（真实值来自 `process`）。 */
export class LocalRuntime implements RuntimeProbe {
  /** Node 版本。 */
  nodeVersion(): string {
    return process.versions.node
  }

  /**
   * 剩余字节。**判不了**（见文件头）。
   * @param dir 忽略。
   */
  freeBytes(dir: string): number | null {
    void dir
    return null
  }
}
