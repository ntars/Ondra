/**
 * 做梦的**宿主侧调用方** —— `run()` 与梦话注入的唯一接线处。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-memory-dream` 把三支分支、四道闸、五类卡片的规则挖掘、荒诞边的
 * 同实体近似、三张表、记账、读回校验全写完了，README 连「为什么不做重写
 * 摘要」都写清了。缺的是两样，两样都不报错：
 *
 * ```
 * 不在默认启用名单   ← 服务不注册，config 段恒标「插件已停用」
 * run() 零调用方     ← 即便装上，一场梦都不会发生，dream_log 恒 0 行
 * talk() 零调用方    ← 梦话产出来也没人往提示词里放
 * ```
 *
 * 这是本仓第十二次踩同一个形态（A 写、B 读、中间少根线），也是第三次
 * 同一类漏判：**`ctx.get('ondra-memory-dream')` 全仓命中数为 0**，
 * 静态普查据此判「没有插件消费它」，而漏掉了宿主自己。前两次是
 * `ondra-emotion-diffuse` 与 `ondra-memory-heal`。
 *
 * ## 为什么落笔在宿主
 *
 * | 候选 | 为什么不行 |
 * | --- | --- |
 * | 插件自己装定时器 | 插件文件头明写「不装定时器，22:00 与空闲多久都由调用方给」。那不是偷懒，是防止出现「不知道第几个装载的定时器」 |
 * | 插件自己读 `memory_raw` | 它只认 `MemoryCoreLike`，而内核**没有读原文的公开方法**（只有 `appendTurn` 写）。要它自己查表就得让它认识存储端口，那是把两层的边界搅在一起 |
 * | **宿主做** | 宿主同时握着「这一轮结束了」「多久没动」「库在哪儿」三件事，且已有一处 `publishTurn` 在做同类接线 |
 *
 * ## 三条纪律
 *
 * 1. **素材只取原文，不取事实。** 闸式做梦的价值是「补带逐字出处的事实」，
 *    素材必须是用户真说过的话（`memory_raw`），不能是已提炼的事实——
 *    拿事实当素材就等于让模型给自己的结论找出处，四道闸挡不住这种自证。
 * 2. **一天最多一场。** 判据是 `history()` 里今天有没有记录，不是内存里的
 *    一个布尔——进程重启后布尔就丢了，而库里的记账还在。
 * 3. **梦话只注入一次。** 注入后立刻 `consume()`。不标记的话，同一句梦话
 *    会在之后每一轮都被塞进提示词，她就会连着几天说同一句呓语。
 */

import type { Context } from '@ntars/cordis'
import type { SystemPromptPart } from './system-prompt.js'

/**
 * 记忆原文层的一行（只取做梦要用的四列）。
 *
 * 表名写死成字面量而不是 import 内核的常量：宿主与插件之间不 import 源码
 * （§18.5 同一条纪律），一致性由 `check-acceptance` 的表名断言钉住。
 */
interface RawRow {
  readonly id: string
  readonly role: string
  readonly text: string
  readonly created_at: number
}

/** 存储端口的原始 SQL 面（只取 `all`）。 */
interface SqlFacetLike {
  all<T = unknown>(sql: string, ...params: (string | number | null)[]): T[]
}

/** 存储端口的结构对位子集。 */
interface StoreLike {
  readonly raw?: SqlFacetLike
}

/** 素材条目（与插件的 `DreamMaterialItem` 结构对位）。 */
interface MaterialItem {
  readonly text: string
  readonly source: 'USER' | 'TOOL' | 'ACT' | 'SELF'
  readonly at: number
}

/** 做梦服务的结构对位子集。 */
interface DreamPort {
  readonly available: boolean
  readonly reason?: string
  readonly mode: 'gate' | 'lightweight' | 'surreal'
  run(input: unknown): Promise<DreamReportLike>
  talk(): readonly DreamTalkLike[]
  consume(ids: readonly string[], at?: number): number
  cards(at?: number): readonly DreamCardLike[]
  history(limit?: number): readonly DreamLogLike[]
  stats(): Record<string, unknown>
}

