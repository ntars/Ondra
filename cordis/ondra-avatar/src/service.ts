/**
 * 立绘服务的实现：**把三件事拼成一份帧，别的什么都不做**。
 *
 * 三件事：
 * 1. 此刻能用哪条通道（`providerOf`，纯函数）；
 * 2. 脸上该是哪个态（O-052 标记 → O-031 六态 → 默认，依次降级）；
 * 3. 该不该换脸（`buildFrame`，纯函数）。
 *
 * ## 为什么状态只在内存
 *
 * 表情是**瞬时**的。落盘会让"重启后她还板着昨天的脸"——那不是记忆，
 * 那是没擦干净的黑板。要记住情绪的是 O-026（`user/emotion.db`），
 * 重启后它会重新判出一个态，立绘跟着它走就行。
 *
 * ## 为什么 `registerRenderer` 会抛
 *
 * 它不是运行时数据（用户填的配置、上游回的值），而是**代码调用**。
 * 传一个不合规的 id 是编程错误，静默返回一个空 disposer 会让调用方
 * 以为接上了——症状是"接了 airi 但一直是静态图"，而日志里一个字都没有。
 * 抛错是这里唯一能在开发期就暴露问题的形状。
 *
 * ## 为什么没有定时器
 *
 * 立绘没有"自己动"的需求：没有帧就没有人看。所有输出都由
 * `frame()` / `resolve()` 拉动，插件空闲时零开销（§12.4 禁常驻服务）。
 */

import { buildFrame, assetFor, providerOf } from './resolve.js'
import type { ProviderState } from './resolve.js'
import { scanAvatar } from './scan.js'
import type { ScanTarget } from './scan.js'
import { isAvatarState, isFrameSource, NAME_RE } from './types.js'
import type { Config } from './settings.js'
import type {
  AvatarAsset,
  AvatarDegraded,
  AvatarFrame,
  AvatarProvider,
  AvatarReason,
  AvatarScan,
  AvatarService,
  AvatarState,
  AvatarStats,
  ExpressLike,
  FsLike,
  FrameInput,
  FrameSource,
  LogLike,
  ModelRef,
  PathLayoutLike,
  PersonaCoreLike,
  RendererSpec,
  ResolveOptions,
} from './types.js'

/** 服务依赖。全部以函数形式注入，便于装载后再取（服务可能后到）。 */
export interface AvatarDeps {
  /** 已补全的配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 当前时刻（毫秒）。 */
  readonly now: () => number
  /** 文件系统。 */
  readonly fs: FsLike
  /** O-002（可能缺席）。 */
  readonly layout: () => PathLayoutLike | undefined
  /** O-020（可能缺席，只用来取当前人设 id）。 */
  readonly persona: () => PersonaCoreLike | undefined
  /** O-031（可能缺席）。 */
  readonly express: () => ExpressLike | undefined
}

/** 取帧时解析出来的「态 + 来源」。 */
interface ResolvedSource {
  /** 态。 */
  readonly state: AvatarState
  /** 来源。 */
  readonly source: FrameSource
  /** 降级。 */
  readonly degraded: readonly AvatarDegraded[]
}

/** O-031 的读数结果。 */
interface ExpressRead {
  /** 读到了。 */
  readonly state?: AvatarState
  /** 没读到。 */
  readonly reason?: 'no-express' | 'unknown-state'
}

