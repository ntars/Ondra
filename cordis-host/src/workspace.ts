/**
 * 工作区目录。
 *
 * ## 什么是"工作区"
 *
 * 空谷在跟用户对话时，可能需要在磁盘上落一些东西：临时文件、生成的结果、
 * 用户让它整理的材料。这些不该散落在任何地方，也不该直接写到用户的主目录。
 * 工作区就是**这一次对话被允许触碰的唯一目录**。
 *
 * ## 为什么按日期分
 *
 * 路径形如 `~/Ondra/workspace/2026-11-06`，一天一个目录。
 *
 * 理由不是"好看"，而是三条实际需要：
 * 1. **可回顾**：想找"上周三做的那件事"，按日期就能定位，不用记住会话标题。
 * 2. **可清理**：用户想腾空间时，删掉几个日期目录即可，不必理解内部结构。
 * 3. **天然分界**：同一天的对话共享一个目录，跨天就分开。这一条同时意味着
 *    目录名可以从会话创建时间**推导**出来，不需要额外存一份绑定关系——
 *    少一份数据就少一处可能出现的不一致。
 *
 * ## 为什么不是懒创建
 *
 * 曾经考虑过"等第一次真正写文件时才建目录"，理由是避免堆满空目录。
 * 但那样用户会先看到一个不存在的工作区，直到某次操作才突然出现；
 * 而"进入即建立"让"我在哪工作"这件事在进入的第一秒就有答案。
 * 空目录的代价（一个 0 字节文件夹）远小于不确定性。
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 目录名格式。只允许这个形状的字符串拼进路径。 */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * 默认工作区根目录。
 *
 * 用 `~/Ondra/workspace` 而不是数据目录（`~/Library/Application Support/...`）：
 * 数据目录是"应用私有"的位置，用户几乎不会主动去看；工作区里的东西是
 * 用户自己的产出，必须放在一个他自己会去翻的地方。
 *
 * 环境变量优先，便于测试与多实例各自隔离。
 */
export function resolveWorkspaceRoot(): string {
  const fromEnv = process.env.ONDRA_WORKSPACE_ROOT?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), 'Ondra', 'workspace')
}

/**
 * 把时间戳转成工作区目录名。
 *
 * 用**本地时区**而不是 UTC：用户在 11 月 6 日晚上 11 点工作，目录名就该是
 * `2026-11-06`。用 UTC 的话中国时区会提前 8 小时跳到第二天，
 * 用户会觉得"我刚建的东西跑到明天的文件夹里了"。
 *
 * @param at 时间戳，毫秒。
 * @returns 形如 `2026-11-06` 的字符串。
 */
export function dayOf(at: number): string {
  const date = new Date(at)
  const year = date.getFullYear()
  // getMonth 从 0 开始；补零是为了目录名能按字典序正确排序。
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(year)}-${month}-${day}`
}

/**
 * 确保某一天的工作区存在，返回其绝对路径。
 *
 * `recursive: true` 同时完成两件事：补齐中间目录，以及**目录已存在时不报错**。
 * 这使得本函数天然幂等——每次进入会话都调用一次是安全的。
 *
 * @param at 会话创建时间，毫秒。
 * @param root 根目录，默认 {@link resolveWorkspaceRoot}。
 * @returns 工作区绝对路径。
 */
export async function ensureWorkspace(at: number, root = resolveWorkspaceRoot()): Promise<string> {
  const day = dayOf(at)
  // day 由 dayOf 生成，形状恒定，这个判断是纵深防御：
  // 万一将来有人改成接受外部传入的日期字符串，拼路径时不会被 `../` 穿出去。
  if (!DAY_PATTERN.test(day)) {
    throw new Error(`工作日目录名不合法：${day}`)
  }
  const directory = join(root, day)
  await mkdir(directory, { recursive: true })
  return directory
}
