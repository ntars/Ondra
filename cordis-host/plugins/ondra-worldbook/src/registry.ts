/**
 * 条目库：校验、注册、删除、从文件加载。
 *
 * 三条纪律：
 *
 * 1. **逐条判定，一条坏不连累其余。** 世界书是用户手写的 JSON，
 *    一条写错就整份不加载，等于让用户面对「我明明配了，怎么一条都没有」。
 *
 * 2. **同 id 覆盖是禁止的。** 直接覆盖会制造一类极难查的事故：
 *    用户改了文件、重启、发现「没生效」——因为运行时那条 id 先注册了。
 *    所以同 id 再注册一律拒收，要换内容必须显式 `remove()` 再注册。
 *
 * 3. **文件重复加载视为已加载。** `loadFromFile()` 会在界面「重新导入」时被调用多次，
 *    每次都报一遍 `duplicate` 会把真正的错误埋在噪音里。
 *    只对 `source === 'file'` 的重复静默跳过；其他来源的重复照样报。
 */

import { readFileSync } from 'node:fs'
import { charCount, foldText } from './meter.js'
import { LAYER_IDS } from './types.js'
import type {
  EntryFilter,
  EntryInput,
  EntryProblem,
  FileIssue,
  LayerId,
  LoadResult,
  LogLike,
  RegisterResult,
  TokenMeter,
  WorldbookEntry,
} from './types.js'

/** id 允许的形态：非空、无空白、无冒号（冒号留给"命名空间"语义，故此处禁用）。 */
const ID_FORBIDDEN = /[\s:：]/

/** id 长度上限。 */
const ID_MAX = 64

/** 标题长度上限（防止一条标题把整行撑爆）。 */
const TITLE_MAX = 80

/** 世界书文件大小上限：8 MB。超了不读，避免把内存打满。 */
const FILE_MAX_BYTES = 8 * 1024 * 1024

/**
 * 判断一个值是否是合法的层 id。
 * @param value 值。
 */
export function isLayerId(value: unknown): value is LayerId {
  return typeof value === 'string' && (LAYER_IDS as readonly string[]).includes(value)
}

/** 校验一条输入，返回条目或被拒原因。 */
interface ValidateOutcome {
  readonly entry?: WorldbookEntry
  readonly problem?: EntryProblem
}

/**
 * 校验并落成条目。
 * @param input 输入。
 * @param seq 注册序号。
 * @param meter 计量器。
 * @param maxEntryTokens 单条上限（0 = 不限）。
 */
function validate(
  input: EntryInput,
  seq: number,
  meter: TokenMeter,
  maxEntryTokens: number,
): ValidateOutcome {
  const rawId: unknown = input.id
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (id.length === 0 || id.length > ID_MAX || ID_FORBIDDEN.test(id)) {
    return {
      problem: {
        id,
        code: 'bad-id',
        detail: 'id 必须是非空、不超过 ' + ID_MAX + ' 个字符、且不含空白与冒号的字符串',
      },
    }
  }
  if (!isLayerId(input.layer)) {
    return {
      problem: {
        id,
        code: 'bad-layer',
        detail: 'layer 只能是 ' + LAYER_IDS.join(' / '),
      },
    }
  }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (title.length === 0 || text.length === 0) {
    return { problem: { id, code: 'empty-text', detail: '标题与正文都不能为空' } }
  }
  const folded = foldText(text)
  const tokens = meter(folded)
  if (maxEntryTokens > 0 && tokens > maxEntryTokens) {
    return {
      problem: {
        id,
        code: 'too-large',
        detail: '单条约 ' + tokens + ' token，超过上限 ' + maxEntryTokens + '（整条拒收，不截断）',
      },
    }
  }
  const priority = typeof input.priority === 'number' && Number.isFinite(input.priority) ? input.priority : 0
  const slot = typeof input.slot === 'string' ? input.slot.trim().slice(0, ID_MAX) : ''
  return {
    entry: {
      id,
      layer: input.layer,
      title: title.slice(0, TITLE_MAX),
      text: folded,
      constant: input.constant === true,
      slot,
      priority,
      enabled: input.enabled !== false,
      source: input.source === 'file' || input.source === 'scene' ? input.source : 'runtime',
      seq,
      chars: charCount(folded),
      tokens,
    },
  }
}

