/**
 * O-122 `ondra-memory-vector`：向量检索分支 + 混合检索（〔研〕自研，多方案分支）。
 *
 * 定位（手册 §12.3「记忆检索」行 + 台账第 16 组）：**2-gram 倒排（O-014）是默认**，
 * 本插件是可选语义分支——台账裁决④的三档（<300 纯字面 / 300–1000 混合 / >1000 向量+ANN）
 * 由本插件按索引规模自动切换。
 *
 * 装载纪律（沿 O-014 的教训）：**刻意不声明插件级 `inject`**——声明后依赖缺席会让整个
 * 插件停在 PENDING（静默不加载，最难查的失败形态）。改成「照常注册 + 按需降级」：
 * 记忆内核缺席时索引为空、`search()` 返回空，O-014 的探测把它当「语义因子缺席」处理，
 * 四因子归一化照跑。
 *
 * 默认关闭（`enabled: false`）：台账第 16 组「默认分支否（倒排默认）」。
 * 打开它 = 用户显式要语义召回；倒排侧（O-014）不需要任何改动。
 */

import type { Context } from '@ntars/cordis'
import { VectorRepository } from './service.js'
import { VECTOR_SERVICE_KEY } from './types.js'
import type {
  MemoryCoreLike,
  StorePortLike,
  VectorService,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、维度常量），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { EMBED_DIM, MODE_THRESHOLD_LITERAL, MODE_THRESHOLD_VECTOR, VECTOR_SERVICE_KEY, VectorError } from './types.js'
export { VectorRepository } from './service.js'
export { hashEmbed, cosineOf, fingerprintOf } from './embed.js'
export { bigramsOf, literalScoreOf, rrfFuse, HYBRID_RRF_K } from './literal.js'
export { buildIvf, ivfSearch, IVF_MIN_DOCS } from './ann.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-vector'

/** 配置项：全部有默认值。 */
export interface Config {
  /**
   * 是否启用本分支。**默认 false**——台账第 16 组：默认分支「否（倒排默认）」。
   * 关闭时不注册服务：O-014 的探测把它当「没有 ondra-memory-vector」，语义因子退出归一化。
   */
  readonly enabled: boolean
  /**
   * 模式。`auto`（默认）按索引规模在字面 / 混合 / 向量三档间自动切换；
   * 也可钉死某一档（调试 / 对拍用）。
   */
  readonly mode: 'auto' | 'literal' | 'hybrid' | 'vector'
  /**
   * 装载时是否从记忆内核同步一次全量索引。默认 true。
   * 内核缺席时跳过（不算错误）；之后由消费方按需调 `sync()`（本插件不装定时器）。
   */
  readonly autoSync: boolean
  /**
   * 是否把索引持久化到存储端口（O-006 / O-007 / O-121 三后端通用）。
   * 默认 true；存储缺席时退回纯内存索引（重启重嵌，哈希嵌入本来就快）。
   */
  readonly persist: boolean
  /**
   * IVF 探桶数（>1000 条时的近似检索精度开关）。默认 3：多探更准、更慢。
   */
  readonly annProbes: number
  /** 读数与同步打一行日志。默认 false。 */
  readonly verbose: boolean
}

/** 默认配置。 */
const DEFAULT_CONFIG: Config = {
  enabled: false,
  mode: 'auto',
  autoSync: true,
  persist: true,
  annProbes: 3,
  verbose: false,
}

/** 允许的模式值。 */
const MODES: readonly string[] = ['auto', 'literal', 'hybrid', 'vector']

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
interface IdentityLike {
  loggerName(feature: string): string
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 补全并夹紧配置。 */
function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const enabled = raw['enabled']
  const mode = raw['mode']
  const autoSync = raw['autoSync']
  const persist = raw['persist']
  const annProbes = raw['annProbes']
  const verbose = raw['verbose']
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_CONFIG.enabled,
    mode: typeof mode === 'string' && (MODES as readonly string[]).includes(mode)
      ? (mode as Config['mode'])
      : DEFAULT_CONFIG.mode,
    autoSync: typeof autoSync === 'boolean' ? autoSync : DEFAULT_CONFIG.autoSync,
    persist: typeof persist === 'boolean' ? persist : DEFAULT_CONFIG.persist,
    annProbes:
      typeof annProbes === 'number' && Number.isFinite(annProbes) && annProbes > 0
        ? Math.min(64, Math.trunc(annProbes))
        : DEFAULT_CONFIG.annProbes,
    verbose: typeof verbose === 'boolean' ? verbose : DEFAULT_CONFIG.verbose,
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 向量检索分支；未装载或 `enabled=false` 时为 undefined（O-014 据此退四因子归一化）。 */
    'ondra-memory-vector'?: VectorService
  }
}

