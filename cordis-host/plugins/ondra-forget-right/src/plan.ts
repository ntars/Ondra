/**
 * 计划层：**把「要忘掉谁」解析成一串 id，再逐个面说清「这一面打算动几条、能不能动」**。
 *
 * ## 纯函数原则
 *
 * 本文件不落盘、不写上游、不读配置以外的任何东西。全部输入从外面传进来，
 * 全部输出是普通对象。这样「出计划」这件事本身绝不会误删任何数据——
 * 一个会顺手删东西的 `plan()`，迟早会在某次自动重试里被调两遍。
 *
 * ## 为什么 `blind` 面也要列出来
 *
 * 计划的价值不在「能删几面」，而在**「哪些删不掉」**。只列能删的那几面，
 * 用户会以为清单结束了，然后放心地以为清干净了。列全十一面，
 * 才能让「日记里还留着一份」这句话出现在人眼前。
 */

import {
  FORGET_RIGHT_SERVICE_KEY,
  SURFACE_IDS,
  SURFACE_SPECS,
} from './types.js'
import type {
  Capability,
  ForgetPlan,
  ForgetTarget,
  PlannedScrub,
  ResolvedTarget,
  ResidueReport,
  ResidueRow,
  SurfaceId,
  SurfaceSpec,
} from './types.js'

/** 目标的字段上限（防一次传进一万个 id 把日志撑爆）。 */
export const MAX_TARGETS = 200

/** 原因文本上限（中文按码位算）。 */
export const MAX_REASON_CHARS = 200

/** 一面的运行时可判状态（**只看上游在不在位，不调任何方法**）。 */
export interface Availability {
  /** 面 id。 */
  readonly surface: SurfaceId
  /** 上游是否在位且可用。 */
  readonly present: boolean
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 规整一个目标：去空白、去重、限长。
 *
 * **不抛错**：非法输入交给调用方判（`plan()` 会抛 `bad-target`）。
 * 这里只负责把能救的救回来。
 * @param raw 原始目标。
 */
export function normalizeTarget(raw: unknown): ForgetTarget | undefined {
  if (!isRecord(raw)) return undefined
  const kind = raw['kind']
  if (kind !== 'fact' && kind !== 'subject' && kind !== 'capsule' && kind !== 'todo') return undefined

  const rawValues = raw['values']
  if (!Array.isArray(rawValues)) return undefined

  const values: string[] = []
  const seen = new Set<string>()
  for (const item of rawValues) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '') continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    values.push(trimmed)
    if (values.length >= MAX_TARGETS) break
  }

  const reasonRaw = raw['reason']
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().slice(0, MAX_REASON_CHARS) : ''
  if (values.length === 0) return undefined

  return Object.freeze({ kind, values: Object.freeze(values), reason })
}

/**
 * 目标是否只按主体名找（`subject` 类）。
 * @param kind 目标种类。
 */
export function isSubjectKind(kind: ForgetTarget['kind']): boolean {
  return kind === 'subject'
}

/**
 * 从 `listFacts()` 的结果里取 id（去重、保序）。
 * @param rows 记录行。
 */
export function idsOf(rows: readonly { readonly id: string }[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '') continue
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row.id)
  }
  return Object.freeze(out)
}

/**
 * 静态能力 + 运行时在位 → 这一面**实际**能做什么。
 *
 * 三档降级，顺序不能反：
 * 1. 上游不在位 → `absent`（**不管静态上限多高**）；
 * 2. 上游在位但静态上限是 `blind` → 仍是 `blind`；
 * 3. 其余沿用静态上限。
 *
 * 反过来判（先看静态再看在位）会把「没装插件」报成「装了但删不掉」，
 * 用户就会去翻一个压根没装的插件。
 * @param spec 面说明书。
 * @param present 上游是否在位。
 */
export function effectiveCapability(spec: SurfaceSpec, present: boolean): Capability | 'absent' {
  if (!present) return 'absent'
  return spec.maxCapability
}

/**
 * 这一面的「打算做什么」人话。
 * @param surface 面 id。
 * @param targets 打算动的条数。
 */
