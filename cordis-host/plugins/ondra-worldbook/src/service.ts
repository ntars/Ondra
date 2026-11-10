/**
 * 世界书服务的门面：把条目库、六层预算、常驻段缓存拼在一起。
 *
 * 三条设计取舍：
 *
 * 1. **服务照常注册，`available` 说清现状。** 世界书缺席不该让对话层拿不到服务：
 *    拿到「一个说清为什么空的对象」比拿到 `undefined` 有用得多——
 *    前者能在界面上显示「还没导入世界书」，后者只能显示「世界书未就绪」这种废话。
 *
 * 2. **常驻段按「注册版本号」缓存，不按时间。** 用时间做缓存键（比如 5 秒）
 *    会让同一轮里两次取到不同的前缀，而那正是缓存命中率的死因（§8.5）。
 *    版本号只在注册/删除/换计量器时 +1，别的时候一次都不会变。
 *
 * 3. **`pack()` 不写任何状态。** 同样的条目 + 同样的候选，任何时候调都得到同样的结果
 *    （包括同样的 `digest`）。有状态的分装器无法回答「上一轮到底是什么样」。
 */

import { emptyBlock, layerSpecs, packLayers, renderConstant } from './layers.js'
import { createMeter } from './meter.js'
import { WorldbookRegistry, describeIssue } from './registry.js'
import { meterDoc } from './settings.js'
import { ALLOCATED_TOKENS, LAYER_BUDGETS, LAYER_IDS, TOTAL_TOKENS } from './types.js'
import type {
  ConstantBlock,
  EntryFilter,
  EntryInput,
  LayerId,
  LayerSpec,
  LoadResult,
  LogLike,
  PackRequest,
  RegisterResult,
  TokenMeter,
  WorldbookBlock,
  WorldbookEntry,
  WorldbookService,
  WorldbookStats,
  WorldbookUnavailableReason,
} from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。 */
export interface ServiceDeps {
  /** 配置（已补全）。 */
  readonly config: Config
  /** 日志。 */
  readonly log: LogLike
  /** 世界书文件的绝对路径；没有路径服务时为 `undefined`。 */
  readonly filePath: string | undefined
  /** 文件路径的用户可见写法。 */
  readonly fileDisplay: string | undefined
  /** 文件存在性探针；没有路径服务时一律返回 `false`。 */
  readonly exists: (path: string) => boolean
}

/** 世界书服务实现。 */
export class WorldbookRepository implements WorldbookService {
  private readonly config: Config
  private readonly log: LogLike
  private readonly filePath: string | undefined
  private readonly fileDisplay: string | undefined
  private readonly existsProbe: (path: string) => boolean
  private readonly registry: WorldbookRegistry
  private meterFn: TokenMeter
  private cached: ConstantBlock | undefined
  private cachedRevision = -1

  /**
   * @param deps 依赖。
   */
  constructor(deps: ServiceDeps) {
    this.config = deps.config
    this.log = deps.log
    this.filePath = deps.filePath
    this.fileDisplay = deps.fileDisplay
    this.existsProbe = deps.exists
    this.meterFn = createMeter(deps.config.cjkCharsPerToken, deps.config.asciiCharsPerToken)
    this.registry = new WorldbookRegistry(deps.log, this.meterFn, deps.config.maxEntryTokens)
  }

  /** 是否可用。 */
  get available(): boolean {
    if (!this.config.enable) return false
    return this.registry.list({ enabled: true }).length > 0
  }

  /** 不可用原因。 */
  get reason(): WorldbookUnavailableReason | undefined {
    if (!this.config.enable) return 'disabled'
    if (this.registry.list({ enabled: true }).length === 0) return 'empty'
    return undefined
  }

  /** 六层声明。 */
  layers(): readonly LayerSpec[] {
    return layerSpecs()
  }

  /**
   * 条目清单。
   * @param filter 条件。
   */
  entries(filter?: EntryFilter): readonly WorldbookEntry[] {
    return this.registry.list(filter)
  }

  /**
   * 取一条。
   * @param id 条目 id。
   */
  entry(id: string): WorldbookEntry | undefined {
    return this.registry.get(id)
  }

