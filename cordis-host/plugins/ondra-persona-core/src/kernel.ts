/**
 * 内核装配：把一份 `SKILL.md` 的切分结果变成 `KernelView`，并出边界 / 索引 / 激活。
 *
 * 三条边界，写在这里防止下一轮有人「顺手优化」：
 *
 * 1. **不改写正文。** `kernelTextOf()` 只做「按顺序拼接」，不删标点、不改小标题、
 *    不合并重复句。人设正文是产品资产，改一个字就再也说不清
 *    「这句是她原本的设定，还是插件作者加的」。
 * 2. **不裁剪。** 没有 `maxChars` 参数。裁剪归 O-023（四段拼装 + `overBudget`），
 *    这里多一个上限就是第二套预算，而两套预算打架时没人查得出来。
 * 3. **缺槽位留空，不顶替。** 找不到就是 `text: ''` + `found: false`，
 *    绝不拿别的段落补位——补出来的一定是「一个很像 AI 助手的人」。
 */

import { layoutOf, splitItems } from './slots.js'
import type { SkillLayout } from './slots.js'
import type {
  ActivationView,
  BoundaryItem,
  KernelView,
  PersonaDetailLike,
  ReferenceEntry,
  SlotId,
} from './types.js'

/** 包内运行入口文件名（与 O-020 的 `SKILL_FILE` 同值，镜像理由见文件末尾）。 */
export const SKILL_FILE = 'SKILL.md'

/** 边界条目拆分结果。 */
export interface BoundarySplit {
  /** 实际返回的条目。 */
  readonly items: readonly BoundaryItem[]
  /** 拆出来的总条数（可能大于 `items.length`）。 */
  readonly total: number
}

/**
 * 由 `SKILL.md` 文本建内核视图。
 * @param personaId 人设 id。
 * @param personaVersion 人设版本（缓存键的一部分）。
 * @param skillText `SKILL.md` 原文。
 * @param sourceBytes `SKILL.md` 的字节数。
 */
export function buildKernel(
  personaId: string,
  personaVersion: string,
  skillText: string,
  sourceBytes: number,
): KernelView {
  return kernelOfLayout(personaId, personaVersion, layoutOf(skillText), sourceBytes)
}

/**
 * 由已切好的布局建内核视图（`service.ts` 已经切过一次时用这个，省一次切分）。
 * @param personaId 人设 id。
 * @param personaVersion 人设版本。
 * @param layout 切分结果。
 * @param sourceBytes 字节数。
 */
export function kernelOfLayout(
  personaId: string,
  personaVersion: string,
  layout: SkillLayout,
  sourceBytes: number,
): KernelView {
  const missing: SlotId[] = layout.slots.filter(slot => !slot.found).map(slot => slot.id)
  const essenceChars = layout.preface === undefined ? 0 : layout.preface.chars
  const slotChars = layout.slots.reduce((sum, slot) => sum + slot.chars, 0)
  return Object.freeze({
    personaId,
    personaVersion,
    essence: layout.preface,
    slots: layout.slots,
    extras: layout.extras,
    chars: essenceChars + slotChars,
    missing: Object.freeze(missing),
    complete: missing.length === 0,
    sourceBytes,
  })
}

/**
 * 拼内核正文：引言块 + 六个槽位，按顺序、以空行分隔。
 *
 * 段与段之间用两个换行：人设包自己的写法就是空行分段，而单换行会让
 * 「4.1 三条硬指标」与「4.2 句式九类」贴在一起，模型会把它们读成同一条。
 * @param view 内核视图。
 * @param includeExtras 是否把未映射章节接在最后。
 */
export function kernelTextOf(view: KernelView, includeExtras: boolean): string {
  const parts: string[] = []
  if (view.essence !== undefined) parts.push(view.essence.text)
  for (const slot of view.slots) {
    if (slot.found) parts.push(slot.text)
  }
  if (includeExtras) {
    for (const extra of view.extras) parts.push(extra.text)
  }
  return parts.join('\n\n')
}