export function intentOf(surface: SurfaceId, targets: number): string {
  switch (surface) {
    case 'todo':
      return `逐条删掉 ${String(targets)} 条相关待办`
    case 'capsule':
      return `删掉 ${String(targets)} 颗未开封的胶囊（已开封的不动）`
    case 'memory-edge':
      return `清掉指向这 ${String(targets)} 条记忆的全部图边`
    case 'memory-vector':
      return `从向量索引移除这 ${String(targets)} 条`
    case 'memory-pin':
      return `拔掉这 ${String(targets)} 条上的钉子`
    case 'memory-fact':
      return `真删这 ${String(targets)} 条正文并写墓碑`
    case 'promise':
      return `只数得出还剩 ${String(targets)} 条；**删不掉**（上游没有删承诺的方法）`
    case 'lexicon':
      return '整份清空语感样本（没有按条入口，会连带清掉别人说的话）'
    case 'diary':
      return '删不掉：日记是 Markdown 一天一篇，只能由人在文件系统里删'
    case 'trace':
      return '删不掉：只能按保留期整天清理，会连带删掉无关条目'
    case 'snapshot':
      return '不代删：快照是整份库副本，删它不可逆且归 O-009'
    default:
      return '未知面'
  }
}

/**
 * 这一面**不处理**的原因（只有非 `erase` 面才有）。
 * @param capability 实际能力。
 * @param clearLexicon 是否允许整份清台词库。
 */
export function blockedBecauseOf(
  capability: Capability | 'absent',
  clearLexicon: boolean,
): string | undefined {
  if (capability === 'absent') return '上游未装载'
  if (capability === 'blind') return '上游没有删除入口'
  if (capability === 'stage') return '只能打标记，数据还在'
  if (capability === 'erase-all' && !clearLexicon) {
    return '只能整份清空，且未开启 clear-lexicon（会连带清掉别人说的话）'
  }
  return undefined
}

/**
 * 排计划：**十一面一个不少，按 `SCRUB_ORDER` 顺序**。
 *
 * @param target 目标。
 * @param resolved 解析结果。
 * @param availability 逐面在位情况。
 * @param clearLexicon 是否允许整份清台词库。
 */
export function planScrubs(
  target: ForgetTarget,
  resolved: ResolvedTarget,
  availability: readonly Availability[],
  clearLexicon: boolean,
): readonly PlannedScrub[] {
  const bySurface = new Map<SurfaceId, boolean>()
  for (const item of availability) bySurface.set(item.surface, item.present)

  const count = resolved.ids.length
  const scrubs: PlannedScrub[] = []

  for (const spec of SURFACE_SPECS) {
    const present = bySurface.get(spec.id) === true

    // 「这一面要动几条」不是十面都一样：
    // - 按 id 逐条删的三面（正文 / 边 / 向量 / 钉子）跟着 id 数；
    // - 待办与胶囊按目标种类判定，只有点名时才动；
    // - 台词库整份清没有条数概念，记 1；
    // - 删不掉的四面恒 0（**不拿目标的条数冒充「将删除 N 条」**）。
    let targets = 0
    if (spec.maxCapability === 'erase') {
      if (spec.id === 'todo') targets = target.kind === 'todo' ? target.values.length : 0
      else if (spec.id === 'capsule') targets = target.kind === 'capsule' ? target.values.length : 0
      else targets = count
    } else if (spec.maxCapability === 'erase-all') {
      targets = 1
    }

    const capability = effectiveCapability(spec, present)
    const blockedBecause = blockedBecauseOf(capability, clearLexicon)

    scrubs.push(
      Object.freeze({
        surface: spec.id,
        zh: spec.zh,
        capability,
        targets,
        intent: intentOf(spec.id, targets),
        ...(blockedBecause === undefined ? {} : { blockedBecause }),
      }),
    )
  }

  return Object.freeze(scrubs)
}

/**
 * 计划总结：**只说「会删几面、删不掉几面、缺了什么」，不报比例不评价**。
 * @param scrubs 逐面计划。
 * @param resolved 解析结果。
 */
export function planSummaryOf(scrubs: readonly PlannedScrub[], resolved: ResolvedTarget): string {
  const erasable = scrubs.filter(item => item.capability === 'erase').length
  const residual = scrubs.length - erasable
  const absent = scrubs.filter(item => item.capability === 'absent').length

  if (!resolved.hit) return `没找到要忘的东西：${resolved.note}`
  const head = `清单一共 ${String(scrubs.length)} 面：能真删 ${String(erasable)} 面，另有 ${String(residual)} 面删不掉或不会动`
  if (absent > 0) return `${head}（其中 ${String(absent)} 面因为上游没装，暂时也动不了）。`
  return `${head}。`
}

