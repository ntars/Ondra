/**
 * 八池表的**唯一真源**与纯分类判定（不碰 ctx、不碰存储）。
 *
 * 数据逐行抄自手册 §2.5（`Ondra-dev-handbook.md` 第 288–302 行），
 * 单位统一为**天**。抄写时只做两处形式转换，不改语义：
 *
 * 1. 手册写「∞ / 永不」→ 这里写 `Number.POSITIVE_INFINITY`。
 *    这样 `ageDays < archiveDays` 恒真，不必在每个判定点写一次「是不是 null」。
 * 2. 手册的 `skill` 行标注「（代码保留，README 写 60，以代码 90 为准）」
 *    → 这里保留该行（半衰期 90），并标 `legacy: true` / `assignable: false`。
 *
 * **为什么保留 legacy 的 `skill` 行而不是删掉凑成 8 个**：
 * 手册小节标题写「八池」，但表里有 9 行。这时有两个选择——
 * ①按标题删掉一行凑八个；②按表登记九行。选②，因为：
 * - 删除会让「读回旧数据」时遇到 `pool='skill'` 无从判定（落海马体？报错？两种都糟）；
 * - 表是**证据**、标题是**概括**。「把证据改到符合概括」是这一轮最不该做的事。
 * 已把该冲突写进 README「已知限制 1」，登记为待裁决。
 *
 * **分类不猜**（手册 §2.5 最后一条）：
 * `classifyByLabels()` 只认**显式标签**——池 id 本身，或手册表里逐字出现过的中文语义名
 * （原则 / 铁律 / 经验 / 日常被反复提起 …）。**刻意不做正文关键词猜测**：
 * 「今天吃了拉面」猜成 `dailyPartial`（20 天）还是 `fact`（365 天）差 18 倍，
 * 而手册原话是「猜错的代价不对称——猜成 7 天的片面日常，那条就真没了」。
 */

import type { PoolClassify, PoolId, PoolPreset } from './types.js'

/**
 * 宽限 / 半衰期 / 归档三段天级时间轴，逐行抄自手册 §2.5。
 *
 * 表头顺序与手册一致：`池 | 宽限 | 半衰期 | 归档(天) | 语义`。
 */
export const POOL_PRESETS: readonly PoolPreset[] = Object.freeze([
  {
    id: 'core',
    label: '核心',
    guardDays: Number.POSITIVE_INFINITY,
    halfLifeDays: Number.POSITIVE_INFINITY,
    archiveDays: Number.POSITIVE_INFINITY,
    injectable: true,
    assignable: true,
    singleSlot: false,
    legacy: false,
    doc: '原则 / 人格 / 边界，永不衰减，上限 32 条。满了直接拒绝，提示改去写 AGENTS.md。',
  },
  {
    id: 'fact',
    label: '事实',
    guardDays: 15,
    halfLifeDays: 365,
    archiveDays: 1095,
    injectable: true,
    assignable: true,
    singleSlot: false,
    legacy: false,
    doc: '关于用户的事实，会变但慢。',
  },
  {
    id: 'skillRule',
    label: '铁律',
    guardDays: 120,
    halfLifeDays: 730,
    archiveDays: 3650,
    injectable: true,
    assignable: true,
    singleSlot: false,
    legacy: false,
    doc: '铁律：必须 / 不许 / 红线，常驻全量。半衰期 730 天是 skillExp 的 12 倍——「用户立的规矩」最该长期保留。',
  },
  {
    id: 'skillExp',
    label: '经验',
    guardDays: 15,
    halfLifeDays: 60,
    archiveDays: 365,
    injectable: true,
    assignable: true,
    singleSlot: false,
    legacy: false,
    doc: '经验：教训 / 工具 / 排障，按需拉。',
  },
  {
    id: 'skill',
    label: '技能（代码保留）',
    guardDays: 15,
    halfLifeDays: 90,
    archiveDays: 365,
    injectable: true,
    assignable: false,
    singleSlot: false,
    legacy: true,
    doc: 'legacy 行：手册注「代码保留，README 写 60，以代码 90 为准」。只用于读回旧数据，不参与新记忆分类。',
  },
  {
    id: 'dailyCore',
    label: '日常·核心',
    guardDays: 20,
    halfLifeDays: 60,
    archiveDays: 180,
    injectable: true,
    assignable: true,
    singleSlot: false,
    legacy: false,
    doc: '被反复提起的日常，可从 dailyPartial 升级到此。',
  },
  {
    id: 'dailyPartial',
    label: '日常·片段',
    guardDays: 5,
    halfLifeDays: 20,
    archiveDays: 45,
    injectable: true,
    assignable: true,
    singleSlot: false,
    legacy: false,
    doc: '一次性进展，速朽。',
  },
  {
    id: 'emotion',
    label: '情绪牌',
    guardDays: 0.125,
    halfLifeDays: 1,
    archiveDays: 3,
    injectable: true,
    assignable: true,
    singleSlot: true,
    legacy: false,
    doc: '单槽状态牌，会自己过期，不是日志。同池只留一条；顶替动作不在本插件（见 `slotHolders`）。',
  },
  {
    id: 'hippocampus',
    label: '海马体',
    guardDays: 0,
    halfLifeDays: 1,
    archiveDays: 14,
    injectable: false,
    assignable: true,
    singleSlot: false,
    legacy: false,
    doc: '原始片段缓冲，永不注入，等夜巡整理。标签一个都认不出时落这里，并打「未归类」。',
  },
] as const)

