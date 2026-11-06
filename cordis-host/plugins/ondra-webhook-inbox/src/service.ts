/**
 * 接线与降级：把纯判定层（`fingerprint.ts` / `priority.ts`）接上时钟、路径与存档。
 *
 * ## 只有两个方法会写盘
 *
 * `ingest()` 入箱、`ack()` 确认。其余三个（`pending()` / `snapshot()` / `stats()`）都是只读的，
 * 外壳随便轮询都不会改变任何状态——否则「取一次就少一条」会让重试变成漏播。
 *
 * ## 为什么 `pending()` 不推进
 *
 * 投递这件事一定会在外面失败（网络、通道、六道闸）。如果 `pending()` 取出即算投递，
 * 一次失败就是永久漏播。所以「取」与「确认」必须分开：取到的条目在 `ack()` 之前
 * 会一直出现在下一批里，最多是重复取，不会是丢。
 *
 * ## 四种降级，各自看得见
 *
 * | 缺什么 | 退回什么 | 怎么看出来 |
 * |---|---|---|
 * | `ondra-path-layout` | 只在内存，重启后收件箱为空 | `stored=false` |
 * | `ondra-clock` | 静默判断用系统本地时区 | 无感，不额外报 |
 * | `ondra-config-schema` | 插件实例配置 + 本地 `completeConfig` | 一行 `warn` |
 * | `ondra-identity` | 命名空间退回 `ondra.webhook-inbox` | 无感，不额外报 |
 *
 * ## 它不发出任何一句话
 *
 * 返回值只有条目、原因与额度。没有消息模板、没有通道、没有发送调用——
 * 发不发、怎么发、发到哪，全部归 O-042 的六道闸。
 */

import type {
  AckResult,
  ClockLike,
  InboxEvent,
  InboxItem,
  InboxPolicy,
  InboxService,
  InboxSnapshot,
  InboxStats,
  IngestResult,
  LogLike,
  PathLike,
  PendingBatch,
  WebhookInboxErrorCode,
} from './types.js'
import { STATE_FILE_NAME, WebhookInboxError } from './types.js'
import type { Config } from './settings.js'
import { policyOf } from './settings.js'
import { fingerprintOf, isKeyList, isToken, summarize } from './fingerprint.js'
import { compareItems, expireItems, inQuietHours, normalizePriority, oldestIndex, selectDeliverable } from './priority.js'
import type { FingerprintEntry, InboxState } from './store.js'
import { ACK_STAMPS_CAP, readState, writeState } from './store.js'

/** 一小时的毫秒数。 */
const HOUR_MS = 3_600_000

/** 事件源 / 类型的长度上限。 */
const TOKEN_LIMIT = 64

/** 依赖。 */
export interface InboxDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 时钟服务（可能缺席；只用来取「几点」）。 */
  readonly clock: () => ClockLike | undefined
  /** 路径服务（可能缺席）。 */
  readonly path: () => PathLike | undefined
  /** 系统时钟（毫秒）。 */
  readonly now: () => number
}

/** 把时刻参数规整成合法值；非法一律抛 `bad-request`。 */
function atOf(given: number | undefined, now: () => number): number {
  const at = given === undefined ? now() : given
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    throw new WebhookInboxError('bad-request', '时刻必须是正的有限数', String(given))
  }
  return Math.trunc(at)
}

/** 事件播报收件箱。 */
export class Inbox implements InboxService {
  readonly #deps: InboxDeps

  /** 判定口径（配置换算一次）。 */
  readonly #policy: InboxPolicy

  /** 入箱序号水位。 */
  #seq = 0

  /** 队列。 */
  #items: InboxItem[] = []

  /** 去重表。 */
  #fps: FingerprintEntry[] = []

  /** 最近确认投递的时刻（每个条目一条，做额度用）。 */
  #ackedAt: number[] = []

  /** 是否已经读过盘。 */
  #loaded = false

  /** 最近一次写盘是否成功。 */
  #writeOk = false

  /** 累计计数（只在内存）。 */
  #ingested = 0
  #accepted = 0
  #duplicates = 0
  #evicted = 0
  #expired = 0
  #quietHeld = 0
  #delivered = 0
  #rateLimited = 0
  #fingerprintEvicted = 0
  #writes = 0
  #writeFailures = 0

  /** 最近一次失败原因。 */
  #lastIssue: string | undefined

  /**
   * @param deps 依赖。
   */
  constructor(deps: InboxDeps) {
    this.#deps = deps
    this.#policy = policyOf(deps.settings)
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): WebhookInboxErrorCode | undefined {
    return this.available ? undefined : 'disabled'
  }

  /** 状态是否真的落盘。 */
  get stored(): boolean {
    return this.#filePath() !== undefined && (this.#writeOk || !this.#loaded)
  }