/**
 * 计划里的不可逆警示。**执行前必须显示给人看**。
 *
 * 措辞刻意不含安慰话：这里唯一该传递的信息是「删了就没了，而且还有地方留着」。
 * @param scrubs 逐面计划。
 */
export function warningOf(scrubs: readonly PlannedScrub[]): string {
  const blind = scrubs.filter(item => item.capability === 'blind').map(item => item.zh)
  const eraseAll = scrubs.filter(item => item.capability === 'erase-all').map(item => item.zh)
  const parts: string[] = ['记忆正文删除**不可逆**（会写墓碑，合并时不会复活）。']
  if (blind.length > 0) {
    parts.push(`以下面**删不掉**，删完仍会留着：${blind.join('、')}。`)
  }
  if (eraseAll.length > 0) {
    parts.push(`以下面只能整份清空（不是只清这一条）：${eraseAll.join('、')}。`)
  }
  parts.push('要连这些一起清干净，需要人在应用外壳里逐个处理。')
  return parts.join('')
}

/**
 * 残余扫描的总结。
 * @param rows 逐面残余。
 */
export function residueSummaryOf(rows: readonly ResidueRow[]): string {
  const residual = rows.filter(row => row.remaining === null || row.remaining > 0).length
  const unknown = rows.filter(row => !row.countable).length
  if (residual === 0) return '十一面都数得出来，且都是空的。'
  const head = `${String(residual)} 面还有东西或数不出来`
  return unknown > 0 ? `${head}（其中 ${String(unknown)} 面数不出来）。` : `${head}。`
}

/**
 * 残余报告。
 * @param rows 逐面残余。
 */
export function residueReportOf(rows: readonly ResidueRow[]): ResidueReport {
  const residual = rows.filter(row => row.remaining === null || row.remaining > 0).length
  return Object.freeze({
    rows: Object.freeze(rows),
    residual,
    summary: residueSummaryOf(rows),
  })
}

/**
 * 造一行残余。**数不出来就是 `null` + `countable: false`**，绝不用 0 顶替。
 * @param spec 面说明书。
 * @param remaining 剩余条数；`undefined` = 数不出来。
 * @param note 人话说明。
 */
export function residueRowOf(
  spec: SurfaceSpec,
  remaining: number | undefined,
  note: string,
): ResidueRow {
  const countable = remaining !== undefined
  return Object.freeze({
    surface: spec.id,
    zh: spec.zh,
    remaining: countable ? (remaining as number) : null,
    countable,
    note,
  })
}

/**
 * 出计划（纯函数，**不碰任何服务**）。
 * @param target 目标。
 * @param resolved 解析结果。
 * @param availability 逐面在位。
 * @param clearLexicon 是否允许整份清台词库。
 */
export function buildPlan(
  target: ForgetTarget,
  resolved: ResolvedTarget,
  availability: readonly Availability[],
  clearLexicon: boolean,
): ForgetPlan {
  const scrubs = planScrubs(target, resolved, availability, clearLexicon)
  const erasable = scrubs.filter(item => item.capability === 'erase').length
  return Object.freeze({
    target,
    resolved,
    scrubs,
    erasable,
    residual: scrubs.length - erasable,
    summary: planSummaryOf(scrubs, resolved),
    warning: warningOf(scrubs),
  })
}

/**
 * 服务键是否合规的自证（自检用；运行时也用它给日志打一行）。
 * @param key 服务键。
 */
export function keyCompliant(key: string): boolean {
  return key === FORGET_RIGHT_SERVICE_KEY && /^[a-z][a-z0-9_-]{1,63}$/.test(key)
}

/** 面的全量 id（自检用，确保 `SURFACE_SPECS` 与 `SURFACE_IDS` 集合一致）。 */
export const SPEC_IDS: readonly SurfaceId[] = Object.freeze(SURFACE_SPECS.map(spec => spec.id))

/** 面数（日志里报一句，便于和台账对数）。 */
export const SURFACE_COUNT = SURFACE_IDS.length