/** 池 id → 声明。由 `POOL_PRESETS` 派生，不手写第二份。 */
const PRESET_BY_ID: Readonly<Record<string, PoolPreset>> = Object.freeze(
  Object.fromEntries(POOL_PRESETS.map(preset => [preset.id, preset])),
)

/**
 * 标签别名表（大小写不敏感）。
 *
 * **只收两类**：①池 id 本身；②手册 §2.5 表里「语义」列逐字出现过的中文名。
 * 刻意不收录「吃 / 情绪 / 工作」这类**内容关键词**——那属于猜测，见文件头末段。
 */
const LABEL_ALIASES: Readonly<Record<string, PoolId>> = Object.freeze({
  // 池 id 原样（大小写不敏感，故只列小写形式；驼峰靠 `toLowerCase` 归一）
  core: 'core',
  fact: 'fact',
  skillrule: 'skillRule',
  skillexp: 'skillExp',
  skill: 'skill',
  dailycore: 'dailyCore',
  dailypartial: 'dailyPartial',
  emotion: 'emotion',
  hippocampus: 'hippocampus',
  // 手册表「语义」列逐字出现的中文名
  原则: 'core',
  人格: 'core',
  边界: 'core',
  事实: 'fact',
  铁律: 'skillRule',
  红线: 'skillRule',
  经验: 'skillExp',
  教训: 'skillExp',
  日常: 'dailyCore',
  日常核心: 'dailyCore',
  日常片段: 'dailyPartial',
  情绪: 'emotion',
  情绪牌: 'emotion',
  海马体: 'hippocampus',
})

/** 取一个池的声明（未知 id 返回 `undefined`，不抛）。 */
export function presetOf(poolId: string): PoolPreset | undefined {
  return PRESET_BY_ID[poolId]
}

/** 是不是合法池 id。 */
export function isPoolId(value: unknown): value is PoolId {
  return typeof value === 'string' && PRESET_BY_ID[value] !== undefined
}

/** 是不是「永不沉底」的池（三段都是 ∞）。 */
export function isPermanent(preset: PoolPreset): boolean {
  return preset.archiveDays === Number.POSITIVE_INFINITY
}

/**
 * 把一个标签归一成池 id。
 * @param label 原始标签。
 */
export function resolveLabel(label: string): PoolId | undefined {
  return LABEL_ALIASES[label.trim().toLowerCase()]
}

/**
 * 纯分类判定（**不落库、不读库**）。
 *
 * 优先级：显式 `pool` → 逐个 `label` → 都没命中则海马体 + `unclassified=true`。
 *
 * @param explicitPool 调用方直接指定的池（非法值会被忽略并落进 `unknownLabels`）。
 * @param labels 调用方给的标签。
 */
