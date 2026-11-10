/**
 * 同意账本的文件端口。
 *
 * ## 为什么单独一个文件
 *
 * `consent.ts` 只管格式（序列化 / 解析 / 过期），落盘细节（原子写、0600、ENOENT）
 * 归这里。分开之后 `consent.ts` 不 import `node:fs`，可以被纯逻辑对拍；而换存储
 * （SQLite / 测试内存）也不用碰格式代码。
 *
 * ## 原子写：临时文件 + 同目录 rename
 *
 * 直接覆盖会在断电时留下半个 JSON。半个 JSON 解析失败 → 账本按空处理 →
 * 所有同意失效 → 用户下次启动被重新问一遍，而且他不知道为什么。
 * 同目录内 `rename` 是原子的，所以先写 `.tmp` 再改名。
 *
 * ## 权限不在这里改
 *
 * 文件由 `ondra-path-layout.prepareFile()` 以 0600 建好（权限的真源在 O-002）。
 * 本文件不 chmod、不建目录——那两件事各有主人。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ConsentLedger } from './types.js'

/** 日志子集。 */
export interface LedgerLogLike {
  warn(message: string, ...args: readonly unknown[]): void
}

/**
 * 取异常的 `code`（`unknown` 不能直接比较，纪律：先判类型再取值）。
 * @param error 异常。
 */
export function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return ''
}

/** 基于文件的同意账本。 */
export class FileLedger implements ConsentLedger {
  /** 端口名。 */
  readonly id = 'file'
  /** 给用户看的相对位置。 */
  readonly display: string
  readonly #path: string
  readonly #log: LedgerLogLike

  /**
   * @param filePath 绝对路径（由 O-002 给出）。
   * @param display 相对位置（不暴露机器绝对路径）。
   * @param log 日志。
   */
  constructor(filePath: string, display: string, log: LedgerLogLike) {
    this.#path = filePath
    this.display = display
    this.#log = log
  }

  /** 读全文；文件不存在返回 `null`。 */
  read(): string | null {
    try {
      return readFileSync(this.#path, 'utf8')
    } catch (error) {
      // ENOENT 是「还没有」，不是「读失败」——两者对调用方的含义完全不同。
      if (codeOf(error) === 'ENOENT') return null
      this.#log.warn('同意账本读不出来（按空处理）：%s', this.display)
      return null
    }
  }

  /**
   * 写全文（原子）。
   * @param text 全文。
   */
  write(text: string): boolean {
    const temp = `${this.#path}.tmp`
    try {
      writeFileSync(temp, text, { mode: 0o600 })
      renameSync(temp, this.#path)
      return true
    } catch {
      return false
    }
  }
}
