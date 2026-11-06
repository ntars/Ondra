/**
 * 「为什么她记不清了」的人话解释（**纯函数，不碰 ctx、不碰库、不算公式**）。
 *
 * 这个文件只做一件事：把 O-010 已经算好的字段**翻译成句子**。
 * 它不乘、不除、不开方——一个公式都不写。原因很直接：
 *
 * > 一旦这里出现 `Math.pow(0.5, elapsed / S)`，就有了第二份强度公式。
 * > 改参数时改一处，另一处继续用旧参数，而且**不会报错**，
 * > 表现是「面板说还剩 3 天、实际第二天就淡没了」。
 *
 * 所以 `reasons` 里的每一句都只由两类事实构成：
 * - **输入**：`category`（哪一类）、`timesSaid`（提过几次）、`hits`（命中几次）、
 *   `revisions`（订正几次）、`salience`、`arousal`；
 * - **结果**：`stabilityBaseHours`（基线）、`stabilityHours`（当前）、
 *   `remainingHours`（还剩多久）、`strength`（当前强度）。
 *
 * 刻意**不写**的三类句子：
 * 1. 不写「强度低于 0.4 所以只剩影子」——0.4 / 0.7 是 **O-013 的话术阈值**，
 *    在这里再说一遍就是第二份阈值（产品调成 0.65 时，一半界面还在说 0.4）。
 * 2. 不写「显著度系数 1.575」——那是因子数值，本插件没有它（见 types.ts 文件头第 1 条）。
 * 3. 不写「她忘了」——`archived` 是「沉底」不是「忘了」，措辞错了比数字错了更伤人。
 */

import type { MemoryRecordLike } from './types.js'

/**
 * 11 类寿命类别的**中文名**（只有名字，**没有数值**）。
 *
 * 数值（2h / 3h / … / 20000h）的唯一真源是 O-010 的 `STABILITY_BASE_HOURS`。
 * 这里抄一份数字就等于抄了一份公式——而这一层的用途只是「把 watch 说成看片」。
 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  watch: '看片',
  daily: '日常',
  food: '吃',
  place: '地方',
  misc: '杂项',
  event: '事件',
  feeling: '情绪',
  study: '学习',
  person: '人',
  promise: '约定',
  self: '自我',
})

/**
 * 类别中文名。认不出的类别原样返回（**不猜**）。
 * @param category 类别键。
 */
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category
}

/**
 * 正文预览（**只用于清单展示，绝不回写**）。
 *
 * 截断时补一个省略号。这里可以截断，是因为它只出现在清单里；
 * 而 `ExplainView.text` 必须原样——裁剪正文会让「为什么记不清」
 * 变成「为什么记错了」。
 * @param text 正文。
 * @param chars 最多几个字。
 */
export function previewOf(text: string, chars: number): string {
  const body = typeof text === 'string' ? text.trim() : ''
  const units = Array.from(body)
  if (units.length <= chars) return body
  return `${units.slice(0, Math.max(1, chars)).join('')}…`
}

/** 把小时数说成人话（`<1` 小时说「不到一小时」，`>48` 说「N 天」）。 */
function humanHours(hours: number): string {
  if (!Number.isFinite(hours)) return '很久'
  if (hours <= 0) return '已经到底了'
  if (hours < 1) return '不到一小时'
  if (hours < 48) return `${Math.round(hours)} 小时`
  return `${Math.round(hours / 24)} 天`
}

/** 把时间差说成人话。 */
function humanAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '刚刚'
  const hours = ms / (60 * 60 * 1000)
  if (hours < 1) return '不到一小时前'
  if (hours < 48) return `${Math.round(hours)} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/**
 * 逐条解释。**顺序即重要性**：先说「它本来能活多久」，再说「为什么现在这样」。
 * @param input 记录、强度结果、是否钉住、当前时刻、以及「快淡了」的窗口（**毫秒**）。
 */
export function reasonsOf(input: {
  readonly record: MemoryRecordLike
  readonly strength: number
  readonly remainingHours: number
  readonly pinned: boolean
  readonly at: number
  readonly fadingWindowMs: number
}): string[] {
  const { record, strength, remainingHours, pinned, at, fadingWindowMs } = input
  const reasons: string[] = []

  // 1. 类别：这是「寿命的起点」，也是用户最容易忽略的一条。
  reasons.push(
    `它属于「${categoryLabel(record.category)}」这一类，基线寿命 ${humanHours(record.stabilityBaseHours)}。`,
  )

  // 2. 基线 → 当前：只报两个数，不报中间的因子。数值差本身就是解释。
  if (record.stabilityHours !== record.stabilityBaseHours) {
    reasons.push(
      `当前寿命是 ${humanHours(record.stabilityHours)}（基线 ${humanHours(record.stabilityBaseHours)}），差额来自被提起、被命中与订正。`,
    )
  }

  // 3. 提及：写入那一次不算「反复提起」，所以 ≤1 就是「没再提过」。
  if (record.timesSaid <= 1) {
    reasons.push('写下来之后没再被提起过，所以没有额外加成。')
  } else {
    reasons.push(`被提起过 ${record.timesSaid} 次，每提一次都会让它衰减得更慢一点。`)
  }

  // 4. 命中：这是「想起来」的痕迹，与「被提起」是两回事。
  if (record.hits <= 0) {
    reasons.push('从没被检索命中过——也就是说，这段时间里她一次都没想起过它。')
  } else {
    reasons.push(`被检索命中过 ${record.hits} 次。`)
  }

  // 5. 订正：会乘 1.3，是唯一「越改越牢」的机制。
  if (record.revisions > 0) {
    reasons.push(`订正过 ${record.revisions} 次，每次订正都会把寿命拉长一些。`)
  }

  // 6. 状态：三个状态的说法必须准确，不能都说成「忘了」。
  if (record.sealed) {
    reasons.push('已封存：不主动注入、不参与回忆，但按类检索仍能翻到，到期只归档。')
  } else if (record.archived) {
    reasons.push('已沉底：不再占主动位，但**没有被删**，按类检索仍能翻到。')
  }

  // 7. 钉子：解释「为什么它明明很淡却还在」。
  if (pinned) {
    reasons.push('被钉住了：每一轮都会进注入，也不会被自动沉底。')
  }

  // 8. 剩余：用本插件自己的 `fadingDays` 窗口，**不借用强度阈值**。
  if (!record.archived && !record.sealed) {
    if (remainingHours <= 0) {
      reasons.push('强度已经掉到地板了，只剩下一点点余光。')
    } else if (remainingHours * 60 * 60 * 1000 <= fadingWindowMs) {
      reasons.push(`还剩 ${humanHours(remainingHours)} 就会掉到地板。`)
    }
  }

  // 9. 最近一次被带出：这是「她最近有没有想起它」的直接证据。
  if (record.lastSeenAt > 0) {
    reasons.push(`上次被带出是 ${humanAgo(at - record.lastSeenAt)}。`)
  }

  // 10. 强度只用来说「还剩多少」，不做档位判定（档位归 O-013）。
  reasons.push(`当前强度 ${strength.toFixed(2)}（0 是完全淡掉，1 是刚写下来）。`)

  return reasons
}
