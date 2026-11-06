/**
 * 服务实现：把「来源状态 + 统计 + 选路 + 流式」缝成一个对象。
 *
 * 这里**不持有任何可变的外部引用**：没有连接、没有缓存、没有定时器。
 * 唯一的可变状态是统计计数器，且只在内存里——网关崩了，最坏结果是报表归零，
 * 不会让任何一条记忆或情绪丢数据。这也是它敢放在所有域插件上游的原因。
 */

import { probeStates, pickSource } from './sources.js'
import { Runner } from './stream.js'
import type { GatewayMetrics } from './stream.js'
import { GatewayError } from './types.js'
import type {
  CredentialLike,
  GatewayChunk,
  GatewayCompletion,
  GatewayFailureCode,
  GatewayRequest,
  GatewayStats,
  GatewayTrace,
  GatewayUsage,
  LlmGatewayService,
  LlmProviderInfoLike,
  LlmRuntimeLike,
  LogLike,
  SourceState,
  SourceStat,
} from './types.js'
import type { Config } from './settings.js'

/** 单条来源的可变统计。 */
interface MutableSourceStat {
  attempts: number
  failures: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  lastFailureCode?: string
  lastLatencyMs?: number
}

/** 构造依赖。全部是取值函数，而不是值——服务要能在上游晚装载时自己变可用。 */
export interface GatewayDeps {
  /** 配置（已补全）。 */
  readonly settings: Config
  /** 取上游 LLM 服务；缺席返回 `undefined`。**每次都现取**，这样上游晚装载也能自愈。 */
  readonly runtime: () => LlmRuntimeLike | undefined
  /** 取凭据服务；缺席返回 `undefined`。 */
  readonly credentials: () => CredentialLike | undefined
  /** 日志。 */
  readonly log: LogLike
  /** 时钟。 */
  readonly now: () => number
}

export class LlmGateway implements LlmGatewayService {
  private readonly deps: GatewayDeps
  private statesCache: readonly SourceState[]
  private readonly counters = {
    attempts: 0,
    failures: 0,
    fallbacks: 0,
    credentialSkips: 0,
    lastSourceId: undefined as string | undefined,
    lastFailureCode: undefined as GatewayFailureCode | undefined,
  }
  private readonly perSource = new Map<string, MutableSourceStat>()
  private readonly metrics: GatewayMetrics

  constructor(deps: GatewayDeps) {
    this.deps = deps
    this.statesCache = probeStates(deps.settings.sources, this.providersOf())
    this.metrics = {
      attempt: (sourceId) => {
        this.counters.attempts += 1
        this.statOf(sourceId).attempts += 1
      },
      failure: (sourceId, code) => {
        this.counters.failures += 1
        const stat = this.statOf(sourceId)
        stat.failures += 1
        stat.lastFailureCode = code
      },
      success: (sourceId) => {
        this.counters.lastSourceId = sourceId
      },
      fallback: () => {
        this.counters.fallbacks += 1
      },
      credentialSkip: () => {
        this.counters.credentialSkips += 1
      },
      usage: (sourceId, usage) => {
        const stat = this.statOf(sourceId)
        stat.tokensIn += usage.inputTokens
        stat.tokensOut += usage.outputTokens
        stat.cacheRead += usage.cacheReadTokens ?? 0
      },
      latency: (sourceId, ms) => {
        this.statOf(sourceId).lastLatencyMs = ms
      },
      fail: (code) => {
        this.counters.lastFailureCode = code
      },
    }
  }

  /** 上游 LLM 服务是否在位。 */
  get available(): boolean {
    return this.deps.runtime() !== undefined
  }

  /** 不可用原因。 */
  get reason(): GatewayFailureCode | undefined {
    return this.available ? undefined : 'gateway-unavailable'
  }

  /** 来源状态（构造时与每次 `probe()` 后的快照）。 */
  get sources(): readonly SourceState[] {
    return this.statesCache
  }

  /** 配置快照（只读，供自检与日志用）。 */
  get settings(): Config {
    return this.deps.settings
  }