export function classifyByLabels(
  explicitPool: string | undefined,
  labels: readonly string[],
): PoolClassify {
  const unknown: string[] = []

  if (explicitPool !== undefined && explicitPool !== '') {
    if (isPoolId(explicitPool)) {
      // 显式指定的 legacy 池也照收：人工定池有最终解释权，
      // 只是新记忆不允许被**自动**分到那里（`assignable` 在 `assign()` 里把关）。
      return { pool: explicitPool, source: 'explicit', matchedLabel: explicitPool, unclassified: false, unknownLabels: unknown }
    }
    unknown.push(explicitPool)
  }

  for (const label of labels) {
    if (label.trim() === '') continue
    const pool = resolveLabel(label)
    if (pool !== undefined) {
      return { pool, source: 'label', matchedLabel: label, unclassified: false, unknownLabels: unknown }
    }
    unknown.push(label)
  }

  // 一个都认不出 → **不猜**，落海马体（3 天过期线内、永不注入），等夜巡整理。
  return { pool: 'hippocampus', source: 'fallback', matchedLabel: null, unclassified: true, unknownLabels: unknown }
}

/** 一天的毫秒数。 */
export const DAY_MS = 86400000

/**
 * 三段天级时间轴（纯算术，无副作用）。
 *
 * 锚点取 `lastSeenAt`（最近一次被带出），为 0 时退回 `createdAt`——
 * 与 O-010 的「新鲜度锚点 `lastHitAt ?? createdAt`」是**两个不同的锚点**，
 * 不要混：那一条算「还亮不亮」，这一条算「还占不占主动位」。
 *
 * @param preset 池声明。
 * @param anchorAt 锚点时刻。
 * @param at 判定时刻。
 */
export function timelineOfPreset(
  preset: PoolPreset,
  anchorAt: number,
  at: number,
): {
  readonly guardUntil: number | null
  readonly firstHalfLifeAt: number | null
  readonly archiveAt: number | null
  readonly ageDays: number
  readonly halfLives: number
  readonly phase: 'permanent' | 'guarded' | 'decaying' | 'archive-due'
} {
  const ageDays = Math.max(0, (at - anchorAt) / DAY_MS)

  if (isPermanent(preset)) {
    return {
      guardUntil: null,
      firstHalfLifeAt: null,
      archiveAt: null,
      ageDays,
      halfLives: 0,
      phase: 'permanent',
    }
  }

  // `guardDays` 为 0 表示「立即开始衰减」（海马体），不是「永不衰减」。
  const guardUntil = anchorAt + preset.guardDays * DAY_MS
  const firstHalfLifeAt = guardUntil + preset.halfLifeDays * DAY_MS
  const archiveAt = anchorAt + preset.archiveDays * DAY_MS

  // 宽限期内完全不动；出了宽限，每过一个半衰期算一档。
  // 半衰期为 0 的病态配置（本插件不会产生，留给人工写错的旧数据）按「出了宽限即算一档」处理，
  // 否则会除零得到 Infinity。
  // 宽限的边界只判一次（`ageDays < guardDays`），`halfLives` 与 `phase` 共用同一个判断。
  // 两处各写一个（一个 `<=`、一个 `<`）会让「正好第 N 天」这一刻同时被判成
  // 「还没开始算档」与「已在衰减」——两个字段互相矛盾，而谁都不报错。
  const inGuard = ageDays < preset.guardDays
  const halfLives =
    inGuard ? 0 : preset.halfLifeDays <= 0 ? 1 : Math.floor((ageDays - preset.guardDays) / preset.halfLifeDays)

  const phase = ageDays >= preset.archiveDays ? 'archive-due' : inGuard ? 'guarded' : 'decaying'

  return { guardUntil, firstHalfLifeAt, archiveAt, ageDays, halfLives, phase }
}

/** 宽限 / 半衰期 / 归档三列的形状校验（返回问题描述，空数组表示合规）。 */
export function checkPoolTimeline(preset: PoolPreset): readonly string[] {
  const issues: string[] = []
  const inf = Number.POSITIVE_INFINITY
  if (!(preset.guardDays >= 0)) issues.push(`${preset.id}: 宽限必须是 ≥0 的数`)
  if (!(preset.halfLifeDays > 0) && preset.halfLifeDays !== inf) {
    issues.push(`${preset.id}: 半衰期必须 >0（或 ∞）`)
  }
  if (!(preset.archiveDays > 0) && preset.archiveDays !== inf) {
    issues.push(`${preset.id}: 归档必须 >0（或 ∞）`)
  }
  if (preset.archiveDays !== inf && preset.guardDays > preset.archiveDays) {
    // 宽限比归档还长，等于「永远碰不到归档」，与手册语义相反。
    issues.push(`${preset.id}: 宽限（${preset.guardDays}）不得大于归档（${preset.archiveDays}）`)
  }
  return issues
}
