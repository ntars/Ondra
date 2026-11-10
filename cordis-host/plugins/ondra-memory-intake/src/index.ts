/**
 * `ondra-memory-intake`：把对话轮次真正写进记忆。
 *
 * ## 为什么需要这个插件
 *
 * 记忆内核提供了两个写入口——`appendTurn()` 落原文、`addFact()` 落事实，
 * 提炼服务提供了 `extract()` 提炼并直写。但**133 个插件里没有任何一个调用它们**：
 * 记忆库永远是空的，召回应答永远说「我不认识」，右栏永远是「暂无记忆」。
 * 她嘴上会说「记着了」，数据库里一条都没有。本插件补的就是这条断掉的边。
 *
 * ## 三个刻意的决定
 *
 * 1. **监听 `session/event`，不监听 `turn/end`。** 后者只带轮次号与结束原因，
 *    拿不到正文；前者逐条给出 `user/message` 与 `assistant/message`，是唯一
 *    能拿到原话的稳定入口。
 * 2. **一轮一收，攒满再写。** 用户消息与助手回复分属两个事件，中间还可能夹
 *    工具调用。所以按轮次攒，遇到 `turn/end` 才落盘——半轮写进去的原文，
 *    下一轮召回会读到「问了没答」的残句。
 * 3. **写原文与提炼分开、且提炼失败不回滚原文。** 原文是「她经历过这件事」的
 *    证据，提炼只是从原文里挑事实；提炼挂了照样要留下原文，否则一次模型抖动
 *    就等于这一轮没发生过。
 *
 * ## 刻意不做的事
 *
 * - 不判断「这句话值不值得记」。那是提炼服务的证据闸门（O-011）的活，
 *   在这里加一层启发式只会让两处标准打架。
 * - 不改写原文。原文进 `memory_raw` 是为了「顺藤摸回原话」，改写就没法追溯了。
 * - 不阻塞对话。整条链路是 fire-and-forget：采集、写库、提炼都在对话结束后
 *   异步进行，任何一步抛错只记日志，绝不影响已经发出的回复。
 */

import type { Context } from '@ntars/cordis'
import { CONFIG_SECTION_ID, Config, completeConfig } from './settings.js'
import { DEDUPE_SERVICE_KEY, EXTRACT_SERVICE_KEY, INTAKE_SERVICE_KEY } from './types.js'
import type {
  DedupeServiceLike,
  DriveGapLike,
  ExtractResultLike,
  ExtractServiceLike,
  GraphServiceLike,
  IntakeService,
  IntakeStats,
  LogLike,
  MemoryCoreLike,
  PoolServiceLike,
  MessageLike,
  ProspectiveLike,
  SessionEventLike,
  TurnDraft,
} from './types.js'
import { catchPromises } from './promise.js'
import { catchGaps } from './gap.js'
import { feelOnce, readSignal, saveEmotion } from './feel.js'
import type { EmotionLike } from './feel.js'

declare module '@ntars/cordis' {
  interface Context {
    /** 对话轮次采集服务；未装载本插件时为 undefined。 */
    'ondra-memory-intake'?: IntakeService
  }
}

/** 一个轮次草稿最多保留多少字符（防止一整段工具输出把内存撑爆）。 */
const MAX_TURN_CHARS = 8000

/**
 * 把一条消息的内容块拼成纯文本。
 *
 * 只取 `text` 块：推理块与附件不是「她说过的话」，写进记忆会让召回匹配到
 * 一段用户从没见过的思考过程。
 * @param message 消息。
 * @returns 纯文本；没有文本块时为空串。
 */
