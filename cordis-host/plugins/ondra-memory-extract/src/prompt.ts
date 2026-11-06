/**
 * 提炼提示词。**稳定段是模块级常量，永不拼接日期与情绪**（手册 §8.5 前缀缓存）。
 *
 * 这条纪律的具体含义：每次调用都发**逐字相同**的 `SYSTEM_PROMPT`，
 * 易变内容（本轮对话、轮次 id）只出现在 `user` 消息里。
 * 若把「今天是 11 月 1 日」拼进 system，缓存前缀每轮都变，命中率直接归零——
 * 实测代价是成本从 ¥19.96 涨回 ¥879.97（§8.5 原数据）。
 *
 * 提示词本身的三条设计：
 *
 * 1. **先给格式，再给规则**。模型对「输出什么形状」的服从度远高于「注意什么」。
 * 2. **每条规则都对应一个确定性检查**。写了但查不了的规则等于没写——
 *    例如「必须逐字引用」对应 `verify.ts` 的子串比对，
 *    「数字必须有 TOOL 来源」对应数字游程覆盖检查。规则与检查**一一对应**。
 * 3. **明确给出「没有就返回空」的出口**。不给出口，模型会为了完成任务而编一条。
 */

import { EVIDENCE_SOURCES, EXTRACT_CATEGORIES, EXTRACT_KINDS } from './types.js'
import type { EvidenceSource, TurnMessage } from './types.js'

/** 类别说明（给模型看的中文注解，与 11 类一一对应）。 */
const CATEGORY_HINTS: Readonly<Record<string, string>> = Object.freeze({
  watch: '看片、视频、影视',
  daily: '日常琐事',
  food: '吃什么、口味、忌口',
  place: '地点、住处、常去的地方',
  misc: '杂项（拿不准就选它）',
  event: '发生的事、计划、安排',
  feeling: '情绪、感受、心情',
  study: '学习、考试、课程',
  person: '关于某个人的事实',
  promise: '答应过的事、约定',
  self: '关于她自己（人格、边界、原则）',
})

/** 11 类清单的提示词写法（由常量派生，不手抄第二份）。 */
const CATEGORY_LINE = EXTRACT_CATEGORIES.map(key => `${key}（${CATEGORY_HINTS[key] ?? ''}）`).join(' / ')

/** 五类清单。 */
const KIND_LINE = EXTRACT_KINDS.join(' / ')

/**
 * 稳定段系统提示。**逐字冻结**，见文件头。
 *
 * 模板里只有一个占位（类别与种类清单），它在模块加载时就被填好，
 * 之后每次调用都是同一个字符串——不是每轮现拼。
 */
export const SYSTEM_PROMPT = `你是记忆提炼器。你的唯一任务是从一段对话里挑出「值得长期记住」的事实，并为每条事实提供逐字引文。

输出格式（只输出 JSON，不要解释，不要代码块围栏）：
{"facts":[{"kind":"fact","category":"person","text":"……","summary":"……","subject":"user","evidence":[{"source":"USER","quote":"……","messageIndex":0}]}]}

字段说明：
- kind：${KIND_LINE}
- category：${CATEGORY_LINE}
- text：一条事实，不超过 200 字，用全名不用代词，写清「谁说的 / 谁做的」
- summary：不超过 80 字
- subject：user / self / 具体人名
- evidence：至少一条，每条形如 {"source":"USER","quote":"原文里的连续片段","messageIndex":消息序号}

规则：
1. 只提炼对话里明确出现过的信息。不推断、不补全、不美化、不总结成道理。
2. 每条事实至少一条引文；引文必须与原文**逐字相同**（可以少标点，不可以改字、不可以合并两句）。
3. 引文来源只能是 ${EVIDENCE_SOURCES.join(' / ')}：
   USER=用户说的话，TOOL=工具或命令的返回，ACT=实际发生的动作或系统事件，SELF=她自己说的话。
4. 任何数字（日期、年龄、价格、数量、次数）必须来自 TOOL 引文。用户口述的数字不要写进 text。
5. 不收：系统状态、群友闲聊、她的心理活动、寒暄、重复内容、你自己刚说过的话里的观点。
6. 没有值得记的内容就返回 {"facts":[]}。**空数组是正确答案，不是失败。**`

/**
 * 一条消息的引文来源。
 *
 * 默认由角色推导；调用方可用 `source` 显式覆盖（`ACT` 只能显式给，
 * 从文本猜「这是不是动作」必然猜错）。
 * @param message 消息。
 */
export function sourceOfMessage(message: TurnMessage): EvidenceSource {
  if (message.source !== undefined && (EVIDENCE_SOURCES as readonly string[]).includes(message.source)) {
    return message.source
  }
  if (message.role === 'user') return 'USER'
  if (message.role === 'tool') return 'TOOL'
  return 'SELF'
}

/**
 * 把本轮消息渲染成 user 消息。
 *
 * 格式刻意朴素（`[序号] 来源: 正文`）：模型要引用的是**序号与原文**，
 * 任何额外装饰（缩进、引号、JSON 包一层）都会让「逐字引用」多一层转义歧义。
 * @param messages 消息列表。
 * @param budgetChars 总字符预算；超了从**最早**的消息开始丢。
 * @returns 渲染后的正文，以及实际保留的消息下标集合。
 */
export function buildUserMessage(
  messages: readonly TurnMessage[],
  budgetChars: number,
): { readonly content: string; readonly kept: readonly number[] } {
  const lines: string[] = []
  const kept: number[] = []
  let used = 0

  // 从后往前装：最近的话最可能被引用，而超预算时先丢最早的（§2.6 装箱制的同一取向）。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    const line = `[${index}] ${sourceOfMessage(message)}: ${message.text}`
    if (used + line.length > budgetChars && kept.length > 0) break
    lines.unshift(line)
    kept.unshift(index)
    used += line.length + 1
  }

  return { content: lines.join('\n'), kept: Object.freeze(kept) }
}