  /** 存档的绝对路径；缺路径服务时 `undefined`。 */
  #filePath(): string | undefined {
    const path = this.#deps.path()
    if (path === undefined) return undefined
    try {
      return path.fileIn('user', STATE_FILE_NAME)
    } catch (error) {
      this.#lastIssue = '拼不出收件箱存档路径：' + this.#messageOf(error)
      return undefined
    }
  }

  /** 取错误消息文本。 */
  #messageOf(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  /** 首次使用时惰性读盘。 */
  #ensureLoaded(): void {
    if (this.#loaded) return
    this.#loaded = true
    const result = readState(this.#filePath())
    this.#load(result.state)
    this.#writeOk = this.#filePath() !== undefined
    if (result.issue !== undefined) {
      this.#lastIssue = result.issue
      this.#deps.log.warn('%s（本次启动收件箱按空箱处理）', result.issue)
    }
  }

  /** 把存档内容搬进内存字段。 */
  #load(state: InboxState): void {
    this.#seq = state.seq
    this.#items = [...state.items]
    this.#fps = [...state.fingerprints]
    this.#ackedAt = [...state.ackedAt]
  }

  /** 落盘。失败只记日志并计数，**永不抛出**。 */
  #persist(): void {
    const filePath = this.#filePath()
    if (filePath === undefined) {
      this.#writeOk = false
      return
    }
    const state: InboxState = {
      seq: this.#seq,
      items: this.#items,
      fingerprints: this.#fps,
      ackedAt: this.#ackedAt,
    }
    try {
      writeState(filePath, state)
      this.#writes += 1
      this.#writeOk = true
    } catch (error) {
      this.#writeFailures += 1
      this.#writeOk = false
      this.#lastIssue = '写收件箱存档失败：' + this.#messageOf(error)
      this.#deps.log.warn('%s（重启后会丢收件箱与去重表）', this.#lastIssue)
    }
  }

  /** 总开关关掉时，写方法一律拒绝（读接口照常）。 */
  #guard(): void {
    if (!this.available) {
      throw new WebhookInboxError('disabled', '事件播报收件箱已关闭（enable=false）')
    }
  }

  /** 当前时刻。 */
  #now(): number {
    return this.#deps.now()
  }

  /** 取某个时刻的小时数（优先走 O-003，缺席用系统本地时区）。 */
  #hourOf(at: number): number {
    const clock = this.#deps.clock()
    if (clock === undefined) return new Date(at).getHours()
    try {
      const hour = clock.parts(at).hour
      if (Number.isInteger(hour) && hour >= 0 && hour <= 23) return hour
      return new Date(at).getHours()
    } catch (error) {
      // 静默判断不该因为时钟服务坏掉就失效：退回本地时区，并把原因留下。
      this.#lastIssue = '时钟服务取值失败，静默判断退回系统本地时区：' + this.#messageOf(error)
      return new Date(at).getHours()
    }
  }

  /** 现在是否静默。 */
  #quietAt(at: number): boolean {
    if (!this.#policy.quietEnabled) return false
    return inQuietHours(this.#hourOf(at), this.#policy.quietStartHour, this.#policy.quietEndHour)
  }

  /** 本小时剩余额度（按 `ack()` 记下的时刻算）。 */
  #quota(at: number): number {
    const since = at - HOUR_MS
    let used = 0
    for (const stamp of this.#ackedAt) {
      // 未来时刻不计数：时钟回拨时不该凭空烧掉额度。
      if (stamp >= since && stamp <= at) used += 1
    }
    const left = this.#policy.maxPerHour - used
    return left > 0 ? left : 0
  }

  /** 找某个指纹的记录。 */
  #fingerprintOf(fp: string): FingerprintEntry | undefined {
    return this.#fps.find(entry => entry.fp === fp)
  }

  /** 丢掉某条指纹（条目被丢弃时必须一起丢）。 */
  #dropFingerprint(fp: string): void {
    this.#fps = this.#fps.filter(entry => entry.fp !== fp)
  }

  /**
   * 清掉过期的东西：超龄条目 + 超出窗口的指纹。**不落盘**（由调用方决定何时写）。
   * @param at 当前时刻。
   */
  #prune(at: number): void {
    const result = expireItems(this.#items, at, this.#policy.maxAgeMs)
    if (result.expired.length > 0) {
      this.#items = [...result.kept]
      for (const item of result.expired) this.#dropFingerprint(item.id)
      this.#expired += result.expired.length
      // 过期清理意味着「这几条永远不会播了」。不报出来，就没人知道箱子里漏过东西。
      this.#deps.log.info(
        '%d 条事件超过 %d 小时未投递，已清理（不会补播）',
        result.expired.length,
        this.#deps.settings.maxAgeHours,
      )
    }
    const ttl = this.#policy.fingerprintTtlMs
    this.#fps = this.#fps.filter(entry => at - entry.firstAt < ttl)
  }

  /**
   * 交一条事件进来。
   * @param event 宿主解析好的事件。
   * @param at 时刻，省略用事件自带的 `at`，再省略用系统时间。
   */
  ingest(event: InboxEvent, at?: number): IngestResult {
    this.#guard()
    if (event === null || typeof event !== 'object') {
      throw new WebhookInboxError('bad-request', '事件必须是对象', String(event))
    }
    if (!isToken(event.source, TOKEN_LIMIT)) {
      throw new WebhookInboxError('bad-request', '事件源必填且不超过 64 字符', String(event.source))
    }
    if (!isToken(event.type, TOKEN_LIMIT)) {
      throw new WebhookInboxError('bad-request', '事件类型必填且不超过 64 字符', String(event.type))
    }
    const keys = event.key === undefined ? [] : event.key
    if (!isKeyList(keys)) {
      throw new WebhookInboxError('bad-request', '关键字段必须是字符串数组', String(keys))
    }
    const stamp = atOf(at ?? event.at, () => this.#now())
    this.#ensureLoaded()
    this.#ingested += 1

    // 先清过期，再算去重：否则一条早该清掉的指纹会把新事件挡成「重复」。
    this.#prune(stamp)

    const fp = fingerprintOf(event.source, event.type, keys)
    const known = this.#fingerprintOf(fp)
    if (known !== undefined && stamp - known.firstAt < this.#policy.fingerprintTtlMs) {
      // 去重窗内已见过。**刷新指纹时刻是禁止的**：否则每分钟上报一次的事件
      // 会让窗口无限延长，而「同一件事一小时说一遍」正是要避免的东西。
      this.#duplicates += 1
      return Object.freeze({
        accepted: false,
        reason: 'duplicate',
        id: fp,
        queued: this.#items.length,
        held: this.#quietAt(stamp),
      })
    }

    const item: InboxItem = Object.freeze({
      id: fp,
      source: event.source.trim(),
      type: event.type.trim(),
      priority: normalizePriority(event.priority),
      summary: summarize(event.summary, this.#policy.summaryMaxChars),
      at: stamp,
      seq: this.#seq + 1,
    })

    // 箱子满了，且这条比箱子里最旧的还旧：丢它，不要把刚发生的那条挤掉。
    // 补投的历史事件在队列满时应当出局，这是「丢最旧」这条规则的自然推论。
    if (this.#items.length >= this.#policy.queueCap) {
      const oldest = oldestIndex(this.#items)
      const oldestItem = oldest >= 0 ? this.#items[oldest] : undefined
      if (oldestItem !== undefined && item.at < oldestItem.at) {
        this.#evicted += 1
        this.#deps.log.warn(
          '队列已满（上限 %d 条），且这条事件比箱内最旧的还旧，直接丢弃：%s / %s',
          this.#policy.queueCap,
          item.source,
          item.type,
        )
        return Object.freeze({
          accepted: false,
          reason: 'evicted',
          id: fp,
          queued: this.#items.length,
          held: this.#quietAt(stamp),
        })
      }
    }

    this.#seq = item.seq
    this.#items.push(item)
    const dropped: InboxItem[] = []
    while (this.#items.length > this.#policy.queueCap) {
      const index = oldestIndex(this.#items)
      if (index < 0) break
      const gone = this.#items.splice(index, 1)[0]
      if (gone !== undefined) {
        // 条目丢了，指纹也必须丢：留着指纹会让「从未播过的事件」被当成播过了。
        this.#dropFingerprint(gone.id)
        dropped.push(gone)
        this.#evicted += 1
      }
    }
    if (dropped.length > 0) {
      // 显式说丢了什么。静默截断会让「为什么这条没播」永远查不出来。
      this.#deps.log.warn(
        '队列已满（上限 %d 条），丢弃最旧的 %d 条：%s',
        this.#policy.queueCap,
        dropped.length,
        dropped.map(entry => entry.source + '/' + entry.type).join('、'),
      )
    }

    if (known !== undefined) {
      // 指纹过期后重新入箱：时刻归零，去重窗从这一次重新算。
      this.#dropFingerprint(fp)
    }
    this.#fps.push(Object.freeze({ fp, firstAt: stamp }))
    this.#trimFingerprints()

    this.#accepted += 1
    const held = this.#quietAt(stamp)
    if (held) this.#quietHeld += 1
    this.#persist()

    return Object.freeze({
      accepted: true,
      reason: 'accepted',
      id: fp,
      queued: this.#items.length,
      held,
    })
  }

  /** 去重表超出上限时挤掉最早的那些。**挤掉意味着可能重播，必须记数。** */
  #trimFingerprints(): void {
    let evicted = 0
    while (this.#fps.length > this.#policy.fingerprintCap) {
      let index = 0
      let bestAt = Number.POSITIVE_INFINITY
      for (let i = 0; i < this.#fps.length; i += 1) {
        const entry = this.#fps[i] as FingerprintEntry
        if (entry.firstAt < bestAt) {
          index = i
          bestAt = entry.firstAt
        }
      }
      this.#fps.splice(index, 1)
      evicted += 1
      this.#fingerprintEvicted += 1
    }
    if (evicted > 0) {
      this.#deps.log.warn(
        '去重表超过上限（%d 条），挤掉最早的 %d 条；这些事件在去重窗内可能被重播一次',
        this.#policy.fingerprintCap,
        evicted,
      )
    }
  }

  /**
   * 取一批可投递的条目。**只读**。
   * @param at 时刻，省略用系统时间。
   */
  pending(at?: number): PendingBatch {
    const stamp = atOf(at, () => this.#now())
    this.#ensureLoaded()
    const quiet = this.#quietAt(stamp)
    const quota = this.#quota(stamp)
    const result = selectDeliverable(this.#items, {
      maxBatch: this.#policy.maxBatch,
      quota,
      quiet,
      now: stamp,
      maxAgeMs: this.#policy.maxAgeMs,
    })
    if (result.reason === 'rate-limited') this.#rateLimited += 1
    let stale = 0
    for (const item of this.#items) {
      if (stamp - item.at >= this.#policy.maxAgeMs) stale += 1
    }
    return Object.freeze({
      items: result.items,
      reason: result.reason,
      quiet,
      quota,
      queued: this.#items.length,
      stale,
    })
  }

  /**
   * 确认这些条目已经投递出去。
   * @param ids 条目 id 列表。
   * @param at 时刻，省略用系统时间。
   */
  ack(ids: readonly string[], at?: number): AckResult {
    this.#guard()
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
      throw new WebhookInboxError('bad-request', '确认列表必须是字符串数组', String(ids))
    }
    const stamp = atOf(at, () => this.#now())
    this.#ensureLoaded()
    this.#prune(stamp)

    const wanted = new Set<string>()
    for (const id of ids) {
      const text = id.trim()
      if (text !== '') wanted.add(text)
    }

    const kept: InboxItem[] = []
    const removed: string[] = []
    for (const item of this.#items) {
      if (wanted.has(item.id)) {
        removed.push(item.id)
        wanted.delete(item.id)
      } else {
        kept.push(item)
      }
    }

    if (removed.length > 0) {
      this.#items = kept
      this.#delivered += removed.length
      // 每条投递各记一个时刻：额度是「一小时最多投几条」，不是「最多 ack 几次」。
      for (let i = 0; i < removed.length; i += 1) this.#ackedAt.push(stamp)
      if (this.#ackedAt.length > ACK_STAMPS_CAP) {
        this.#ackedAt = this.#ackedAt.slice(-ACK_STAMPS_CAP)
      }
      this.#persist()
    }

    return Object.freeze({
      removed: removed.length,
      unknown: Object.freeze([...wanted]),
      queued: this.#items.length,
    })
  }

  /**
   * 全量只读视图。
   * @param at 时刻，省略用系统时间。
   */
  snapshot(at?: number): InboxSnapshot {
    const stamp = atOf(at, () => this.#now())
    this.#ensureLoaded()
    const ttl = this.#policy.fingerprintTtlMs
    let live = 0
    for (const entry of this.#fps) {
      if (stamp - entry.firstAt < ttl) live += 1
    }
    const items = [...this.#items].sort(compareItems)
    return Object.freeze({
      items: Object.freeze(items),
      queued: this.#items.length,
      quiet: this.#quietAt(stamp),
      quota: this.#quota(stamp),
      fingerprints: live,
      available: this.available,
      stored: this.stored,
    })
  }

  /** 累计统计快照。 */
  stats(): InboxStats {
    this.#ensureLoaded()
    const base = {
      ingested: this.#ingested,
      accepted: this.#accepted,
      duplicates: this.#duplicates,
      evicted: this.#evicted,
      expired: this.#expired,
      quietHeld: this.#quietHeld,
      delivered: this.#delivered,
      rateLimited: this.#rateLimited,
      fingerprintEvicted: this.#fingerprintEvicted,
      writes: this.#writes,
      writeFailures: this.#writeFailures,
      stored: this.stored,
    }
    return Object.freeze(this.#lastIssue === undefined ? base : { ...base, lastIssue: this.#lastIssue })
  }
}
