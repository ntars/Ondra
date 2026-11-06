/**
 * 四段的组装与预算装箱（**纯算法，不碰 ctx**）。
 *
 * 这个文件是整个插件的判断所在，四条规则写死在这里：
 *
 * 1. **顺序恒为「内核 → 关系微调 → 浓度 → 边界」。**
 *    `priority` 只用来决定「超预算时先砍谁」，**绝不参与排序**。
 *    master-plan §10 第 8 条点名的旧缺陷是「提示词按 priority 全局排序，
 *    模型第一句读到的就是『不许做什么』」；把排序与裁剪拆成两个维度，是这条的解法。
 *
 * 2. **装箱制，不是「取前 N 字」。** 按优先级逐条试装，装不下**跳过这条继续试下一条**，
 *    不是整段停（手册 §2.6 原话）。所以一个 2600 字的预算里，
 *    可能保住了 291 字的「回复格式」却丢了 2380 字的「驱动力」——
 *    这正是想要的：短而关键的段落不该被长段落挤掉。
 *
 * 3. **边界层整层豁免。** 它不是「优先级最高」，是**根本不进装箱**。
 *    所以 `overBudget` 的第一大成因永远是边界层——报告里单独给 `exemptChars`。
 *
 * 4. **不切字。** 单元只有「带走」与「不带」两种命运，没有「带前 200 字」。
 *    被切掉半句的红线读起来仍然通顺，只是意思变了——最难发现的一类失真。
 *
 * 另外一处刻意设计（`kernel-mismatch`）：内核按槽位裁，前提是
 * 「六个槽位拼起来 === O-021 给出的内核段」。这两个字串对不上时（上游改了拼接口径），
 * 本插件**不猜**，把整段内核作为一个不可裁单元带上并报 `kernel-mismatch`。
 * 宁可超预算，也不许按一知半解的分段去砍人格。
 */

import { charCount } from './text.js'
import { SECTION_IDS } from './types.js'
import type {
  AssemblyReport,
  AssemblyUnit,
  AssembledPrompt,
  AssembledSection,
  Degradation,
  SectionId,
  TrimRecord,
} from './types.js'

/**
 * 段的中文名与段标题。
 *
 * 标题用「【】」而不是「##」：`##` 会被模型当成 markdown 结构，而这里是**指令分段**。
 * 人设包自己用 `##` 分章，两者混在一起会让模型以为这些是同一份文档的章节。
 */
const SECTION_META: Readonly<Record<SectionId, { readonly label: string; readonly heading: string }>> =
  Object.freeze({
    kernel: Object.freeze({ label: '人格内核', heading: '【人格内核】' }),
    relation: Object.freeze({ label: '关系微调', heading: '【关系】' }),
    tone: Object.freeze({ label: '说话浓度', heading: '【说话浓度】' }),
    boundaries: Object.freeze({ label: '边界', heading: '【不能越过的线】' }),
  })

/**
 * 保留优先级表（**数字越大越先保**）。
 *
 * 取值理由逐条：
 * - `identity 100`：她是谁。丢了这一段的后果不是「说得不像」，是「不是她」。
 * - `essence 95`：作者自己写的一句话内核（144–159 字），最小、最浓缩，几乎不占预算。
 * - `voice 90`：人设包原话是「Layer 2 · 说话（决定『像不像』的 80%）」。
 * - `format 75`：回复格式只有 190–291 字，但它管「分几条、多长」—— 短而决定观感。
 * - `selfcheck 65`：发出前五问，390–426 字。丢了会「像了但不收尾」。
 * - `relation 60`：关系微调约 200 字，只改称呼与节奏。**排在格式与自检之后**，
 *   是因为它改的是「怎么称呼」而不是「怎么说话」——称呼错了她仍是她。
 * - `drive 45`：驱动力 1.0k–2.4k 字，是长段落里最该先让位的（它解释「为什么」，
 *   而模型在预算紧张时更需要「怎么做」）。
 * - `scene 35`：场景与连续 556–1847 字，与人设相似度关系最远的一档。
 * - `tone 10`：**永远第一个被砍**。它是刻度不是人格；砍掉只是「回到默认浓淡」。
 */
export const UNIT_PRIORITY: ReadonlyMap<string, number> = new Map([
  ['slot:identity', 100],
  ['essence', 95],
  ['slot:voice', 90],
  ['slot:format', 75],
  ['slot:selfcheck', 65],
  ['relation', 60],
  ['slot:drive', 45],
  ['extra', 40],
  ['slot:scene', 35],
  ['tone', 10],
])

