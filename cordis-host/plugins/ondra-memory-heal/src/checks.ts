/**
 * 巡检的判定层：**纯函数**，不碰服务、不碰文件、不读时间。
 *
 * 这样设计的目的只有一个：**每一类判定都能单独核对**。
 * 自愈插件最容易犯的错是「把判定和修复写在一个循环里」，于是没人能说清
 * 「它到底按什么标准算问题」。这里把标准全放在这个文件，修不修在别处决定。
 *
 * ## 几条刻意的判定口径
 *
 * 1. **同一 `code + id` 只报一次。** 钉子表里若有重复行，报两条会让人以为
 *    有两条问题，修完一条还剩一条，观感像「修不好」。
 * 2. **`advise` 档也照报。** 修不了不等于不该说——但它们在 `plan()` 里
 *    `planned` 恒为 `false`，永远不会被自动执行。
 * 3. **`detail` 允许带数字。** 体检报告不是对话话术，内感受铁律（不报数）
 *    约束的是她嘴里说的话，不是体检清单。清单不给数就没法核对。
 */

import {
  FINDING_SPECS,
  PIN_WARN_LIMIT,
  REPAIR_TIERS,
  SUMMARY_MIN_CHARS,
} from './types.js'
import type { Finding, FindingCode, MemoryRecordLike, RepairTier, StrengthLike } from './types.js'

/** 按码点算去空白后的长度（不用 `String.length`，那是 UTF-16 单元数）。 */
function charCount(text: string): number {
  return [...text.replace(/\s+/g, '')].length
}

/** 一条记忆的人话指代：只用 id 与长度，**不引正文**（体检清单不搬运内容）。 */
function refOf(record: MemoryRecordLike): string {
  return `${record.id}（${charCount(record.text)} 字）`
}

/**
 * 钉子指向的记忆已不存在。
 * @param pins 钉子清单。
 * @param exists 记忆是否还在（由调用方用 `getFact()` 实现）。
 */
export function danglingPinsOf(
  pins: readonly { readonly id: string; readonly note: string }[],
  exists: (id: string) => boolean,
): Finding[] {
  const out: Finding[] = []
  for (const pin of pins) {
    if (exists(pin.id)) continue
    out.push({
      code: 'dangling-pin',
      tier: FINDING_SPECS['dangling-pin'].tier,
      id: pin.id,
      detail: `钉子 ${pin.id} 指向的记忆已不存在${pin.note === '' ? '' : `（备注：${pin.note}）`}`,
      action: FINDING_SPECS['dangling-pin'].action,
    })
  }
  return out
}

/**
 * 活着的记忆正文已被墓碑覆盖。
 *
 * **只查活跃与沉底的记录**：已封存的本来就「收起来了」，再报出来只会让人
 * 去动一条他自己封存的东西。
 * @param records 待查记录。
 * @param tombstoned 正文是否在墓碑里。
 */
export function tombstoneLeaksOf(
  records: readonly MemoryRecordLike[],
  tombstoned: (text: string) => boolean,
): Finding[] {
  const out: Finding[] = []
  for (const record of records) {
    if (record.sealed) continue
    if (record.text.trim() === '') continue
    if (!tombstoned(record.text)) continue
    out.push({
      code: 'tombstone-leak',
      tier: FINDING_SPECS['tombstone-leak'].tier,
      id: record.id,
      detail: `${refOf(record)} 的内容在墓碑里，但还有一条活着的同内容记录`,
      action: FINDING_SPECS['tombstone-leak'].action,
    })
  }
  return out
}

/**
 * 最低曝光候选里指向已消失的记忆。
 *
 * 这一档是 `advise`：它下一次扫描自己就没了，给人报出来只是让他别困惑。
 * @param ids 待曝光 id 清单。
 * @param exists 记忆是否还在。
 */
export function resurfaceGhostsOf(ids: readonly string[], exists: (id: string) => boolean): Finding[] {
  const out: Finding[] = []
  for (const id of ids) {
    if (exists(id)) continue
    out.push({
      code: 'resurface-ghost',
      tier: FINDING_SPECS['resurface-ghost'].tier,
      id,
      detail: `待补曝光的 ${id} 已不存在（下一轮扫描会自动消失，不用动手）`,
      action: null,
    })
  }
  return out
}

