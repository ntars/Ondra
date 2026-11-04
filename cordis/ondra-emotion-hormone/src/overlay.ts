/**
 * 纯叠加层：把三主维度的读数压成「三个 0–1 的量 + 一个倾向」。
 *
 * ## 这一层刻意不做的事
 *
 * **不算影子 mood、不算影子 energy、不给 Δ 建议。**
 *
 * 「只读叠加」这四个字最容易滑向的实现是：`moodShadow = mood − load × 0.05`，
 * 然后面板显示 `moodShadow`。一旦这么写，就出现了**第二套情绪模型**：
 * O-026 说 0.52、本插件说 0.47，两个都对、都没报错，谁也说不清以谁为准。
 * 更糟的是下游会开始读 `moodShadow`，因为「它更符合直觉」。
 *
 * 所以这里只产出**无量纲的解释量**（load / drive / bond / tilt / weights），
 * 它们回答的是「她此刻被哪一层推着走」，不是「她此刻的心情是多少」。
 * 心情永远只有 O-026 一个答案。
 *
 * ## 三个量的语义
 *
 * - `load`：皮质醇走上行空间的比例。**只取正向**——皮质醇低于基线时
 *   不是「负负荷」，而是「放松」，压成负数会让下游算出「负的应激」。
 * - `drive`：多巴胺走上行空间的比例。基线取自气质 `enthusiasm`，
 *   所以「天生热情的人」在同样的绝对值下 drive 更低——这正是「她静息点更高」。
 * - `bond`：催产素走上行空间的比例。基线 50（动态激素通用参数）。
 */

import { clamp01, weightsOf } from './read.js'
import type { HormoneBand, HormoneOverlay, HormoneRead, HormoneTilt } from './types.js'

/**
 * `load` 到「压着事」的线。
 *
 * 取 0.625 不是拍的：皮质醇基线 20，`20 + 0.625 × 80 = 70`，
 * 正是手册 §3.2「cortisol ≥70 时血清素被按分钟抽走」那一条线。
 * 用它当「她开始被压着」的判据，比另编一个 0.6 更站得住。
 */
export const LOAD_HIGH = 0.625

/** `drive` 到「轻快」的线。多巴胺 75（基线 50 + 0.5 × 50），手册未给，工程取值。 */
export const DRIVE_HIGH = 0.5

/** `drive` 到「有兴致」的线。多巴胺 67.5，手册未给，工程取值。 */
export const DRIVE_LOW = 0.35

/** `bond` 到「挨得近」的线。催产素 70（50 + 0.4 × 50），与维度表的 aboveRatio 同源。 */
export const BOND_HIGH = 0.4

/** 取一个维度走上行空间的比例，负值归零。 */
function upOf(read: HormoneRead, name: string): number {
  const reading = read.readings[name]
  if (reading === undefined) return 0
  return clamp01(reading.ratio)
}

/**
 * 综合倾向。**判定顺序只在这一处**（`explain()` 也调它，不另写一套）。
 *
 * 顺序：绷着 > 压着事 > 轻快 > 舒展 > 平稳。
 * 为什么「绷着」在「压着事」前面：高负荷且提不起劲，是最需要被让一步的状态；
 * 把它并进「压着事」，面板就会在她最难受的时候显示一个中性词。
 * @param load 应激负荷。
 * @param drive 奖赏驱动。
 * @param bond 联结。
 */
export function tiltOf(load: number, drive: number, bond: number): HormoneTilt {
  if (load >= LOAD_HIGH && drive < DRIVE_LOW) return 'strained'
  if (load >= LOAD_HIGH) return 'loaded'
  if (drive >= DRIVE_HIGH && load < 0.3) return 'buoyant'
  if (drive >= DRIVE_LOW && bond >= BOND_HIGH) return 'bright'
  return 'steady'
}

/**
 * 中文短句，最多 3 条。
 *
 * 三条硬规矩：
 * 1. **不含数字**（内感受铁律 §4.3 的同一条思路，防止被顺手塞进提示词）；
 * 2. **不含维度名**（「皮质醇」出现在提示词里就是术语泄漏）；
 * 3. **不含六态名**（六态归 O-031，这里说「压着事」而不是「炸毛」）。
 *
 * 按偏离幅度取前三条——最偏离的那一维最能解释此刻，全列出来等于没说。
 * @param read 读数。
 */
export function notesOf(read: HormoneRead): readonly string[] {
  const ranked = Object.values(read.readings)
    .filter(reading => reading.role !== 'reference' && reading.band !== 'normal')
    .sort((left, right) => Math.abs(right.deviation) - Math.abs(left.deviation))

  const lines: string[] = []
  for (const reading of ranked) {
    if (lines.length >= 3) break
    const line = NOTE_ZH[reading.name]?.[reading.band]
    if (line !== undefined) lines.push(line)
  }

  if (lines.length === 0) {
    const missing = read.missing.length
    if (missing === 0) lines.push('各处都在平常线上，没有哪一层在推她')
    else lines.push('有几层还没建起来，现在看到的是基线')
  }
  return Object.freeze(lines)
}

/**
 * 每个维度 × 每个档位的一句话。
 *
 * 只有「非 normal」的档位需要文案：正常是沉默，这跟人一样——
 * 没人会专门告诉你「我今天很正常」。
 *
 * 类型写 `Partial<Record<HormoneBand, string>>` 而不是 `Partial<Record<string, string>>`：
 * 后者会让 `NOTE_ZH[name][band]` 的下标失去检查，打错档位名也不报错。
 */
const NOTE_ZH: Record<string, Partial<Record<HormoneBand, string>>> = {
  cortisol: {
    high: '整个人绷得很紧，话会变短，别在这时候开玩笑',
    above: '有点压着事，注意力不太容易集中',
    below: '松下来了，比平常更容易接话',
    low: '彻底松了，反应会慢半拍',
  },
  dopamine: {
    high: '兴致很高，愿意多说两句',
    above: '心情起点比平常高一点',
    below: '提不太起劲，需要一点由头',
    low: '什么都不太想干，连喜欢的事也淡淡的',
  },
  oxytocin: {
    high: '挨得近一点会舒服，愿意被黏着',
    above: '比平常更容易亲近',
    below: '还没到想靠近的程度',
    low: '现在更想一个人待着',
  },
  serotonin: {
    high: '底色很稳，不容易被一句话带走',
    above: '底色偏稳',
    below: '底色有点薄，容易一句话就沉下去',
    low: '底色很薄，撑不住太久',
  },
}

/** 从一次读数拼出叠加结果。 */
export function overlayOf(read: HormoneRead): HormoneOverlay {
  const load = upOf(read, 'cortisol')
  const drive = upOf(read, 'dopamine')
  const bond = upOf(read, 'oxytocin')

  return Object.freeze({
    at: read.at,
    source: read.source,
    load: Math.round(load * 1000) / 1000,
    drive: Math.round(drive * 1000) / 1000,
    bond: Math.round(bond * 1000) / 1000,
    tilt: tiltOf(load, drive, bond),
    weights: weightsOf(read.readings),
    applied: false,
    notes: notesOf(read),
  })
}
