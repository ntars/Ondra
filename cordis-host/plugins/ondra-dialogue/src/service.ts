/**
 * 对话编排门面。
 *
 * 四个阶段：**取上下文 → 组装 → 流式 → 收尾**。每个阶段只做一件事，
 * 且都不改别的阶段的结果：
 *
 * 1. **取上下文**：稳定段只在 `begin()` 取一次（人格四段 + 世界书常驻），
 *    之后一个字节都不动。易变段由调用方每轮传入。
 * 2. **组装**：`buildMessages()` 拼出「前缀 + 历史 + 易变段 + 本轮输入」。
 * 3. **流式**：把网关的块翻成五帧，逐帧 yield。**不改写正文**。
 * 4. **收尾**：成功结束才提交历史（整轮事务），失败整轮作废。
 *
 * ## 为什么「整轮提交」而不是「逐条 push」
 *
 * 逐条 push 会让一次中断留下半轮：一条 user 消息，一条说到一半的 assistant。
 * 下一轮模型看到的是「用户问了，她答了半句」，于是她会**接着那半句往下说**，
 * 或者干脆重答一遍——两种表现用户都会觉得「她今天怪怪的」，而日志里
 * 一切正常（没有异常、没有降级）。所以这里用事务语义：
 *
 * > 一轮要么成立（user + assistant 一起进历史），要么不成立（整轮丢弃）。
 *
 * 代价写在 README 的已知限制里：用户按了停止之后说「继续说」，
 * 她不会记得自己刚才说到哪。
 */

import { compactHistory } from './compact.js'
import { buildMessages, charsOf } from './messages.js'
import { djb2, joinStable, joinTails, normalizeStable, orderTails } from './prefix.js'
import type { Config } from './settings.js'
import { createSink } from './writer.js'
import type { ProtocolLike } from './writer.js'
import type {
  AssembleLike,
  BeginInput,
  CompactReason,
  CompactResult,
  ConversationView,
  DialogueFrame,
  DialogueMessage,
  DialogueService,
  DialogueStats,
  DialogueStopReason,
  GatewayLike,
  GatewayTraceLike,
  LogLike,
  PrefixSnapshot,
  StablePart,
  TurnInput,
  WorldbookLike,
} from './types.js'

/** 服务依赖。全部用取值函数：上游晚装载时能自愈。 */
export interface DialogueDeps {
  readonly settings: Config
  readonly log: LogLike
  /** 网关（O-035）。 */
  readonly gateway: () => GatewayLike | undefined
  /** 帧协议（O-034）。 */
  readonly protocol: () => ProtocolLike | undefined
  /** 人格装配（O-023）。 */
  readonly assemble: () => AssembleLike | undefined
  /** 世界书（O-024）。 */
  readonly worldbook: () => WorldbookLike | undefined
  /** 时钟（便于纯逻辑推演时替换）。 */
  readonly now: () => number
}

/** 一个会话的内存状态。**不落盘**。 */
interface ConversationState {
  readonly id: string
  /** 冻结前缀正文。 */
  readonly system: string
  /** 冻结前缀指纹。 */
  readonly hash: string
  /** 拼进前缀的段。 */
  readonly parts: readonly StablePart[]
  /** 已提交的历史（user/assistant 交替，成对）。 */
  history: DialogueMessage[]
  readonly createdAt: number
  /** 最近一次活动时刻（用于按 LRU 淘汰）。 */
  lastActive: number
  /** 是否有回合在跑。 */
  busy: boolean
  /** 当前回合的取消控制器。 */
  controller: AbortController | undefined
}

/** 会话 id 的合法形状（与手册 §8.4 同一条正则）。 */
const ID_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 取错误消息文本（不把堆栈或用户原文带进日志）。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 对话编排实现。 */
export class Dialogue implements DialogueService {
  private readonly deps: DialogueDeps
  private readonly conversations = new Map<string, ConversationState>()
  private defaultId: string | undefined
  /** 自动 id 的序号。 */
  private counter = 0
  private turns = 0
  private frames = 0
  private errors = 0
  private aborted = 0
  private discarded = 0
  private compactions = 0
  private lastError: string | undefined

