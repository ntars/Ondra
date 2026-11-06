/**
 * 分支 B：**轻量睡眠巩固**（`lightweight: true`，手册 §1.7 / §2.7）。
 *
 * 「空闲 2 分钟浅睡 / 5 分钟深睡，纯规则挖掘五类卡片，未用卡片 168 小时半衰期、
 * 归档不删除，**零模型调用**。」
 *
 * ## 为什么这个分支值得存在
 *
 * 闸式做梦要花模型的钱，而且四道闸会拒掉大部分候选（那正是它的目的）。
 * 轻量分支反过来：**不花钱、可解释、失败可回溯**。模型网关全挂了它照跑——
 * 这是它在 §14.2「独立降级」里的全部价值，所以 `needsModel = false` 必须是可观测的。
 *
 * ## 五类卡片的判据（手册 §B 原值，全部可配）
 *
 * | 卡片 | 判据 |
 * |---|---|
 * | `pitfall` | 同一工具**连续**失败 ≥3 次 |
 * | `playbook` | 跨工具成功链（A→B）重复 ≥2 次 |
 * | `hotspot` | 同一工具调用 ≥8 次且成功率 <70% |
 * | `unresolved` | 上次成功之后累计 ≥3 次失败 |
 * | `fact` | 最近 7 天、从未被带出、显著度 ≥50 的记忆（仅深睡时做） |
 *
 * ## 两个刻意的「不做」
 *
 * 1. **不装定时器。** 空闲多久由调用方给（`SleepInput.idleMs`）。
 *    自己检测空闲需要一个 tick 源，而「谁在什么时候 tick」是宿主的职责；
 *    自己装定时器就成了「不知道第几个装载的定时器」，排查成本远高于收益。
 * 2. **同类型同标题的卡片不新建也不刷新。** 同一个坑每晚都挖出来会让表无限膨胀；
 *    而「刷新 `last_used_at`」等于每晚给它续命，衰减就永远不生效。
 *    已存在就跳过，计入 `deduped`。
 */

import { dateKey } from '../quote.js'
import { makeId } from '../store.js'
import type {
  BranchContext,
  CardKind,
  DreamBranch,
  DreamCard,
  DreamInput,
  DreamFactRecord,
  DreamLogEntry,
  DreamRejection,
  DreamReport,
  DreamTalk,
  MemoryRecordLike,
  ToolSignal,
} from '../types.js'

/** 卡片的草稿（还没落库，所以没有 id 与权重）。 */
export interface CardDraft {
  /** 类型。 */
  readonly kind: CardKind
  /** 标题（同类型内唯一，去重用）。 */
  readonly title: string
  /** 正文。 */
  readonly body: string
  /** 标签。 */
  readonly tags: readonly string[]
}

/** 一次挖掘的结果。 */
export interface DigResult {
  /** 草稿。 */
  readonly drafts: readonly CardDraft[]
  /** 睡眠阶段。 */
  readonly stage: 'none' | 'shallow' | 'deep'
}

/**
 * 按时间升序排信号（调用方给的顺序不一定可靠）。
 * @param signals 信号。
 */
export function sortSignals(signals: readonly ToolSignal[]): readonly ToolSignal[] {
  return [...signals].sort((left, right) => left.at - right.at)
}

/**
 * `pitfall`：同一工具连续失败 ≥ 阈值。
 * @param signals 已排序的信号。
 * @param streak 阈值。
 */
export function pitfallCards(signals: readonly ToolSignal[], streak: number): readonly CardDraft[] {
  const drafts: CardDraft[] = []
  const run = new Map<string, number>()
  const done = new Set<string>()
  for (const signal of signals) {
    const current = signal.ok ? 0 : (run.get(signal.tool) ?? 0) + 1
    run.set(signal.tool, current)
    if (current >= streak && !done.has(signal.tool)) {
      done.add(signal.tool)
      drafts.push({
        kind: 'pitfall',
        title: `${signal.tool} 连续失败`,
        body: `「${signal.tool}」连续失败 ${current} 次。下次先看参数与前置条件，不要直接重试——同因重试只会把伤口拖成慢性。`,
        tags: Object.freeze(['tool', signal.tool, 'failure']),
      })
    }
  }
  return Object.freeze(drafts)
}

/**
 * `unresolved`：上次成功之后累计失败 ≥ 阈值。
 * @param signals 已排序的信号。
 * @param fails 阈值。
 */
