/**
 * 会话存储的两个实现。
 *
 * ## 为什么有两份
 *
 * {@link MemorySessionStore} 是契约的参照实现：行为最简、无副作用，用来在
 * 单元测试里对照。{@link FileSessionStore} 是正式实现，把数据落到磁盘。
 *
 * 两者对外行为必须一致，差异只在"存在哪里"。任何一处行为分叉都会让
 * "测试里通过、实际用起来丢数据"这类问题变得难以定位。
 *
 * ## 文件版为什么不用单个大文件
 *
 * 单文件（所有会话塞进一个 JSON）写入最简单，但每追加一条消息都要重写全部
 * 会话。陪伴类应用的会话会长期累积，几百个会话意味着每次说话都写几 MB，
 * 既慢又容易在写入中断时丢掉全部历史。
 *
 * 因此拆成"一会话一文件"：追加只碰一个文件，某个文件损坏也只影响那一个会话。
 * 不额外维护索引文件——索引与正文是两份数据，一旦不同步就要写修复逻辑；
 * 直接扫描目录能从正文本身得到全部元信息，只有一个真源。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionMessage, SessionMeta, SessionStore } from './types.js'

/** 会话文件的当前格式版本。将来改结构时据此迁移，而不是靠猜字段。 */
const FILE_VERSION = 1

/** 磁盘上单个会话文件的完整形状。 */
interface SessionFile {
  version: number
  id: string
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  /** 绑定的工作区绝对路径。老文件没有这个字段，读回来是空串。 */
  workspace: string
  messages: SessionMessage[]
}

/** 内存版存储。进程退出即丢数据，仅用于测试与对照。 */
export class MemorySessionStore implements SessionStore {
  private readonly metas = new Map<string, SessionMeta>()
  private readonly bodies = new Map<string, SessionMessage[]>()

  async create(title: string, workspace = ''): Promise<SessionMeta> {
    const now = Date.now()
    const id = randomUUID()
    const meta: SessionMeta = {
      id,
      // 空标题会给界面留下一个没有信息的空行，故回落到固定占位。
      title: title.trim() === '' ? DEFAULT_TITLE : title,
      createdAt: now,
      updatedAt: now,
      archived: false,
      workspace,
    }
    this.metas.set(id, meta)
    this.bodies.set(id, [])
    return meta
  }

  async get(id: string): Promise<SessionMeta | undefined> {
    return this.metas.get(id)
  }

  async list(includeArchived: boolean): Promise<SessionMeta[]> {
    const all = [...this.metas.values()]
    const filtered = includeArchived ? all : all.filter((meta) => !meta.archived)
    // 按最近更新倒序：会话列表的首要需求是"刚才聊的那个在最上面"。
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async archive(id: string): Promise<boolean> {
    const meta = this.metas.get(id)
    if (meta === undefined) return false
    // 幂等：已归档的再归档不改时间戳，避免它在"最近更新"里被顶上来。
    if (!meta.archived) {
      meta.archived = true
      meta.updatedAt = Date.now()
    }
    return true
  }

  async append(sessionId: string, message: Omit<SessionMessage, 'id' | 'createdAt'>): Promise<SessionMessage> {
    const body = this.bodies.get(sessionId)
    const meta = this.metas.get(sessionId)
    if (body === undefined || meta === undefined) {
      throw new Error(`会话不存在：${sessionId}`)
    }
    const now = Date.now()
    const full: SessionMessage = { ...message, id: randomUUID(), createdAt: now }
    body.push(full)
    meta.updatedAt = now
    return full
  }

  async messages(sessionId: string): Promise<SessionMessage[]> {
    const body = this.bodies.get(sessionId)
    if (body === undefined) throw new Error(`会话不存在：${sessionId}`)
    // 返回副本，防止调用方就地修改存储内部状态。
    return [...body]
  }

  async deleteMessage(sessionId: string, seq: number): Promise<boolean> {
    const body = this.bodies.get(sessionId)
    const meta = this.metas.get(sessionId)
    if (body === undefined || meta === undefined) throw new Error(`会话不存在：${sessionId}`)
    // 序号越界不是错误：界面可能连点两次删除，第二次要找的那条已经不在了。
    // 返回 false 让调用方知道「什么都没删」，而不是把并发当成故障。
    if (!Number.isInteger(seq) || seq < 0 || seq >= body.length) return false
    body.splice(seq, 1)
    meta.updatedAt = Date.now()
    return true
  }

  async clear(sessionId: string): Promise<number> {
    const body = this.bodies.get(sessionId)
    const meta = this.metas.get(sessionId)
    if (body === undefined || meta === undefined) throw new Error(`会话不存在：${sessionId}`)
    const removed = body.length
    // 用 `length = 0` 而不是换成新数组：存储内部持有的是同一个引用，
    // 换引用会让已经在读旧数组的调用方看到一份永远不再更新的数据。
    body.length = 0
    meta.updatedAt = Date.now()
    return removed
  }
}

/**
 * 落盘版存储。
 *
 * ## 加载时机
 *
 * 构造时就同步读完全部会话文件。为什么不在首次访问时懒加载：会话列表是
 * 首屏内容，懒加载只是把读取的延迟挪到第一次渲染，却要额外维护"加载中"
 * 这个中间状态，得不偿失。
 *
 * ## 写入原子性
 *
 * 每次写入先落临时文件再 `rename`。`rename` 在同一文件系统内是原子的，
 * 因此进程在写入中途被杀时，磁盘上要么是旧文件、要么是新文件，
 * 不会出现被截断的半截 JSON。
 */
export class FileSessionStore implements SessionStore {
  private readonly metas = new Map<string, SessionMeta>()
  private readonly bodies = new Map<string, SessionMessage[]>()