/** 一场梦的报告（只取界面与日志要用的字段）。 */
interface DreamReportLike {
  readonly ok: boolean
  readonly reason?: string
  readonly mode: string
  readonly at: number
  readonly date: string
  readonly candidates: number
  readonly written: readonly unknown[]
  readonly rejected: readonly unknown[]
  readonly cards: readonly unknown[]
  readonly talk: readonly unknown[]
  readonly edges: number
  readonly backup: 'created' | 'skipped' | 'failed'
  readonly logged: boolean
  readonly note?: string
}

/** 一句梦话。 */
interface DreamTalkLike {
  readonly id: string
  readonly text: string
  readonly date: string
  readonly createdAt: number
  readonly consumedAt: number
}

/** 一张卡片。 */
interface DreamCardLike {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly body: string
  readonly weight: number
  readonly archived: boolean
  readonly uses: number
}

/** 一条记账。 */
interface DreamLogLike {
  readonly id: string
  readonly date: string
  readonly mode: string
  readonly at: number
  readonly facts: number
  readonly cards: number
  readonly talk: number
  readonly edges: number
  readonly note: string
}

/**
 * 素材条数上限。
 *
 * 与插件的 `scan-limit`（默认 500）不是一回事：那是它扫库的上限，这里是
 * 宿主递进去的条数。取 40 的理由是「一晚的梦只看最近几十句话」——
 * 递五百条进去，模型的注意力会被摊平，而 token 成本线性涨。
 */
const MAX_MATERIAL = 40

/**
 * 一次注入几句梦话。
 *
 * 只取 1 句：梦话是**呓语**，连着三句会让整轮回复变成意识流。
 * 剩下的留在库里，明天再说。
 */
const MAX_TALK_PER_TURN = 1

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 本地日期键（`YYYY-MM-DD`）。
 *
 * 为什么不用 `toISOString()`：那是 UTC。东八区凌晨 1 点做的一场梦
 * 会被记成前一天，于是「一天最多一场」在跨零点时会连做两场。
 * 插件自己的 `dateKey()` 用的是本地时区，这里必须同口径。
 *
 * @param at 时间戳。
 */
