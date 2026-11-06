/**
 * 边表 `memory_multimodal`：**回答「这条记忆是从哪张图/哪段语音来的」**。
 *
 * ## 它为什么不是第二份记忆库
 *
 * 权威正文只有一份，在 O-010 的 `memory_fact.text`。边表里有两列文本，各有各的用处：
 *
 * | 列 | 是什么 | 权威吗 |
 * |---|---|---|
 * | `title` | 一句话标题（与写进 O-010 的 summary 同值） | 否，副本 |
 * | `full_text` | 截断前的全文（手册 §2.2 条目 ≤200 字，超出的留在这里） | 否，留档 |
 *
 * 把边表整张删掉，任何一条记忆都仍然能被检索、被注入、被忘记——
 * 只是「它来自哪张图」查不到了。**这就是它不构成双真源的判据**：
 * 删了不影响主流程，只影响解释力。
 *
 * ## 为什么不用唯一索引保证去重
 *
 * 去重是 `ingest()` 里的**先查后写**（同一进程、同步执行，没有竞态）。
 * 不建唯一索引有两个理由：
 *
 * 1. `dedupe: false` 是合法配置——那时同一内容**本来就该**记两条；
 *   唯一索引会让这个配置直接写不进去，变成「关不掉的开关」；
 * 2. 建唯一索引在历史数据有重复时会失败，而建表失败会让**整张边表不可用**——
 *    为了一个「不该发生」的重复，赔上全部元数据，不划算。
 *
 * 普通索引 + 先查后写，代价是极端情况下多一条重复；收益是这张表永远建得起来。
 *
 * ## 为什么不用 `raw`（原始 SQL）
 *
 * 一旦写 SQL 就绑死 SQLite，而 O-007 的内存后端是「SQLite 打不开时的兜底」。
 * 边表跟着一起失效，比丢元数据更糟——那时连「哪条记忆是多模态的」都不知道了。
 */

import type {
  DetectionBox,
  FilterLike,
  LogLike,
  MmEntry,
  MmQuery,
  Modality,
  RowLike,
  StoreLike,
  TableSpecLike,
  TranscriptSpan,
} from './types.js'
import { MM_TABLE, MODALITIES } from './types.js'
import { messageOf, numberOr, stringOr } from './text.js'

/** 查询条数默认上限。 */
export const LIST_LIMIT_DEFAULT = 50

/** 查询条数硬上限（内存保护，不是召回预算）。 */
export const LIST_LIMIT_MAX = 500