function textOf(message: MessageLike): string {
  const parts: string[] = []
  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 从会话事件里取出消息；拿不到就返回 undefined（不猜）。
 *
 * `user/message` 与 `assistant/message` 的 `data` **本身就是消息对象**
 * （带 `content` / `role` / `source`），不是 `{ message: … }` 包了一层。
 * 这里先按「就是消息」认，再兼容「包了一层」的写法——两种写法都见得到，
 * 猜错任一种的后果都一样：用户那半轮永远收不到，只有她自己的话进记忆。
 * @param event 会话事件。
 * @returns 消息，或 undefined。
 */
function messageOf(event: SessionEventLike): MessageLike | undefined {
  const data = event.data as (MessageLike & { readonly message?: MessageLike }) | undefined
  if (data === undefined) return undefined
  if (Array.isArray(data.content)) return data
  return data.message
}

/** 本轮草稿：按轮次号攒 user / assistant 原话。 */
interface Draft extends TurnDraft {
  /** 用户与助手的文本，按发生顺序。 */
  readonly lines: { role: 'user' | 'assistant'; text: string }[]
}

/**
 * Cordis 函数插件名。与 `package.json` 的 `name` 去掉 scope 后一致。
 *
 * 必须导出：Cordis 用 `name` 作为插件标识，缺了它框架无法在日志、
 * 依赖声明与 `ctx.get(插件名)` 中引用本插件。旧仓库中这个插件恰好
 * 漏了导出行，迁入时补齐。
 */
export const name = 'ondra-memory-intake'

/**
 * Cordis 入口：注册采集服务并挂上会话监听。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`inject` 里有任何一个上游缺席，整个插件会停在
 * PENDING（静默不加载，最难查的失败形态）。这里全部改成取值函数，
 * 缺谁就跳过哪一步并在统计里留痕。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: unknown): void {
  const settings = completeConfig(config)
  const log = (ctx.logger?.('ondra.memory-intake') ?? console) as LogLike

  const core = (): MemoryCoreLike | undefined => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  const extractor = (): ExtractServiceLike | undefined =>
    ctx.get(EXTRACT_SERVICE_KEY) as ExtractServiceLike | undefined
  /**
   * 判重服务（O-012）。
   *
   * ## 它有与没有，写入语义是两回事
   *
   * | 判重 | 走法 | 说三遍「搭档叫阿岚」之后 |
   * | --- | --- | --- |
   * | 在册 | `propose()` 提炼 → `settle()` 按裁决写 | 一条，`timesSaid=3` |
   * | 缺席 | `extract()` 提炼并直写 | **三条**，库里躺三份 |
   *
   * 所以在册与否不是「多一道检查」，而是「同一件事会被记几遍」。
   * 用取值函数而不是装载时取一次：它与本插件同在 `after: ondra-memory-core`
   * 一层，装载先后由拓扑排序决定，取一次可能拿到 `undefined`——而那个后果
   * 与「没装判重」完全同形（库里悄悄多出重复条目），是最难察觉的一种。
   */
  const dedupeOf = (): DedupeServiceLike | undefined =>
    ctx.get(DEDUPE_SERVICE_KEY) as DedupeServiceLike | undefined
  const poolOf = (): PoolServiceLike | undefined =>
    ctx.get('ondra-memory-pool') as PoolServiceLike | undefined
  /**
   * 图谱服务（O-015），只用来建 `cooccur` 边。
   *
   * ## 为什么归池这一步顺手建边
   *
   * `link()` 全仓唯一的调用方是做梦插件的荒诞分支（建 `surreal` 边）。
   * `same_topic` 按设计归 O-011 提炼 / O-012 判重建，**而这两处都没有实现**，
   * 于是图谱边表从建库起就是 0 行——`relatedness()` 永远返回空，
   * `ondra-memory-recall` 的图谱因子整项恒为缺席，而它的 `available` 仍是 true。
   *
   * 补 `cooccur` 而不补 `same_topic`，是因为**判据的硬度不同**：
   *
   * | 边 | 判据 | 为什么现在能定 |
   * | --- | --- | --- |
   * | `cooccur` | 「同一轮对话里被一起提炼出来」 | 客观事实，`assignPools` 手里正好有这一批 id |
   * | `same_topic` | 「内容同主题」 | 要语义判断，而提炼器不输出主题标签，编一个就是假边 |
   *
   * 初值 0.15、每次 +0.10、扩散门槛 0.4——**要共现三次才算数**。
   * 这是插件刻意的设计：「见过一次」不足以成为「想起来」的依据。
   * 所以这里不改门槛去迁就它，只负责把证据如实记下。
   */
  const graphOf = (): GraphServiceLike | undefined =>
    ctx.get('ondra-memory-graph') as GraphServiceLike | undefined
  /**
   * 承诺与待办服务。
   *
   * 用取值函数而不是装载时取一次：上游晚装载能自愈，早卸载立刻反映。
   * 这也是本插件刻意不声明插件级 `inject` 的原因（见函数头）。
   */
  const prospective = (): ProspectiveLike | undefined =>
    ctx.get('ondra-memory-prospective') as ProspectiveLike | undefined
  /**
   * 缺口池服务（O-129）。
   *
   * 同样是取值函数：`ondra-drive-gap` 的 `after` 只声明了 `ondra-store-sqlite`，
   * 与本插件的装载先后由拓扑排序决定，装载时取一次可能拿到 `undefined`。
   */
  const gapOf = (): DriveGapLike | undefined => ctx.get('ondra-drive-gap') as DriveGapLike | undefined
  /**
   * 情绪服务（O-026）。
   *
   * 取值函数而不是装载时取一次：情绪内核的 `after` 只声明了存储端口，
   * 与本插件的先后不固定。取一次拿到 `undefined` 的后果是**情绪永远是基线**，
   * 而那看起来完全正常（平静是合法状态）。
   */
  const emotionOf = (): EmotionLike | undefined => ctx.get('ondra-emotion-core') as EmotionLike | undefined

  const stats = {
    turns: 0,
    raw: 0,
    facts: 0,
    skipped: 0,
    failed: 0,
    promises: 0,
    todos: 0,
    gaps: 0,
    felt: 0,
  }

  /** 正在攒的轮次，按 session 分桶（多会话并行时不能混）。 */
  const drafts = new Map<unknown, Draft>()
  let sequence = 0
  /**
   * 上一轮对话的时刻（**进程内**，`undefined` 表示本进程还没收过一轮）。
   *
   * ## 为什么只记内存、不读存档
   *
   * 「久别重逢」只需要知道「刚才有没有人说话」。跨进程的那段时间差由
   * 情绪内核自己的闭式回归处理（它按 `settledAt` 补算），这里再读一次存档
   * 就是第二处判断「她离开了多久」——而两处必然漂开：存档里的时刻是
   * **上次落盘**的时刻，不是上次对话的时刻，中间可能差好几天。
   *
   * 代价：重启后的第一轮一定判不出「久别」。这一条是刻意接受的——
   * 重启本身就是一次久别，把它算成「重逢」会让每次开 app 她都莫名精神一下。
   */
  let lastTurnAt: number | undefined
  /** 每轮最多触发几次提炼的并发闸：模型调用不便宜，也不该排队堵死。 */
  let extracting = 0

  const service: IntakeService = {
    get available(): boolean {
      return settings.enable && core() !== undefined
    },
    get reason(): string | undefined {
      if (!settings.enable) return 'disabled'
      if (core() === undefined) return 'no-core'
      return undefined
    },
    stats(): IntakeStats {
      return Object.freeze({
        available: service.available,
        reason: service.reason,
        ...stats,
      })
    },
    /**
     * 手动收一轮（供测试与补录用）。
     * @param turn 轮次内容。
     * @param sinceLastTurn 距上一轮的毫秒数；省略表示判不出「久别」（重启后第一轮就是这种）。
     * @returns 写入结果。
     */
    async ingest(turn: TurnDraft, sinceLastTurn?: number) {
      return flush(turn, sinceLastTurn)
    },
  }

  /**
   * 落一轮：先写原文，再（可选）提炼并写事实。
   * @param draft 轮次草稿。
   * @param sinceLastTurn 距上一轮的毫秒数（`undefined` = 本进程还没收过一轮）。
   * @returns 写入结果。
   */
  async function flush(
    draft: TurnDraft,
    sinceLastTurn?: number,
  ): Promise<{ readonly rawId?: string; readonly facts: number; readonly reason?: string }> {
    log.info?.('收到一轮：%d 行', draft.lines.length)
    const spoken = draft.lines.filter(line => line.text.trim() !== '')
    if (spoken.length === 0) {
      stats.skipped += 1
      return { facts: 0, reason: 'empty-turn' }
    }

    /*
     * 承诺与待办**先于**内核检查。
     *
     * 这里踩过一次：原先这段在整个 `flush` 的最前面就被 `no-core` 拦掉了。
     * 后果是「没装记忆内核 ⇒ 待办也一条都记不下」，而待办按设计**根本不进记忆**
     * （手册 §2.8：「待办一次都不碰记忆内核」）。一条与内核无关的能力被内核
     * 的缺席连坐，症状是「她连你交代的事都不记」——看起来像待办功能没做。
     *
     * 位置也讲究：放在原文落盘之前，因为待办要靠这一轮的用户原话，与落盘无关。
     */
    try {
      const caught = catchPromises(prospective(), spoken, log, draft.at)
      stats.promises += caught.promises
      stats.todos += caught.todos
      if (caught.promises > 0 || caught.todos > 0) {
        log.info?.('记下承诺 %d 条、待办 %d 条', caught.promises, caught.todos)
      }
    } catch (error) {
      log.warn?.('承诺与待办采集失败（本轮跳过）：%s', message(error))
    }

    /*
     * 缺口（执念）同样**先于**内核检查，理由与上面完全一样：
     * 缺口池不碰记忆内核（`ondra-drive-gap` 只依赖存储端口），
     * 让「没装记忆」把「她记不住自己没答上什么」一起挡掉，是同一类连坐。
     *
     * 位置在承诺之后：一轮里既有交代又有困惑时，先落「用户交代的事」，
     * 再落「她自己卡住的事」——前者有明确的时间语义（会到期、会提醒），
     * 后者只是记一笔，先后不影响判定。
     */
    let gapDetected = 0
    try {
      const caught = catchGaps(gapOf(), spoken, log, draft.at)
      stats.gaps += caught.opened
      /*
       * 这个数要留给情绪那一段。
       *
       * `stumble` 信号的准入是「她这轮答不上来」，而它的唯一真源就是
       * `gap.detect()`。再调一次是同一句话判两遍——两遍之间上游若改了词表，
       * 就会得到「记了缺口却没涨张力」这种说不通的组合。
       */
      gapDetected = caught.detected
      if (caught.detected > 0) {
        log.info?.('她这轮有 %d 句没答上来，缺口新建 %d 条、并入 %d 条', caught.detected, caught.opened, caught.merged)
      }
    } catch (error) {
      log.warn?.('缺口采集失败（本轮跳过）：%s', message(error))
    }

    /*
     * 情绪投递：紧跟在缺口判定之后，**独立一层 try/catch**。
     *
     * ## 为什么单独一层，不和缺口共用一个 catch
     *
     * 共用会让「缺口池坏了」连带把情绪一起挡掉——两者一个碰存储、一个碰
     * 情绪内核，完全没有依赖关系。本仓已经踩过两次同类的连坐（待办被
     * 记忆内核缺席挡住、path-layout 缺席让 22 个插件一起退回内存态），
     * 症状都是「A 坏了，B 跟着不动，而日志只说了 A」。
     *
     * ## 为什么在缺口之后、原文之前
     *
     * 情绪是「这一轮刚发生了什么」的直接后果，紧贴着产生它的判定写最清楚。
     * 放到原文落盘之后也不影响正确性，但那时 `flush()` 已进入「记忆」语义，
     * 读者会以为情绪是从记忆里算出来的——实际不是。
     */
    try {
      const emotion = emotionOf()
      const signal = readSignal(spoken, gapDetected, sinceLastTurn)
      const felt = feelOnce(emotion, signal, log, draft.at)
      stats.felt += felt.felt
      if (felt.felt > 0) {
        log.info?.('情绪事件已投：%s（安慰 %d 次）', String(felt.signal), felt.comforted)
        /*
         * 只在真投出去过之后落盘。
         *
         * 一次都没投的轮次不需要写库：`state()` 按闭式公式从 `settledAt`
         * 往前补算，存档里那个时刻足够重启后复原。每轮无脑写一次只是把
         * 同一行覆盖一遍，代价是每轮一次磁盘写。
         */
        saveEmotion(emotion, log, draft.at)
      } else if (felt.reason !== undefined && felt.reason !== 'no-emotion') {
        log.warn?.('情绪事件没投出去：%s', felt.reason)
      }
    } catch (error) {
      log.warn?.('情绪采集失败（本轮跳过）：%s', message(error))
    }

    const memory = core()
    if (memory === undefined || !memory.available) {
      stats.skipped += 1
      log.warn?.('原文与事实跳过：记忆内核不可用（present=%s available=%s）', String(memory !== undefined), String(memory?.available))
      return { facts: 0, reason: 'no-core' }
    }

    // 1. 原文逐条落盘，**保留真实角色**。
    //
    //    此前这里把「用户说的 + 她说的」拼成一段、统一标成 role=user。后果不只是
    //    难看：提炼按角色判定证据来源（USER / SELF），一条混在一起的 `user` 行会让
    //    她的自我介绍被当成「用户说过的事实」——实测抽出来的第一条事实就是
    //    「助手自己说过她在杭州待过几天」。角色错了，事实的归属就全错。
    let rawId: string | undefined
    try {
      for (const [index, line] of spoken.entries()) {
        const raw = memory.appendTurn({
          turnId: `${draft.turnId}#${index}`,
          role: line.role,
          text: line.text.slice(0, MAX_TURN_CHARS),
          ...draft.at === undefined ? {} : { at: draft.at },
        })
        // 只把**用户那一行**的 id 当作本轮原文锚点：事实最终是关于用户的，
        // 追回原话时应该落到用户自己说的话上。
        if (line.role === 'user' && rawId === undefined) rawId = raw?.id
      }
      stats.raw += spoken.length
    } catch (error) {
      stats.failed += 1
      log.warn?.('写入对话原文失败（本轮不进记忆）：%s', message(error))
      return { facts: 0, reason: 'append-failed' }
    }

    // 2. 提炼：关闭时只留原文，照样算「她记得发生过什么」。
    if (!settings.extract) return { rawId, facts: 0 }
    const extract = extractor()
    if (extract === undefined || !extract.available) {
      const why = extract === undefined ? 'no-service' : (extract as { reason?: string }).reason ?? 'unavailable'
      log.warn?.('提炼不可用（原文已保留）：%s', why)
      return { rawId, facts: 0, reason: 'no-extract' }
    }
    if (extracting >= settings.maxConcurrent) return { rawId, facts: 0, reason: 'busy' }

    extracting += 1
    try {
      /*
       * 走哪条写入路径，由「判重在不在册」定。
       *
       * 判重的 `settle()` 才是唯一该决定「新建 / 合并 / 加固 / 丢弃 / 冲突」
       * 的地方；`extract()` 是纯追加。此前这里无条件调 `extract()`，于是
       * `propose()` 与 `settle()` 在整仓都是零调用方——判重插件写得再完整
       * 也不会生效，而症状只是「库里同一句话有好几份」，一眼看过去像正常记录。
       *
       * 判重不可用（内核缺席 / 配置关掉）时**退回 `extract()`**：那是一条
       * 设计好的降级路径（语义是 append，不强求去重），不是失败。
       */
      const dedupe = dedupeOf()
      const useDedupe = dedupe !== undefined && dedupe.available && typeof extract.propose === 'function'
      const request = {
        turnId: draft.turnId,
        ...rawId === undefined ? {} : { rawId },
        messages: spoken.map(line => ({ role: line.role, text: line.text })),
        ...draft.at === undefined ? {} : { at: draft.at },
        ...settings.maxFacts === undefined ? {} : { maxFacts: settings.maxFacts },
      }
      const result: ExtractResultLike = useDedupe
        ? await extract.propose!(request)
        : await extract.extract(request)

      /*
       * 有判重时，提炼只到「候选事实」为止，落库归判重。
       *
       * 为什么把落库放在这一侧而不是让 `propose()` 顺手写：判重需要
       * **先看到候选、再决定合并谁**。先写再合并会把「原本两条独立事实」
       * 这个信息永久抹掉，日志里再也看不出发生过什么。
       */
      let written = result?.written ?? 0
      let poolFacts = result?.facts
      if (useDedupe) {
        const settled = settleAll(dedupe, result?.facts, rawId, draft.at)
        written = settled.written
        // 只把**真的新建成功**的那几条拿去归池。
        //
        // 合并与加固都不产生新行：拿被合并掉的那条正文去回查 id，会命中
        // 主条本身（正文已被改写，其实命中不了，于是空转），更坏的情况是
        // 命中一条**别的**同文事实，把一个池标签贴到无关条目上。
        poolFacts = settled.landed
      }
      stats.facts += written
      // 归池：事实刚写完就在手边，这是唯一能顺手做的地方。
      //
      // 此前 `assign()` 在全仓**没有任何调用方**：事实进了 memory_fact，却一条
      // 池归属都没有。这里要说准一件事——「没归池」本身**不阻断注入**：
      // O-131 对未登记记忆返回 `eligible:true`（八池是分层，不是准入名单）。
      // 真正会挡住注入的是「归了池、却落进海马体」：海马体按设计永不注入。
      // 所以本步的价值是给每条事实一个**能命中的标签**，让寿命分层生效，
      // 而不是靠归池来放行。
      assignPools(poolFacts, draft.at)
      log.info?.(
        '提炼返回：ok=%s written=%s 路径=%s',
        String(result?.ok),
        String(written),
        useDedupe ? 'propose+settle' : 'extract',
      )
      if (result?.ok === false) {
        // 提炼失败不是本轮失败：原文已经在库里，只是这一轮没抽到事实。
        log.warn?.('提炼失败（原文已保留）：%s', result.reason ?? 'unknown')
      }
      return { rawId, facts: written }
    } catch (error) {
      stats.failed += 1
      log.warn?.('提炼抛错（原文已保留）：%s', message(error))
      return { rawId, facts: 0, reason: 'extract-failed' }
    } finally {
      extracting -= 1
    }
  }

  /**
   * 把提炼出的候选逐条交给判重落库。
   *
   * ## 为什么逐条而不是整批
   *
   * 同一轮里的两条事实会互相成为候选：先落的那条应当成为后一条的合并目标。
   * 整批一起判，两条互为候选时「谁是主条」没有答案，裁决只能靠下标，而
   * 下标不是语义。逐条走完，每一次判重看到的都是**已经更新过的库**。
   *
   * ## 一条失败不连坐
   *
   * 判重抛错（存储抖动、内核瞬时不可用）只让这一条没写成，其余照写。
   * 若整批 return，一次抖动就等于这一轮全部丢失——而用户看到的现象是
   * 「我明明说了，她没记住」，没有任何报错可循。
   * @param dedupe 判重服务。
   * @param facts 提炼出的候选事实。
   * @param rawId 本轮原文锚点。
   * @param at 本轮时刻。
   * @returns 新建条数与可用于归池的事实清单。
   */
  function settleAll(
    dedupe: DedupeServiceLike,
    facts: readonly {
      readonly text?: string
      readonly kind?: string
      readonly category?: string
      readonly subject?: string
      readonly summary?: string
      readonly evidence?: readonly { readonly source: string; readonly quote: string; readonly messageIndex?: number }[]
    }[] | undefined,
    rawId: string | undefined,
    at: number | undefined,
  ): {
    readonly written: number
    readonly landed: readonly { readonly id?: string; readonly text?: string; readonly category?: string; readonly subject?: string }[]
  } {
    if (!Array.isArray(facts) || facts.length === 0) return { written: 0, landed: [] }
    let written = 0
    const landed: { readonly id?: string; readonly text?: string; readonly category?: string; readonly subject?: string }[] = []
    // 计数器：让「判重到底做了什么」在日志里可数，而不是只知道「写了 N 条」。
    const tally = { add: 0, merge: 0, append: 0, drop: 0, conflict: 0 }
    for (const fact of facts) {
      const text = typeof fact.text === 'string' ? fact.text.trim() : ''
      if (text === '') continue
      try {
        const outcome = dedupe.settle({
          text,
          ...fact.kind === undefined ? {} : { kind: fact.kind },
          ...fact.category === undefined ? {} : { category: fact.category },
          ...fact.subject === undefined ? {} : { subject: fact.subject },
          ...fact.summary === undefined ? {} : { summary: fact.summary },
          ...fact.evidence === undefined ? {} : { evidence: fact.evidence },
          ...rawId === undefined ? {} : { rawId },
          ...at === undefined ? {} : { at },
        })
        const action = outcome?.verdict?.action
        if (action === 'add' || action === 'merge' || action === 'append' || action === 'drop' || action === 'conflict') {
          tally[action] += 1
        }
        if (outcome?.written === true) {
          written += 1
          // 只有真新建的那条才有新 id；冲突策略为 `seal-old` 时也会新建，
          // 同样算「这一轮多了一条新事实」。
          landed.push({
            ...outcome.record?.id === undefined ? {} : { id: outcome.record.id },
            text,
            ...fact.category === undefined ? {} : { category: fact.category },
            ...fact.subject === undefined ? {} : { subject: fact.subject },
          })
        }
      } catch (error) {
        log.warn?.('判重落库失败（这一条按「没记住」处理，其余照写）：%s', message(error))
      }
    }
    log.info?.(
      '判重裁决：新建 %d · 合并 %d · 复述 %d · 丢弃 %d · 冲突 %d',
      tally.add + tally.conflict,
      tally.merge,
      tally.append,
      tally.drop,
      tally.conflict,
    )
    return { written, landed }
  }


  /**
   * 把刚提炼出的若干事实归池。
   *
   * 事实结构里**没有 id**——id 是记忆内核写库时才生成的，归池却按 id 落行。
   * 所以按正文回查：取最近写入的那批事实，用文本对上号。对不上就跳过，
   * 不猜一个 id 填进去（错配比缺失更难查）。
   * @param facts 提炼返回的事实（只有正文与类别）。
   * @param at 本轮时刻。
   */
  function assignPools(
    facts: readonly { readonly text?: string; readonly category?: string; readonly subject?: string }[] | undefined,
    at: number | undefined,
  ): void {
    const pool = poolOf()
    if (pool === undefined || !pool.available || !Array.isArray(facts) || facts.length === 0) return
    const memory = core()
    if (memory === undefined || !memory.available || typeof memory.listFacts !== 'function') return
    // 正文 → 该条事实应当落哪个池（按提炼给的 category 与 subject 定）。
    //
    // 归池只认**显式标签**，一个都认不出就落海马体并置 unclassified——而海马体
    // 按设计**永不注入**。此前这里不带标签，于是每条事实都成了「未归类」，
    // 症状就是：事实写得好好的、右栏也有，可对话里她永远想不起来。
    const wanted = new Map<string, string>()
    for (const fact of facts) {
      const text = typeof fact.text === 'string' ? fact.text.trim() : ''
      if (text === '' || wanted.has(text)) continue
      wanted.set(text, poolLabelOf(fact.category, fact.subject))
    }
    if (wanted.size === 0) return
    let rows: readonly { readonly id?: string; readonly text?: string }[]
    try {
      // 放宽条数：一轮最多抽出几条事实，取 4 倍足够覆盖同批写入。
      rows = memory.listFacts({ limit: Math.max(20, wanted.size * 4) }) ?? []
    } catch (error) {
      log.warn?.('回查事实失败（不归池）：%s', message(error))
      return
    }
    /*
     * 归池的同一批 id 顺手建共现边。
     *
     * 位置选在这里而不是 `flush` 里另开一遍回查：`rows` 已经是「这一轮
     * 落库的那批事实」，再查一次既要承担新写入的竞态，又会拿到不止一轮的量。
     * 一次性把 id 收齐，交出去，比在别处重算一遍可靠。
     */
    const landed: string[] = []
    for (const row of rows) {
      if (typeof row.id !== 'string' || typeof row.text !== 'string') continue
      const label = wanted.get(row.text.trim())
      if (label === undefined) continue
      landed.push(row.id)
      try {
        pool.assign({
          factId: row.id,
          text: row.text,
          labels: [label],
          ...at === undefined ? {} : { at },
        })
      } catch (error) {
        // 归池失败不影响事实本身：它只是分类，不是内容。
        log.warn?.('归池失败（事实已写入）：%s', message(error))
      }
    }
    linkCooccur(landed, at)
  }

  /**
   * 把同一轮落库的事实两两连成 `cooccur` 边。
   *
   * ## 为什么是「两两」而不是「连成一条链」
   *
   * 链式（A→B→C）会让 B 的枢纽度虚高、A 与 C 之间查不到直接关联；而「这一轮
   * 它们四个一起出现」本就是一个完全图的事实。条数上限由 `maxPerTurn` 兜住：
   * 一轮提炼默认最多 6 条，两两组合 15 条边，是可接受的一次写。
   *
   * ## 为什么要先判 available
   *
   * 图谱的 `link()` 在存储缺席时返回 `refusal:'unavailable'` 而不是抛错，
   * 照写会让每轮多一次无谓调用。判一次 `available` 是零成本的提前退出。
   * @param ids 本轮落库的事实 id。
   * @param at 本轮时刻。
   */
  function linkCooccur(ids: readonly string[], at: number | undefined): void {
    if (ids.length < 2) return
    const graph = graphOf()
    if (graph === undefined || !graph.available || typeof graph.link !== 'function') return
    let built = 0
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        try {
          graph.link({
            from: ids[i] as string,
            to: ids[j] as string,
            relation: 'cooccur',
            ...at === undefined ? {} : { at },
          })
          built += 1
        } catch (error) {
          // 建边失败不影响事实与归池：边是「顺手想起另一件」的索引，不是内容。
          log.warn?.('建共现边失败（事实已写入）：%s', message(error))
          return
        }
      }
    }
    if (built > 0) log.info?.('共现边 +%d（本轮 %d 条事实）', built, ids.length)
  }

  /**
   * 会话身份：优先用 `id`，没有才退回对象本身。
   *
   * 用对象当键踩过坑：`user/message` 与 `turn/end` 是两个不同的发射点，
   * 同一个会话可能以不同的包装对象抵达，按引用相等分组会让「攒了一半的草稿」
   * 永远等不到收尾——症状是消息全收到了、库还是空的。
   */
  function identityOf(session: unknown): unknown {
    const id = (session as { readonly id?: unknown } | undefined)?.id
    return id === undefined ? session : id
  }

  /** 收一条消息进当前轮次草稿。 */
  function collect(session: unknown, event: SessionEventLike): void {
    const message = messageOf(event)
    if (message === undefined) return
    if (message.role !== 'user' && message.role !== 'assistant') return
    // 宿主每轮会把运行时上下文（工作目录、沙箱策略、**注入的记忆段**）与
    // 时间采样伪装成 user 消息塞进会话，来源分别是 `runtime-context` 与
    // `time-context`（都带 `form:'snapshot'`）。照单全收会让提炼器把注入段里的
    // 旧记忆当成「用户这轮新说的话」再抽一遍——实测：只问一句「我是谁」，
    // 库里就多出「用户自称小玖」，而它的引文只有「我是谁」。这是记忆自我回灌，
    // 0 命中兜底每轮恒定注入旧事实时尤其明显。
    // 只认真实对话的两个来源；`source` 缺失时放行，兼容不带来源标记的发射点。
    // 不计入 stats.skipped：那是「跳过一轮」的统计，这里是丢弃一条系统消息。
    const kind = message.source?.kind
    if (kind !== undefined && kind !== 'user' && kind !== 'model') return
    const text = textOf(message)
    if (text === '') return
    const key = identityOf(session)
    const draft = drafts.get(key) ?? { turnId: '', at: undefined, lines: [] }
    draft.lines.push({ role: message.role, text })
    drafts.set(key, draft)
  }

  /**
   * 订阅会话事件。
   *
   * `try/catch` 不是吞错：监听器抛错会被宿主当成订阅失败，连对话主链都会受影响。
   */
  ctx.effect(
    () => {
      // 事件名不在宿主的 `Events` 映射里（那是宿主自己的强类型表），
      // 用结构化的总线面订阅：拿不到就是没有，不影响插件其余部分。
      const bus = ctx as unknown as {
        on(name: string, handler: (session: unknown, event: SessionEventLike) => void): () => void
      }
      const off = bus.on('session/event', (session, event) => {
        try {
          if (event.type === 'user/message' || event.type === 'assistant/message') {
            collect(session, event)
            return
          }
          if (event.type !== 'turn/end') return
          const key = identityOf(session)
          const draft = drafts.get(key)
          if (draft === undefined) return
          drafts.delete(key)
          if (draft.lines.length === 0) return
          const turn = event.data as { readonly turn?: number } | undefined
          sequence += 1
          /*
           * 「上一轮」的时刻在本轮**开始**时取，取完立刻更新。
           *
           * 顺序不能反：先更新再取，`sinceLastTurn` 恒为 0，`reunion` 信号
           * 永远不会命中——而它的失效完全静默（久别重逢只是少一次唤醒）。
           *
           * 用 `event.time` 而不是 `Date.now()`：事件自带时刻，宿主补发历史
           * 或检查脚本注入固定时刻时才不会把「昨天的事」算成「刚才」。
           */
          const at = event.time
          const sinceLast = lastTurnAt === undefined ? undefined : (at ?? Date.now()) - lastTurnAt
          lastTurnAt = at ?? Date.now()
          const finished: TurnDraft = {
            turnId: `${String(session)}#${turn?.turn ?? sequence}`,
            lines: draft.lines,
            ...at === undefined ? {} : { at },
          }
          stats.turns += 1
          // fire-and-forget：回复已经发出去了，这里失败不该冒到对话链上。
          void flush(finished, sinceLast).catch(error => {
            stats.failed += 1
            log.warn?.('轮次收尾失败：%s', message(error))
          })
        } catch (error) {
          log.warn?.('会话监听出错（本事件跳过）：%s', message(error))
        }
      })
      return off
    },
    'ondra-memory-intake: 监听对话轮次',
  )

  ctx.effect(() => ctx.provide(INTAKE_SERVICE_KEY, service), 'ondra-memory-intake: 注册采集服务')

  log.info?.(
    '对话采集就绪：提炼=%s，并发上限=%s',
    settings.extract ? '开' : '关',
    settings.maxConcurrent,
  )
  if (core() === undefined) {
    log.warn?.('记忆内核未就绪：等它出现后自动开始采集')
  }
  if (extractor() === undefined) {
    log.warn?.('提炼服务未就绪：只写原文，不抽事实')
  }
}

