/**
 * 做梦的三张表（本插件独占）。
 *
 * | 表 | 粒度 | 为什么要单独一张 |
 * |---|---|---|
 * | `dream_log` | 一晚一条 | 「这一晚做了什么、写了多少、建了几条边」是记账 |
 * | `dream_talk` | 一句一条 | 梦话要**逐条消费**（次日首次对话注入一次就不再重复） |
 * | `dream_card` | 一张一条 | 卡片要**单独衰减**（各自的闲置时长不同） |
 *
 * 合成一张表会怎样：`dream_talk` 的「已注入」变成行级覆盖，
 * 而「这一晚的记账」是整晚一条——两个粒度挤在一张表里，改一个字段就动到另一个。
 *
 * **手册说「梦话存 `dream_log`」**：本插件用 `dream_talk` 承载同一语义
 * （字段同构、可原样导出），理由同上。这是解释性差异，不是冲突，已在 README 登记。
 *
 * 权重**不落库**：`0.5^(闲置小时/168)` 是闭式函数，算一次与算一百次结果一样。
 * 存一份就会出现「库里写着 0.42、算出来 0.31」两个答案（O-013 已经踩过同型的坑）。
 */

import type {
  CardRow,
  DreamCard,
  DreamLogEntry,
  DreamLogPort,
  DreamTalk,
  LogLike,
  RowLike,
  StoreLike,
  TableSpecLike,
} from './types.js'

/** 记账表。 */
export const TABLE_DREAM_LOG = 'dream_log'

/** 梦话表。 */
export const TABLE_DREAM_TALK = 'dream_talk'

/** 卡片表。 */
export const TABLE_DREAM_CARD = 'dream_card'

/** 三张表的声明。 */
export const DREAM_TABLE_SPECS: readonly TableSpecLike[] = Object.freeze([
  Object.freeze({
    name: TABLE_DREAM_LOG,
    columns: Object.freeze([
      Object.freeze({ name: 'id', type: 'TEXT' as const, primaryKey: true }),
      Object.freeze({ name: 'date', type: 'TEXT' as const, notNull: true, default: "''" }),
      Object.freeze({ name: 'mode', type: 'TEXT' as const, notNull: true, default: "''" }),
      Object.freeze({ name: 'at', type: 'INTEGER' as const, notNull: true, default: '0' }),
      Object.freeze({ name: 'facts', type: 'INTEGER' as const, notNull: true, default: '0' }),
      Object.freeze({ name: 'cards', type: 'INTEGER' as const, notNull: true, default: '0' }),
      Object.freeze({ name: 'talk', type: 'INTEGER' as const, notNull: true, default: '0' }),
      Object.freeze({ name: 'edges', type: 'INTEGER' as const, notNull: true, default: '0' }),
      Object.freeze({ name: 'note', type: 'TEXT' as const, notNull: true, default: "''" }),
    ]),
    indexes: Object.freeze([Object.freeze({ name: 'idx_dream_log_at', columns: Object.freeze(['at']) })]),
  }),
  Object.freeze({
    name: TABLE_DREAM_TALK,
    columns: Object.freeze([
      Object.freeze({ name: 'id', type: 'TEXT' as const, primaryKey: true }),
      Object.freeze({ name: 'text', type: 'TEXT' as const, notNull: true, default: "''" }),
      Object.freeze({ name: 'date', type: 'TEXT' as const, notNull: true, default: "''" }),
      Object.freeze({ name: 'created_at', type: 'INTEGER' as const, notNull: true, default: '0' }),
      Object.freeze({ name: 'consumed_at', type: 'INTEGER' as const, notNull: true, default: '0' }),
    ]),
    indexes: Object.freeze([
      Object.freeze({ name: 'idx_dream_talk_created', columns: Object.freeze(['created_at']) }),
    ]),
  }),
  Object.freeze({
    name: TABLE_DREAM_CARD,
    columns: Object.freeze([
      Object.freeze({ name: 'id', type: 'TEXT' as const, primaryKey: true }),
      Object.freeze({ name: 'kind', type: 'TEXT' as const, notNull: true, default: "''" }),
      Object.freeze({ name: 'title', type: 'TEXT' as const, notNull: true, default: "''" }),
      Object.freeze({ name: 'body', type: 'TEXT' as const, notNull: true, default: "''" }),
      Object.freeze({ name: 'tags', type: 'TEXT' as const, notNull: true, default: "''" }),
      Object.freeze({ name: 'created_at', type: 'INTEGER' as const, notNull: true, default: '0' }),
      Object.freeze({ name: 'last_used_at', type: 'INTEGER' as const, notNull: true, default: '0' }),
      Object.freeze({ name: 'uses', type: 'INTEGER' as const, notNull: true, default: '0' }),
    ]),
    indexes: Object.freeze([
      Object.freeze({ name: 'idx_dream_card_kind', columns: Object.freeze(['kind', 'title']) }),
    ]),
  }),
])