/** 未知槽位的兜底优先级（比 `tone` 高：没见过的槽位不该第一个被砍）。 */
const UNKNOWN_PRIORITY = 50

/**
 * 查一个单元的保留优先级。
 *
 * 用 `Map.get()` 而不是对象下标：`Record<string, number>` 的下标在无
 * `noUncheckedIndexedAccess` 时类型是 `number`（不含 undefined），
 * 于是 `?? 兜底` 会被 TS 判成「右操作数不可达」而报错——
 * 而这条兜底恰恰是「新人设包带来没见过的槽位」时必须生效的。
 * @param id 单元 id（`slot:voice` / `essence` / `tone` …）。
 */
export function priorityOf(id: string): number {
  return UNIT_PRIORITY.get(id) ?? UNKNOWN_PRIORITY
}

/**
 * 一个槽位单元。
 * @param id 槽位 id。
 * @param label 中文名。
 * @param order 段内顺序。
 * @param text 正文。
 */
export function slotUnit(id: string, label: string, order: number, text: string): AssemblyUnit {
  const unitId = 'slot:' + id
  return Object.freeze({
    id: unitId,
    section: 'kernel' as SectionId,
    label,
    priority: priorityOf(unitId),
    order,
    text,
    chars: charCount(text),
    // 槽位**不豁免**：内核 5.8k–8.6k 字，不裁就必然超预算（O-021 README 待裁决②）。
    exempt: false,
  })
}

/**
 * 整段内核作为一个不可裁单元（`kernel-mismatch` 时用）。
 * @param text 内核全文。
 */
export function kernelWholeUnit(text: string): AssemblyUnit {
  return Object.freeze({
    id: 'kernel:whole',
    section: 'kernel' as SectionId,
    label: '人格内核（整段）',
    priority: priorityOf('slot:identity'),
    order: 0,
    text,
    chars: charCount(text),
    exempt: true,
  })
}

/**
 * 未映射章节单元（O-021 的 `extras`，仅在 `includeExtras` 打开时出现）。
 *
 * 优先级 40：比 `scene`（35）高、比 `drive`（45）低——它是人设包作者多写的一段，
 * 内容未知，不该比六个正式槽位更优先，也不该比「浓度刻度」更容易被砍掉。
 * @param order 段内顺序。
 * @param text 正文。
 */
export function extraUnit(order: number, text: string): AssemblyUnit {
  return Object.freeze({
    id: 'extra:' + String(order),
    section: 'kernel' as SectionId,
    label: '未映射章节',
    priority: priorityOf('extra'),
    order,
    text,
    chars: charCount(text),
    exempt: false,
  })
}

/**
 * 关系单元。
 * @param text 关系段正文。
 */
export function relationUnit(text: string): AssemblyUnit {
  return Object.freeze({
    id: 'relation',
    section: 'relation' as SectionId,
    label: SECTION_META.relation.label,
    priority: priorityOf('relation'),
    order: 0,
    text,
    chars: charCount(text),
    exempt: false,
  })
}

/**
 * 浓度单元。
 * @param text 浓度段正文。
 */
export function toneUnit(text: string): AssemblyUnit {
  return Object.freeze({
    id: 'tone',
    section: 'tone' as SectionId,
    label: SECTION_META.tone.label,
    priority: priorityOf('tone'),
    order: 0,
    text,
    chars: charCount(text),
    exempt: false,
  })
}

/**
 * 边界单元。**恒 `exempt: true`**——这是硬规则，不给开关。
 * @param id 条目 id（`skill:3` / `meta:1`）。
 * @param text 条目原文。
 * @param order 段内顺序。
 * @param hard 是否硬约束（硬排前面）。
 */
export function boundaryUnit(id: string, text: string, order: number, hard: boolean): AssemblyUnit {
  return Object.freeze({
    id: 'boundary:' + id,
    section: 'boundaries' as SectionId,
    label: hard ? '红线' : '边界',
    // 边界层不参与装箱，priority 只是「同一段内的排序依据」——硬条目先排在前面。
    priority: hard ? 1000 : 900,
    order,
    text,
    chars: charCount(text),
    exempt: true,
  })
}

/**
 * 段标题（含「另有 N 段未展开」）。
 *
 * 手册 §2.6 的原话是「装不下的条数写在段标题里」，本插件把这条口径照抄到人格段：
 * 少了几段就写几段。**模型看得见，提示词预览也看得见。**
 * @param id 段 id。
 * @param dropped 这一段掉了几个单元。
 */
export function headingOf(id: SectionId, dropped: number): string {
  const base = SECTION_META[id].heading
  if (dropped <= 0) return base
  return base + '（另有 ' + String(dropped) + ' 段未展开）'
}

