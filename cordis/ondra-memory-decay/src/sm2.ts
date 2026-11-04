/**
 * SM-2 间隔复习的**纯算法**层：不碰 ctx、不碰库、不读时间。
 *
 * ## 为什么是「ladder + EF」而不是纯 SM-2
 *
 * 手册给了两张表，各说各的一半：
 *
 * 1. §2.4「SM-2 间隔复习（O-013 增强）：按记忆难度排复习，**不靠固定半衰期**；
 *    同构于艾宾浩斯表 5min/30min/12h/1d/2d/4d/7d/15d」；
 * 2. 语料·第三编 戊-1 给了同一张表的人工操作细节（每次复习先主动回忆）。
 *
 * 纯 SM-2 的间隔是 `1 天 → 6 天 → ×EF`，**表达不了 5 分钟与 30 分钟**这种
 * 分钟级复习；而纯艾宾浩斯表是死节拍，**表达不了「这条特别难记」**。
 *
 * 本插件的做法是把两者**融会贯通**（§12.1「能融就融」）：
 *
 * - **前 8 次复习走艾宾浩斯八档**（人类可读的节拍，手册原表）；
 * - **第 9 次起由 EF 接管**（`上一档 × EF`），「难度」在这里真正生效；
 * - **遗忘（`grade < 3`）打回第一档**，EF 同时下调。
 *
 * 为什么不把 EF 也塞进前 8 档做「跳级」：那会出现「5 分钟后直接 12 小时」这种
 * 明显不符合艾宾浩斯的排期，而排期是用户能直接感知的东西（「她昨天才问过我」）。
 *
 * ## EF 的初值从哪来
 *
 * 从 O-010 给的 `stabilityBaseHours`（**基线 S**，已含类别、显著度、唤醒度、通道）
 * 做对数归一化。**刻意不复制 11 类基线表**——那张表的真源在 O-010，
 * 抄一份过来就成了第二真源，改一处不会同步另一处。
 */

/** 艾宾浩斯八档（小时）。手册 §2.4 原表：5min / 30min / 12h / 1d / 2d / 4d / 7d / 15d。 */
export const LADDER_HOURS: readonly number[] = Object.freeze([5 / 60, 0.5, 12, 24, 48, 96, 168, 360])

/** EF 下限。SM-2 标准值：低于 1.3 会让间隔几乎不增长，等于永远在复习同一条。 */
export const EF_MIN = 1.3

/**
 * EF 上限。**本项目补的**（SM-2 原版没有上限）。
 *
 * 没有上限时，连续 5 分会让 EF 一路涨到 3 以上，间隔呈指数爆炸，
 * 结果是「这条记忆从此再也不会被复习」——而它恰恰是记得最牢的那条，不需要复习，
 * 所以这个上限的代价很小，收益是让「复习计划」不会静默变成一张空表。
 */
export const EF_MAX = 2.8

/** EF 初始值。SM-2 标准值。 */
export const EF_START = 2.5

/** 及格线：`grade ≥ 3` 算想起来，`< 3` 算没想起来（SM-2 原定义）。 */
export const PASS_GRADE = 3

/** EF 归一化的下界（小时）。取 1 小时而不是 0：`ln(0)` 是负无穷。 */
export const EF_BASE_MIN_HOURS = 1

/** EF 归一化的上界（小时）。取 20000（手册 11 类里最长的一档 `self`）。 */
export const EF_BASE_MAX_HOURS = 20000

/** 一个数字夹到区间内。 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 把任意输入夹成 0–5 的整数评分。
 *
 * 非数字一律按 0（「没想起来」）——把「评分写错了」当成「记住了」会让
 * 一条本该重学的记忆被推到几个月后，而这个错误不会报任何日志。
 * @param value 原始评分。
 */
export function clampGrade(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.round(clamp(value, 0, 5))
}

/**
 * SM-2 的 EF 更新公式：`EF' = EF + (0.1 − (5−q) × (0.08 + (5−q) × 0.02))`。
 *
 * 注意 `q = 5` 时增量是 **+0.1**，`q = 3` 时是 **−0.14**：
 * 「勉强想起来」会让这条变得更难，这是 SM-2 的原意——它不是奖励分。
 * @param ef 当前 EF。
 * @param grade 评分 0–5。
 */
export function efAfter(ef: number, grade: number): number {
  const current = clamp(Number.isFinite(ef) ? ef : EF_START, EF_MIN, EF_MAX)
  const q = clampGrade(grade)
  const diff = 5 - q
  const next = current + (0.1 - diff * (0.08 + diff * 0.02))
  return clamp(next, EF_MIN, EF_MAX)
}

/**
 * 由基线 S 推初始 EF（对数归一化到 `[EF_MIN, EF_START]`）。
 *
 * 基线越长（越难忘）→ EF 越接近 2.5；基线越短（越快忘）→ EF 越接近 1.3。
 * **这只是初值**：真正的难度由之后的复习表现（评分）决定，
 * 先验不参与后续计算——否则「按记忆难度排复习」会退化成「按类别排复习」。
 * @param stabilityBaseHours O-010 给的基线 S（小时）。
 */
export function initialEf(stabilityBaseHours: number): number {
  const base = Number.isFinite(stabilityBaseHours) && stabilityBaseHours > 0
    ? stabilityBaseHours
    : EF_BASE_MIN_HOURS
  const span = Math.log(EF_BASE_MAX_HOURS) - Math.log(EF_BASE_MIN_HOURS)
  const t = span <= 0 ? 0 : clamp((Math.log(base) - Math.log(EF_BASE_MIN_HOURS)) / span, 0, 1)
  return clamp(EF_MIN + (EF_START - EF_MIN) * t, EF_MIN, EF_START)
}

/**
 * 下一次间隔（小时）。
 *
 * - `reps ≤ 0`（刚被遗忘）：回到第一档 5 分钟；
 * - `reps ≤ 8`：走艾宾浩斯八档；
 * - `reps > 8`：`上一档 × EF`，上限 `maxHours`。
 * @param reps 连续成功复习次数（**已含本次**）。
 * @param previousHours 上一次的间隔（小时）；`reps ≤ 8` 时不使用。
 * @param ef 当前 EF。
 * @param maxHours 间隔上限（小时）。
 */
export function intervalHoursOf(reps: number, previousHours: number, ef: number, maxHours: number): number {
  const count = Number.isFinite(reps) ? Math.max(0, Math.trunc(reps)) : 0
  const cap = Number.isFinite(maxHours) && maxHours > 0 ? maxHours : 8760
  const first = LADDER_HOURS[0] as number
  if (count <= 0) return first
  if (count <= LADDER_HOURS.length) return LADDER_HOURS[count - 1] as number

  const last = LADDER_HOURS[LADDER_HOURS.length - 1] as number
  const base = Number.isFinite(previousHours) && previousHours > 0 ? previousHours : last
  const factor = clamp(Number.isFinite(ef) ? ef : EF_START, EF_MIN, EF_MAX)
  return Math.min(cap, Math.max(first, base * factor))
}