  /**
   * 每个会话一条写入串行链。
   *
   * 存在的理由：连续两条消息几乎同时到达时，两次「读-改-写」会互相覆盖，
   * 后写的把先写的那条吞掉。按会话串行化，不同会话之间仍然并发。
   */
  private readonly writeChains = new Map<string, Promise<void>>()

  private readonly directory: string

  private constructor(directory: string) {
    this.directory = directory
  }

  /**
   * 打开存储。
   *
   * @param directory 数据目录。不存在时自动创建。
   * @returns 已加载完历史会话的存储实例。
   */
  static async open(directory: string): Promise<FileSessionStore> {
    const store = new FileSessionStore(directory)
    await mkdir(directory, { recursive: true })
    await store.loadAll()
    return store
  }

  async create(title: string, workspace = ''): Promise<SessionMeta> {
    const now = Date.now()
    const id = randomUUID()
    const meta: SessionMeta = {
      id,
      title: title.trim() === '' ? DEFAULT_TITLE : title,
      createdAt: now,
      updatedAt: now,
      archived: false,
      workspace,
    }
    this.metas.set(id, meta)
    this.bodies.set(id, [])
    await this.persist(id)
    return meta
  }

  async get(id: string): Promise<SessionMeta | undefined> {
    return this.metas.get(id)
  }