/**
 * Cordis 入口：装配依赖、（可选）同步索引、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Config): void {
  const complete = completeConfig(config)

  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('memory-vector') : 'ondra.memory-vector')

  // 0. 总开关。关闭就不注册服务：O-014 的探测看到 undefined 走「缺席」路径，语义因子退出归一化。
  if (!complete.enabled) {
    log.info('enabled=false（默认）：向量分支未注册。2-gram 倒排（O-014）独自承担召回')
    return
  }

  // 1. 记忆内核（软依赖）：数据源。缺席时索引为空，只能手动 upsert 喂。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.warn('找不到记忆内核（ondra-memory-core）：索引将保持为空，只能经 upsert() 手动喂数据')
  }

  // 2. 存储端口（软依赖）：三后端通用（O-006 / O-007 / O-121）。缺席时索引仅内存。
  const store =
    (ctx.get('ondra-store-sqlite') as StorePortLike | undefined) ??
    (ctx.get('ondra-store-memory') as StorePortLike | undefined) ??
    (ctx.get('ondra-store-json') as StorePortLike | undefined)
  if (store === undefined) {
    log.info('没有存储端口：向量索引仅存内存，重启后重嵌（哈希嵌入零依赖，代价可接受）')
  }

  // 3. 装配服务。
  const repository = new VectorRepository(core, store, complete.mode, complete.annProbes, complete.persist, (level, message, ...args) => {
    if (level === 'error') log.error(message, ...args)
    else if (level === 'warn') log.warn(message, ...args)
    else log.info(message, ...args)
  })

  // 4. 装载时同步一次（autoSync）。内核缺席或不可用时跳过。
  //    外部嵌入器（bge-m3 等）不经服务键接入——仓内没有已确认的 embedding 服务键，
  //    本插件不编造 API；宿主想接真模型时通过 `setEmbedder()` 编程注入（README 已知限制）。
  if (complete.autoSync && core !== undefined && core.available) {
    const result = repository.sync()
    if (result.added + result.updated + result.removed > 0 || complete.verbose) {
      log.info(
        '向量索引同步完成：+%d / ~%d / -%d，共 %d 条（模式 %s）',
        result.added,
        result.updated,
        result.removed,
        result.total,
        repository.mode(),
      )
    }
  }

  // 5. 可逆注册。
  ctx.effect(
    () => ctx.provide(VECTOR_SERVICE_KEY, repository),
    'ondra-memory-vector: 注册向量检索分支',
  )

  const stats = repository.stats()
  log.info(
    '向量分支就绪：%s 模式，%d 条索引，嵌入器 %s（维度 %d），持久化 %s',
    stats.effectiveMode,
    stats.docs,
    stats.embedder,
    stats.dim,
    stats.persisted ? '开' : '关',
  )
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**（与 O-014 同款）。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: Config } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      const complete = completeConfig(value)
      const issues: { message: string }[] = []
      const raw = isRecord(value) ? value : {}
      if (typeof raw['mode'] === 'string' && !(MODES as readonly string[]).includes(raw['mode'])) {
        issues.push({ message: '配置项 mode 只能是 auto / literal / hybrid / vector' })
      }
      if (typeof raw['annProbes'] === 'number') {
        const probes = raw['annProbes']
        if (!Number.isInteger(probes) || probes <= 0) {
          issues.push({ message: '配置项 annProbes 必须是正整数' })
        }
      }
      if (issues.length > 0) return { issues }
      return { value: complete }
    },
  },
}