/** 装箱结果。 */
interface PackResult {
  /** 保住的单元（按段 id 分组）。 */
  readonly kept: ReadonlyMap<SectionId, readonly AssemblyUnit[]>
  /** 丢掉的全部单元。 */
  readonly dropped: readonly { readonly unit: AssemblyUnit; readonly reason: TrimRecord['reason'] }[]
  /** 段标题总字数。 */
  readonly headingChars: number
}

/**
 * 装箱。
 *
 * 两步，顺序不能换：
 * ① **逐条试装**（手册 §2.6 的装箱制）：按优先级降序，装不下就跳过这条、
 *    继续试下一条，不是整段停。这一步保证「短而关键的段落不被长段落挤掉」。
 * ② **段级单调**（本插件加的一条）：前面那段一段都没留下时，后面的段不许单独保留。
 *
 * 第②步为什么必须有：纯装箱制有个真实副作用——**短单元会插队**。剩余预算只够装
 * 98 字的浓度段、装不下 212 字的关系段时，「跳过继续试」会让浓度留下、关系掉光。
 * 结果是「她还在按你调的浓淡说话，却不知道自己跟你是谁」——而放弃顺序
 * （`tone` 优先级最低，本该第一个走）被静默违反了。
 *
 * 反过来也不行：预算 400 字时，内核（1200 字）装不下、关系（212 字）装得下，
 * 于是只剩一段「这一段只改你和他之间的关系，不改你是谁」——**它修饰的内核不在**，
 * 这句话没有指代对象。所以第②步只做一件事：**砍掉，不补回**。
 * 「砍掉不补回」是刻意的——补回就要再迭代，而迭代在极限预算下会把所有段都试空。
 *
 * 第②步是一次性判定、必然收敛，没有循环。
 * @param units 全部单元。
 * @param budgetChars 预算（字符）。
 * @param withHeading 是否给段加标题。
 */
export function pack(units: readonly AssemblyUnit[], budgetChars: number, withHeading: boolean): PackResult {
  let headingChars = 0
  let packResult: PackResult | undefined

  // 段标题的字数取决于「掉了几个单元」，而「掉了几个」又取决于预算剩多少——这是个环。
  // 做法是先假设没有标题挤一遍，再按算出来的标题长度重挤，最多三轮
  // （实测两轮内必收敛；三轮不收敛说明预算小于标题本身，那本来就不可能装下）。
  for (let round = 0; round < 3; round += 1) {
    const result = packOnce(units, budgetChars, withHeading, headingChars)
    packResult = result
    if (result.headingChars === headingChars) return result
    headingChars = result.headingChars
  }
  return packResult ?? emptyPack()
}

/** 空结果（预算小于全部标题时兜底）。 */
function emptyPack(): PackResult {
  const kept = new Map<SectionId, AssemblyUnit[]>()
  for (const id of SECTION_IDS) kept.set(id, [])
  return { kept, dropped: Object.freeze([]), headingChars: 0 }
}

/**
 * 单轮：逐条试装 + 段级单调。
 * @param units 全部单元。
 * @param budgetChars 预算（字符）。
 * @param withHeading 是否给段加标题。
 * @param headingChars 上一轮算出的标题字数（本轮从可用额度里预留）。
 */