/** 边表结构。时间一律存毫秒整数（与 O-010 / O-012 / O-140 同口径）。 */
const TABLE: TableSpecLike = Object.freeze({
  name: MM_TABLE,
  columns: Object.freeze([
    { name: 'fact_id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'modality', type: 'TEXT', notNull: true },
    { name: 'source_path', type: 'TEXT', notNull: true },
    { name: 'fingerprint', type: 'TEXT', notNull: true },
    { name: 'title', type: 'TEXT' },
    { name: 'provider', type: 'TEXT' },
    { name: 'model', type: 'TEXT' },
    { name: 'chars', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'full_chars', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'truncated', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'frames', type: 'TEXT' },
    { name: 'spans', type: 'TEXT' },
    { name: 'boxes', type: 'TEXT' },
    { name: 'degraded', type: 'TEXT' },
    { name: 'full_text', type: 'TEXT' },
    { name: 'at', type: 'INTEGER', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
  ]),
  indexes: Object.freeze([
    { name: 'idx_memory_multimodal_fp', columns: Object.freeze(['fingerprint']) },
    { name: 'idx_memory_multimodal_modality', columns: Object.freeze(['modality']) },
    { name: 'idx_memory_multimodal_at', columns: Object.freeze(['at']) },
  ]),
  strict: true,
} satisfies TableSpecLike)

/** 读 JSON 数组列；坏了就当空数组（不抛，因为一条坏行不该让整次查询失败）。 */
function jsonArrayOf(value: unknown): readonly unknown[] {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 读时间戳数组。 */
function spansOf(value: unknown): readonly TranscriptSpan[] {
  const out: TranscriptSpan[] = []
  for (const item of jsonArrayOf(value)) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const start = numberOr(row['startMs'])
    const end = numberOr(row['endMs'])
    const text = stringOr(row['text'])
    if (start === undefined || end === undefined || text === undefined) continue
    const speaker = stringOr(row['speaker'])
    out.push(
      speaker === undefined || speaker === ''
        ? { startMs: start, endMs: end, text }
        : { startMs: start, endMs: end, text, speaker },
    )
  }
  return out
}

/** 读检测框数组。 */
function boxesOf(value: unknown): readonly DetectionBox[] {
  const out: DetectionBox[] = []
  for (const item of jsonArrayOf(value)) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const label = stringOr(row['label'])
    const x = numberOr(row['x'])
    const y = numberOr(row['y'])
    const w = numberOr(row['w'])
    const h = numberOr(row['h'])
    if (label === undefined || x === undefined || y === undefined || w === undefined || h === undefined) {
      continue
    }
    const confidence = numberOr(row['confidence'])
    out.push(confidence === undefined ? { label, x, y, w, h } : { label, x, y, w, h, confidence })
  }
  return out
}

/** 读字符串数组。 */
function stringsOf(value: unknown): readonly string[] {
  const out: string[] = []
  for (const item of jsonArrayOf(value)) {
    const text = stringOr(item)
    if (text !== undefined && text !== '') out.push(text)
  }
  return out
}

/** 一行 → 视图。 */
function entryOf(row: RowLike): MmEntry | undefined {
  const factId = stringOr(row['fact_id'])
  const modality = stringOr(row['modality'])
  if (factId === undefined || factId === '' || modality === undefined) return undefined
  if (!(MODALITIES as readonly string[]).includes(modality)) return undefined
  return {
    factId,
    modality: modality as Modality,
    sourcePath: stringOr(row['source_path']) ?? '',
    fingerprint: stringOr(row['fingerprint']) ?? '',
    title: stringOr(row['title']) ?? '',
    provider: stringOr(row['provider']) ?? '',
    model: stringOr(row['model']) ?? null,
    chars: Math.trunc(numberOr(row['chars']) ?? 0),
    fullChars: Math.trunc(numberOr(row['full_chars']) ?? 0),
    truncated: (numberOr(row['truncated']) ?? 0) !== 0,
    frames: stringsOf(row['frames']),
    spans: spansOf(row['spans']),
    boxes: boxesOf(row['boxes']),
    degraded: stringOr(row['degraded']) ?? null,
    at: Math.trunc(numberOr(row['at']) ?? 0),
    createdAt: Math.trunc(numberOr(row['created_at']) ?? 0),
  }
}

/** 边表。 */
export class MmIndex {
  private readonly store: StoreLike
  private readonly log: LogLike

  /**
   * 上一次失败有没有已经打过 warn。
   *
   * 只在**日志**上防重，不在**尝试**上防重：`ensureTable()` 是幂等的，
   * 一次瞬时失败（库正忙、卷暂时不可写）之后应当能自己好起来。
   * 写成「试过一次就不再试」，等于把一次三秒的抖动变成永久的「查不到来源」。
   */
  private loggedFailure = false
  private ready = false

  /**
   * @param store 存储端口。
   * @param log 日志。
   */
  constructor(store: StoreLike, log: LogLike) {
    this.store = store
    this.log = log
  }

  /** 边表可写不可写。 */
  get available(): boolean {
    return this.ready
  }

  /** 后端标识（不可写时是空串）。 */
  get provider(): string {
    return this.ready ? this.store.provider : ''
  }

  /**
   * 建表（幂等，**懒调用**：第一次要写时才建）。
   *
   * 为什么懒：装载期宿主正忙，一次建表（含三个索引）会把「启动慢」记到本包头上；
   * 而绝大多数会话根本不会发图。第一次要写时建，失败也只影响那一次。
   * @returns 是否可写。
   */
  ensure(): boolean {
    if (this.ready) return true
    try {
      const result = this.store.ensureTable(TABLE)
      for (const issue of result.issues) {
        this.log.warn('多模态边表建表问题（%s）：%s', issue.code, issue.detail)
      }
      this.ready = true
      this.loggedFailure = false
    } catch (error) {
      // 建不起来不是致命：记忆正文照样能进 O-010，只是「来自哪张图」查不到。
      // 下一次要写时**再试**——瞬时失败不该变成永久缺能力。
      this.ready = false
      if (!this.loggedFailure) {
        this.loggedFailure = true
        this.log.warn('多模态边表建表失败（记忆正文照常入库，只是查不到来源）：%s', messageOf(error))
      } else {
        this.log.debug('多模态边表仍未建好：%s', messageOf(error))
      }
    }
    return this.ready
  }

  /**
   * 写一行。已存在同 `fact_id` 时**不覆盖**（返回 false）：
   * 一条记忆只有一条来源，覆盖等于把前一次的来源悄悄抹掉。
   * @param entry 视图。
   * @param fullText 全文留档。
   */
  put(entry: MmEntry, fullText: string): boolean {
    if (!this.ensure()) return false
    try {
      const exists = this.store.get(MM_TABLE, { fact_id: entry.factId })
      if (exists !== undefined) return false
      this.store.insert(MM_TABLE, {
        fact_id: entry.factId,
        modality: entry.modality,
        source_path: entry.sourcePath,
        fingerprint: entry.fingerprint,
        title: entry.title,
        provider: entry.provider,
        model: entry.model,
        chars: entry.chars,
        full_chars: entry.fullChars,
        truncated: entry.truncated ? 1 : 0,
        frames: JSON.stringify(entry.frames),
        spans: JSON.stringify(entry.spans),
        boxes: JSON.stringify(entry.boxes),
        degraded: entry.degraded,
        full_text: fullText,
        at: entry.at,
        created_at: entry.createdAt,
      })
      return true
    } catch (error) {
      this.log.warn('多模态边表写入失败（记忆正文已在库里，只是查不到来源）：%s', messageOf(error))
      return false
    }
  }

  /**
   * 按指纹查一行。
   * @param fingerprint 指纹。
   */
  byFingerprint(fingerprint: string): MmEntry | undefined {
    if (fingerprint === '' || !this.ensure()) return undefined
    try {
      const rows = this.store.select(MM_TABLE, {
        where: [{ column: 'fingerprint', op: 'eq', value: fingerprint }],
        orderBy: [{ column: 'created_at', direction: 'asc' }],
        limit: 1,
      })
      const first = rows[0]
      return first === undefined ? undefined : entryOf(first)
    } catch (error) {
      this.log.debug('多模态边表按指纹查询失败：%s', messageOf(error))
      return undefined
    }
  }

  /**
   * 按记忆 id 查一行。
   * @param factId 记忆 id。
   */
  byFactId(factId: string): MmEntry | undefined {
    if (factId === '' || !this.ensure()) return undefined
    try {
      const row = this.store.get(MM_TABLE, { fact_id: factId })
      return row === undefined ? undefined : entryOf(row)
    } catch (error) {
      this.log.debug('多模态边表按 id 查询失败：%s', messageOf(error))
      return undefined
    }
  }

  /**
   * 查一批。
   * @param query 条件。
   */
  list(query?: MmQuery): readonly MmEntry[] {
    if (!this.ensure()) return []
    const where: FilterLike[] = []
    if (query?.modality !== undefined) {
      where.push({ column: 'modality', op: 'eq', value: query.modality })
    }
    if (query?.sourcePath !== undefined && query.sourcePath !== '') {
      where.push({ column: 'source_path', op: 'eq', value: query.sourcePath })
    }
    const rawLimit = query?.limit
    const limit =
      rawLimit === undefined || !Number.isFinite(rawLimit)
        ? LIST_LIMIT_DEFAULT
        : Math.min(LIST_LIMIT_MAX, Math.max(1, Math.trunc(rawLimit)))
    const direction = query?.order === 'asc' ? 'asc' : 'desc'
    try {
      const rows = this.store.select(MM_TABLE, {
        ...(where.length === 0 ? {} : { where }),
        orderBy: [{ column: 'created_at', direction }],
        limit,
      })
      const out: MmEntry[] = []
      for (const row of rows) {
        const entry = entryOf(row)
        if (entry !== undefined) out.push(entry)
      }
      return out
    } catch (error) {
      this.log.debug('多模态边表列举失败：%s', messageOf(error))
      return []
    }
  }

  /**
   * 按记忆 id 取全文留档。
   *
   * 单独一个方法而不是塞进 `MmEntry`：`list()` 一次回 50 行，每行都带全文
   * 就是几十万字进内存——而绝大多数调用（面板列表、审计清单）根本不需要全文。
   * @param factId 记忆 id。
   */
  fullTextOf(factId: string): string | undefined {
    if (factId === '' || !this.ensure()) return undefined
    try {
      const row = this.store.get(MM_TABLE, { fact_id: factId })
      if (row === undefined) return undefined
      const text = stringOr(row['full_text'])
      return text === undefined || text === '' ? undefined : text
    } catch (error) {
      this.log.debug('多模态边表取全文失败：%s', messageOf(error))
      return undefined
    }
  }

  /** 行数（不可写时 0）。 */
  count(): number {
    // **不调 ensure()**：`stats()` 会被面板轮询，一次轮询顺手建一张表
    // 就等于「读一下统计」也有写副作用。行数不准比偷建表可接受。
    if (!this.ready) return 0
    try {
      return this.store.count(MM_TABLE)
    } catch {
      return 0
    }
  }
}