export function unresolvedCards(signals: readonly ToolSignal[], fails: number): readonly CardDraft[] {
  const drafts: CardDraft[] = []
  const sinceSuccess = new Map<string, number>()
  const everSucceeded = new Set<string>()
  const reported = new Set<string>()
  for (const signal of signals) {
    if (signal.ok) {
      sinceSuccess.set(signal.tool, 0)
      everSucceeded.add(signal.tool)
      continue
    }
    const count = (sinceSuccess.get(signal.tool) ?? 0) + 1
    sinceSuccess.set(signal.tool, count)
    // 只有「成功过又卡住」才算 unresolved；从头到尾没成功过的是 pitfall 的事。
    if (count >= fails && everSucceeded.has(signal.tool) && !reported.has(signal.tool)) {
      reported.add(signal.tool)
      drafts.push({
        kind: 'unresolved',
        title: `${signal.tool} 卡住了`,
        body: `「${signal.tool}」上次成功之后累计失败 ${count} 次，还没解决。这件事没闭合，别当成已经过去了。`,
        tags: Object.freeze(['tool', signal.tool, 'open']),
      })
    }
  }
  return Object.freeze(drafts)
}

/**
 * `hotspot`：调用 ≥ 阈值且成功率 < 阈值。
 * @param signals 已排序的信号。
 * @param minCalls 最少调用次数。
 * @param maxRate 成功率上限（低于它才算）。
 */
export function hotspotCards(
  signals: readonly ToolSignal[],
  minCalls: number,
  maxRate: number,
): readonly CardDraft[] {
  const total = new Map<string, number>()
  const ok = new Map<string, number>()
  for (const signal of signals) {
    total.set(signal.tool, (total.get(signal.tool) ?? 0) + 1)
    if (signal.ok) ok.set(signal.tool, (ok.get(signal.tool) ?? 0) + 1)
  }

  const drafts: CardDraft[] = []
  for (const [tool, calls] of total) {
    if (calls < minCalls) continue
    const success = ok.get(tool) ?? 0
    const rate = success / calls
    if (rate >= maxRate) continue
    drafts.push({
      kind: 'hotspot',
      title: `${tool} 高频但常败`,
      body: `「${tool}」调用 ${calls} 次，成功 ${success} 次（${Math.round(rate * 100)}%）。用得最多、也最容易失败，值得先修它而不是绕开它。`,
      tags: Object.freeze(['tool', tool, 'hotspot']),
    })
  }
  return Object.freeze(drafts)
}

/**
 * `playbook`：跨工具成功链（A→B）重复 ≥ 阈值。
 *
 * 「跨工具」是关键：同一工具连着成功两次不是套路，是批量操作。
 * @param signals 已排序的信号。
 * @param repeat 阈值。
 */
export function playbookCards(signals: readonly ToolSignal[], repeat: number): readonly CardDraft[] {
  const pairs = new Map<string, number>()
  let previous: string | undefined
  for (const signal of signals) {
    if (!signal.ok) continue
    if (previous !== undefined && previous !== signal.tool) {
      const key = `${previous}\u0000${signal.tool}`
      pairs.set(key, (pairs.get(key) ?? 0) + 1)
    }
    previous = signal.tool
  }

  const drafts: CardDraft[] = []
  for (const [key, count] of pairs) {
    if (count < repeat) continue
    const [from, to] = key.split('\u0000')
    if (from === undefined || to === undefined) continue
    drafts.push({
      kind: 'playbook',
      title: `${from} → ${to} 常用链路`,
      body: `「${from}」之后常接「${to}」，已经出现 ${count} 次。这条链路可以固化下来，不必每次重新摸索。`,
      tags: Object.freeze(['tool', from, to, 'chain']),
    })
  }
  return Object.freeze(drafts)
}

/**
 * `fact`：把最近值得记、又一直没被带出的事实做成卡片（仅深睡时做）。
 * @param records 候选记忆。
 * @param at 时间戳。
 * @param days 最近几天。
 * @param minSalience 最低显著度。
 * @param limit 最多几条。
 */
export function factCards(
  records: readonly MemoryRecordLike[],
  at: number,
  days: number,
  minSalience: number,
  limit: number,
): readonly CardDraft[] {
  const drafts: CardDraft[] = []
  const cutoff = at - days * 86_400_000
  for (const record of records) {
    if (drafts.length >= limit) break
    if (record.sealed || record.archived) continue
    if (record.createdAt < cutoff) continue
    if (record.hits > 0) continue
    if (record.salience < minSalience) continue
    const body = record.summary ?? record.text
    drafts.push({
      kind: 'fact',
      title: `事实：${body.slice(0, 12)}`,
      body,
      tags: Object.freeze(['fact', record.category, record.kind]),
    })
  }
  return Object.freeze(drafts)
}

/** 分支实现。 */
export class LightweightBranch implements DreamBranch {
  /** 分支名。 */
  readonly mode = 'lightweight' as const
  /** **不需要**模型网关。 */
  readonly needsModel = false