  constructor(deps: DialogueDeps) {
    this.deps = deps
  }

  get available(): boolean {
    return this.deps.settings.enable
  }

  get gatewayReady(): boolean {
    return this.deps.gateway() !== undefined
  }

  /**
   * 从 O-023 / O-024 收集稳定段。
   *
   * 两处都**必须** try/catch：它们在 `begin()` 的同步路径上，抛一次就是
   * 「开不了会话」，而用户看到的只是「发消息没反应」。
   * @returns 稳定段（可能为空）。
   */
  private autoStable(): readonly StablePart[] {
    const parts: StablePart[] = []
    if (this.deps.settings.includePersona) {
      const assemble = this.deps.assemble()
      if (assemble !== undefined) {
        try {
          const prompt = assemble.assemble()
          if (typeof prompt.text === 'string' && prompt.text.trim() !== '') {
            parts.push({ id: 'persona', text: prompt.text, source: 'persona' })
          }
        } catch (error) {
          this.deps.log.warn('从人格装配取稳定段失败（本次前缀不含人格）：%s', messageOf(error))
        }
      }
    }
    if (this.deps.settings.includeWorldbook) {
      const worldbook = this.deps.worldbook()
      if (worldbook !== undefined) {
        try {
          const block = worldbook.constantBlock()
          if (typeof block.text === 'string' && block.text.trim() !== '') {
            parts.push({ id: 'worldbook', text: block.text, source: 'worldbook' })
          }
        } catch (error) {
          this.deps.log.warn('从世界书取常驻块失败（本次前缀不含世界书）：%s', messageOf(error))
        }
      }
    }
    return parts
  }

  /**
   * 按 LRU 淘汰会话，给新会话让位。
   *
   * 只淘汰**空闲**的会话：淘汰一个正在跑的会话会让它的回合拿到
   * 「会话已不存在」而静默失败。若全都在跑，就允许暂时超限——
   * 内存涨一点，比打断一轮对话好。
   */
  private evictIfNeeded(): void {
    const limit = this.deps.settings.maxConversations
    if (this.conversations.size < limit) return
    let oldest: ConversationState | undefined
    for (const conversation of this.conversations.values()) {
      if (conversation.busy) continue
      if (conversation.id === this.defaultId) continue
      if (oldest === undefined || conversation.lastActive < oldest.lastActive) oldest = conversation
    }
    if (oldest === undefined) return
    this.conversations.delete(oldest.id)
    this.deps.log.info('会话数达到上限（%d），已淘汰最久未用的会话 %s', limit, oldest.id)
  }

  begin(input?: BeginInput): ConversationView {
    const requested = input?.id
    const id =
      requested !== undefined && ID_RE.test(requested)
        ? requested
        : (() => {
          this.counter += 1
          return `dialogue-${this.counter}`
        })()

    const existing = this.conversations.get(id)
    // 同 id 已存在时**不覆盖**：覆盖等于偷偷重拼前缀，那正是本插件要防的事。
    if (existing !== undefined) return this.viewOf(existing)

    this.evictIfNeeded()

    // 调用方给了 `stable` 就完全以它为准；只有**没给**时才从上游自动收集。
    // 合并两者的结果不可预测：调用方以为「我给了人格」，实际上还混进了
    // 一份自动收集的人格，前缀里出现两段互斥的人设。
    const parts =
      input?.stable !== undefined ? normalizeStable(input.stable) : normalizeStable(this.autoStable())
    const system = joinStable(parts)
    const now = this.deps.now()

    const state: ConversationState = {
      id,
      system,
      hash: djb2(system),
      parts,
      history: [],
      createdAt: now,
      lastActive: now,
      busy: false,
      controller: undefined,
    }

    // 初始历史也要过一遍闸门：调用方常常把「整段旧记录」塞进来，
    // 直接吃下去就等于把 2000 字的预算第一轮就用光。
    const seeded = (input?.history ?? []).filter(message => message.role !== 'system')
    const outcome = compactHistory(seeded, this.deps.settings.maxTurns, this.deps.settings.maxHistoryChars)
    state.history = outcome.dropped > 0 ? seeded.slice(outcome.dropped) : seeded.slice()

    this.conversations.set(id, state)
    if (this.defaultId === undefined) this.defaultId = id

    this.deps.log.info(
      '会话 %s 已开始：前缀 %d 字（%s），段 %d 个，初始历史 %d 条',
      id,
      system.length,
      state.hash,
      parts.length,
      state.history.length,
    )
    if (parts.length === 0) {
      this.deps.log.warn(
        '会话 %s 的稳定段为空（人格与世界书都不可用）：本轮没有可冻结的前缀，模型只能靠历史与易变段',
      )
    }
    return this.viewOf(state)
  }

