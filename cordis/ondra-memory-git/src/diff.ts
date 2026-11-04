/**
 * 纯函数层：阶段判定、预览截断、差异计算。
 *
 * 这一层**不碰服务、不碰文件、不碰时间**（时刻从参数进来），因此可以单独核对。
 *
 * ## 为什么差异用「字符级 LCS」而不是「按行」
 *
 * git 的 diff 是按行的，因为代码一行一行写。记忆正文是一段连续的中文句子，
 * 换行可有可无——按行比对会把「只改了一个词」判成「整行删掉 + 整行新增」，
 * 那是**最没用的差异**：用户看到的是一片红一片绿，却不知道改了什么。
 * 故这里按 Unicode 码点切分后做最长公共子序列，得到的是「哪几个字变了」。
 *
 * 中文没有词边界，按字符比对在中文上恰好是对的；对英文会出现「半个单词」的
 * 片段（例如 `hel` + `lo`），但记忆正文以中文为主，且半个单词仍比整行替换可读。
 */

import { MEMORY_STAGES } from './types.js'
import type { DiffHunk, DiffResult, MemoryRecordLike, MemoryStage } from './types.js'

/** 差异算法允许的最大单元格数。超过就不做 LCS，退化成「整体替换」。 */
const MAX_CELLS = 400_000

/** 按 Unicode 码点切分（`[...str]` 会把代理对当一个字符，中文与 emoji 都对）。 */
function charsOf(text: string): string[] {
  return [...text]
}

/**
 * 判定一条记忆处于哪个阶段。
 *
 * **封存优先于沉底**：两者可能同时为真（O-010 的两个独立布尔位），
 * 而封存是更强的意愿表达。取沉底会让「我明明封存了它」变成「它只是沉底了」。
 * @param record 记录。
 * @returns 阶段。
 */
export function stageOf(record: MemoryRecordLike): MemoryStage {
  if (record.sealed) return 'sealed'
  if (record.archived) return 'archived'
  return 'active'
}

/** 阶段中文名。未知阶段退成 id 本身，不编一个新名字。 */
export function stageZhOf(stage: MemoryStage): string {
  switch (stage) {
    case 'active':
      return '活跃'
    case 'archived':
      return '沉底'
    case 'sealed':
      return '封存'
    case 'forgotten':
      return '已遗忘'
    default:
      return stage
  }
}

/** 阶段是否在闭集内（读存档与外部输入时用）。 */
export function isStage(value: unknown): value is MemoryStage {
  return MEMORY_STAGES.some(item => item === value)
}

/**
 * 截一段正文预览。
 *
 * 两点刻意：
 * 1. **按码点截**，不按 `slice()` 的 UTF-16 单元——否则会把 emoji 劈成乱码；
 * 2. **把换行压成空格**：清单是一行一项，正文里的换行会把布局撑坏。
 * @param text 正文。
 * @param limit 最多几个字。
 */
export function previewOf(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (limit <= 0) return ''
  const chars = charsOf(flat)
  if (chars.length <= limit) return flat
  return chars.slice(0, limit).join('') + '…'
}

/**
 * 最长公共子序列的片段表（纯函数）。
 *
 * 返回的片段按原文顺序，`equal` / `delete` 来自旧文、`insert` 来自新文。
 * @param from 旧文。
 * @param to 新文。
 */
function lcsHunks(from: string, to: string): DiffHunk[] {
  const a = charsOf(from)
  const b = charsOf(to)

  // 超长直接退化成「全删 + 全增」：这不是偷懒，是承认「这次差异没法逐字看」。
  // 返回一条假的分词结果比返回「整体替换」更糟——用户会以为真的只改了这些。
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    const out: DiffHunk[] = []
    if (from !== '') out.push({ kind: 'delete', text: from })
    if (to !== '') out.push({ kind: 'insert', text: to })
    return out
  }

  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度。倒着填，回溯时正着读。
  const width = b.length + 1
  const dp = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const here = i * width + j
      if (a[i] === b[j]) {
        dp[here] = (dp[(i + 1) * width + (j + 1)] as number) + 1
      } else {
        const down = dp[(i + 1) * width + j] as number
        const right = dp[i * width + (j + 1)] as number
        dp[here] = down >= right ? down : right
      }
    }
  }

  const raw: DiffHunk[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      raw.push({ kind: 'equal', text: a[i] as string })
      i += 1
      j += 1
    } else if ((dp[(i + 1) * width + j] as number) >= (dp[i * width + (j + 1)] as number)) {
      raw.push({ kind: 'delete', text: a[i] as string })
      i += 1
    } else {
      raw.push({ kind: 'insert', text: b[j] as string })
      j += 1
    }
  }
  while (i < a.length) {
    raw.push({ kind: 'delete', text: a[i] as string })
    i += 1
  }
  while (j < b.length) {
    raw.push({ kind: 'insert', text: b[j] as string })
    j += 1
  }

  return mergeHunks(raw)
}

/**
 * 把同类的相邻片段合并成一段。
 *
 * 不合并的话，「改了三个字」会返回三个 `delete` 与三个 `insert` 片段，
 * 界面上就是六段碎片——读的人得自己在脑子里拼回去。
 * @param raw 逐字片段。
 */
function mergeHunks(raw: readonly DiffHunk[]): DiffHunk[] {
  const out: DiffHunk[] = []
  for (const hunk of raw) {
    const last = out[out.length - 1]
    if (last !== undefined && last.kind === hunk.kind) {
      out[out.length - 1] = { kind: last.kind, text: last.text + hunk.text }
      continue
    }
    out.push({ kind: hunk.kind, text: hunk.text })
  }
  return out
}

/**
 * 算一条记忆最近一次订正的差异。**纯函数**：不写库、不落盘、不读时间。
 *
 * @param record 记录。
 * @param limit 最多比对多少个字符。
 * @param at 计算时刻（写进结果，便于界面显示「这是什么时候算的」）。
 * @returns 没有上一版正文时 `undefined`。
 */
export function diffOf(record: MemoryRecordLike, limit: number, at: number): DiffResult | undefined {
  const previous = record.oldText
  if (previous === null || previous.trim() === '') return undefined

  const fromChars = charsOf(previous)
  const toChars = charsOf(record.text)
  const truncated = fromChars.length > limit || toChars.length > limit
  const from = truncated ? fromChars.slice(0, limit).join('') : previous
  const to = truncated ? toChars.slice(0, limit).join('') : record.text

  const hunks = lcsHunks(from, to)
  let insertedChars = 0
  let deletedChars = 0
  for (const hunk of hunks) {
    if (hunk.kind === 'insert') insertedChars += charsOf(hunk.text).length
    if (hunk.kind === 'delete') deletedChars += charsOf(hunk.text).length
  }

  return Object.freeze({
    id: record.id,
    from,
    to,
    hunks: Object.freeze(hunks),
    insertedChars,
    deletedChars,
    truncated,
    at,
  })
}

/**
 * 版本深度 = `revisions + 1`。
 *
 * 订正 0 次时深度为 1（只有初版）。负数（手改库）夹到 0 后再 +1，不让它变负。
 * @param revisions 订正次数。
 */
export function depthOf(revisions: number): number {
  if (!Number.isFinite(revisions)) return 1
  const safe = Math.max(0, Math.trunc(revisions))
  return safe + 1
}