function packOnce(
  units: readonly AssemblyUnit[],
  budgetChars: number,
  withHeading: boolean,
  headingChars: number,
): PackResult {
  // 豁免单元**永远在**，且**不占候选额度**。
  const exemptUnits = units.filter(unit => unit.exempt)
  const candidateUnits = units.filter(unit => !unit.exempt)

  // 候选按「优先级降序 → 段顺序 → 段内顺序」排。后两个键保证结果是确定的
  // （不依赖入参顺序），否则同一份输入两次拼装可能给出不同结果。
  const ordered = [...candidateUnits].sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority
    const leftSection = SECTION_IDS.indexOf(left.section)
    const rightSection = SECTION_IDS.indexOf(right.section)
    if (leftSection !== rightSection) return leftSection - rightSection
    return left.order - right.order
  })

  const available = budgetChars - (withHeading ? headingChars : 0)
  const kept = new Map<SectionId, AssemblyUnit[]>()
  for (const id of SECTION_IDS) kept.set(id, [])
  const dropped: { unit: AssemblyUnit; reason: TrimRecord['reason'] }[] = []

  // ① 豁免单元先全部收下，**且不占候选额度**。
  //    这是「边界层整层豁免」的准确含义：它不是「优先级最高的候选」，
  //    而是「根本不参与装箱」。让它在候选额度里扣，会让 1415 字的一层红线
  //    把内核挤到只剩一千字——那等于用「保护红线」的方式毁掉人格。
  //    它带来的超支由 `overBudget` 与 `exemptChars` 如实报出来。
  for (const unit of exemptUnits) {
    const bucket = kept.get(unit.section)
    if (bucket !== undefined) bucket.push(unit)
  }

  // ② 候选按优先级逐条试装，装不下跳过继续试下一条。
  let used = 0
  for (const unit of ordered) {
    if (used + unit.chars > available) {
      dropped.push({ unit, reason: 'over-budget' })
      continue
    }
    used += unit.chars
    const bucket = kept.get(unit.section)
    if (bucket !== undefined) bucket.push(unit)
  }

  // ③ 段级单调：前面那段一段都没留下，后面那段就不许单独保留。
  const emptyIndex = firstEmptyCandidateSection(kept, candidateUnits)
  if (emptyIndex >= 0) {
    for (let index = emptyIndex + 1; index < SECTION_IDS.length; index += 1) {
      const id = SECTION_IDS[index]
      if (id === undefined) continue
      const bucket = kept.get(id)
      if (bucket === undefined || bucket.length === 0) continue
      for (const unit of [...bucket]) {
        if (unit.exempt) continue
        bucket.splice(bucket.indexOf(unit), 1)
        dropped.push({ unit, reason: 'inversion' })
      }
    }
  }

  // 段内重排：装箱顺序是优先级顺序，输出必须是段内顺序。
  for (const [, bucket] of kept) bucket.sort((left, right) => left.order - right.order)

  const droppedBySection = new Map<SectionId, number>()
  for (const item of dropped) {
    droppedBySection.set(item.unit.section, (droppedBySection.get(item.unit.section) ?? 0) + 1)
  }
  let nextHeadingChars = 0
  if (withHeading) {
    for (const id of SECTION_IDS) {
      const bucket = kept.get(id) ?? []
      // 空段不出标题：出了就是「【关系】（另有 1 段未展开）」这种把空话算进预算的写法。
      if (bucket.length === 0) continue
      nextHeadingChars += charCount(headingOf(id, droppedBySection.get(id) ?? 0))
    }
  }

  return {
    kept,
    dropped: Object.freeze(dropped.map(item => Object.freeze(item))),
    headingChars: nextHeadingChars,
  }
}

/**
 * 找出第一个「有候选却一个都没留下」的段。
 *
 * 只看**非豁免**候选：边界层豁免之后，就算它一条都没装（被 `empty` 清空），
 * 也不该让后面的段跟着倒霉——而它本来就是最后一段，没有「后面」。
 * @param kept 已保留的单元。
 * @param candidates 全部候选（不含豁免）。
 */
function firstEmptyCandidateSection(
  kept: ReadonlyMap<SectionId, readonly AssemblyUnit[]>,
  candidates: readonly AssemblyUnit[],
): number {
  const hasCandidate = new Set<SectionId>()
  for (const unit of candidates) hasCandidate.add(unit.section)
  for (let index = 0; index < SECTION_IDS.length; index += 1) {
    const id = SECTION_IDS[index]
    if (id === undefined) continue
    if (!hasCandidate.has(id)) continue
    const bucket = kept.get(id) ?? []
    if (bucket.length === 0) return index
  }
  return -1
}

/** 拼装函数入参。 */
export interface ComposeAssemblyInput {
  /** 全部单元。 */
  readonly units: readonly AssemblyUnit[]
  /** 预算（字符）。 */
  readonly budgetChars: number
  /** 是否加段标题。 */
  readonly includeHeadings: boolean
  /** 缺了哪几个槽位。 */
  readonly missingSlots: readonly string[]
  /** 是否含未映射章节。 */
  readonly hasExtras: boolean
  /** 上游降级说明（`no-vars` 一类）。 */
  readonly degradations: readonly Degradation[]
}

/**
 * 把单元拼成四段 + 报告。
 * @param input 入参。
 */