  /**
   * 跑一轮。
   * @param input 本轮参数。
   */
  async *turn(input: TurnInput): AsyncIterable<DialogueFrame> {
    const sink = createSink(this.deps.protocol())
    this.turns += 1

    /**
     * 造一帧终帧。
     *
     * `sink.done()` 可能返回 `undefined`（协议被关掉时 writer 立刻关闭、
     * 拒绝一切写入）。那样调用方会拿到一个「有开始没有结束」的空流——
     * 用户看到的是「消息发出去了，她一个字都没回，也没有任何提示」。
     * 所以这里自己兜一帧：**任何回合都必须以 done 收尾**。
     * @param reason 结束原因。
     */
    const finishWith = (reason: DialogueStopReason): DialogueFrame => {
      const frame = sink.done(reason)
      return frame ?? { type: 'done', seq: 1, stopReason: reason }
    }

    const fail = (reason: string): DialogueFrame => {
      this.errors += 1
      this.noteError(reason)
      return finishWith('error')
    }

    if (!this.deps.settings.enable) {
      yield fail('对话编排已关闭（enable=false）')
      return
    }

    let conversation: ConversationState | undefined
    if (input.conversationId === undefined) {
      const current = this.pick(undefined)
      conversation = current ?? this.stateOf(this.begin())
    } else {
      conversation = this.conversations.get(input.conversationId)
    }
    if (conversation === undefined) {
      yield fail(`会话不存在：${input.conversationId ?? '(默认)'}`)
      return
    }

    if (conversation.busy) {
      yield fail('上一轮尚未结束（同一会话不允许并发回合）')
      return
    }

    const gateway = this.deps.gateway()
    if (gateway === undefined) {
      yield fail('模型网关未装载（ondra-llm-gateway 缺席）')
      return
    }
    if (!gateway.available) {
      yield fail('模型网关已装载但上游未就绪（没有可用来源）')
      return
    }

    // 先把本轮消息拼好，再置 busy。顺序反过来的话，拼装阶段任何一次抛错
    // 都会把 `busy` 永久留在 true 上——那个会话从此再也说不了话，而且没有报错。
    const settings = this.deps.settings
    const tails = orderTails(input.tail, settings.minTailConfidence)
    const tailText = joinTails(tails)
    const messages = buildMessages({
      system: conversation.system,
      history: conversation.history,
      tailText,
      userText: input.text,
    })

    conversation.busy = true
    conversation.lastActive = this.deps.now()
    const controller = new AbortController()
    conversation.controller = controller

    // 外部取消信号接到内部控制器上。用 `addEventListener` 而不是把 signal
    // 直接传下去：网关只接受一个 signal，而这里有两个来源（调用方 + abort()）。
    const external = input.signal
    const forwardAbort = (): void => controller.abort()
    if (external !== undefined) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', forwardAbort)
    }

    let collected = ''
    let stop: DialogueStopReason = 'stop'
    let finished = false