/** 条目库。 */
export class WorldbookRegistry {
  private readonly items = new Map<string, WorldbookEntry>()
  private readonly log: LogLike
  private meterFn: TokenMeter
  private maxEntryTokens: number
  private nextSeq = 0
  private rev = 0

  /**
   * @param log 日志。
   * @param meter 计量器。
   * @param maxEntryTokens 单条上限（0 = 不限）。
   */
  constructor(log: LogLike, meter: TokenMeter, maxEntryTokens: number) {
    this.log = log
    this.meterFn = meter
    this.maxEntryTokens = maxEntryTokens
  }

  /** 注册版本号。每次增删 +1。 */
  get revision(): number {
    return this.rev
  }

  /**
   * 换计量器并**重算全部条目的 token**。
   * @param meter 计量器。
   */
  setMeter(meter: TokenMeter): void {
    this.meterFn = meter
    const rebuilt: WorldbookEntry[] = []
    for (const entry of this.items.values()) {
      rebuilt.push({ ...entry, tokens: meter(entry.text) })
    }
    this.items.clear()
    for (const entry of rebuilt) this.items.set(entry.id, entry)
    this.rev += 1
  }

  /**
   * 设置单条上限（若变小，已入库的超限条目**不回溯删除**，只影响之后的注册）。
   * @param value 上限。
   */
  setMaxEntryTokens(value: number): void {
    this.maxEntryTokens = value
  }

  /** 全部条目（按层与序号排，稳定）。 */
  all(): readonly WorldbookEntry[] {
    return Array.from(this.items.values())
  }

  /**
   * 按条件筛。
   * @param filter 条件。
   */
  list(filter?: EntryFilter): readonly WorldbookEntry[] {
    if (filter === undefined) return this.all()
    return this.all().filter(entry => {
      if (filter.layer !== undefined && entry.layer !== filter.layer) return false
      if (filter.source !== undefined && entry.source !== filter.source) return false
      if (filter.constant !== undefined && entry.constant !== filter.constant) return false
      if (filter.enabled !== undefined && entry.enabled !== filter.enabled) return false
      return true
    })
  }

  /**
   * 取一条。
   * @param id 条目 id。
   */
  get(id: string): WorldbookEntry | undefined {
    return this.items.get(id)
  }

  /**
   * 注册一批。逐条判定。
   * @param input 输入。
   */
  register(input: readonly EntryInput[]): RegisterResult {
    const accepted: string[] = []
    const rejected: EntryProblem[] = []
    for (const item of input) {
      const outcome = validate(item, this.nextSeq, this.meterFn, this.maxEntryTokens)
      if (outcome.problem !== undefined) {
        rejected.push(outcome.problem)
        continue
      }
      const entry = outcome.entry
      if (entry === undefined) continue
      if (this.items.has(entry.id)) {
        rejected.push({
          id: entry.id,
          code: 'duplicate',
          detail: '这个 id 已经登记过。要换内容请先 remove()，本插件不静默覆盖',
        })
        continue
      }
      this.items.set(entry.id, entry)
      this.nextSeq += 1
      accepted.push(entry.id)
    }
    if (accepted.length > 0) this.rev += 1
    if (rejected.length > 0) {
      // 只在注册这一处 warn 一次：明细逐条在返回值里，日志只报「有几条没过」，
      // 否则一次导入 30 条错会把日志刷成一片。
      this.log.warn('世界书有 %d 条未通过校验（明细见 register 返回值）', rejected.length)
    }
    return { accepted, rejected }
  }

  /**
   * 删一条。
   * @param id 条目 id。
   */
  remove(id: string): boolean {
    const ok = this.items.delete(id)
    if (ok) this.rev += 1
    return ok
  }

  /**
   * 清空（可按来源）。
   * @param source 来源。
   */
  clear(source?: 'file' | 'runtime' | 'scene'): number {
    let removed = 0
    for (const entry of Array.from(this.items.values())) {
      if (source !== undefined && entry.source !== source) continue
      if (this.items.delete(entry.id)) removed += 1
    }
    if (removed > 0) this.rev += 1
    return removed
  }

