/**
 * 服务层：编排「调模型 → 解析 → 校验 → 写库」四步。
 *
 * 三条纪律（每条都对应一次真实事故形态）：
 *
 * 1. **降级返回空结果，不抛错。** 提炼挂在对话之后，它抛一个错就会顺着
 *    `await` 冒进对话链，用户看到的是「回复失败」而不是「这次没记住」。
 *    只有两种错会抛：调用方参数错（`bad-request`，程序 bug，必须暴露）
 *    与取消（`aborted`，必须让上游知道别继续烧钱）。
 * 2. **`ok` 与「有没有事实」是两件事。** `ok=false` 表示「没走通」，
 *    `ok=true + facts=[]` 表示「走通了，但这段对话没什么值得记的」。
 *    混成一个布尔，监控就分不清「模型挂了」和「今天很平淡」。
 * 3. **不写自己的状态到磁盘。** 计数器只在内存——提炼是一个无状态函数，
 *    它一旦有状态，同一个会话重放两次就会得到两份不同的记忆。
 */

import { buildUserMessage, SYSTEM_PROMPT } from './prompt.js'
import { parseExtraction } from './parse.js'
import type { Config } from './settings.js'
import { normalizeForMatch, verifyCandidate } from './verify.js'
import type { VerifySettings } from './verify.js'
import { ExtractError } from './types.js'
import type {
  ExtractRejection,
  ExtractRequest,
  ExtractResult,
  ExtractService,
  ExtractedFact,
  ExtractStats,
  ExtractUnavailableReason,
  LlmGatewayLike,
  LogLike,
  MemoryCoreLike,
} from './types.js'

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 判一个错误是不是取消。 */
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** 提炼服务实现。 */
export class MemoryExtractor implements ExtractService {
  private readonly settings: Config
  private readonly gateway: () => LlmGatewayLike | undefined
  private readonly core: () => MemoryCoreLike | undefined
  private readonly log: LogLike
  private readonly now: () => number

  private readonly counters = { calls: 0, succeeded: 0, failed: 0, factsWritten: 0 }
  private readonly rejected: Record<string, number> = {}
  private lastError: string | undefined

  /**
   * @param deps 依赖。网关与内核都用**取值函数**：上游晚装载时能自愈，
   *   而不用在装载那一刻把「谁先到」赌一遍。
   */
  constructor(deps: {
    readonly settings: Config
    readonly gateway: () => LlmGatewayLike | undefined
    readonly core: () => MemoryCoreLike | undefined
    readonly log: LogLike
    readonly now: () => number
  }) {
    this.settings = deps.settings
    this.gateway = deps.gateway
    this.core = deps.core
    this.log = deps.log
    this.now = deps.now
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.unavailableReason() === undefined
  }

  /** 不可用原因。 */
  get reason(): ExtractUnavailableReason | undefined {
    return this.unavailableReason()
  }

  /** 只提炼、不写库。 */
  async propose(request: ExtractRequest): Promise<ExtractResult> {
    return this.run(request, false)
  }

  /** 提炼并直写（append 语义，不合并）。 */
  async extract(request: ExtractRequest): Promise<ExtractResult> {
    return this.run(request, true)
  }