  async list(includeArchived: boolean): Promise<SessionMeta[]> {
    const all = [...this.metas.values()]
    const filtered = includeArchived ? all : all.filter((meta) => !meta.archived)
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async archive(id: string): Promise<boolean> {
    const meta = this.metas.get(id)
    if (meta === undefined) return false
    if (!meta.archived) {
      meta.archived = true
      meta.updatedAt = Date.now()
      await this.persist(id)
    }
    return true
  }

  /**
   * 追加一条消息。
   *
   * @param sessionId 会话 id。
   * @param message 消息内容。
   * @param override 可选的元信息覆盖。用于本轮推理结束后一次性更新标题与更新时间，
   *   避免"改了标题又要落一次盘"。
   */
  async append(
    sessionId: string,
    message: Omit<SessionMessage, 'id' | 'createdAt'>,
    override?: { title?: string },
  ): Promise<SessionMessage> {
    const body = this.bodies.get(sessionId)
    const meta = this.metas.get(sessionId)
    if (body === undefined || meta === undefined) {
      throw new Error(`会话不存在：${sessionId}`)
    }
    const now = Date.now()
    const full: SessionMessage = { ...message, id: randomUUID(), createdAt: now }
    body.push(full)
    meta.updatedAt = now
    if (override?.title !== undefined && meta.title === DEFAULT_TITLE) {
      meta.title = override.title
    }
    await this.persist(sessionId)
    return full
  }

  async messages(sessionId: string): Promise<SessionMessage[]> {
    const body = this.bodies.get(sessionId)
    if (body === undefined) throw new Error(`会话不存在：${sessionId}`)
    return [...body]
  }

  /**
   * 删除一条消息。
   *
   * ## 为什么用序号而不是消息 id
   *
   * 序号是存储自己排出来的顺序，删完立刻重新编号；消息 id 要额外扫一遍
   * 才能换成下标，扫的这一次与真正 splice 之间还可能被并发写入插队。
   * 序号由调用方从 `session.messages` 的返回位置取得，天然与存储同序。
   *
   * 越界返回 false 而不是抛错：界面连点两次删除时，第二次要找的那条
   * 已经不在了——那是正常竞态，不是故障。
   */
  async deleteMessage(sessionId: string, seq: number): Promise<boolean> {
    const body = this.bodies.get(sessionId)
    const meta = this.metas.get(sessionId)
    if (body === undefined || meta === undefined) throw new Error(`会话不存在：${sessionId}`)
    if (!Number.isInteger(seq) || seq < 0 || seq >= body.length) return false
    body.splice(seq, 1)
    meta.updatedAt = Date.now()
    await this.persist(sessionId)
    return true
  }

  /**
   * 清空会话的全部消息，保留会话本身。
   *
   * 与「归档」的区别：归档把整段移出活跃列表但数据不动；清空是真的把
   * 正文删掉。两者都返回受影响的消息条数，供调用方如实告诉用户删了多少。
   */
  async clear(sessionId: string): Promise<number> {
    const body = this.bodies.get(sessionId)
    const meta = this.metas.get(sessionId)
    if (body === undefined || meta === undefined) throw new Error(`会话不存在：${sessionId}`)
    const removed = body.length
    // 就地把长度置零，而不是换一个新数组：存储内部持有的是同一个引用，
    // 换引用会让已经在读旧数组的调用方继续读到一份不再更新的数据。
    body.length = 0
    meta.updatedAt = Date.now()
    await this.persist(sessionId)
    return removed
  }

  /**
   * 物理删除一个会话。
   *
   * 合约里没有这个方法——界面上"删除对话"的语义是归档（数据保留、不出现在列表），
   * 真正删除由用户显式操作数据目录完成。这里保留能力供将来的"清空全部"使用。
   */
  async remove(sessionId: string): Promise<boolean> {
    if (!this.metas.has(sessionId)) return false
    this.metas.delete(sessionId)
    this.bodies.delete(sessionId)
    await unlink(this.pathOf(sessionId)).catch(() => {
      // 文件可能已经不在了，删除的目标状态已达成，不视为失败。
    })
    return true
  }

  /** 扫描目录，把全部会话读进内存。损坏的文件跳过并留痕，不让一个坏文件拖垮启动。 */
  private async loadAll(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      process.stderr.write(`[dsh] 读取会话目录失败：${String(error)}\n`)
      return
    }

    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const full = join(this.directory, name)
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(full, 'utf8'))
      } catch (error) {
        process.stderr.write(`[dsh] 跳过无法解析的会话文件 ${name}：${String(error)}\n`)
        continue
      }
      const file = asSessionFile(parsed)
      if (file === undefined) {
        process.stderr.write(`[dsh] 跳过结构不符的会话文件 ${name}\n`)
        continue
      }
      this.metas.set(file.id, {
        id: file.id,
        title: file.title,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        archived: file.archived,
        workspace: file.workspace,
      })
      this.bodies.set(file.id, file.messages)
    }
  }

  /** 把一个会话写回磁盘。同一会话的写入串行执行，避免并发覆盖。 */
  private async persist(sessionId: string): Promise<void> {
    const previous = this.writeChains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const meta = this.metas.get(sessionId)
      const body = this.bodies.get(sessionId)
      if (meta === undefined || body === undefined) return
      const file: SessionFile = {
        version: FILE_VERSION,
        id: meta.id,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        archived: meta.archived,
        workspace: meta.workspace,
        messages: body,
      }
      const target = this.pathOf(sessionId)
      // 临时文件带进程号与随机后缀：两个实例同时写同一目录时不会互相踩。
      const temporary = `${target}.${String(process.pid)}.${randomUUID().slice(0, 8)}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(file), 'utf8')
        await rename(temporary, target)
      } catch (error) {
        process.stderr.write(`[dsh] 写入会话 ${sessionId} 失败：${String(error)}\n`)
        await unlink(temporary).catch(() => {})
      }
    })
    this.writeChains.set(sessionId, next)
    // 链执行完就丢弃，否则每写一次都会在 Map 里留下一个已完成的 Promise。
    await next
    if (this.writeChains.get(sessionId) === next) this.writeChains.delete(sessionId)
  }

  /** 会话 id 到文件路径。id 由内核生成（UUID），不含路径分隔符，可安全拼接。 */
  private pathOf(sessionId: string): string {
    return join(this.directory, `${sessionId}.json`)
  }
}

/** 未命名会话的占位标题。首轮用户消息到达时会用它判断是否该自动命名。 */
export const DEFAULT_TITLE = '未命名会话'

/**
 * 把磁盘上读到的任意值收窄成 {@link SessionFile}。
 *
 * 逐字段检查而不是直接断言：数据目录是用户可见的，被手工编辑过是常态。
 * 一个少了大括号的文件不该让整个应用起不来。
 */
function asSessionFile(value: unknown): SessionFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return undefined
  if (typeof record.title !== 'string') return undefined
  if (typeof record.createdAt !== 'number') return undefined
  if (typeof record.updatedAt !== 'number') return undefined
  if (!Array.isArray(record.messages)) return undefined

  const messages: SessionMessage[] = []
  for (const item of record.messages) {
    if (typeof item !== 'object' || item === null) continue
    const message = item as Record<string, unknown>
    if (typeof message.id !== 'string') continue
    if (typeof message.content !== 'string') continue
    if (!isRole(message.role)) continue
    messages.push({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: typeof message.createdAt === 'number' ? message.createdAt : 0,
      ...(typeof message.toolName === 'string' ? { toolName: message.toolName } : {}),
    })
  }

  return {
    version: typeof record.version === 'number' ? record.version : FILE_VERSION,
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archived: record.archived === true,
    // 老文件没有 workspace 字段。给空串而不是补一个猜出来的路径：
    // 猜错会让界面显示一个实际并不存在的位置。
    workspace: typeof record.workspace === 'string' ? record.workspace : '',
    messages,
  }
}

/** 判断是否为合法的消息角色。 */
function isRole(value: unknown): value is SessionMessage['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool'
}
