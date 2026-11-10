/**
 * 六槽位的定义，以及 `SKILL.md` 的章节切分。
 *
 * 这个文件回答两个问题：
 * 1. **哪六段**算「内核」（`SLOT_IDS` 的顺序即拼装顺序）；
 * 2. **怎么从一份 `SKILL.md` 里把这几段切出来**（`SECTION_RULES` 一张表 + 切分器）。
 *
 * 切分的三条实现要点：
 *
 * 1. **按二级标题切，`###` 留在父段里。** 两个人设包的层级是「`##` 是 Layer，
 *    `###` 是 Layer 内的细则」；按 `###` 切会把「说话」拆成九个碎片，
 *    而它们必须一起出现才有意义（4.1 三条硬指标 + 4.2 句式九类 + 4.5 禁忌）。
 *
 * 2. **代码围栏里的 `##` 不算标题。** 人设包里确实有代码块（自检模板、回复示例），
 *    围栏里出现 `## 示例` 会被误切成新章节，症状是「内核里少了一段、多了一段垃圾」。
 *    所以切分器维护围栏状态。
 *
 * 3. **映射只认这张表，先命中先算。** 表里 `boundaries` 排在 `identity` 之前，
 *    因为「Layer 0 · 硬规则」与「Layer 1 · 身份锚定」只差一个数字，
 *    顺序一旦反过来，硬规则会被当成身份锚定的一部分塞进内核，
 *    而红线从此不进闸门——这是那种「看起来都在、其实少了一层」的错。
 */

import { AUX_IDS, SLOT_IDS } from './types.js'
import type { AuxId, SectionSlice, SlotContent, SlotId, SlotSpec } from './types.js'

/** 一条映射规则。 */
interface SectionRule {
  /** 归到槽位还是辅助段。 */
  readonly kind: 'slot' | 'aux'
  /** id。 */
  readonly id: SlotId | AuxId
  /** 中文名。 */
  readonly label: string
  /** 标题匹配关键词，按顺序试、先命中先算。 */
  readonly keywords: readonly string[]
  /** 这一段落回答什么问题。 */
  readonly doc: string
}

/**
 * **唯一的映射表。**
 *
 * 关键词不是猜的，逐字出现在两个人设包的 `SKILL.md` 标题里：
 * `## 一、激活与退出` / `## 二、Layer 0 · 硬规则（任何情况下不得违背）` /
 * `## 三、Layer 1 · 身份锚定` / `## 四、Layer 2 · 说话` /
 * `## 五、Layer 3 · 三条底层机制` / `## 六、Layer 4 · 场景与连续` /
 * `## 七、回复格式` / `## 八、发出前自检（五问）` / `## 九、红线` /
 * `## 十、按需读取（渐进披露）` / `## 十一、诚实边界`。
 */
const SECTION_RULES: readonly SectionRule[] = Object.freeze([
  {
    kind: 'aux',
    id: 'activation',
    label: '激活与退出',
    keywords: ['激活'],
    doc: '什么时候切到她、怎么收萌。归「切换」不归人格，所以不是槽位。',
  },
  {
    kind: 'aux',
    id: 'boundaries',
    label: '边界',
    keywords: ['硬规则', '红线', '诚实边界', '禁区', '禁止'],
    doc: '硬规则 / 红线 / 诚实边界。归闸门（O-037）与拼装的边界层（O-023）。',
  },
  {
    kind: 'slot',
    id: 'identity',
    label: '身份锚定',
    keywords: ['身份锚定', '身份', 'Layer 1'],
    doc: '她是谁：名字、自称、年龄与身份设定、所处的世界。',
  },
  {
    kind: 'slot',
    id: 'voice',
    label: '说话',
    keywords: ['说话', 'Layer 2', '语言'],
    doc: '怎么开口：句长、句式、语气词、标点习惯、称呼与自称、用词黑白名单。',
  },
  {
    kind: 'slot',
    id: 'drive',
    label: '驱动力',
    keywords: ['底层机制', 'Layer 3', '驱动力'],
    doc: '为什么这样：她的行为都是哪几条驱动力的变形、自相矛盾在哪、冷热怎么转。',
  },
  {
    kind: 'slot',
    id: 'scene',
    label: '场景与连续',
    keywords: ['场景与连续', '场景', 'Layer 4'],
    doc: '什么时候怎么变：场景调用、记忆与连续、进化模式。',
  },
  {
    kind: 'slot',
    id: 'format',
    label: '回复格式',
    keywords: ['回复格式', '输出格式'],
    doc: '输出长什么样：分条、长度、括号动作、标点收尾。',
  },
  {
    kind: 'slot',
    id: 'selfcheck',
    label: '发出前自检',
    keywords: ['自检', '发出前'],
    doc: '发出去之前查什么：几问自检清单。',
  },
  {
    kind: 'aux',
    id: 'references',
    label: '按需读取',
    keywords: ['按需读取', '渐进披露'],
    doc: '包内文件的索引。**永不进提示词**——它是目录不是内容。',
  },
])