/** 立绘服务。 */
export class Avatar implements AvatarService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: () => number
  private readonly fs: FsLike
  private readonly layoutOf: () => PathLayoutLike | undefined
  private readonly personaOf: () => PersonaCoreLike | undefined
  private readonly expressOf: () => ExpressLike | undefined

  /** 最近一次扫描结果。 */
  private scanned: AvatarScan
  /** 已注册渲染器（插入顺序即优先顺序）。 */
  private readonly renderers = new Map<string, RendererSpec>()
  /** 上一帧。**只在内存**。 */
  private last: AvatarFrame | undefined

  private readonly counters: {
    frames: number
    switches: number
    holds: number
    bySource: Record<FrameSource, number>
    byState: Record<AvatarState, number>
  } = {
    frames: 0,
    switches: 0,
    holds: 0,
    bySource: { text: 0, state: 0, default: 0 },
    byState: { joyful: 0, soft: 0, calm: 0, wilted: 0, bristled: 0, sleepy: 0 },
  }

  constructor(deps: AvatarDeps) {
    this.settings = deps.settings
    this.log = deps.log
    this.clock = deps.now
    this.fs = deps.fs
    this.layoutOf = deps.layout
    this.personaOf = deps.persona
    this.expressOf = deps.express
    this.scanned = this.rescan()
  }

  /* ---------------------------------------------------------------- *
   * 只读状态
   * ---------------------------------------------------------------- */

  get available(): boolean {
    if (!this.settings.enable) return false
    return this.providerNow().provider !== 'none'
  }

  get reason(): AvatarReason | undefined {
    return this.providerNow().reason
  }

  get provider(): AvatarProvider {
    return this.providerNow().provider
  }

  get renderer(): string | null {
    const spec = this.activeRenderer()
    return spec === undefined ? null : spec.id
  }

  /* ---------------------------------------------------------------- *
   * 取帧
   * ---------------------------------------------------------------- */

  frame(input?: FrameInput): AvatarFrame {
    const at = input?.at ?? this.clock()
    const state = this.providerNow()
    const expressionOf = this.expressionFactory(state.provider)

    // 关掉：不出图、不查素材（查了会多报一个与本次无关的 no-asset），
    // 但**照常回一帧**，让界面能把"已关闭"显示出来，而不是白屏。
    if (!this.settings.enable) {
      return buildFrame({
        state: this.last?.state ?? this.settings.defaultState,
        source: 'default',
        at,
        previous: this.last,
        minHoldMs: this.settings.minHoldMs,
        assets: [],
        provider: 'none',
        expressionOf,
        degraded: ['disabled'],
        lookupAsset: false,
      })
    }

    const resolved = this.resolveSource(input, at)
    const built = buildFrame({
      state: resolved.state,
      source: resolved.source,
      at,
      previous: this.last,
      minHoldMs: this.settings.minHoldMs,
      assets: this.scanned.images,
      provider: state.provider,
      model: this.scanned.models[0],
      expressionOf,
      degraded: [...state.degraded, ...resolved.degraded],
    })

    this.last = built
    this.tally(built)
    if (this.settings.verbose && built.motion === 'switch') {
      this.log.info(
        '换脸 → %s（来源 %s · 表情 %s · 通道 %s）',
        built.zh,
        built.source,
        built.expression,
        built.provider,
      )
    }
    return built
  }

  peek(): AvatarFrame | undefined {
    return this.last
  }

  resolve(state: AvatarState, options?: ResolveOptions): AvatarFrame {
    const at = options?.at ?? this.clock()
    const current = this.providerNow()
    return buildFrame({
      state,
      source: options?.source ?? 'state',
      at,
      previous: options?.previous,
      minHoldMs: this.settings.minHoldMs,
      assets: this.scanned.images,
      provider: current.provider,
      model: this.scanned.models[0],
      expressionOf: this.expressionFactory(current.provider),
      degraded: current.degraded,
    })
  }

  /* ---------------------------------------------------------------- *
   * 素材
   * ---------------------------------------------------------------- */

  assets(): readonly AvatarAsset[] {
    return this.scanned.images
  }

  models(): readonly ModelRef[] {
    return this.scanned.models
  }

  assetOf(state: AvatarState): AvatarAsset | undefined {
    return assetFor(this.scanned.images, state)
  }

  lastScan(): AvatarScan {
    return this.scanned
  }

  refresh(): AvatarScan {
    this.scanned = this.rescan()
    if (this.scanned.issues.length > 0) {
      this.log.warn('立绘素材有 %d 处需要注意：%s', this.scanned.issues.length, this.scanned.issues.join(' / '))
    }
    return this.scanned
  }

  /* ---------------------------------------------------------------- *
   * 接线
   * ---------------------------------------------------------------- */

  registerRenderer(spec: RendererSpec): () => void {
    if (typeof spec !== 'object' || spec === null) {
      throw new TypeError('渲染器描述不能为空')
    }
    if (typeof spec.id !== 'string' || !NAME_RE.test(spec.id)) {
      throw new TypeError(`渲染器 id 不合规（须匹配 ${NAME_RE.source}）：${String(spec.id)}`)
    }
    const unknown = spec.expressions === undefined
      ? []
      : Object.keys(spec.expressions).filter(key => !isAvatarState(key))
    if (unknown.length > 0) {
      // 不抛：多余的键不影响任何一条映射（取值只按六态索引），
      // 但它几乎一定是拼错了（`joy` / `happy`），说出来比默默忽略好。
      this.log.warn('渲染器 %s 的表情映射里有不认识的态名，已忽略：%s', spec.id, unknown.join(' / '))
    }
    this.renderers.set(spec.id, spec)
    this.log.info('立绘渲染器已注册：%s（共 %d 个）', spec.id, this.renderers.size)
    return () => {
      // 只删自己那一条：同名后注册的会覆盖，此时撤销前者不该把后者带走。
      if (this.renderers.get(spec.id) === spec) {
        this.renderers.delete(spec.id)
        this.log.info('立绘渲染器已撤销：%s', spec.id)
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 统计
   * ---------------------------------------------------------------- */

  stats(): AvatarStats {
    return Object.freeze({
      frames: this.counters.frames,
      switches: this.counters.switches,
      holds: this.counters.holds,
      bySource: Object.freeze({ ...this.counters.bySource }),
      byState: Object.freeze({ ...this.counters.byState }),
      registered: this.renderers.size,
      scannedAt: this.scanned.at,
    })
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  /**
   * 素材目录（**顺序即优先级**）：人设包在前，共享目录在后。
   * @returns 待扫目录；拿不到路径服务时为空数组。
   */
  private dirs(): readonly ScanTarget[] {
    const layout = this.layoutOf()
    if (layout === undefined) return []
    // 纪律 119：可选方法必须 `fn.call(obj, …)`。脱开 this 调用会静默读到空配置。
    const fileIn = layout.fileIn
    if (typeof fileIn !== 'function') return []

    const out: ScanTarget[] = []
    const personaId = this.personaId()
    if (this.settings.usePersonaDir && personaId !== undefined) {
      out.push({
        path: fileIn.call(layout, 'user', 'personas', personaId, 'avatar'),
        label: 'persona',
      })
    }
    out.push({ path: fileIn.call(layout, 'user', this.settings.dir), label: 'shared' })
    return out
  }

  /** 取当前人设 id（拿不到就是 undefined）。 */
  private personaId(): string | undefined {
    const service = this.personaOf()
    if (service === undefined) return undefined
    const stats = service.stats
    if (typeof stats !== 'function') return undefined
    try {
      const view = stats.call(service)
      const id = view === undefined || view === null ? undefined : view.personaId
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  /** 扫一遍并返回结果（不改 `this.scanned`）。 */
  private rescan(): AvatarScan {
    return scanAvatar({ dirs: this.dirs(), fs: this.fs, at: this.clock() })
  }

  /** 此刻的通道判定。**每次现算**：注册渲染器之后要立刻生效。 */
  private providerNow(): ProviderState {
    return providerOf({
      enable: this.settings.enable,
      pref: this.settings.provider,
      images: this.scanned.images.length,
      models: this.scanned.models.length,
      renderer: this.activeRenderer() !== undefined,
      readError: this.scanned.dirs.some(
        dir => dir.error !== undefined && dir.code !== 'ENOENT',
      ),
      missingPath: this.scanned.dirs.length === 0,
    })
  }

  /** 第一个就绪的渲染器（插入顺序）。 */
  private activeRenderer(): RendererSpec | undefined {
    for (const spec of this.renderers.values()) {
      if (spec.ready !== false) return spec
    }
    return undefined
  }

  /**
   * 造一个「态 → 表情名」的映射函数。
   *
   * 只有 live2d 才用渲染器的映射：静态图的表情名就是文件名主干，
   * 改了反而找不到图（这和学习 O-053 的「文件名即标签」是同一条理由）。
   * @param provider 当前通道。
   */
  private expressionFactory(provider: AvatarProvider): (state: AvatarState) => string {
    if (provider !== 'live2d') return (state: AvatarState) => state
    const spec = this.activeRenderer()
    const map = spec === undefined ? undefined : spec.expressions
    return (state: AvatarState) => {
      const mapped = map === undefined ? undefined : map[state]
      return typeof mapped === 'string' && mapped !== '' ? mapped : state
    }
  }

  /**
   * 解析「这一帧的态与来源」。
   *
   * 优先级：`mark`（它带来源）→ 显式 `state` → O-031 → 保持上一帧 → 默认。
   * @param input 入参。
   * @param at 时刻。
   */
  private resolveSource(input: FrameInput | undefined, at: number): ResolvedSource {
    const degraded: AvatarDegraded[] = []

    const mark = input?.mark
    if (mark !== undefined) {
      if (isAvatarState(mark.state)) {
        const source = isFrameSource(mark.source) ? mark.source : 'state'
        // `default` = 一条依据都没有。此时保持原样比"回落成平静"更诚实：
        // 没有依据不该让她的脸动一下。
        if (source === 'default' && this.last !== undefined) {
          degraded.push('no-mark')
          return { state: this.last.state, source, degraded }
        }
        return { state: mark.state, source, degraded }
      }
      degraded.push('unknown-state')
    }

    const given = input?.state
    if (isAvatarState(given)) return { state: given, source: 'state', degraded }

    const read = this.readExpress(at)
    if (read.state !== undefined) return { state: read.state, source: 'state', degraded }
    if (read.reason !== undefined) degraded.push(read.reason)

    if (this.last !== undefined) {
      degraded.push('no-mark')
      return { state: this.last.state, source: 'default', degraded }
    }
    return { state: this.settings.defaultState, source: 'default', degraded }
  }

  /**
   * 读 O-031 的当前态。**任何异常都折成"没读到"**。
   *
   * 立绘是纯展示：上游坏了，最差的正确表现是"脸上不动"，
   * 而不是把异常抛进调用方的渲染循环（那会让整个界面白掉）。
   * @param at 时刻。
   */
  private readExpress(at: number): ExpressRead {
    const service = this.expressOf()
    if (service === undefined) return { reason: 'no-express' }
    try {
      const stateOf = service.stateOf
      if (typeof stateOf !== 'function') return { reason: 'no-express' }
      const view = stateOf.call(service, at)
      return isAvatarState(view?.state) ? { state: view.state } : { reason: 'unknown-state' }
    } catch {
      return { reason: 'no-express' }
    }
  }

  /** 记一笔。 */
  private tally(frame: AvatarFrame): void {
    this.counters.frames += 1
    if (frame.motion === 'switch') this.counters.switches += 1
    else this.counters.holds += 1
    this.counters.bySource[frame.source] += 1
    this.counters.byState[frame.state] += 1
  }
}
