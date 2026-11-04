/**
 * 已答集合（`seen`）。**唯一需要跨重启记住的东西。**
 *
 * ## 为什么必须落盘，虽然内存版看起来更干净
 *
 * 本包**只读**：不把短信标成已读。于是设备上的 `read=0` 永远成立，
 * 同一批未读每次轮询都会**原样再出现**。没有跨重启的已答集合，
 * 每次启动都会把最近这批未读全部重答一遍——用户看到的是
 * 「她每次开机都要把三天前的短信再回一次」。
 *
 * 这不是「顺手加个缓存」，是**正确性的一部分**。
 *
 * ## 纪律 142：谁加、谁删、哪条路径会绕过删除
 *
 * - 谁加：`service.ts` 在**转交成功之后**才加（不是转交之前）。
 *   先加会让一次失败的转交永久占位，那条短信再也不会被回应。
 * - 谁删：只有裁剪会删（超过上限时丢最旧的）。
 * - 绕过删除的路径：**没有删除。** 本插件不提供「清除已答」的写接口——
 *   面板上「重答一遍」不是需求，是事故。
 *
 * ## 裁剪为什么会丢消息，以及为什么仍然这么裁
 *
 * 丢最旧的 N 条理论上可能让一条**仍然未读**的旧短信重新排队。
 * 但裁剪只在超过 1000 条时发生，而那 1000 条按加入顺序都是**已经处理过**的；
 * 只有当用户手机里同时悬着上千条未读（且我们一条条答过）时才可能撞上。
 * 手册 §9.11 给的就是 1000→500，本包按它执行并把这一条写进已知限制。
 *
 * ## 写盘：原子 + 0600 + 一次一轮
 *
 * 三次写（直接覆盖）会在断电时留下半个 JSON，下次启动解析失败 → 集合清零 →
 * 全部重答。所以写临时文件再 rename（同目录内 rename 是原子的）。
 * 权限由调用方经 `ondra-path-layout.prepareFile()` 先建好（0600），本类不自己
 * 造目录，也不改权限——权限的真源在 O-002。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { SEEN_KEEP, SEEN_MAX } from './types.js'

/** 日志子集。 */
export interface SeenLogLike {
  warn(message: string, ...args: readonly unknown[]): void
  info(message: string, ...args: readonly unknown[]): void
}

/** 构造依赖。 */
export interface SeenStoreDeps {
  /** 落盘路径（空串 = 只放内存）。 */
  readonly file: string
  /** 上限（超过就裁到一半）。 */
  readonly max: number
  /** 日志。 */
  readonly log: SeenLogLike
}

/** 落盘格式版本。改结构就加一，老版本一律当空处理（**不猜**）。 */
const FORMAT_VERSION = 1

/**
 * 裁剪后保留多少条。
 *
 * 默认值 1000→500 与手册 §9.11 逐字一致；上限被配置改过时按比例减半，
 * 保证「一次裁剪不会连着裁第二次」——裁到刚好等于上限会导致下一条消息又触发裁剪。
 * @param max 上限。
 */
export function keepOf(max: number): number {
  if (max === SEEN_MAX) return SEEN_KEEP
  return Math.max(1, Math.ceil(max / 2))
}

/** 已答集合。 */
export class SeenStore {
  private readonly deps: SeenStoreDeps

  /** 按加入顺序（旧→新）。 */
  private ids: string[] = []

  /** 判定用的索引，与 `ids` 同步维护。 */
  private index = new Set<string>()

  /** 有未落盘的变更。 */
  private dirty = false

  /** 上次落盘失败的原因（空 = 没失败过）。 */
  private lastError = ''

  constructor(deps: SeenStoreDeps) {
    this.deps = deps
  }

  /** 现有条数。 */
  get size(): number {
    return this.ids.length
  }

  /** 上次落盘失败原因（面板用）。 */
  get error(): string {
    return this.lastError
  }

  /**
   * 从磁盘读回。文件不存在算正常（第一次跑）。
   * @returns 读到的条数。
   */
  load(): number {
    if (this.deps.file === '') return this.size
    let text = ''
    try {
      text = readFileSync(this.deps.file, 'utf8')
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code !== 'ENOENT') {
        this.deps.log.warn('已答集合读取失败（当作空，稍后会重新写回）：%s', textOf(error))
      }
      return this.size
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.deps.log.warn('已答集合不是合法 JSON（当作空；旧内容会在下次写入时被替换）')
      return this.size
    }

    const record = parsed as { version?: unknown; ids?: unknown }
    if (record.version !== FORMAT_VERSION || !Array.isArray(record.ids)) {
      this.deps.log.warn('已答集合格式版本不认识（当作空，不猜）：version=%s', String(record.version))
      return this.size
    }

    const loaded: string[] = []
    for (const item of record.ids) {
      if (typeof item !== 'string' || item === '') continue
      if (loaded.includes(item)) continue
      loaded.push(item)
    }
    this.ids = loaded
    this.index = new Set(loaded)
    if (this.ids.length > this.deps.max) this.trim()
    return this.size
  }

  /**
   * 这条处理过没有。
   * @param id 短信主键。
   */
  has(id: string): boolean {
    return this.index.has(id)
  }

  /**
   * 记一条已处理。
   * @param id 短信主键。
   * @returns 是否真的新增（重复加入返回 false）。
   */
  add(id: string): boolean {
    if (id === '' || this.index.has(id)) return false
    this.index.add(id)
    this.ids.push(id)
    this.dirty = true
    if (this.ids.length > this.deps.max) this.trim()
    return true
  }

  /**
   * 落盘（有变更才写）。**永不抛错**。
   * @returns 是否真的写了。
   */
  flush(): boolean {
    if (!this.dirty || this.deps.file === '') return false
    const payload = JSON.stringify({ version: FORMAT_VERSION, ids: this.ids })
    const temporary = this.deps.file + '.tmp'
    try {
      // 临时文件也用 0600 建：否则 rename 之后文件权限会跟着临时文件走。
      writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.deps.file)
      this.dirty = false
      this.lastError = ''
      return true
    } catch (error) {
      this.lastError = textOf(error)
      this.deps.log.warn('已答集合落盘失败（内存里仍然有效，重启后会重答一批）：%s', this.lastError)
      return false
    }
  }

  /** 清空（只给「重读文件」用，不是对外能力）。 */
  private clear(): void {
    this.ids = []
    this.index = new Set()
    this.dirty = false
  }

  /** 重读磁盘（用户手改过文件时）。 */
  reload(): number {
    this.clear()
    return this.load()
  }

  /** 裁剪：丢最旧的，保留较新的 `keepOf(max)` 条。 */
  private trim(): void {
    const keep = keepOf(this.deps.max)
    const dropped = this.ids.length - keep
    if (dropped <= 0) return
    const kept = this.ids.slice(dropped)
    this.ids = kept
    this.index = new Set(kept)
    this.dirty = true
    this.deps.log.info('已答集合超过 %d 条，按 §9.11 裁到 %d 条（丢最旧的 %d 条）', this.deps.max, keep, dropped)
  }
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