    try {
      const trace: GatewayTraceLike = {}
      const stream = gateway.stream(
        {
          messages,
          temperature: input.temperature ?? settings.temperature,
          // `maxTokens: 0` 表示不设：传 0 给上游会被当成「输出上限 0」，
          // 那是「一个字都不许说」，不是「不限」。所以这里要把 0 转成 undefined。
          ...(settings.maxTokens > 0 ? { maxTokens: settings.maxTokens } : {}),
          ...(input.source === undefined ? {} : { source: input.source }),
          signal: controller.signal,
        },
        trace,
      )

      for await (const chunk of stream) {
        // 上游不保证理会 signal，所以每块都要自己再看一眼。
        if (controller.signal.aborted) break
        if (chunk.type === 'text-delta') {
          const text = typeof chunk.text === 'string' ? chunk.text : ''
          if (text === '') continue
          collected += text
          const frame = sink.delta(text)
          if (frame !== undefined) {
            this.frames += 1
            yield frame
          }
          continue
        }
        if (chunk.type === 'usage' && chunk.usage !== undefined) {
          const frame = sink.usage(chunk.usage.inputTokens, chunk.usage.outputTokens)
          if (frame !== undefined) {
            this.frames += 1
            yield frame
          }
          continue
        }
        if (chunk.type === 'finish') {
          finished = true
          stop = this.stopOf(chunk.reason?.kind)
        }
      }

      // 取消优先于结束原因：上游在中断时可能给出任意 kind，用户按了停止才是事实。
      if (controller.signal.aborted) {
        stop = 'aborted'
      } else if (!finished && collected === '') {
        // 既没有内容、也没有结束原因：这不是一次「她说完了」，是一次空流。
        // 若当成 `stop` 提交，历史里会留下一条空的 assistant 消息——下一轮
        // 多数适配器会拒收空正文，而报错点会落在「下一轮」，查起来毫不相干。
        stop = 'error'
        this.noteError('流已结束，但既没有正文也没有结束原因（空流）')
      } else if (!finished) {
        // 有正文、没 finish：部分适配器确实不吐 finish，按正常收尾处理。
        stop = 'stop'
      }
    } catch (error) {
      // **永不外抛**：调用方已经在处理异步流，再让它处理异常必然有一边漏，
      // 而漏掉的那边表现为「用户发了消息，她永远不回」。
      stop = controller.signal.aborted ? 'aborted' : 'error'
      this.noteError(`流式调用失败：${messageOf(error)}`)
    } finally {
      conversation.busy = false
      conversation.controller = undefined
      if (external !== undefined) external.removeEventListener('abort', forwardAbort)
    }

    // —— 收尾：整轮提交或整轮作废 ——
    if (stop === 'stop' || stop === 'length') {
      conversation.history.push({ role: 'user', content: input.text })
      // 正文可能为空（模型给了 finish 但没吐字），仍然成对写入：
      // 只写 user 不写 assistant，下一轮的交替结构就断了——
      // 下一条 user 会被模型当成「assistant 的延续」来理解。
      conversation.history.push({ role: 'assistant', content: collected })
      const outcome = compactHistory(conversation.history, settings.maxTurns, settings.maxHistoryChars)
      if (outcome.dropped > 0) {
        conversation.history = conversation.history.slice(outcome.dropped)
        this.compactions += 1
      }
    } else {
      this.discarded += 1
      if (stop === 'aborted') this.aborted += 1
      else this.errors += 1
    }

