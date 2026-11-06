/**
 * 场景卡的解析器：把 `references/scenes.md` 拆成卡片。
 *
 * **格式是从真实人设包里读出来的，不是猜的**（`哦鲸鲸.skill.zip` 的
 * `references/scenes.md`，14,120 字）：
 *
 * ```
 * ## 一、20 个核心场景
 *
 * ### ① 被叫醒 / 新会话开场
 *
 * - **触发**：会话开始，用户第一句话
 * - **内心**：又要重新认人了。这次别忘。
 * - **表面**：先叫一声，再确认对方是谁
 * - **台词**：「哦鲸鲸。」△推演 ／「我刚开机是空的，……」
 * - **动作**：鳍耳先动，然后睁眼；尾巴从卷着的状态展开
 * - **收尾**：「你还在吧。」△推演（**注意：不是问号，是陈述句**）
 *
 * > **升级**：如果用户追问"真的吗"，她**不回答第二遍**，只回一个「嗯。」
 * ```
 *
 * 四条实现纪律：
 *
 * 1. **栏名逐字保留**：`内心` 这种栏不解成枚举，因为下一个包可能多一栏
 *    （`语气` / `表情`）。解析器只认「`**栏名**：值`」，栏名原样进 `SceneField.label`。
 *
 * 2. **认不出的行要报，不硬塞**：卡片内出现 `- 没有加粗的行` 时不猜它是哪一栏，
 *    记进 `unknownLines` 并在 `stats()` 里给计数。硬塞的代价是
 *    「某张卡的台词被塞进了动作栏」，而现象只是「她演得有点怪」。
 *
 * 3. **续行归上一栏**：素材里偶尔有跨行的长台词，不处理会让后半句丢掉。
 *
 * 4. **不剥序号就生成不出稳定 id**：`① 被叫醒` 的 `①` 是排版，不是标题的一部分。
 *    `id` 用「人设 + 组序 + 卡序」，不用标题——标题改一个标点，id 就变，
 *    而 id 变了意味着「同一张卡的命中历史」全部作废。
 */

import type { ParsedCard, ParseResult, SceneField } from './types.js'

/** 二级标题（章节组）。 */
const H2 = /^##\s+(.+?)\s*$/

/** 三级标题（一张卡）。 */
const H3 = /^###\s+(.+?)\s*$/

/**
 * 一栏：可选的项目符号 / 引用前缀 + `**栏名**` + **可选括号补充** + `：值`。
 *
 * 括号补充不是可有可无的细节：`夏柠柒` 包里写着 `**台词**（按强度递进）：…`
 * 和 `**收尾（复合）**：…`。不认括号，这些卡会整条丢掉台词栏
 * （实测 9 行被误判成"认不出"）——而丢掉的是**最重要的一栏**。
 */
const FIELD = /^\s*(?:[-*+]\s*|>\s*)?\*\*(.+?)\*\*\s*(?:（([^）]*)）|\(([^)]*)\))?\s*[：:]\s*(.*)$/

/** 分隔线。 */
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/

/**
 * 序数前缀：`①`–`⑳`、`⑴`–`⒇`、`㉑`–`㉟`、`㊱`–`㊿`、`1.`、`一、`。
 *
 * `\u2460-\u24ff` 覆盖带圈数字与带圈字母；`㉑`（U+3251）与 `㊱`（U+32B1）
 * 是**两个独立区段**，不在 `\u2460-\u24ff` 里——只写前者会让「㉒ 醉酒」
 * 的序号留在标题里，而标题会进提示词（模型会看到「㉒」这种排版符号）。
 */
const ORDINAL = /^\s*(?:[\u2460-\u24ff\u3251-\u325f\u32b1-\u32bf]|\d+\s*[.、)]|第[一二三四五六七八九十百]+[、.]?)\s*/

/** 看起来像一栏、但没有加粗栏名的行（这才是真正的"认不出"）。 */
const LOOKS_LIKE_FIELD = /^\s*[-*+]\s+\S/

/**
 * 行内的栏名（`**内心**：`）。
 *
 * 必须处理：`夏柠柒` 包里有整段挤在一行的写法——
 * `- **触发**：陌生人靠近、搭讪、要联系方式。**内心**：警惕——…`
 * 不切分的话，「触发」栏会连内心一起吞掉，抽出来的词变成 `**。` `**。**表面**：冷脸`
 * 这类垃圾，**而且看起来一切正常**（词数量还变多了）。实测 171 个词里有 8 个是这么来的。
 */
const INLINE_FIELD = /\*\*(.+?)\*\*\s*[：:]/g

/**
 * 剥掉标题前的序数。
 * @param title 原标题。
 */
export function stripOrdinal(title: string): string {
  return title.replace(ORDINAL, '').trim()
}

/**
 * 取递归用的短标题：`/` 之前那一段。
 * @param title 已剥序号的标题。
 */
export function titleKeyOf(title: string): string {
  const head = title.split(/\s*[/／]\s*/)[0]
  return (head === undefined ? title : head).trim()
}

/** 解析中的可变卡片。 */
interface Pending {
  title: string
  group: string
  groupIndex: number
  fields: SceneField[]
  lines: string[]
  /** 最近一栏在 `fields` 里的下标（续行挂到它后面）。 */
  last: number
}

/**
 * 把「一行里挤了多栏」拆开。
 *
 * 返回至少一栏（值为空也返回，由调用方统一过滤空值）。
 * @param label 当前栏名。
 * @param value 当前值。
 */