function localDateKey(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/**
 * 从原文表里取素材。
 *
 * 只取 `role='user'` 的行：她自己的回复是 SELF，而闸式做梦按设计只补
 * 「用户说过的事」——把她的回复也当素材，会让模型给自己的话找出处。
 *
 * @param store 存储端口。
 * @param limit 取多少条。
 * @returns 新→旧之外的顺序：**按时间正序**（模型读素材要顺着说话顺序）。
 */
function readMaterial(store: StoreLike | undefined, limit: number): MaterialItem[] {
  const sql = store?.raw
  if (sql === undefined) return []
  let rows: RawRow[]
  try {
    /*
     * `ORDER BY created_at DESC` 后在外面反转：SQL 需要 LIMIT 才能只取最近
     * 那么多条，而模型读的顺序要与说话顺序一致。先倒序取、再正序喂。
     */
    rows = sql.all<RawRow>(
      'SELECT id, role, text, created_at FROM memory_raw WHERE role = ? ORDER BY created_at DESC LIMIT ?',
      'user',
      limit,
    )
  } catch {
    // 表不存在（内核建表失败过）不是致命：返回空素材，报告里会说「没有素材」。
    return []
  }
  const out: MaterialItem[] = []
  for (const row of [...rows].reverse()) {
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    if (text === '') continue
    out.push({ text, source: 'USER', at: Number(row.created_at) || Date.now() })
  }
  return out
}

/** 做梦的探针读数（诊断与界面共用）。 */
export interface DreamProbe {
  /** 服务在不在。 */
  readonly loaded: boolean
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: string
  /** 当前分支。 */
  readonly mode?: string
  /** 插件累计统计。 */
  readonly stats?: Record<string, unknown> | null
  /** 最近几场梦（新→旧）。 */
  readonly history?: readonly DreamLogLike[]
  /** 卡片（按权重降序）。 */
  readonly cards?: readonly DreamCardLike[]
  /** 待注入的梦话条数。 */
  readonly pendingTalk?: number
}

/**
 * 读一次做梦的状态。
 *
 * 与 `projectionProbe` 同一口径：把「没装 / 装了不可用 / 装了可用」三种
 * 状态分开报，因为它们在界面上长得一样，含义却完全不同。
 *
 * @param ctx 宿主上下文。
 */
export function dreamProbe(ctx: Context): DreamProbe {
  const service = ctx.get('ondra-memory-dream') as DreamPort | undefined
  if (service === undefined) {
    return Object.freeze({ loaded: false, available: false, reason: 'not-loaded' })
  }
  let stats: Record<string, unknown> | null = null
  let history: readonly DreamLogLike[] = []
  let cards: readonly DreamCardLike[] = []
  let pendingTalk = 0
  try {
    stats = service.stats()
    history = service.history(10)
    cards = service.cards()
    pendingTalk = service.talk().length
  } catch (error) {
    // 读取出错也要能把「服务在、但读不动」说出来。
    return Object.freeze({
      loaded: true,
      available: service.available === true,
      ...(service.reason === undefined ? {} : { reason: service.reason }),
      mode: service.mode,
      stats: { error: messageOf(error) },
    })
  }
  return Object.freeze({
    loaded: true,
    available: service.available === true,
    ...(service.reason === undefined ? {} : { reason: service.reason }),
    mode: service.mode,
    stats,
    history,
    cards,
    pendingTalk,
  })
}

/** 一场梦的执行结果（给路由与日志用）。 */
export interface DreamRunOutcome {
  /** 是否跑了。`false` 表示今天已经跑过（或被显式拒绝）。 */
  readonly ran: boolean
  /** 没跑的原因。 */
  readonly skipped?: 'already-today' | 'not-loaded' | 'unavailable' | 'no-material'
  /** 报告（跑了才有）。 */
  readonly report?: DreamReportLike
  /** 一句人话，进日志与界面。 */
  readonly note: string
}

/**
 * 做一场梦。
 *
 * ## 为什么在这里判「今天跑过没有」
 *
 * 插件自己不判——它明写「22:00 与空闲多久都由调用方给」，也就是**频率归宿主**。
 * 而判据必须是库里的记账（`history()`），不能是内存布尔：进程一重启布尔就丢，
 * 于是同一天可能被重启几次就做几场梦，而每一场都会往记忆库里加事实。
 *
 * ## 为什么素材为空就返回 `no-material` 而不是照样调 `run()`
 *
 * 插件收到空素材会返回一条 `ok: true, candidates: 0` 的报告，并**不记入
 * `dream_log`**（它写在 `material.items.length === 0` 的早退分支里）。
 * 于是「跑过一场空梦」在库里的痕迹是零——如果宿主在这里不拦，
 * 界面上就会显示「刚做完一场梦、写了 0 条」，而库里什么都没发生。
 *
 * @param ctx 宿主上下文。
 * @param options.force 忽略「今天跑过」这道闸（界面上「再来一场」用）。
 */
export async function runDream(
  ctx: Context,
  options: { readonly force?: boolean } = {},
): Promise<DreamRunOutcome> {
  const service = ctx.get('ondra-memory-dream') as DreamPort | undefined
  if (service === undefined) {
    return Object.freeze({ ran: false, skipped: 'not-loaded', note: '没有装载 ondra-memory-dream' })
  }
  if (service.available !== true) {
    return Object.freeze({
      ran: false,
      skipped: 'unavailable',
      note: `做梦不可用（${service.reason ?? '未知原因'}）`,
    })
  }

  const at = Date.now()
  const today = localDateKey(at)

  if (options.force !== true) {
    let ranToday = false
    try {
      ranToday = service.history(60).some(entry => entry.date === today)
    } catch {
      // 读不出记账就当作「没跑过」：宁可多做一场，也不要因为读失败而永远不做。
      ranToday = false
    }
    if (ranToday) {
      return Object.freeze({ ran: false, skipped: 'already-today', note: '今天已经做过一场梦了' })
    }
  }

  const store = ctx.get('ondra-store-sqlite') as StoreLike | undefined
  const material = readMaterial(store, MAX_MATERIAL)
  if (material.length === 0) {
    return Object.freeze({ ran: false, skipped: 'no-material', note: '还没有可做素材的对话（原文层是空的）' })
  }

  let report: DreamReportLike
  try {
    /*
     * 分支入参按 `service.mode` 组装，**不在这里按配置猜**：
     * 插件自己会在 `mode` 不一致时返回 `mode-mismatch`，而那是一条
     * 更容易读懂的原因码，比宿主猜错分支后收到一堆拒收要好。
     */
    report = await service.run(
      service.mode === 'lightweight'
        ? { mode: 'lightweight', sleep: { idleMs: 0, signals: [] }, at }
        : { mode: service.mode, material: { items: material }, at },
    )
  } catch (error) {
    return Object.freeze({ ran: true, note: `做梦抛错：${messageOf(error)}` })
  }

  return Object.freeze({
    ran: true,
    report,
    note: report.note ?? `做完一场梦：写了 ${String(report.written.length)} 条`,
  })
}

/**
 * 把待注入的梦话取出来，并标记已注入。
 *
 * ## 为什么「取」与「标记」必须在一次调用里
 *
 * 分两步写（先 `talk()` 再 `consume()`）会有两个调用方各自读到同一句，
 * 各自标记一次——第二次标记返回 0，但那段文本已经进了两份提示词。
 * 合成一个函数，调用方就没有「只取不标」的机会。
 *
 * ## 为什么注入后立刻标记
 *
 * 不标记的话，同一句梦话会在之后每一轮都被塞进提示词，她会连着几天
 * 说同一句呓语。这是「梦话」这个词唯一的产品含义：它只在次日第一次
 * 见面时说一次。
 *
 * @param ctx 宿主上下文。
 * @param at 时刻。
 * @returns 拼好的那一段；没有待注入的梦话时返回 `undefined`。
 */
export function takeDreamTalk(ctx: Context, at: number = Date.now()): SystemPromptPart | undefined {
  const service = ctx.get('ondra-memory-dream') as DreamPort | undefined
  if (service === undefined || service.available !== true) return undefined

  let pending: readonly DreamTalkLike[] = []
  try {
    pending = service.talk()
  } catch {
    // 读梦话失败只让这一轮少一句呓语，不该影响整轮对话。
    return undefined
  }
  if (pending.length === 0) return undefined

  const picked = pending.slice(0, MAX_TALK_PER_TURN)
  const ids = picked.map(item => item.id)
  try {
    // 标记失败也要把文本送出去：宁可下轮重复一次，也不要这一场梦白做。
    service.consume(ids, at)
  } catch {
    // 吞掉：见上。
  }

  /*
   * 文本里**必须标明这是梦话**，而且要说清「怎么用它」。
   *
   * ## 为什么只说「这是梦话」不够
   *
   * 真机验过一次：只写「这是梦话，不是真事」，她收到后的第一反应是
   * **直接复述**——用户问「你昨天梦见什么了吗」，她把那句呓语一字不差说了出来。
   * 这不算错，但梦话的产品含义不是「可以背诵的梦日记」，而是**语气的一点底色**：
   * 它该让她今天说话带一点没来由的恍惚，而不是让她多一条可引用的内容。
   *
   * 所以这里给三条明确动作：不必主动提、被问起才说、说的时候别逐字背。
   * 这三条与插件 README 里「梦话次日首次对话注入并标注这是梦话」不冲突——
   * 它只管**产出正文并交出去**，怎么用归宿主，而这里是唯一知道
   * 「这一轮真的有用户在场」的地方。
   */
  const lines = picked.map(item => item.text.trim()).filter(text => text !== '')
  if (lines.length === 0) return undefined
  const text = [
    '昨夜梦里的碎片（这是梦话，不是真事，不能当成记忆去确认）：',
    ...lines,
    '用法：不必主动提起，也不必逐字复述。它只是今天语气里一点没来由的恍惚；'
    + '若是被问到，就说记不太清了，顺着那种感觉说话即可。',
  ].join('\n')
  return Object.freeze({
    // 用 `context` 而不是新 id：`SystemPromptPart.id` 的四个值是装配契约的一部分，
    // 加第五个值要么改契约、要么让前端的分段显示漏一段。梦话属于「她想起的事」。
    id: 'context' as const,
    label: '梦话',
    chars: [...text].length,
    text,
  })
}
