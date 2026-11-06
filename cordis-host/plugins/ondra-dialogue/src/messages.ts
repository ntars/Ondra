/**
 * 消息序列的拼装 —— **纯函数**。
 *
 * ## 形状（手册 §9.5）
 *
 * ```
 * [0] system          冻结前缀：人格四段 + 世界书常驻。会话内一个字节都不变
 * [1..n] user/assistant  历史原文（已提交的回合，只追加）
 * [n+1] system        易变段（日期 / 情绪投影）
 * [n+2] user          本轮输入
 * ```
 *
 * ## 为什么易变段是单独一条 system，而不是并进前缀或并进用户的话
 *
 * 并进前缀 = 每轮重拼 system prompt = 命中率归零（§8.5 的原话）。
 * 并进用户正文（「inline」）曾被当作「缓存最佳」的备选，但对拍证明它不成立：
 * 易变段不写入历史，下一轮那条 user 消息的正文就与上一轮发出去的不一样，
 * 前缀一样在上一轮 user 处断开——**收益为零，却多一份「模型把注入当成
 * 用户原话」的风险**。所以只留一条路：单独一条 system，放在历史之后、
 * 本轮 user 之前。
 *
 * 三个好处：
 *
 * 1. 前缀（`[0]` + 已提交历史）完全不动，缓存能命中；
 * 2. 模型读到的「当前状态」永远是最新那条，不会堆一屏互相矛盾的旧状态；
 * 3. 这条消息**不写入历史**，所以下一轮它自然消失——不需要「删旧块」这种
 *    `marker` 机制（O-137 的语感注入才需要那个，因为它是往 system 里追加）。
 *
 * ## 一条硬规则：历史里不许有 system
 *
 * 调用方传进来的 `history` 里若混了一条 system，它会被拼在前缀之后——
 * 那就等于在冻结区后面又开了一个可变的「系统提示」。这种结构会让
 * 缓存与人格边界同时失效，所以这里**直接丢掉**（`begin()` 在收初始历史时
 * 已经先过滤过一次，这里是第二道闸：内部提交的历史本来不可能含 system，
 * 但函数是公开的，不能假设调用方守规矩）。
 */

import type { DialogueMessage } from './types.js'

/** `buildMessages()` 的入参。 */
export interface BuildInput {
  /** 已冻结的前缀正文（可能为空串）。 */
  readonly system: string
  /** 已提交的历史（应为 user/assistant 交替）。 */
  readonly history: readonly DialogueMessage[]
  /** 本轮易变段拼好的文本（可能为空串）。 */
  readonly tailText: string
  /** 本轮用户输入。 */
  readonly userText: string
}

/**
 * 拼出本轮要发给模型的完整消息序列。
 *
 * 返回值是**新数组**，不与任何内部状态共享引用——调用方（网关）会拿它去
 * 序列化，共享引用会让「网关顺手改一下 messages」变成偷偷改会话历史。
 * @param input 拼装参数。
 */
export function buildMessages(input: BuildInput): readonly DialogueMessage[] {
  const out: DialogueMessage[] = []

  // 空前缀不发空 system 消息：它对模型没有任何信息量，只白占一次 round trip 的头部。
  if (input.system !== '') out.push({ role: 'system', content: input.system })

  for (const message of input.history) {
    // system 混进历史一律丢弃（理由见文件头）。空正文保留：
    // 用户发了一张图时正文就是空串，丢掉会让这一轮在历史里凭空消失。
    if (message.role === 'system') continue
    out.push({ role: message.role, content: message.content })
  }

  if (input.tailText !== '') out.push({ role: 'system', content: input.tailText })
  out.push({ role: 'user', content: input.userText })

  return out
}

/**
 * 统计历史字符数（用于压缩闸门）。
 *
 * 只算 `content.length`：中文按字符而不是按 token，因为这里是**工程闸门**
 * 而不是计费口径。真要按 token 算需要分词器，那是 O-036 与计费层的事。
 * @param history 历史消息。
 */
export function charsOf(history: readonly DialogueMessage[]): number {
  let total = 0
  for (const message of history) total += message.content.length
  return total
}