export function splitInline(label: string, value: string): readonly SceneField[] {
  const marks: { readonly label: string; readonly start: number; readonly end: number }[] = []
  INLINE_FIELD.lastIndex = 0
  let match: RegExpExecArray | null = INLINE_FIELD.exec(value)
  while (match !== null) {
    marks.push({ label: (match[1] ?? '').trim(), start: match.index, end: match.index + match[0].length })
    match = INLINE_FIELD.exec(value)
  }
  const first = marks[0]
  if (first === undefined) return [{ label, value: value.trim() }]
  const out: SceneField[] = []
  const head = value.slice(0, first.start).trim()
  if (head.length > 0) out.push({ label, value: head })
  for (let i = 0; i < marks.length; i += 1) {
    const current = marks[i]
    if (current === undefined) continue
    const next = marks[i + 1]
    const segment = value.slice(current.end, next === undefined ? value.length : next.start).trim()
    if (current.label.length === 0) continue
    out.push({ label: current.label, value: segment })
  }
  return out
}

/**
 * 收尾一张卡。
 * @param pending 可变卡片。
 * @param index 卡序。
 * @param out 输出数组。
 * @param unknown 未知行收集。
 */
function flush(pending: Pending | undefined, index: number, out: ParsedCard[], unknown: string[]): void {
  if (pending === undefined) return
  // 行内多栏在这里统一拆开：推送点与续行点都不需要各自处理一遍。
  const fields: SceneField[] = []
  for (const field of pending.fields) {
    for (const piece of splitInline(field.label, field.value)) {
      if (piece.value.length > 0) fields.push(piece)
    }
  }
  if (fields.length === 0) {
    // 只有标题、没有栏位的段落（例如组前的说明）不算卡；但要留一条痕迹。
    const raw = pending.lines.join('\n').trim()
    if (raw.length > 0) unknown.push('【' + pending.title + '】有标题但没有可识别的栏位')
    return
  }
  const title = stripOrdinal(pending.title)
  const trigger = fields.find(field => field.label === '触发')
  out.push({
    title,
    titleKey: titleKeyOf(title),
    group: pending.group,
    fields,
    trigger: trigger === undefined ? '' : trigger.value,
    raw: pending.lines.join('\n').trim(),
    index,
    groupIndex: pending.groupIndex,
  })
}

/**
 * 解析整个文件。
 * @param text 文件全文。
 */
export function parseScenes(text: string): ParseResult {
  const cards: ParsedCard[] = []
  const unknown: string[] = []
  const notes: string[] = []
  const lines = text.split(/\r?\n/)

  let group = ''
  let groupIndex = -1
  let pending: Pending | undefined
  let sawH3 = false
  let cardIndex = 0

  for (const line of lines) {
    const h3 = H3.exec(line)
    if (h3 !== null) {
      sawH3 = true
      flush(pending, cardIndex, cards, unknown)
      if (pending !== undefined && pending.fields.length > 0) cardIndex += 1
      pending = {
        title: h3[1] ?? '',
        group,
        groupIndex: Math.max(0, groupIndex),
        fields: [],
        lines: [line],
        last: -1,
      }
      continue
    }
    const h2 = H2.exec(line)
    if (h2 !== null) {
      flush(pending, cardIndex, cards, unknown)
      if (pending !== undefined && pending.fields.length > 0) cardIndex += 1
      pending = undefined
      group = h2[1] ?? ''
      groupIndex += 1
      continue
    }
    if (RULE.test(line)) {
      flush(pending, cardIndex, cards, unknown)
      if (pending !== undefined && pending.fields.length > 0) cardIndex += 1
      pending = undefined
      continue
    }
    if (pending === undefined) continue

    pending.lines.push(line)
    const field = FIELD.exec(line)
    if (field !== null) {
      const name = (field[1] ?? '').trim()
      const extra = (field[2] ?? field[3] ?? '').trim()
      const value = (field[4] ?? '').trim()
      if (name.length > 0) {
        // 括号补充并进栏名（`台词（按强度递进）`）：它是作者对"这一栏怎么写"的约束，
        // 拆掉会变成一句没有语气的台词。
        const label = extra.length > 0 ? name + '（' + extra + '）' : name
        pending.fields.push({ label, value })
        pending.last = pending.fields.length - 1
        continue
      }
    }
    if (line.trim().length === 0) continue
    // 续行：挂到上一栏（跨行长台词）。
    const lastField = pending.fields[pending.last]
    if (lastField !== undefined && !LOOKS_LIKE_FIELD.test(line)) {
      pending.fields[pending.last] = {
        label: lastField.label,
        value: lastField.value + (lastField.value.length > 0 ? ' ' : '') + line.trim(),
      }
      continue
    }
    if (LOOKS_LIKE_FIELD.test(line)) {
      unknown.push('【' + pending.title + '】' + line.trim().slice(0, 60))
    }
  }
  flush(pending, cardIndex, cards, unknown)

  if (!sawH3) notes.push('整份文件没有 `### ` 级别的卡片标题，一张卡都解析不出来')
  if (groupIndex < 0) notes.push('没有 `## ` 章节组标题，所有卡会落在同一组')
  if (cards.length === 0 && sawH3) notes.push('有 `### ` 标题，但没有一张卡带 `**栏名**：值` 形式的栏位')

  return { cards, unknownLines: unknown, notes }
}