/**
 * 取错误信息。
 * @param error 任意错误。
 * @returns 一行文本。
 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { CONFIG_SECTION_ID, Config }

/**
 * 把一条提炼结果的类别映射成归池标签。
 *
 * ## 为什么 11 类必须**一类不漏**
 *
 * O-011 的 `EXTRACT_CATEGORIES` 是 11 类：`watch / daily / food / place /
 * misc / event / feeling / study / person / promise / self`。池服务只认
 * `pools.ts` 里登记过的标签，一个都认不出就落**海马体**并置 unclassified，
 * 而海马体 `injectable:false`——注入时一律 `pool-denied`。此前这里只认
 * person / place / event / misc 四类，其余七类返回空串，于是「她今天吃了什么」
 * 「她答应过什么」全被写进一个永不注入的池，右栏看得到、对话里永远想不起来。
 *
 * ## 映射依据
 *
 * 不按内容猜，只按两套体系**共同的时间轴**对齐：O-010 `STABILITY_BASE_HOURS`
 * 里 `self`(20000h) 与 `promise`(8000h) 是永久档，`person`(240h) 次之，
 * 其余八类都在 2–80 小时的速朽档。对应到 O-131 的池：
 * - 人格 / 自我 → `core`（永不衰减，语义「原则 / 人格 / 边界」）
 * - 人 / 地方 / 约定 → `fact`（半衰期 365 天，「关于用户的事实，会变但慢」）
 * - 其余速朽类 → `dailyPartial`（半衰期 20 天，「一次性进展，速朽」）
 *
 * 刻意**不用** `emotion`：那是单槽状态牌，提炼产出的是历史事实而非实时状态，
 * 全塞进去会互相顶替（O-131 README 已知限制 6）。也刻意不用 `skillExp`：
 * 它的语义是「教训 / 工具 / 排障」，`study`(80h) 只是学过什么，不是排障经验。
 *
 * ## 兜底
 *
 * 认不出的类别也返回「日常片段」，绝不返回空串。空串会让 `classifyByLabels()`
 * 走 fallback 落海马体——那是本函数唯一真正需要防住的后果。以后 O-011 新增
 * 类别时，最坏情况只是这条记忆淡得快一点，不会静默消失。
 *
 * @param category 提炼给的 11 类之一。
 * @param subject 主体（user / self / 人名）。
 * @returns 池标签；恒为 `pools.ts` 别名表里登记过的值。
 */
function poolLabelOf(category: string | undefined, subject: string | undefined): string {
  // 她自己的人格、原则、边界——主体优先于类别：一条 `person` 但说的是她自己，
  // 也该按核心设定记，而不是当用户资料。
  if (subject === 'self' || category === 'self') return '人格'
  // 关于用户本人是谁、住哪、答应过什么——会变但慢，长期有效。
  if (category === 'person' || category === 'place' || category === 'promise') return '事实'
  // 其余（watch / daily / food / event / misc / feeling / study）以及未知类别：
  // 一次性进展与心情，会淡、但必须能被带出。
  return '日常片段'
}