    conversation.lastActive = this.deps.now()
    this.frames += 1
    yield finishWith(stop)
  }

  abort(conversationId?: string): boolean {
    const conversation = this.pick(conversationId)
    if (conversation === undefined) return false
    if (!conversation.busy || conversation.controller === undefined) return false
    conversation.controller.abort()
    return true
  }

  close(conversationId?: string): boolean {
    const conversation = this.pick(conversationId)
    if (conversation === undefined) return false
    // 正在跑的会话不许直接删：删了之后那一轮的 `finally` 会写到一个
    // 已经不在 Map 里的对象上，看起来"什么都没发生"，实际历史丢了。
    if (conversation.busy) {
      if (this.deps.settings.verbose) {
        this.deps.log.warn('会话 %s 正在跑，拒绝关闭（先 abort 再 close）', conversation.id)
      }
      return false
    }
    this.conversations.delete(conversation.id)
    if (this.defaultId === conversation.id) {
      this.defaultId = undefined
      for (const candidate of this.conversations.values()) {
        this.defaultId = candidate.id
        break
      }
    }
    return true
  }

  prefixOf(conversationId?: string): PrefixSnapshot | undefined {
    const conversation = this.pick(conversationId)
    if (conversation === undefined) return undefined
    return {
      hash: conversation.hash,
      text: conversation.system,
      chars: conversation.system.length,
      parts: conversation.parts,
      frozenAt: conversation.createdAt,
    }
  }

  historyOf(conversationId?: string): readonly DialogueMessage[] {
    const conversation = this.pick(conversationId)
    if (conversation === undefined) return []
    // 复制一份再给：共享数组会让调用方 `push` 一行就悄悄改了会话历史，
    // 而这种改动永远不会有日志。
    return conversation.history.map(message => ({ role: message.role, content: message.content }))
  }

  compact(conversationId?: string, reason?: CompactReason): CompactResult {
    const conversation = this.pick(conversationId)
    if (conversation === undefined) {
      return { ok: false, reason: 'not-found', dropped: 0, kept: 0, chars: 0 }
    }
    if (conversation.busy) {
      // 回合进行中裁剪，会让「已经发出去的前缀」与「下一轮要发的前缀」
      // 不是同一个东西——缓存失效是小事，模型看到的历史自相矛盾是大事。
      return {
        ok: false,
        reason: 'busy',
        dropped: 0,
        kept: conversation.history.length,
        chars: charsOf(conversation.history),
      }
    }
    const outcome = compactHistory(
      conversation.history,
      this.deps.settings.maxTurns,
      this.deps.settings.maxHistoryChars,
    )
    if (outcome.dropped > 0) {
      conversation.history = conversation.history.slice(outcome.dropped)
      this.compactions += 1
    }
    if (this.deps.settings.verbose && outcome.dropped > 0) {
      this.deps.log.info(
        '会话 %s 压缩（%s）：丢弃 %d 条，保留 %d 条，%d 字',
        conversation.id,
        reason ?? 'manual',
        outcome.dropped,
        outcome.kept,
        outcome.chars,
      )
    }
    return { ok: true, dropped: outcome.dropped, kept: outcome.kept, chars: outcome.chars }
  }

  stats(): DialogueStats {
    const current = this.pick(undefined)
    const base = {
      available: this.deps.settings.enable,
      gatewayReady: this.deps.gateway() !== undefined,
      conversations: this.conversations.size,
      turns: this.turns,
      frames: this.frames,
      errors: this.errors,
      aborted: this.aborted,
      discarded: this.discarded,
      compactions: this.compactions,
      prefixChars: current === undefined ? 0 : current.system.length,
    }
    return this.lastError === undefined ? base : { ...base, lastError: this.lastError }
  }

  /**
   * 结束原因映射：**优先问协议服务**（它是帧语义的持有者）。
   *
   * 协议缺席时只区分 `aborted`，其余一律 `stop`——这是**有损降级**，
   * 代价是丢掉 `length`（输出被截断）。刻意不在这里再写一份完整映射：
   * 两份映射必然漂移，而漂移的表现是「界面有时提示被截断、有时不提」。
   * @param kind 上游结束原因。
   */
  private stopOf(kind: string | undefined): DialogueStopReason {
    const protocol = this.deps.protocol()
    if (protocol !== undefined) return protocol.stopReasonOf(kind)
    return kind === 'aborted' ? 'aborted' : 'stop'
  }

  /** 记一条错误（不覆盖更早的错误？覆盖：最近一次更有诊断价值）。 */
  private noteError(reason: string): void {
    this.lastError = reason
    this.deps.log.warn('对话回合失败：%s', reason)
  }

  /** 按 id 取会话；省略 id 取默认会话。 */
  private pick(conversationId?: string): ConversationState | undefined {
    if (conversationId !== undefined) return this.conversations.get(conversationId)
    if (this.defaultId === undefined) return undefined
    return this.conversations.get(this.defaultId)
  }

  /** 从 `begin()` 的返回值反查状态（`begin` 刚写入 Map，必然存在）。 */
  private stateOf(view: ConversationView): ConversationState | undefined {
    return this.conversations.get(view.id)
  }

  /** 造一份对外的会话快照。 */
  private viewOf(state: ConversationState): ConversationView {
    return {
      id: state.id,
      prefixHash: state.hash,
      prefixChars: state.system.length,
      parts: state.parts,
      historyCount: state.history.length,
      createdAt: state.createdAt,
    }
  }
}