/** 六个槽位的声明，顺序即拼装顺序。 */
export const SLOT_SPECS: readonly SlotSpec[] = Object.freeze(
  SLOT_IDS.map((id, order) => {
    const rule = SECTION_RULES.find(item => item.kind === 'slot' && item.id === id)
    const spec: SlotSpec = {
      id,
      label: rule === undefined ? id : rule.label,
      order,
      keywords: Object.freeze(rule === undefined ? [] : [...rule.keywords]),
      doc: rule === undefined ? '' : rule.doc,
    }
    return spec
  }),
)

/** 三个辅助段的声明。 */
export const AUX_SPECS: readonly { readonly id: AuxId; readonly label: string; readonly doc: string }[] =
  Object.freeze(
    AUX_IDS.map(id => {
      const rule = SECTION_RULES.find(item => item.kind === 'aux' && item.id === id)
      return {
        id,
        label: rule === undefined ? id : rule.label,
        doc: rule === undefined ? '' : rule.doc,
      }
    }),
  )

/** 字符数（按码点算，中文一个字算一个）。 */
export function charCount(text: string): number {
  return Array.from(text).length
}

/**
 * 去掉 BOM 与 YAML frontmatter。
 *
 * `SKILL.md` 开头是 `---\nname: ...\n---\n`。不去掉的话，第一段「引言」里会混进
 * `name:` 与 `license:` 两行元信息，它们会被当成正文拼进提示词。
 * @param text 原文。
 */
export function stripFrontmatter(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = withoutBom.split('\n')
  if (lines.length === 0) return withoutBom
  if (lines[0].trim() !== '---') return withoutBom
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      return lines.slice(i + 1).join('\n')
    }
  }
  // 只有开头没有结尾：不是 frontmatter，原样返回（宁可多两行也不吃掉正文）。
  return withoutBom
}

/** 切出来的一段。 */
interface RawSection {
  /** 标题行（含 `##`）。 */
  readonly heading: string
  /** 正文（含标题行）。 */
  readonly text: string
}

/**
 * 按二级标题切分，并单独摘出标题之前的引言块。
 * @param text 已去 frontmatter 的正文。
 */
export function splitSections(text: string): { preface: string; sections: RawSection[] } {
  const lines = text.split('\n')
  const prefaceLines: string[] = []
  const sections: { heading: string; lines: string[] }[] = []
  let current: { heading: string; lines: string[] } | undefined
  let inFence = false

  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
    }
    // 围栏内的 `##` 不是标题（见文件头第 2 条）。
    const isHeading = !inFence && /^## (?!#)/.test(line)
    if (isHeading) {
      current = { heading: line.trimEnd(), lines: [line.trimEnd()] }
      sections.push(current)
      continue
    }
    if (current === undefined) {
      prefaceLines.push(line)
    } else {
      current.lines.push(line)
    }
  }

  return {
    preface: trimBlank(prefaceLines.join('\n')),
    sections: sections.map(section => ({ heading: section.heading, text: trimBlank(section.lines.join('\n')) })),
  }
}

/** 去掉首尾空行（保留内部空行）。 */
function trimBlank(text: string): string {
  return text.replace(/^[\s]+/, '').replace(/[\s]+$/, '')
}

/** 一段切片。 */
function toSlice(section: RawSection): SectionSlice {
  return Object.freeze({
    heading: section.heading,
    chars: charCount(section.text),
    text: section.text,
  })
}

/** 按标题判归属。 */
export function classifyHeading(heading: string): { readonly kind: 'slot' | 'aux'; readonly id: SlotId | AuxId } | undefined {
  for (const rule of SECTION_RULES) {
    for (const keyword of rule.keywords) {
      if (heading.includes(keyword)) return { kind: rule.kind, id: rule.id }
    }
  }
  return undefined
}