  /**
   * 跑一次轻量巩固。
   * @param input 入参。
   * @param at 时间戳。
   * @param context 上下文。
   */
  async run(input: DreamInput, at: number, context: BranchContext): Promise<DreamReport> {
    const { settings, core, log } = context
    const date = dateKey(at)
    const base = {
      mode: this.mode,
      at,
      date,
      candidates: 0,
      written: Object.freeze([]) as readonly DreamFactRecord[],
      rejected: Object.freeze([]) as readonly DreamRejection[],
      cards: Object.freeze([]) as readonly DreamCard[],
      talk: Object.freeze([]) as readonly DreamTalk[],
      edges: 0,
      backup: 'skipped' as const,
      logged: false,
    }

    if (input.mode !== 'lightweight') {
      return Object.freeze({ ...base, ok: false, reason: 'mode-mismatch' as const, note: '入参分支与配置不一致' })
    }

    const sleep = input.sleep
    const stage: 'none' | 'shallow' | 'deep' =
      sleep.idleMs >= settings.idleDeepMs ? 'deep' : sleep.idleMs >= settings.idleShallowMs ? 'shallow' : 'none'

    if (stage === 'none') {
      return Object.freeze({
        ...base,
        ok: true,
        note: `空闲 ${Math.max(0, Math.round(sleep.idleMs / 1000))} 秒，不到浅睡门槛（${Math.round(settings.idleShallowMs / 1000)} 秒），不做巩固`,
      })
    }

    const signals = sortSignals(sleep.signals)
    const drafts: CardDraft[] = [
      ...pitfallCards(signals, settings.toolPitfallStreak),
      ...unresolvedCards(signals, settings.toolUnresolvedFails),
      ...hotspotCards(signals, settings.toolHotspotCalls, settings.toolHotspotRate),
      ...playbookCards(signals, settings.toolPlaybookRepeat),
    ]

    // 事实卡片只在深睡做：它要扫记忆库，比数信号贵得多。
    if (stage === 'deep' && core !== undefined && core.available) {
      const records = this.scanFacts(core, settings.scanLimit, settings.pageSize, context)
      drafts.push(...factCards(records, at, settings.factCardDays, settings.factCardSalience, settings.maxFactCards))
    }

    const cards: DreamCard[] = []
    let deduped = 0
    for (const draft of drafts) {
      if (context.store.cardExists(draft.kind, draft.title)) {
        // 已存在：不新建、**也不刷新**（刷新等于每晚给它续命，衰减永不生效）。
        deduped += 1
        continue
      }
      const row = {
        id: makeId('dc', at),
        kind: draft.kind,
        title: draft.title,
        body: draft.body,
        tags: draft.tags,
        createdAt: at,
        lastUsedAt: 0,
        uses: 0,
      }
      context.store.addCard(row)
      cards.push(
        Object.freeze({
          ...row,
          // 刚创建：闲置 0 小时，权重 1。
          weight: 1,
          archived: false,
        }),
      )
    }

    const note =
      drafts.length === 0
        ? `信号 ${signals.length} 条，五类卡片都没挖到东西（这本身是正常的：一切顺利时没有教训可记）`
        : `信号 ${signals.length} 条，挖出 ${drafts.length} 张，新建 ${cards.length} 张，已存在跳过 ${deduped} 张`

    const entry: DreamLogEntry = {
      id: makeId('dl', at),
      date,
      mode: this.mode,
      at,
      facts: 0,
      cards: cards.length,
      talk: 0,
      edges: 0,
      note,
    }
    context.store.recordDream(entry)
    if (!context.store.available) {
      log.warn('轻量巩固挖出 %d 张卡片，但没有存储端口，卡片未能落盘', cards.length)
    }

    return Object.freeze({
      ok: true,
      mode: this.mode,
      at,
      date,
      candidates: drafts.length,
      written: Object.freeze([]),
      rejected: Object.freeze([]),
      cards: Object.freeze(cards),
      talk: Object.freeze([]),
      edges: 0,
      backup: 'skipped',
      logged: context.store.available,
      note: `${stage === 'deep' ? '深睡' : '浅睡'}：${note}`,
    })
  }

  /** 分页扫记忆（撞上限时只影响事实卡片，不报错也不假装扫全了）。 */
  private scanFacts(
    core: NonNullable<BranchContext['core']>,
    limit: number,
    pageSize: number,
    context: BranchContext,
  ): readonly MemoryRecordLike[] {
    const records: MemoryRecordLike[] = []
    let offset = 0
    for (;;) {
      const page = core.listFacts({ limit: pageSize, offset })
      records.push(...page)
      offset += page.length
      if (page.length < pageSize) break
      if (records.length >= limit) {
        context.report({
          code: 'scan-truncated',
          detail: `事实卡片取材扫到 ${limit} 条上限，只覆盖前 ${limit} 条`,
        })
        break
      }
    }
    return Object.freeze(records)
  }
}
