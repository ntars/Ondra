/**
 * 文件系统边界 —— **本插件唯一 `import 'node:fs'` 的地方**。
 *
 * 只提供一个能力：**列一层目录**（不递归）。理由在 `types.ts` 的 `FsLike` 上：
 * 立绘目录是平的，递归会把"旧图"也捞出来。
 *
 * 读不到目录**不抛**：不存在、权限不足、路径是文件，全部折成
 * `{ entries: [], error, code }`。服务层据此把目录标成 `present: false`
 * 或"故障"，面板显示不同的话，而不是弹一个错。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DirEntryLike, FsLike, FsListing } from './types.js'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 真实的文件系统实现。 */
export const nodeFs: FsLike = {
  list(dir: string): FsListing {
    let names: readonly string[]
    try {
      names = readdirSync(dir)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return {
        entries: [],
        error: messageOf(error),
        ...(typeof code === 'string' ? { code } : {}),
      }
    }

    const entries: DirEntryLike[] = []
    for (const name of names) {
      try {
        const info = statSync(join(dir, name))
        entries.push(
          Object.freeze({
            name,
            isDir: info.isDirectory(),
            // 目录的字节数没意义，统一记 0。
            bytes: info.isDirectory() ? 0 : info.size,
          }),
        )
      } catch {
        // 单个文件 stat 失败（权限、断链）：记成 0 字节，由扫描层当作坏图跳过。
        // 不在这里抛，否则一个坏链接会让整个目录都出不来。
        entries.push(Object.freeze({ name, isDir: false, bytes: 0 }))
      }
    }
    return { entries: Object.freeze(entries) }
  },
}
