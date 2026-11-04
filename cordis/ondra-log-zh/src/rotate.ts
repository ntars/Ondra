/**
 * O-004 的按大小轮转。
 *
 * 为什么不用日期切分：一天写 200MB 时日期文件没有上界，磁盘会被日志吃干；
 * 按大小切能给出确定上界 —— `maxFileBytes × (maxRotated + 1)`。
 *
 * 为什么自己记文件大小：每写一行都 `statSync` 一次，在「同一错误每秒 1000 条」
 * 的场景下就是每秒 1000 次系统调用，写放大保护省下来的开销会被它吃回去。
 * 这里只在第一次接触文件时 stat 一次，之后按写入字节累加。
 */

import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'

/** 轮转参数。 */
export interface RotateOptions {
  /** 单文件字节上限。 */
  readonly maxBytes: number
  /** 保留的历史份数（不含当前文件）。 */
  readonly maxRotated: number
}

/** 带大小缓存的追加器。 */
export class SizeRotator {
  private readonly sizes = new Map<string, number>()
  private readonly options: RotateOptions

  constructor(options: RotateOptions) {
    this.options = options
  }

  /**
   * 追加一行（调用方负责带换行）。
   * @param path 目标文件绝对路径。
   * @param text 整行文本。
   * @throws 写入或轮转失败时抛出，由调用方决定降级。
   */
  append(path: string, text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8')
    const current = this.sizeOf(path)
    if (current > 0 && current + bytes > this.options.maxBytes) {
      this.rotate(path)
    }
    const fd = openSync(path, 'a')
    try {
      writeSync(fd, text)
    } finally {
      closeSync(fd)
    }
    this.sizes.set(path, this.sizeOf(path) + bytes)
  }

  /**
   * 读文件当前大小（带缓存）。
   * @param path 文件路径。
   */
  sizeOf(path: string): number {
    const cached = this.sizes.get(path)
    if (cached !== undefined) return cached
    let size = 0
    if (existsSync(path)) {
      try {
        size = statSync(path).size
      } catch {
        size = 0
      }
    }
    this.sizes.set(path, size)
    return size
  }

  /**
   * 轮转：删最旧 → 逐个后移 → 当前改名为 `.1`。
   *
   * 顺序不能反：先删最旧再后移，任何时刻都不会出现两份同号文件；
   * 反过来在 Windows 上会因「目标已存在」直接失败。
   * @param path 当前文件绝对路径。
   */
  private rotate(path: string): void {
    const keep = this.options.maxRotated
    // 1. 丢掉最旧的一份。
    rmSync(path + '.' + String(keep), { force: true })
    // 2. 从高到低后移，避免覆盖尚未移动的文件。
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = path + '.' + String(index)
      if (!existsSync(from)) continue
      renameSync(from, path + '.' + String(index + 1))
    }
    // 3. 当前文件变成 `.1`。
    if (existsSync(path)) {
      renameSync(path, path + '.1')
    }
    // 4. 大小缓存整体失效：文件都换了名字，旧数字不再对应。
    this.sizes.delete(path)
    for (let index = 1; index <= keep; index += 1) {
      this.sizes.delete(path + '.' + String(index))
    }
  }
}