  resolve(request?: Pick<GatewayRequest, 'source' | 'allowFallback'>): SourceState | undefined {
    return pickSource(this.statesCache, request?.source)
  }

  async *stream(request: GatewayRequest, trace?: GatewayTrace): AsyncIterable<GatewayChunk> {
    const runtime = this.deps.runtime()
    if (runtime === undefined) {
      throw new GatewayError('gateway-unavailable', '上游模型服务未就绪，网关无法发起请求')
    }
    // 缓存里的首算发生在本插件构造期，那时上游 `llm` 往往还没 provide，
    // 于是每条来源都被判成 gateway-unavailable 并**一直缓存着**——注释里
    // 说的「上游晚装载时 probe() 能自愈」从来没人调用过 probe()。
    // 症状是首次真实调用 1 毫秒就失败（reason=upstream），日志只有一行 warn。
    // 这里在发起前重算一次：路由注册是纯内存查表，不产生任何网络请求。
    if (this.statesCache.length === 0 || this.statesCache.some(state => state.available === false)) {
      this.probe()
    }
    if (this.statesCache.length === 0) {
      // 清单为空是「还没配」，不是「坏了」：给一句能直接照做的话。
      throw new GatewayError('no-source', '还没有配置任何模型来源：请在设置里填写 sources（provider 必须是已安装适配器的路由键）')
    }
    const runner = new Runner({
      runtime,
      settings: this.deps.settings,
      states: this.statesCache,
      credentials: this.deps.credentials,
      metrics: this.metrics,
      log: this.deps.log,
      now: this.deps.now,
    })
    yield* runner.stream(request, trace)
  }

  async complete(request: GatewayRequest): Promise<GatewayCompletion> {
    const trace: GatewayTrace = {}
    let text = ''
    let reasoning = ''
    let usage: GatewayUsage | undefined
    for await (const chunk of this.stream(request, trace)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
    }
    return {
      text,
      reasoning,
      usage,
      sourceId: trace.sourceId ?? '',
      attempts: trace.attempts ?? 0,
      finishKind: trace.finishKind ?? 'stop',
    }
  }

  probe(): readonly SourceState[] {
    this.statesCache = probeStates(this.deps.settings.sources, this.providersOf())
    return this.statesCache
  }

  stats(): GatewayStats {
    const perSource: SourceStat[] = []
    for (const spec of this.deps.settings.sources) {
      const stat = this.perSource.get(spec.id)
      perSource.push({
        id: spec.id,
        attempts: stat?.attempts ?? 0,
        failures: stat?.failures ?? 0,
        tokensIn: stat?.tokensIn ?? 0,
        tokensOut: stat?.tokensOut ?? 0,
        cacheRead: stat?.cacheRead ?? 0,
        lastFailureCode: stat?.lastFailureCode,
        lastLatencyMs: stat?.lastLatencyMs,
      })
    }
    return {
      available: this.available,
      reason: this.reason,
      sources: this.statesCache,
      attempts: this.counters.attempts,
      failures: this.counters.failures,
      fallbacks: this.counters.fallbacks,
      credentialSkips: this.counters.credentialSkips,
      lastSourceId: this.counters.lastSourceId,
      lastFailureCode: this.counters.lastFailureCode,
      perSource,
    }
  }

  /** 取上游 provider 路由列表；上游缺席返回 `undefined`（与「列表为空」区分开）。 */
  private providersOf(): readonly LlmProviderInfoLike[] | undefined {
    const runtime = this.deps.runtime()
    if (runtime === undefined) return undefined
    try {
      return runtime.listProviders()
    } catch (error) {
      this.deps.log.warn('读取上游 provider 列表失败，按「未就绪」处理：%s', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /** 取（或建）一条来源的统计格子。 */
  private statOf(sourceId: string): MutableSourceStat {
    let stat = this.perSource.get(sourceId)
    if (stat === undefined) {
      stat = { attempts: 0, failures: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0 }
      this.perSource.set(sourceId, stat)
    }
    return stat
  }
}