/** 标题是否属于「诚实边界」类（软约束）。 */
function isSoftBoundary(heading: string): boolean {
  return heading.includes('诚实')
}

/**
 * 抽边界条目。
 *
 * 四个来源、两种硬度：
 * - `SKILL.md` 的「硬规则」「红线」→ **硬**；
 * - `SKILL.md` 的「诚实边界」→ **软**（它是「我是什么、我不是什么」的声明，
 *   不是禁令；当成硬约束会让模型在闲聊里也反复声明「我是虚构角色」）；
 * - `meta.safety.red_lines` → **硬**（作者自己列的、最该被闸门读到的那几条）。
 * @param layout 切分结果。
 * @param safety `meta.safety`。
 * @param limit 条目上限。
 */
export function boundaryItemsOf(
  layout: SkillLayout,
  safety: Readonly<Record<string, unknown>>,
  limit: number,
): BoundarySplit {
  const seen = new Set<string>()
  const items: BoundaryItem[] = []
  let total = 0
  let counter = 0

  /** 收一条（去重、超限只计数）。 */
  const push = (text: string, hard: boolean, source: 'skill' | 'meta'): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    total += 1
    // 去重键去掉全部空白：人设包里同一条红线常在两处出现（硬规则 + 红线），
    // 只差一个空格或换行。不去重的话闸门的指令块里会出现两遍同一句。
    const key = trimmed.replace(/\s+/g, '')
    if (seen.has(key)) return
    seen.add(key)
    if (items.length >= limit) return
    counter += 1
    items.push(Object.freeze({ id: source + ':' + String(counter), text: trimmed, hard, source }))
  }

  // 先收 `meta.safety.red_lines`：那是作者逐条列出来的红线，最短、最硬、最该排前面。
  const redLines = safety['red_lines']
  if (Array.isArray(redLines)) {
    for (const line of redLines) {
      if (typeof line !== 'string') continue
      push(line, true, 'meta')
    }
  }

  for (const slice of layout.boundaries) {
    const hard = !isSoftBoundary(slice.heading)
    for (const part of splitItems(slice.text, limit)) {
      push(part, hard, 'skill')
    }
  }

  return { items: Object.freeze(items), total }
}

/**
 * 渐进披露索引：包内文件 + 作者在 `meta.files` 里写的说明。
 *
 * 已声明的排前面（作者认为该按需读的），未声明的排后面但**不丢**——
 * 「作者没写说明的文件」不等于「不该被读」。
 * @param detail 人设详情。
 */
export function referenceEntriesOf(detail: PersonaDetailLike): readonly ReferenceEntry[] {
  const entries: ReferenceEntry[] = detail.files.map(file =>
    Object.freeze({
      path: file.path,
      doc: detail.declaredFiles[file.path] ?? '',
      bytes: file.bytes,
    }),
  )
  entries.sort((left, right) => {
    const leftRank = left.doc === '' ? 1 : 0
    const rightRank = right.doc === '' ? 1 : 0
    if (leftRank !== rightRank) return leftRank - rightRank
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
  return Object.freeze(entries)
}

/**
 * 激活规则：触发词（来自 `meta`）+ 「激活与退出」章节正文。
 * @param detail 人设详情。
 * @param layout 切分结果。
 */
export function activationOf(detail: PersonaDetailLike, layout: SkillLayout): ActivationView {
  const text = layout.activation.map(slice => slice.text).join('\n\n')
  return Object.freeze({
    triggerWords: detail.triggerWords,
    text,
    chars: Array.from(text).length,
  })
}

/* ------------------------------------------------------------------ *
 * 镜像纪律
 *
 * `SKILL_FILE` 与 O-020 `scan.ts` 的 `SKILL_FILE` 必须同值（都是 `SKILL.md`）。
 * 不 import 是因为 §18.5 禁止同轮互相 import；这条常量几乎不会变一次，
 * 而它一旦变了，`readText(id, 'SKILL.md')` 会返回 `undefined`，
 * `service.ts` 会把它报成 `no-skill`——**不会静默出错**，这是允许镜像的前提。
 * ------------------------------------------------------------------ */
