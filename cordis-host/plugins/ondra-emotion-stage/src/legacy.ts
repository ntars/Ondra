/**
 * 两条只读派生：五阶段（历史映射）与六段刻度（对外展示）。**都不写库**。
 *
 * ## 五阶段：七阶压成五阶，必然有损
 *
 * 手册 §3.4 / §9.3：`cold → thawing → attached → possessive → yandere`。
 * 五比七少两格，所以映射**只能是多对一**。取定：
 *
 * | 七阶 | 五阶段 | 理由 |
 * |---|---|---|
 * | 敌意 hostile | cold | 字面对应 |
 * | 试探 probing | thawing | 「解冻」，字面对应 |
 * | 心动 crush | attached | 依恋的起点 |
 * | 占有 possessive | possessive | 字面对应 |
 * | 病态 pathological | possessive | 病态是占有的加深，五阶段里没有更贴的格子 |
 * | 献祭 sacrifice | yandere | 字面对应（病娇） |
 * | 落定 settled | attached | 稳定依恋。五阶段没有「安定」这一格，只能回落到 attached |
 *
 * 两处多对一（占有/病态、心动/落定）是**信息丢失**，不是 bug：
 * 五阶段本来就是旧口径，只用来读旧数据与做迁移对照。
 * **它不参与任何判定**——拿它反推七阶，就会造出「病态还是落定」这种无解的问题。
 *
 * ## 六段刻度：由好感推，不由阶段推
 *
 * 手册只给了六段的名字与一个实测边界：
 * 「截图实测：好感 72/1000，再 28 分进入『眼熟』，阶段 1/6」
 * —— 即 **陌生 = [0, 100)，眼熟从 100 起**。这是唯一有证据的边界。
 *
 * 剩下五段的边界**手册没给**，按 [100, 1000] 等分反推，每段 180。
 * 这是反推，登记在 README 的「待裁决」里；改口径只需改 `SCALE_BANDS` 一处。
 *
 * **为什么不由阶段推**：阶段是棘轮（只升不降），好感是会衰减的读数。
 * 拿阶段算刻度，会出现「两个月没联系，阶段还是落定，刻度显示交心」——
 * 那不是展示，那是撒谎。刻度回答「现在多亲」，阶段回答「走到过哪里」。
 */

import { type LegacyStage, type ScaleBandSpec, type ScaleView, type StageId } from './types.js'

/** 七阶 → 五阶段。多对一，见文件头。 */
const LEGACY_TABLE: Record<StageId, LegacyStage> = {
  hostile: 'cold',
  probing: 'thawing',
  crush: 'attached',
  possessive: 'possessive',
  pathological: 'possessive',
  sacrifice: 'yandere',
  settled: 'attached',
}

/**
 * 七阶 → 五阶段的**只读出口**。
 *
 * 与 `STAGE_SPECS` 同一个理由：直接写 `= Object.freeze({...})` 时，
 * `'cold'` 会被拓宽成 `string`，而 `LegacyStage` 是字面量联合，赋不过去。
 * 先给中间常量加类型注解，收窄才生效。
 */
export const LEGACY_MAP: Readonly<Record<StageId, LegacyStage>> = Object.freeze(LEGACY_TABLE)

/**
 * 六段刻度的边界表。
 *
 * 第一段的右边界 100 有实测证据（见文件头）；其余按 [100, 1000] 五等分反推。
 * `from` 含、`to` 不含；最后一段的 `to` 取 1001 以便把 1000 收进来。
 */
export const SCALE_BANDS: readonly ScaleBandSpec[] = Object.freeze([
  Object.freeze({ id: 'stranger', zh: '陌生', from: 0, to: 100 }),
  Object.freeze({ id: 'familiar', zh: '眼熟', from: 100, to: 280 }),
  Object.freeze({ id: 'acquaintance', zh: '熟人', from: 280, to: 460 }),
  Object.freeze({ id: 'friend', zh: '朋友', from: 460, to: 640 }),
  Object.freeze({ id: 'close', zh: '亲近', from: 640, to: 820 }),
  Object.freeze({ id: 'confidant', zh: '交心', from: 820, to: 1001 }),
])

/**
 * 好感 → 六段刻度。
 * @param affection 好感 0–1。
 */
export function scaleOf(affection: number): ScaleView {
  const safe = typeof affection === 'number' && Number.isFinite(affection) ? affection : 0
  const score = Math.round(Math.min(1, Math.max(0, safe)) * 1000)
  const last = SCALE_BANDS[SCALE_BANDS.length - 1]
  let band: ScaleBandSpec = last
  for (const candidate of SCALE_BANDS) {
    if (score >= candidate.from && score < candidate.to) {
      band = candidate
      break
    }
  }
  const span = band.to - band.from
  const progress = span <= 0 ? 0 : Math.min(1, Math.max(0, (score - band.from) / span))
  return Object.freeze({ score, band, progress, bands: SCALE_BANDS })
}

/**
 * 七阶 → 五阶段。
 * @param stage 阶名。
 */
export function legacyOf(stage: string): LegacyStage {
  // 参数放宽到 `string` 是刻意的：脏存档里可能躺着不认识的阶名，
  // 而 `LEGACY_MAP[stage as StageId]` 在类型上「一定存在」，
  // 拿它跟 `undefined` 比会被 TS 判成无重叠比较。放宽后这层兜底才写得出来。
  const mapped = (LEGACY_MAP as Readonly<Record<string, LegacyStage | undefined>>)[stage]
  return mapped ?? 'cold'
}
