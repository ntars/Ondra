/**
 * 分支 C：**荒诞联想 + 梦话**（手册 §9.7 第 4–5 步）。
 *
 * 「同实体但时间差 >3 天 → 建 `surreal` 边 0.03（每晚 ≤3 条，**永不进检索**）；
 * 梦话 30–50 字呓语存 `dream_log`，次日首次对话注入并标注「这是梦话」。」
 *
 * ## 为什么它和闸式做梦不能同时开
 *
 * 闸式做梦的四道闸要求「出处逐字可查」，而梦话**按定义没有出处**。
 * 同一个晚上既做闸式又做荒诞，等于让四道闸去审一句它必然要拒的话——
 * 结果只有两种：梦话被 100% 拒掉（白花一次模型钱），或者为了让它过而放宽闸门
 * （那闸式就不再是闸式）。故 `mode` 是单一枚举（裁决⑤）。
 *
 * ## 「同实体」怎么认
 *
 * 手册没定义实体，本插件用「共享 ≥N 个字符二元组」近似。这是**近似**，不是等价：
 * 「火锅」与「麻辣锅」能连上，「他」与「她」也能连上。写进 README 已知限制。
 *
 * ## `surreal` 边永不进检索
 *
 * 这一条**由 O-015 保证**（`neighbors()` 默认 `includeSurreal: false`，
 * `diffuse()` 也不带它）。本插件只负责建边，不负责过滤——
 * 若在这里也加一道过滤，就会出现「两个地方都在管同一件事」，
 * 将来放开其中一个（比如给界面一个「看看荒诞联想」的开关）时，
 * 另一处会静默地继续挡着。
 */

import { bigrams, charCount, cutTo, dateKey, normalizeForMatch, sharedGramCount } from '../quote.js'
import { TALK_SYSTEM_PROMPT, buildTalkMessage } from '../prompt.js'
import { makeId } from '../store.js'
import type {
  BranchContext,
  DreamBranch,
  DreamCard,
  DreamFactRecord,
  DreamInput,
  DreamRejection,
  DreamReport,
  DreamTalk,
  MemoryRecordLike,
} from '../types.js'

/** 一晚找到的一对。 */
export interface SurrealPair {
  /** 新的一端。 */
  readonly from: MemoryRecordLike
  /** 远的一端。 */
  readonly to: MemoryRecordLike
  /** 共享二元组数。 */
  readonly shared: number
}

/**
 * 找「同实体、但隔了很久」的配对。
 *
 * 只从**最近的若干条**出发去找远处的伴：两两全比对是 O(n²)，
 * 500 条就是 12 万次集合比较；而「今晚梦到白天的事、跟很久以前的事连起来」
 * 本来就该从最近出发。这也是 `surrealRecentSeeds` 存在的理由。
 * @param records 记忆（按写入时间倒序，`listFacts()` 的默认顺序）。
 * @param settings 配置子集。
 * @param limit 最多几对。
 */
export function findSurrealPairs(
  records: readonly MemoryRecordLike[],
  settings: { readonly surrealMinGapDays: number; readonly surrealMinSharedGrams: number; readonly surrealRecentSeeds: number },
  limit: number,
): readonly SurrealPair[] {
  const gapMs = settings.surrealMinGapDays * 86_400_000
  const grams = new Map<string, ReadonlySet<string>>()
  const gramsOf = (record: MemoryRecordLike): ReadonlySet<string> => {
    const cached = grams.get(record.id)
    if (cached !== undefined) return cached
    const built = bigrams(record.text)
    grams.set(record.id, built)
    return built
  }

  const recent = records.slice(0, Math.max(1, settings.surrealRecentSeeds))
  const pairs: SurrealPair[] = []
  const used = new Set<string>()

  for (const seed of recent) {
    // 同一条记忆不重复参与：一条新记忆最多连一个远处的伴，
    // 否则它一夜之间变成枢纽，而「荒诞」是不该有枢纽的。
    if (used.has(seed.id)) continue
    for (const other of records) {
      if (pairs.length >= limit) return Object.freeze(pairs)
      if (other.id === seed.id) continue
      if (used.has(other.id)) continue
      if (Math.abs(seed.createdAt - other.createdAt) < gapMs) continue
      const shared = sharedGramCount(gramsOf(seed), gramsOf(other))
      if (shared < settings.surrealMinSharedGrams) continue
      pairs.push({ from: seed, to: other, shared })
      used.add(seed.id)
      used.add(other.id)
      break
    }
  }
  return Object.freeze(pairs)
}

/**
 * 清洗梦话：去掉换行、引号、代码块围栏，按字数上限截断。
 * @param raw 模型输出。
 * @param max 上限。
 */