/** 取整数。 */
function intOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return fallback
}

/** 取字符串。 */
function strOf(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** 解析标签 JSON（坏数据返回空数组，不抛）。 */
function tagsOf(value: unknown): readonly string[] {
  if (typeof value !== 'string' || value.trim() === '') return Object.freeze([])
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return Object.freeze([])
    return Object.freeze(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return Object.freeze([])
  }
}

/** 生成一个合法 id（匹配 `^[a-z][a-z0-9_-]{1,63}$`，与记忆 id 同一把尺子）。 */
export function makeId(prefix: string, at: number): string {
  const random = Math.floor(Math.random() * 1_679_616).toString(36)
  return `${prefix}_${at.toString(36)}_${random}`
}

/** 记账存储。 */
export class DreamStore implements DreamLogPort {
  private readonly store: StoreLike | undefined
  private readonly log: LogLike
  private ready = false

  /**
   * @param store 存储端口；缺席则全部降级为「不落盘」。
   * @param log 日志。
   */
  constructor(store: StoreLike | undefined, log: LogLike) {
    this.store = store
    this.log = log
  }

  /** 是否可用（端口在位且三张表都建好）。 */
  get available(): boolean {
    return this.store !== undefined && this.ready
  }

  /** 建表。失败不抛，只降级。 */
  ensure(): boolean {
    if (this.store === undefined) {
      this.log.warn('没有存储端口：做梦不落盘（梦话与卡片只在内存里，进程退出即失）')
      return false
    }
    try {
      for (const spec of DREAM_TABLE_SPECS) {
        const result = this.store.ensureTable(spec)
        if (result.addedColumns.length > 0) {
          this.log.info('%s 补列：%s', result.table, result.addedColumns.join('、'))
        }
      }
      this.ready = true
      return true
    } catch (error) {
      this.log.warn('做梦三张表初始化失败：%s', error instanceof Error ? error.message : String(error))
      this.ready = false
      return false
    }
  }

  /** 写一条记账。 */
  recordDream(entry: DreamLogEntry): void {
    if (!this.available || this.store === undefined) return
    try {
      this.store.upsert(TABLE_DREAM_LOG, {
        id: entry.id,
        date: entry.date,
        mode: entry.mode,
        at: entry.at,
        facts: entry.facts,
        cards: entry.cards,
        talk: entry.talk,
        edges: entry.edges,
        note: entry.note,
      })
    } catch (error) {
      this.log.warn('写做梦记账失败：%s', error instanceof Error ? error.message : String(error))
    }
  }

  /** 读记账（新→旧）。 */
  recentDreams(limit: number): readonly DreamLogEntry[] {
    if (!this.available || this.store === undefined) return Object.freeze([])
    try {
      const rows = this.store.select(TABLE_DREAM_LOG, {
        orderBy: [{ column: 'at', direction: 'desc' }],
        limit,
      })
      return Object.freeze(rows.map(toLogEntry))
    } catch (error) {
      this.log.warn('读做梦记账失败：%s', error instanceof Error ? error.message : String(error))
      return Object.freeze([])
    }
  }

  /** 写一句梦话。 */
  addTalk(talk: DreamTalk): void {
    if (!this.available || this.store === undefined) return
    try {
      this.store.upsert(TABLE_DREAM_TALK, {
        id: talk.id,
        text: talk.text,
        date: talk.date,
        created_at: talk.createdAt,
        consumed_at: talk.consumedAt,
      })
    } catch (error) {
      this.log.warn('写梦话失败：%s', error instanceof Error ? error.message : String(error))
    }
  }

  /** 待注入的梦话（按写入时间正序：先梦到的先说）。 */
  pendingTalk(): readonly DreamTalk[] {
    if (!this.available || this.store === undefined) return Object.freeze([])
    try {
      const rows = this.store.select(TABLE_DREAM_TALK, {
        where: [{ column: 'consumed_at', op: 'eq', value: 0 }],
        orderBy: [{ column: 'created_at', direction: 'asc' }],
      })
      return Object.freeze(rows.map(toTalk))
    } catch (error) {
      this.log.warn('读梦话失败：%s', error instanceof Error ? error.message : String(error))
      return Object.freeze([])
    }
  }

  /** 标记梦话已注入。 */
  consumeTalk(ids: readonly string[], at: number): number {
    if (!this.available || this.store === undefined || ids.length === 0) return 0
    let changed = 0
    for (const id of ids) {
      try {
        changed += this.store.update(TABLE_DREAM_TALK, { id }, { consumed_at: at })
      } catch (error) {
        // 单条失败不回滚：注入已经发生了，标记失败只是「下次还会被当成没注入过」。
        this.log.warn('标记梦话已注入失败（%s）：%s', id, error instanceof Error ? error.message : String(error))
      }
    }
    return changed
  }

  /** 写一张卡片。 */
  addCard(row: CardRow): void {
    if (!this.available || this.store === undefined) return
    try {
      this.store.insert(TABLE_DREAM_CARD, {
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        tags: JSON.stringify(row.tags),
        created_at: row.createdAt,
        last_used_at: row.lastUsedAt,
        uses: row.uses,
      })
    } catch (error) {
      this.log.warn('写卡片失败：%s', error instanceof Error ? error.message : String(error))
    }
  }

  /** 同类型同标题的卡片是否已存在。 */
  cardExists(kind: string, title: string): boolean {
    if (!this.available || this.store === undefined) return false
    try {
      const rows = this.store.select(TABLE_DREAM_CARD, {
        where: [
          { column: 'kind', op: 'eq', value: kind },
          { column: 'title', op: 'eq', value: title },
        ],
        limit: 1,
      })
      return rows.length > 0
    } catch (error) {
      this.log.warn('查卡片失败：%s', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /** 全部卡片行。 */
  listCards(): readonly CardRow[] {
    if (!this.available || this.store === undefined) return Object.freeze([])
    try {
      const rows = this.store.select(TABLE_DREAM_CARD, {
        orderBy: [{ column: 'created_at', direction: 'desc' }],
      })
      return Object.freeze(rows.map(toCardRow))
    } catch (error) {
      this.log.warn('读卡片失败：%s', error instanceof Error ? error.message : String(error))
      return Object.freeze([])
    }
  }

  /** 标记卡片被用到。 */
  useCard(id: string, at: number): boolean {
    if (!this.available || this.store === undefined) return false
    try {
      const row = this.store.get(TABLE_DREAM_CARD, { id })
      if (row === undefined) return false
      const uses = intOf(row['uses'], 0) + 1
      return this.store.update(TABLE_DREAM_CARD, { id }, { last_used_at: at, uses }) > 0
    } catch (error) {
      this.log.warn('标记卡片被用到失败（%s）：%s', id, error instanceof Error ? error.message : String(error))
      return false
    }
  }
}

/** 一行 → 记账。 */
function toLogEntry(row: RowLike): DreamLogEntry {
  return Object.freeze({
    id: strOf(row['id'], ''),
    date: strOf(row['date'], ''),
    mode: strOf(row['mode'], 'gate') as DreamLogEntry['mode'],
    at: intOf(row['at'], 0),
    facts: intOf(row['facts'], 0),
    cards: intOf(row['cards'], 0),
    talk: intOf(row['talk'], 0),
    edges: intOf(row['edges'], 0),
    note: strOf(row['note'], ''),
  })
}

/** 一行 → 梦话。 */
function toTalk(row: RowLike): DreamTalk {
  return Object.freeze({
    id: strOf(row['id'], ''),
    text: strOf(row['text'], ''),
    date: strOf(row['date'], ''),
    createdAt: intOf(row['created_at'], 0),
    consumedAt: intOf(row['consumed_at'], 0),
  })
}

/** 一行 → 卡片行。 */
function toCardRow(row: RowLike): CardRow {
  return Object.freeze({
    id: strOf(row['id'], ''),
    kind: strOf(row['kind'], ''),
    title: strOf(row['title'], ''),
    body: strOf(row['body'], ''),
    tags: tagsOf(row['tags']),
    createdAt: intOf(row['created_at'], 0),
    lastUsedAt: intOf(row['last_used_at'], 0),
    uses: intOf(row['uses'], 0),
  })
}

/** 卡片行 → 带权重的卡片。 */
export function toDreamCard(row: CardRow, weight: number, archived: boolean): DreamCard {
  return Object.freeze({
    id: row.id,
    kind: row.kind as DreamCard['kind'],
    title: row.title,
    body: row.body,
    tags: row.tags,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    uses: row.uses,
    weight,
    archived,
  })
}