  /**
   * 注册条目。关掉开关时**照收**但不参与拼装——关开关不该让用户的世界书消失。
   * @param input 条目。
   */
  register(input: readonly EntryInput[]): RegisterResult {
    return this.registry.register(input)
  }

  /**
   * 删一条。
   * @param id 条目 id。
   */
  remove(id: string): boolean {
    return this.registry.remove(id)
  }

  /**
   * 清空。
   * @param source 来源。
   */
  clear(source?: 'file' | 'runtime' | 'scene'): number {
    return this.registry.clear(source)
  }

  /** 当前计量器。 */
  meter(): TokenMeter {
    return this.meterFn
  }

  /**
   * 换计量器。传 `undefined` 恢复配置里的估算口径。
   * @param meter 新估算器。
   */
  setMeter(meter: TokenMeter | undefined): void {
    this.meterFn = meter ?? createMeter(this.config.cjkCharsPerToken, this.config.asciiCharsPerToken)
    this.registry.setMeter(this.meterFn)
    // 版本号已经 +1，缓存自然失效；这里显式清一次，省得读的人以为忘了。
    this.cached = undefined
  }

  /**
   * 量一段文本（用当前计量器）。
   * @param text 文本。
   */
  measure(text: string): number {
    return this.meterFn(text)
  }

  /** 常驻段（带缓存）。 */
  constantBlock(): ConstantBlock {
    const revision = this.registry.revision
    if (this.cached !== undefined && this.cachedRevision === revision) return this.cached
    const block = renderConstant(this.registry.all(), this.config.includeHeadings, this.meterFn)
    this.cached = block
    this.cachedRevision = revision
    return block
  }

  /**
   * 打包。
   * @param request 请求。
   */
  pack(request?: PackRequest): WorldbookBlock {
    if (!this.config.enable) return emptyBlock()
    const block = packLayers({
      entries: this.registry.all(),
      request: request ?? {},
      fitPolicy: this.config.fitPolicy,
      includeHeadings: this.config.includeHeadings,
      annotateDropped: request?.annotateDropped ?? this.config.annotateDropped,
      meter: this.meterFn,
    })
    if (this.config.reportDropped && block.dropped.length > 0) {
      // 只报前几条：一次导入 200 条、撞限丢 40 条时，刷屏等于没报。
      const head = block.dropped
        .slice(0, 5)
        .map(item => item.id + '(' + item.code + ')')
        .join('、')
      this.log.info('世界书本轮丢弃 %d 条：%s%s', block.dropped.length, head, block.dropped.length > 5 ? ' …' : '')
    }
    return block
  }

  /** 从世界书文件加载。 */
  loadFromFile(): LoadResult {
    if (this.filePath === undefined) {
      return {
        loaded: 0,
        rejected: [],
        issue: { code: 'no-file', detail: '没有装载 ondra-path-layout，算不出世界书文件在哪' },
      }
    }
    const result = this.registry.loadFromFile(this.filePath, this.existsProbe(this.filePath))
    if (result.issue !== undefined && result.issue.code !== 'no-file') {
      this.log.warn('%s', describeIssue(result.issue))
    }
    return result
  }

  /** 统计快照。 */
  stats(): WorldbookStats {
    const all = this.registry.all()
    const enabled = all.filter(entry => entry.enabled)
    const perLayer: Record<LayerId, number> = { l1: 0, l2: 0, l3: 0, l4: 0, l5: 0, l6: 0 }
    for (const entry of enabled) perLayer[entry.layer] += 1
    const constantOverBudget = LAYER_IDS.some(layer => {
      const used = enabled
        .filter(entry => entry.constant && entry.layer === layer)
        .reduce((sum, entry) => sum + entry.tokens, 0)
      return used > LAYER_BUDGETS[layer]
    })
    const reason = this.reason
    return {
      available: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      entries: all.length,
      enabled: enabled.length,
      constant: enabled.filter(entry => entry.constant).length,
      perLayer,
      constantTokens: this.constantBlock().tokens,
      constantOverBudget,
      totalTokens: TOTAL_TOKENS,
      allocatedTokens: ALLOCATED_TOKENS,
      slackTokens: TOTAL_TOKENS - ALLOCATED_TOKENS,
      meter: meterDoc(this.config),
      file: this.fileDisplay,
      revision: this.registry.revision,
    }
  }
}