/**
 * 活跃记忆强度归零却未沉底。
 *
 * 「归零」的判据是 `remainingHours <= 0`，不是 `strength === 0`：
 * 强度有地板（`floorWeight`，默认 0.01），**到底不等于 0**（只忘不删），
 * 拿 `strength === 0` 当条件会永远查不到东西。
 * @param records 待查记录。
 * @param strengthOf 算强度。
 */
export function zeroStrengthOf(
  records: readonly MemoryRecordLike[],
  strengthOf: (record: MemoryRecordLike) => StrengthLike | undefined,
): Finding[] {
  const out: Finding[] = []
  for (const record of records) {
    if (record.archived || record.sealed) continue
    const view = strengthOf(record)
    if (view === undefined) continue
    if (view.remainingHours > 0) continue
    out.push({
      code: 'zero-strength',
      tier: FINDING_SPECS['zero-strength'].tier,
      id: record.id,
      detail: `${refOf(record)} 已掉到强度地板（剩余 0 小时）却仍是活跃态`,
      action: null,
    })
  }
  return out
}

/**
 * 正文够长但摘要为空。
 * @param records 待查记录。
 */
export function emptySummariesOf(records: readonly MemoryRecordLike[]): Finding[] {
  const out: Finding[] = []
  for (const record of records) {
    const summary = record.summary
    if (summary !== null && summary.trim() !== '') continue
    if (charCount(record.text) < SUMMARY_MIN_CHARS) continue
    out.push({
      code: 'empty-summary',
      tier: FINDING_SPECS['empty-summary'].tier,
      id: record.id,
      detail: `${refOf(record)} 没有摘要（阈值 ${SUMMARY_MIN_CHARS} 字）`,
      action: null,
    })
  }
  return out
}

/**
 * 疑似重复组。**只报锚点，不列全部成员**——清单要能扫。
 * @param groups 疑似重复组。
 */
export function duplicateGroupsOf(
  groups: readonly { readonly anchorId: string; readonly members: readonly { readonly id: string }[] }[],
): Finding[] {
  const out: Finding[] = []
  for (const group of groups) {
    const members = group.members.map(item => item.id)
    out.push({
      code: 'duplicate-group',
      tier: FINDING_SPECS['duplicate-group'].tier,
      id: group.anchorId,
      detail: `疑似重复 ${members.length} 条，锚点 ${group.anchorId}（合并归 ondra-memory-dedupe）`,
      action: null,
    })
  }
  return out
}

/**
 * 钉子数量超过告警线。
 * @param count 钉子条数。
 */
export function pinOverflowOf(count: number): Finding[] {
  if (count <= PIN_WARN_LIMIT) return []
  return [
    {
      code: 'pin-overflow',
      tier: FINDING_SPECS['pin-overflow'].tier,
      id: '',
      detail: `钉住 ${count} 条，超过手册口径的 ${PIN_WARN_LIMIT} 条上限`,
      action: null,
    },
  ]
}

/** 档位排序权重：`auto` 在最前。 */
function tierRank(tier: RepairTier): number {
  return REPAIR_TIERS.indexOf(tier)
}

/**
 * 归一化一批发现：**去重（同 code + id 只留一条）→ 按档位排序 → 冻结**。
 *
 * 排序不是美观问题：`auto` 档（清悬空钉子）最该先看到，
 * `advise` 档（修不了）放最后，免得「这些修不了」淹没「这些能修」。
 * @param findings 原始发现。
 */
export function settleFindings(findings: readonly Finding[]): readonly Finding[] {
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const finding of findings) {
    const key = `${finding.code}|${finding.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(finding)
  }
  out.sort((a, b) => {
    const byTier = tierRank(a.tier) - tierRank(b.tier)
    if (byTier !== 0) return byTier
    const byCode = a.code.localeCompare(b.code)
    if (byCode !== 0) return byCode
    return a.id.localeCompare(b.id)
  })
  return Object.freeze(out)
}

/** 各档位计数。 */
export function countsOf(findings: readonly Finding[]): Readonly<Record<RepairTier, number>> {
  const counts: Record<RepairTier, number> = { auto: 0, confirm: 0, advise: 0 }
  for (const finding of findings) counts[finding.tier] += 1
  return Object.freeze(counts)
}

/** 问题种类的展示名。 */
export function specZhOf(code: FindingCode): string {
  return FINDING_SPECS[code].zh
}
