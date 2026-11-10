/**
 * 七阶判定：把「关系读数 + 相处天数」映射成「走到哪一阶」。**纯函数**。
 *
 * ## 四闸里这一层负责三闸，步长闸在 `relation.ts`
 *
 * | 闸 | 落在哪 | 说明 |
 * |---|---|---|
 * | 时间闸 | 本文件 `probeStage()` | `days >= spec.days` |
 * | 步长闸 0.06 | `relation.ts` `clampStep()` | 单次增量上限，挡住「一夜走完六十天」 |
 * | 只升不降 | 本文件 `resolveStage()` | 目标阶序必须大于当前阶序 |
 * | 冲突锁 | `service.observe()` | 锁定时不升阶，且 `effective` 覆盖为敌意 |
 *
 * ## 为什么允许「跳阶」
 *
 * 表面看「跳阶」像是防跃迁没做够。实际相反：**禁止跳阶会造出死锁**。
 *
 * 病态阶的条件是 `trust ≤ 0.55`。一段健康的关系信任早就 0.70，
 * 永远进不了病态；如果又规定「必须逐阶上升」，那么占有（3）之后
 * 永远升不到献祭（5）与落定（6）——**健康的关系反而走不到终点**。
 *
 * 所以规则是：**目标阶必须满足它自己的全部条件**，不要求途经每一阶。
 * 跳过的阶记在 `explain().probes` 里，一眼能看出「这一段没走」。
 * 防跃迁由时间闸与步长闸保证：要跳到落定，仍然得实打实过 60 天。
 */

import { STAGES, STAGE_SPECS, type StageId, type StageSpec } from './types.js'

/** 判定所需的读数。 */
export interface GateContext {
  /** 相处天数。 */
  readonly days: number
  /** 好感 0–1。 */
  readonly affection: number
  /** 信任 0–1。 */
  readonly trust: number
  /** 累计互动次数。 */
  readonly interactions: number
  /** `sacrifice` 标记。 */
  readonly sacrifice: boolean
}

/** 一阶的判定结果。 */
export interface ProbeResult {
  /** 是否满足全部条件。 */
  readonly ok: boolean
  /** 不满足的条件（人话，只给面板与日志）。 */
  readonly missing: readonly string[]
}

/** 一次判定的结论。 */
export interface ResolveResult {
  /** 应该升到的阶；`undefined` 表示不升。 */
  readonly target?: StageId
  /** 最高那个「没够着」的阶（解释用）。 */
  readonly denied?: StageId
  /** 没够着的原因。 */
  readonly missing: readonly string[]
  /**
   * **这次判定用的是不是漂移后的表**。
   *
   * 由判定函数自己回答（`specs !== STAGE_SPECS` 的引用比较），
   * 不让调用方另算一遍。调用方另算等于「我在上层看一眼参数传没传」——
   * 而把参数删掉之后它照样成立（本仓第六次同族假绿）。
   * 默认值就是常量表本身，所以漏传必然为 false，无法从外部伪造。
   */
  readonly drifted: boolean
}

/** 数字保留两位，只用于人话。 */
function num(value: number): string {
  return value.toFixed(2)
}

/**
 * 判定单阶是否可达。
 * @param spec 阶定义。
 * @param ctx 读数。
 */
export function probeStage(spec: StageSpec, ctx: GateContext): ProbeResult {
  const missing: string[] = []
  if (ctx.days < spec.days) {
    missing.push(`相处天数不足（需 ${spec.days} 天，现 ${ctx.days} 天）`)
  }
  if (ctx.affection < spec.affection) {
    missing.push(`好感不足（需 ${num(spec.affection)}，现 ${num(ctx.affection)}）`)
  }
  if (ctx.trust < spec.trust) {
    missing.push(`信任不足（需 ${num(spec.trust)}，现 ${num(ctx.trust)}）`)
  }
  // 上限只有病态有：`trust ≤ 0.55`。写成独立分支而不是 `if (spec.maxTrust)`，
  // 是因为 0 也是合法上限，而 `if (0)` 会静默跳过。
  if (spec.maxTrust !== undefined && ctx.trust > spec.maxTrust) {
    missing.push(`信任过高（${spec.zh}需 ≤ ${num(spec.maxTrust)}，现 ${num(ctx.trust)}）`)
  }
  if (ctx.interactions < spec.minInteractions) {
    missing.push(`互动次数不足（需 ${spec.minInteractions} 次，现 ${ctx.interactions} 次）`)
  }
  if (spec.requiresSacrifice && !ctx.sacrifice) {
    missing.push('缺少 sacrifice 标记')
  }
  return Object.freeze({ ok: missing.length === 0, missing: Object.freeze(missing) })
}

/**
 * 阶序 → 阶名。
 *
 * 用 `.at()` 而不是 `STAGES[order]`：无 `noUncheckedIndexedAccess` 时，
 * 下标访问的类型是 `StageId`（不含 `undefined`），后面那句 `=== undefined`
 * 会被 TS 判成「无重叠比较」（TS2367）——而那正是越界兜底，删不得。
 */
export function stageAt(order: number): StageId {
  const id = STAGES.at(order)
  return id ?? STAGES[0]
}

/** 阶名 → 阶序。未知阶名按 0 处理。 */
export function orderOf(id: string, specs: Readonly<Record<string, StageSpec | undefined>> = STAGE_SPECS): number {
  const spec = specs[id]
  return spec === undefined ? 0 : spec.order
}

/** 阶名 → 定义。未知阶名回落到起点。 */
export function specOf(id: string, specs: Readonly<Record<string, StageSpec | undefined>> = STAGE_SPECS): StageSpec {
  const spec = specs[id]
  return spec === undefined ? STAGE_SPECS[STAGES[0]] : spec
}

/**
 * 求「从当前阶能升到哪」。
 *
 * 从最高阶往下扫，**第一个满足全部条件的**就是目标——
 * 不是「逐阶试」，理由见文件头「为什么允许跳阶」。
 * @param current 当前阶名。
 * @param ctx 读数。
 * @param specs 判据表；省略用出厂常量表（**阈值漂移时为漂移后的表**）。
 */
export function resolveStage(
  current: StageId,
  ctx: GateContext,
  specs: Readonly<Record<StageId, StageSpec>> = STAGE_SPECS,
): ResolveResult {
  const currentOrder = orderOf(current, specs)
  const drifted = specs !== STAGE_SPECS
  const candidates = STAGES
    .map(id => specs[id])
    .filter(spec => spec.order > currentOrder)
    .sort((a, b) => b.order - a.order)

  for (const spec of candidates) {
    if (probeStage(spec, ctx).ok) {
      return Object.freeze({ target: spec.id, missing: Object.freeze([]), drifted })
    }
  }

  const top = candidates[0]
  if (top === undefined) {
    // 已经在最高阶，没有任何候选。
    return Object.freeze({ missing: Object.freeze([]), drifted })
  }
  return Object.freeze({ denied: top.id, missing: probeStage(top, ctx).missing, drifted })
}

/**
 * 逐阶判定（`explain()` 用）。
 * @param ctx 读数。
 * @param specs 判据表；省略用出厂常量表。
 */
export function probeAll(
  ctx: GateContext,
  specs: Readonly<Record<StageId, StageSpec>> = STAGE_SPECS,
): readonly { readonly spec: StageSpec; readonly probe: ProbeResult }[] {
  return Object.freeze(
    STAGES.map(id => {
      const spec = specs[id]
      return Object.freeze({ spec, probe: probeStage(spec, ctx) })
    }),
  )
}