export function composeAssembly(input: ComposeAssemblyInput): AssembledPrompt {
  const packed = pack(input.units, input.budgetChars, input.includeHeadings)
  const degraded: Degradation[] = [...input.degradations]

  const sections: AssembledSection[] = SECTION_IDS.map((id, order) => {
    const bucket = packed.kept.get(id) ?? []
    const droppedInSection = packed.dropped.filter(item => item.unit.section === id)
    const exempt = bucket.length > 0 && bucket.every(unit => unit.exempt)
    const body = bucket.map(unit => unit.text).filter(text => text !== '').join('\n\n')
    const heading = bucket.length === 0 || !input.includeHeadings ? '' : headingOf(id, droppedInSection.length)
    return Object.freeze({
      id,
      order,
      heading,
      text: body,
      // 标题为空时**不能**算成 0：`includeHeadings: false` 下正文仍然存在，
      // 而 `chars` 是 `lastSectionChars` 与 `exemptChars` 的唯一来源——
      // 算成 0 会让「边界层单独就超了预算」这条判断永远不成立（假阴性）。
      chars: charCount(heading === '' ? body : heading + '\n' + body),
      units: bucket.length,
      dropped: droppedInSection.length,
      exempt,
    })
  })

  // 整段正文：段之间空一行。空段完全跳过（连标题都不出，见 pack 的同一取舍）。
  const text = sections
    .filter(section => section.text !== '')
    .map(section => (section.heading === '' ? section.text : section.heading + '\n' + section.text))
    .join('\n\n')

  const usedChars = charCount(text)
  const exemptChars = sections
    .filter(section => section.id === 'boundaries')
    .reduce((sum, section) => sum + section.chars, 0)
  const budgetChars = input.budgetChars
  const overBudget = usedChars > budgetChars
  const dropped: TrimRecord[] = packed.dropped.map(item =>
    Object.freeze({
      unitId: item.unit.id,
      section: item.unit.section,
      label: item.unit.label,
      chars: item.unit.chars,
      reason: item.reason,
    }),
  )

  const byBudget = dropped.filter(item => item.reason === 'over-budget')
  const byInversion = dropped.filter(item => item.reason === 'inversion')
  if (byBudget.length > 0) {
    degraded.push(
      Object.freeze({
        kind: 'over-budget' as const,
        note:
          '预算 ' +
          String(budgetChars) +
          ' 字符装不下，' +
          String(byBudget.length) +
          ' 段未展开（' +
          byBudget.map(item => item.label).join(' / ') +
          '）——已写进段标题，模型看得见',
      }),
    )
  }
  if (byInversion.length > 0) {
    // 这条与「预算不够」分开说：它是**放弃顺序在起作用**（后面那段没留下，
    // 前面这段就不许留）。混进上一条会让人以为「再加点预算就好了」，
    // 而实际上加预算未必能解决——真正该动的是 `UNIT_PRIORITY`。
    degraded.push(
      Object.freeze({
        kind: 'over-budget' as const,
        note:
          '为纠正段级倒置放弃了 ' +
          String(byInversion.length) +
          ' 段（' +
          byInversion.map(item => item.label).join(' / ') +
          '）：更靠前的段一段都没留下时，后面的段不许单独保留',
      }),
    )
  }
  if (exemptChars > budgetChars) {
    degraded.push(
      Object.freeze({
        kind: 'boundary-exempt' as const,
        note: '边界层单独就占 ' + String(exemptChars) + ' 字符，已超过预算 ' + String(budgetChars) + '；仍整层带上，不砍任何一条禁令',
      }),
    )
  }

  const report: AssemblyReport = Object.freeze({
    budgetChars,
    usedChars,
    remainingChars: budgetChars - usedChars,
    overBudget,
    exemptChars,
    droppedCount: dropped.length,
    dropped: Object.freeze(dropped),
    missingSlots: input.missingSlots,
    degradations: Object.freeze(degraded),
    hasExtras: input.hasExtras,
  })

  return Object.freeze({
    sections: Object.freeze(sections),
    text,
    chars: usedChars,
    report,
  })
}

/**
 * 空拼装结果（上游缺席时用）。
 *
 * 返回**四段都在但都为空**的结果，而不是 `undefined`：调用方少判一次空，
 * 且 `sections.length` 恒为 4——「段没了」与「段是空的」在下游要能区分，
 * 而长度变化是最容易被误读成「插件没加载」的形态。
 * @param budgetChars 预算。
 * @param degradations 降级说明。
 */
export function emptyAssembly(budgetChars: number, degradations: readonly Degradation[]): AssembledPrompt {
  const sections: AssembledSection[] = SECTION_IDS.map((id, order) =>
    Object.freeze({
      id,
      order,
      heading: '',
      text: '',
      chars: 0,
      units: 0,
      dropped: 0,
      exempt: id === 'boundaries',
    }),
  )
  return Object.freeze({
    sections: Object.freeze(sections),
    text: '',
    chars: 0,
    report: Object.freeze({
      budgetChars,
      usedChars: 0,
      remainingChars: budgetChars,
      overBudget: false,
      exemptChars: 0,
      droppedCount: 0,
      dropped: Object.freeze([]),
      missingSlots: Object.freeze([]),
      degradations: Object.freeze([...degradations]),
      hasExtras: false,
    }),
  })
}