  /**
   * 从世界书文件加载。
   * @param filePath 绝对路径。
   * @param exists 文件是否存在。
   */
  loadFromFile(filePath: string, exists: boolean): LoadResult {
    if (!exists) {
      return { loaded: 0, rejected: [], issue: { code: 'no-file', detail: '还没有世界书文件：' + filePath } }
    }
    let raw = ''
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (error) {
      return {
        loaded: 0,
        rejected: [],
        issue: { code: 'read-error', detail: messageOf(error) },
      }
    }
    if (Buffer.byteLength(raw, 'utf8') > FILE_MAX_BYTES) {
      return {
        loaded: 0,
        rejected: [],
        issue: { code: 'read-error', detail: '文件超过 ' + FILE_MAX_BYTES + ' 字节，未读取' },
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { loaded: 0, rejected: [], issue: { code: 'bad-json', detail: messageOf(error) } }
    }
    const list = extractEntries(parsed)
    if (list === undefined) {
      return {
        loaded: 0,
        rejected: [],
        issue: { code: 'bad-shape', detail: '顶层应为 { "entries": [...] }，或直接是一个数组' },
      }
    }
    // 已经是文件来源的条目：视为已加载，静默跳过（见文件头第 3 条）。
    const fresh: EntryInput[] = []
    let skipped = 0
    for (const item of list) {
      const id = typeof item['id'] === 'string' ? item['id'].trim() : ''
      const existing = id.length > 0 ? this.items.get(id) : undefined
      if (existing !== undefined && existing.source === 'file') {
        skipped += 1
        continue
      }
      fresh.push(toInput(item))
    }
    const result = this.register(fresh)
    return { loaded: result.accepted.length + skipped, rejected: result.rejected, issue: undefined }
  }

  /** 重算全部条目的计量（换计量器后条目数字要跟着变）。 */
  remeasure(): void {
    this.setMeter(this.meterFn)
  }
}

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 从解析结果里取出条目数组。
 * @param parsed JSON 解析结果。
 */
function extractEntries(parsed: unknown): readonly Record<string, unknown>[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const list: unknown = (parsed as Record<string, unknown>)['entries']
    if (Array.isArray(list)) {
      return list.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    }
  }
  return undefined
}

/**
 * 把文件里的一条转成输入。**未知字段忽略、缺失字段走默认**——
 * 「字段缺失」与「字段给错」是两条判定，缺失不该让整条消失（见长期纪律）。
 * @param raw 原始条目。
 */
function toInput(raw: Record<string, unknown>): EntryInput {
  const layer = raw['layer']
  const text = raw['text'] ?? raw['content'] ?? raw['body']
  return {
    id: typeof raw['id'] === 'string' ? raw['id'] : '',
    // 层**不猜**：文件里写错了就交给 validate 报 `bad-layer`。
    // 给个 'l1' 兜底等于把「这条设定该在哪层」这件事悄悄替作者决定了。
    layer: layer as LayerId,
    title: typeof raw['title'] === 'string' ? raw['title'] : typeof raw['name'] === 'string' ? raw['name'] : '',
    text: typeof text === 'string' ? text : '',
    constant: raw['constant'] === true || raw['always'] === true,
    slot: typeof raw['slot'] === 'string' ? raw['slot'] : undefined,
    priority: typeof raw['priority'] === 'number' ? raw['priority'] : undefined,
    enabled: raw['enabled'] === false ? false : true,
    source: 'file',
  }
}

/** 文件问题的中文说明（日志用）。 */
export function describeIssue(issue: FileIssue): string {
  switch (issue.code) {
    case 'no-file':
      return '还没有世界书文件（正常状态，不报错）'
    case 'bad-json':
      return '世界书文件不是合法 JSON：' + issue.detail
    case 'bad-shape':
      return '世界书文件结构不对：' + issue.detail
    case 'read-error':
      return '世界书文件读不出来：' + issue.detail
  }
}