/** 一份 `SKILL.md` 的切分结果。 */
export interface SkillLayout {
  /** 标题之前的引言块（作者写的「一句话内核」）；没有为 `undefined`。 */
  readonly preface: SectionSlice | undefined
  /** 六个槽位（顺序固定，缺的也在）。 */
  readonly slots: readonly SlotContent[]
  /** 激活与退出。 */
  readonly activation: readonly SectionSlice[]
  /** 硬规则 / 红线 / 诚实边界。 */
  readonly boundaries: readonly SectionSlice[]
  /** 按需读取索引。 */
  readonly references: readonly SectionSlice[]
  /** 没被映射的章节。 */
  readonly extras: readonly SectionSlice[]
  /** 原文码点数（去 frontmatter 后）。 */
  readonly chars: number
}

/**
 * 把一份 `SKILL.md` 切成「六槽位 + 三辅助段 + 未映射」。
 *
 * 同一槽位命中多段时**按出现顺序拼接**（不丢）：拆开的两段常常是
 * 「说话」与「语言指纹」，只留一段会让内核少半条规矩。
 * @param skillText `SKILL.md` 原文。
 */
export function layoutOf(skillText: string): SkillLayout {
  const body = stripFrontmatter(skillText)
  const { preface, sections } = splitSections(body)

  const slotParts = new Map<SlotId, RawSection[]>()
  const auxParts = new Map<AuxId, RawSection[]>()
  const extras: SectionSlice[] = []

  for (const section of sections) {
    const hit = classifyHeading(section.heading)
    if (hit === undefined) {
      extras.push(toSlice(section))
      continue
    }
    if (hit.kind === 'slot') {
      const id = hit.id as SlotId
      const bucket = slotParts.get(id)
      if (bucket === undefined) slotParts.set(id, [section])
      else bucket.push(section)
      continue
    }
    const id = hit.id as AuxId
    const bucket = auxParts.get(id)
    if (bucket === undefined) auxParts.set(id, [section])
    else bucket.push(section)
  }

  const slots: SlotContent[] = SLOT_IDS.map((id, order) => {
    const spec = SLOT_SPECS.find(item => item.id === id)
    const parts = slotParts.get(id) ?? []
    const text = parts.map(part => part.text).join('\n\n')
    const head = parts.length === 0 ? '' : parts[0].heading
    return Object.freeze({
      id,
      label: spec === undefined ? id : spec.label,
      order,
      heading: head,
      chars: charCount(text),
      found: parts.length > 0,
      text,
    })
  })

  return Object.freeze({
    preface: preface === '' ? undefined : Object.freeze({ heading: '', chars: charCount(preface), text: preface }),
    slots: Object.freeze(slots),
    activation: Object.freeze((auxParts.get('activation') ?? []).map(toSlice)),
    boundaries: Object.freeze((auxParts.get('boundaries') ?? []).map(toSlice)),
    references: Object.freeze((auxParts.get('references') ?? []).map(toSlice)),
    extras: Object.freeze(extras),
    chars: charCount(body),
  })
}

/**
 * 把一段正文拆成条目（用于边界条目）。
 *
 * 只认两种写法：行首 `- ` / `* ` 的列表项，与行首 `1. ` `2、` 的有序列表项。
 * **不按句号切**——红线常常是一句长话，按句号切会把「不做什么，因为什么」劈成两条，
 * 而单独一半读起来是另一个意思。
 * @param text 段落正文（可含标题行）。
 * @param limit 条目上限。
 */
export function splitItems(text: string, limit: number): string[] {
  const out: string[] = []
  let buffer: string[] = []
  const flush = (): void => {
    if (buffer.length === 0) return
    const item = buffer.join(' ').trim()
    buffer = []
    if (item !== '') out.push(item)
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || /^-{3,}$/.test(line)) {
      flush()
      continue
    }
    if (/^([-*]|\d+[.、)])\s+/.test(line)) {
      flush()
      buffer.push(line.replace(/^([-*]|\d+[.、)])\s+/, ''))
      continue
    }
    buffer.push(line)
    if (out.length >= limit) break
  }
  flush()
  return out.slice(0, limit)
}