  stats(): ExtractStats {
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      calls: this.counters.calls,
      succeeded: this.counters.succeeded,
      failed: this.counters.failed,
      factsWritten: this.counters.factsWritten,
      rejected: Object.freeze({ ...this.rejected }),
      lastError: this.lastError,
    })
  }

  /** 判可用性。**顺序有意义**：先说「关了」，再说「上游没装」。 */
  private unavailableReason(): ExtractUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    const gateway = this.gateway()
    if (gateway === undefined) return 'no-gateway'
    if (!gateway.available) return 'gateway-unavailable'
    const core = this.core()
    if (core === undefined) return 'no-core'
    if (!core.available) return 'core-unavailable'
    return undefined
  }

  /**
   * 主流程。
   * @param request 请求。
   * @param write 是否写库。
   */
  private async run(request: ExtractRequest, write: boolean): Promise<ExtractResult> {
    const started = this.now()
    this.counters.calls += 1

    if (
      typeof request.turnId !== 'string' ||
      request.turnId.trim() === '' ||
      !Array.isArray(request.messages) ||
      request.messages.length === 0
    ) {
      throw new ExtractError('bad-request', 'turnId 与 messages 都不能为空')
    }

    const reason = this.unavailableReason()
    if (reason !== undefined) {
      this.counters.failed += 1
      this.lastError = reason
      return this.result(started, false, reason)
    }

    // 群聊：准入红线，不是失败。返回 `ok=true` + 一条拒绝，监控里能看出「按规矩没提炼」。
    if ((request.scope ?? 'private') === 'group' && !this.settings.allowGroup) {
      return this.result(started, true, undefined, [], [
        { code: 'group-chatter', detail: '群聊默认不提炼（准入红线：不收群友闲聊）' },
      ])
    }

    const gateway = this.gateway()
    const core = this.core()
    if (gateway === undefined || core === undefined) {
      // 上面刚判过可用性，走到这里只可能是「判完就卸载了」的瞬时状态。
      return this.result(started, false, 'no-gateway')
    }

    const built = buildUserMessage(request.messages, this.settings.maxInputChars)
    if (built.kept.length === 0) {
      return this.result(started, true, undefined, [], [
        { code: 'empty-text', detail: '本轮没有可用的消息内容（全部为空）' },
      ])
    }

    let text: string
    let sourceId: string | undefined
    let usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined
    try {
      const completion = await gateway.complete({
        // 稳定段走 `system`，易变段（本轮对话）走 `messages`——§8.5 前缀缓存的唯一写法。
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: built.content }],
        temperature: this.settings.temperature,
        maxTokens: this.settings.maxTokens,
        purpose: 'memory-extract',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      text = completion.text
      sourceId = completion.sourceId
      usage = completion.usage
    } catch (error) {
      if (isAbort(error, request.signal)) {
        // 取消必须抛：吞掉它会让上层以为「提炼完成、只是没结果」，然后继续往下写。
        throw new ExtractError('aborted', '提炼被取消')
      }
      this.counters.failed += 1
      this.lastError = messageOf(error)
      this.log.warn('提炼调用失败（降级为空结果，对话不受影响）：%s', messageOf(error))
      return this.result(started, false, 'upstream')
    }

    this.counters.succeeded += 1
    const parsed = parseExtraction(text)
    if (parsed.path === 'none') {
      // 解析不出来不是致命：模型偶尔会答非所问。记 warn 让提示词能被人看见并改。
      this.log.warn('提炼输出无法解析（%d 字符），本轮记 0 条', text.length)
    }

    const rejections: ExtractRejection[] = []
    const verified: ExtractedFact[] = []
    const seen = new Set<string>()
    const maxFacts = Math.max(1, request.maxFacts ?? this.settings.maxFacts)
    const verifySettings: VerifySettings = {
      maxTextChars: this.settings.maxTextChars,
      maxSummaryChars: this.settings.maxSummaryChars,
      minQuoteChars: this.settings.minQuoteChars,
      requireToolForDigits: this.settings.requireToolForDigits,
    }

    parsed.candidates.forEach((candidate, index) => {
      if (verified.length >= maxFacts) {
        rejections.push({ code: 'over-limit', detail: `超过本轮上限 ${maxFacts} 条`, index })
        return
      }
      const outcome = verifyCandidate(candidate, request.messages, verifySettings)
      if (outcome.fact === undefined) {
        rejections.push({ ...outcome.rejection, index })
        return
      }
      const key = normalizeForMatch(outcome.fact.text)
      if (seen.has(key)) {
        rejections.push({ code: 'duplicate', detail: '本轮内重复（去空白后正文相同）', index })
        return
      }
      seen.add(key)
      verified.push(outcome.fact)
    })

    /*
     * 把「提炼出来了，但一条都没过闸」这件事说出来。
     *
     * ## 为什么必须在这里说（这是某一轮悬案的真正成因）
     *
     * 调用方（`ondra-memory-intake`）只打一行 `提炼返回：ok=true written=0`。
     * 那一行把两种完全不同的情况压成同一个形状：
     *
     * | 真实情况 | 用户感受 | 日志 |
     * | --- | --- | --- |
     * | 模型答「这段没什么可记的」（`{"facts":[]}`） | 正常，本就该少记 | `written=0` |
     * | 模型提炼出 4 条，全被 `attribution-without-user` 拒掉 | 「我说了你怎么不记」 | `written=0` |
     *
     * 后者是**真缺陷**（校验口径过严），但日志里与前者长得一模一样，
     * 只能靠 `GET /api/diagnostics/memory` 的 `rejected` 计数才看得出来。
     * 于是「她记不住」这件事被追查了很多轮都没定位——不是没人查，
     * 是证据压根没落进日志。
     *
     * 判据用 `parsed.candidates.length` 而不是「有 rejections」：
     * 超上限（`over-limit`）也会产生 rejection，但那种情况至少写进去了一些，
     * 不值得刷 warn。
     */
    if (parsed.candidates.length > 0 && verified.length === 0) {
      const codes = [...new Set(rejections.map(item => item.code))].join('、')
      this.log.warn(
        '提炼出 %d 条候选，全部没过闸（%s），本轮 0 条入库：这是「她记不住」的直接原因，不是模型没答',
        parsed.candidates.length,
        codes === '' ? '未记录原因' : codes,
      )
    } else if (parsed.path !== 'none' && parsed.candidates.length === 0) {
      // 模型正常作答但答的是空数组：这是它该有的出口（提示词规则 6），记 info 不记 warn。
      this.log.info('提炼答「这段没什么可记的」（%d 字输入），本轮 0 条', text.length)
    }

    let written = 0
    const kept: ExtractedFact[] = []
    for (const fact of verified) {
      try {
        // 墓碑闸：被明确要求忘记过的事，不许借「重新提炼」复活。
        if (core.tombstoned(fact.text)) {
          rejections.push({ code: 'tombstoned', detail: `「${fact.text.slice(0, 24)}」曾被要求忘记，不许复活` })
          continue
        }
        if (write) {
          core.addFact({
            kind: fact.kind,
            category: fact.category,
            text: fact.text,
            summary: fact.summary,
            subject: fact.subject,
            evidence: fact.evidence,
            ...(request.rawId === undefined ? {} : { rawId: request.rawId }),
            ...(request.at === undefined ? {} : { at: request.at }),
          })
          written += 1
          this.counters.factsWritten += 1
        }
        kept.push(fact)
      } catch (error) {
        // 单条写失败不连坐：其余事实照写，失败那条进 rejections。
        rejections.push({ code: 'write-failed', detail: messageOf(error) })
        this.log.warn('写入事实失败：%s', messageOf(error))
      }
    }

    return this.result(started, true, undefined, kept, rejections, sourceId, usage, written, parsed.path)
  }

  /** 组装结果（参数多但都在一个地方，避免八处各拼一份）。 */
  private result(
    started: number,
    ok: boolean,
    reason?: ExtractResult['reason'],
    facts: readonly ExtractedFact[] = [],
    rejections: readonly ExtractRejection[] = [],
    sourceId?: string,
    usage?: { readonly inputTokens: number; readonly outputTokens: number },
    written = 0,
    parsePath: ExtractResult['parsePath'] = 'none',
  ): ExtractResult {
    for (const rejection of rejections) {
      this.rejected[rejection.code] = (this.rejected[rejection.code] ?? 0) + 1
    }
    return Object.freeze({
      ok,
      facts: Object.freeze([...facts]),
      rejections: Object.freeze([...rejections]),
      parsePath,
      written,
      ...(reason === undefined ? {} : { reason }),
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(usage === undefined ? {} : { usage }),
      elapsedMs: Math.max(0, this.now() - started),
    })
  }
}