export function cleanTalk(raw: string, max: number): string {
  const flattened = normalizeForMatch(raw)
    .replace(/```[a-zA-Z]*/g, '')
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '')
    .trim()
  return cutTo(flattened, max)
}

/** 分支实现。 */
export class SurrealBranch implements DreamBranch {
  /** 分支名。 */
  readonly mode = 'surreal' as const
  /** 梦话需要模型；荒诞边不需要。 */
  readonly needsModel = false

  /**
   * 跑一场荒诞梦。
   * @param input 入参。
   * @param at 时间戳。
   * @param context 上下文。
   */
  async run(input: DreamInput, at: number, context: BranchContext): Promise<DreamReport> {
    const { core, graph, gateway, settings, log, report } = context
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

    if (core === undefined || !core.available) {
      return Object.freeze({ ...base, ok: false, reason: 'no-core' as const, note: '没有可用的记忆内核' })
    }

    // 1. 找配对。
    const records = this.scanFacts(core, settings.scanLimit, settings.pageSize, context)
    const pairs = findSurrealPairs(records, settings, settings.maxSurrealPerNight)

    // 2. 建边（不写记忆正文，所以**不请快照**：备份留给会改记忆的闸式分支）。
    let edges = 0
    if (graph === undefined || !graph.available) {
      report({ code: 'no-graph', detail: '没有图谱服务：荒诞边建不了，梦话照常' })
    } else {
      for (const pair of pairs) {
        try {
          const result = graph.link({ from: pair.from.id, to: pair.to.id, relation: 'surreal', at })
          if (result.created) edges += 1
        } catch (error) {
          log.warn('建荒诞边失败（%s → %s）：%s', pair.from.id, pair.to.id, messageOf(error))
        }
      }
    }

    // 3. 梦话（有模型才生成）。
    const talk: DreamTalk[] = []
    if (gateway === undefined || !gateway.available) {
      report({ code: 'no-model', detail: '没有模型网关：这一晚只有荒诞边，没有梦话' })
    } else {
      const seeds = this.pickSeeds(input, pairs)
      try {
        const completion = await gateway.complete({
          messages: [{ role: 'user', content: buildTalkMessage(seeds) }],
          system: TALK_SYSTEM_PROMPT,
          temperature: settings.talkTemperature,
          maxTokens: 200,
          ...(input.mode === 'surreal' && input.signal !== undefined ? { signal: input.signal } : {}),
        })
        const text = cleanTalk(completion.text, settings.talkMaxChars)
        if (charCount(text) < settings.talkMinChars) {
          report({
            code: 'talk-rejected',
            detail: `梦话只有 ${charCount(text)} 字，短于下限 ${settings.talkMinChars} 字，这一晚不记梦话`,
          })
        } else {
          const entry: DreamTalk = Object.freeze({
            id: makeId('dt', at),
            text,
            date,
            createdAt: at,
            consumedAt: 0,
          })
          context.store.addTalk(entry)
          talk.push(entry)
        }
      } catch (error) {
        report({ code: 'gateway-failed', detail: `梦话调用失败：${messageOf(error)}` })
      }
    }

    const note =
      pairs.length === 0
        ? `没有找到「同实体但隔了 ${settings.surrealMinGapDays} 天以上」的配对，这一晚没有荒诞联想`
        : `找到 ${pairs.length} 对，新建 ${edges} 条荒诞边，梦话 ${talk.length} 句`

    context.store.recordDream({
      id: makeId('dl', at),
      date,
      mode: this.mode,
      at,
      facts: 0,
      cards: 0,
      talk: talk.length,
      edges,
      note,
    })

    return Object.freeze({
      ok: true,
      mode: this.mode,
      at,
      date,
      candidates: pairs.length,
      written: Object.freeze([]),
      rejected: Object.freeze([]),
      cards: Object.freeze([]),
      talk: Object.freeze(talk),
      edges,
      backup: 'skipped',
      logged: context.store.available,
      note,
    })
  }

  /** 梦话的种子：优先今晚的素材，其次今晚连上的那几条记忆。 */
  private pickSeeds(input: DreamInput, pairs: readonly SurrealPair[]): readonly string[] {
    if (input.mode === 'surreal' && input.material.items.length > 0) {
      return input.material.items.slice(0, 4).map(item => item.text)
    }
    return pairs.slice(0, 4).map(pair => pair.from.text)
  }

  /** 分页扫记忆。 */
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
          detail: `荒诞联想扫到 ${limit} 条上限，只覆盖前 ${limit} 条`,
        })
        break
      }
    }
    return Object.freeze(records)
  }
}

/** 取错误消息。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
