/**
 * 纯判定：**来源 → 动作**，**能力 → 通道**，**素材 → 图**。
 *
 * 这个文件里没有 ctx、没有文件系统、没有时钟——全部入参都是值。
 * 之所以单独拆出来，是因为这里的每一条都是"改一个数就换个行为"的口径，
 * 混在服务类里就没法逐条对拍。
 *
 * ## 三条容易写反的判定
 *
 * 1. **`source` 决定能不能换脸，`state` 不能。**
 *    O-052 的 `state` 来源语义是「跟内态走、脸上不动」。只看 `state`
 *    会得到"每句话都换脸"，而每句话都换脸 = 每句话都抖一下。
 *
 * 2. **最短停留挡的是"态变化"，不是"取帧"。**
 *    被挡住时仍要返回一帧（`motion: 'hold'`，`since` 保持原值），
 *    绝不能返回空——调用方拿到 `undefined` 会退回自己的兜底逻辑，
 *    那时屏幕上的脸和面板上的态就对不上了。
 *
 * 3. **显式 `provider` 也要能降级。**
 *    钉死 `live2d` 但一个模型都没有时，退回静态图并记 `no-model`。
 *    台账对 O-054 的原话就是「只做接线与**静态降级**」，
 *    如果钉死就等于没有降级，这条能力等于没做。
 */

import { FALLBACK_KEYS, STATE_ZH } from './types.js'
import type {
  AssetKey,
  AvatarAsset,
  AvatarDegraded,
  AvatarFrame,
  AvatarProvider,
  AvatarReason,
  AvatarState,
  FrameSource,
  ModelRef,
  ProviderPref,
} from './types.js'

/**
 * 找出某个态该用的图。**带兜底链**：本态 → neutral → default。
 *
 * 兜底只到 `neutral` / `default` 为止，不会"随便拿一张别的表情"。
 * 拿错表情比没有表情更糟：用户看到的是"她明明很难过却在笑"，
 * 而所有日志都是绿的。
 * @param assets 可用素材。
 * @param state 目标态。
 */
export function assetFor(
  assets: readonly AvatarAsset[],
  state: AvatarState,
): AvatarAsset | undefined {
  const direct = assets.find(asset => asset.key === state)
  if (direct !== undefined) return direct
  for (const key of FALLBACK_KEYS) {
    const hit = assets.find(asset => asset.key === (key as AssetKey))
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 判「此刻能显示什么」的入参。 */
export interface ProviderQuery {
  /** 开关。 */
  readonly enable: boolean
  /** 配置偏好。 */
  readonly pref: ProviderPref
  /** 可用图数。 */
  readonly images: number
  /** 可用模型数。 */
  readonly models: number
  /** 有没有**就绪的** live2d 渲染器。 */
  readonly renderer: boolean
  /** 扫描时是否遇到非 ENOENT 的读目录错误。 */
  readonly readError: boolean
  /** 是不是连数据根都拿不到（O-002 缺席）。 */
  readonly missingPath: boolean
}

/** 判「此刻能显示什么」的结果。 */
export interface ProviderState {
  /** 通道。 */
  readonly provider: AvatarProvider
  /** 整块不可用的原因（`provider === 'none'` 时才有）。 */
  readonly reason?: AvatarReason
  /** 在这个通道决定过程中的降级。 */
  readonly degraded: readonly AvatarDegraded[]
}

/**
 * 判断此刻能用哪条通道。
 *
 * 顺位与理由（§14.2「默认最稳」）：
 * 1. `live2d`：有模型 **且** 有就绪渲染器才成立——少一样都不算，"有模型"≠"能显示"；
 * 2. `static`：有图就成立，这是兜底通道；
 * 3. `none`：都没有，给出原因码。
 *
 * @param query 入参。
 */
export function providerOf(query: ProviderQuery): ProviderState {
  if (!query.enable) {
    return { provider: 'none', reason: 'disabled', degraded: ['disabled'] }
  }

  const degraded: AvatarDegraded[] = []
  const canLive2d = query.models > 0 && query.renderer

  if (query.pref !== 'static') {
    if (canLive2d) return { provider: 'live2d', degraded }
    // 有模型却显示不了：**任何偏好下都要说出来**。
    // 只在钉死 live2d 时才记的话，`auto` 用户放了模型、看到仍是一张静态图，
    // 而日志里一个字都没有——「半对」比「完全没有」更难查（纪律 101）。
    if (query.models > 0) degraded.push('no-renderer')
    else if (query.pref === 'live2d') degraded.push('no-model')
  }

  if (query.images > 0) return { provider: 'static', degraded }

  // 原因码的优先级：不知道目录在哪 > 目录读不了 > 目录里没东西。
  // 顺序反了会把「没装路径服务」报成「你没有放图」，用户会去翻一个不存在的目录。
  const reason: AvatarReason = query.missingPath
    ? 'no-path'
    : query.readError
      ? 'read-error'
      : query.pref === 'static'
        ? 'no-asset'
        : query.models === 0 && query.pref === 'live2d'
          ? 'no-model'
          : query.models > 0 && !query.renderer
            ? 'no-renderer'
            : 'no-asset'

  return { provider: 'none', reason, degraded }
}

/** 组帧入参。**全部是值**，没有闭包之外的状态。 */
export interface FrameShape {
  /** 表情态。 */
  readonly state: AvatarState
  /** 依据来源。 */
  readonly source: FrameSource
  /** 时刻。 */
  readonly at: number
  /** 上一帧（无则为首帧）。 */
  readonly previous?: AvatarFrame
  /** 最短停留（毫秒）。 */
  readonly minHoldMs: number
  /** 可用素材。 */
  readonly assets: readonly AvatarAsset[]
  /** 通道。 */
  readonly provider: AvatarProvider
  /** 模型（仅 live2d）。 */
  readonly model?: ModelRef
  /** 六态 → 渲染层表情名。 */
  readonly expressionOf: (state: AvatarState) => string
  /** 进来时已经确定的降级码（通道侧 + 来源侧）。 */
  readonly degraded: readonly AvatarDegraded[]
  /**
   * 是否去查素材。默认 `true`。
   *
   * 只有"关闭状态"会传 `false`：那时一帧图都不会显示，去查素材只会
   * 在 `degraded` 里多一条 `no-asset`，把"你自己关的"说成"你没放图"。
   */
  readonly lookupAsset?: boolean
}

/**
 * 去重但保序。降级码可能由上游与下游各推一次（比如两处都发现没图）。
 * @param codes 原始序列。
 */
function uniqueCodes(codes: readonly AvatarDegraded[]): readonly AvatarDegraded[] {
  const seen = new Set<AvatarDegraded>()
  const out: AvatarDegraded[] = []
  for (const code of codes) {
    if (seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return Object.freeze(out)
}

/**
 * 组一帧。
 *
 * `since` 的语义是「**这个表情**从何时开始」，所以：
 * 换脸时置为 `at`，保持时沿用上一帧的 `since`。不能用 `at` 兜底——
 * 那样每一帧看起来都是"刚开始"，而"停留了多久"正是判断
 * 「她是不是闪了一下」的唯一依据。
 *
 * @param shape 入参。
 */
export function buildFrame(shape: FrameShape): AvatarFrame {
  const degraded: AvatarDegraded[] = [...shape.degraded]
  const prev = shape.previous

  let motion: 'switch' | 'hold'
  let since: number

  if (prev === undefined) {
    motion = 'switch'
    since = shape.at
  } else if (shape.at < prev.since) {
    // 时钟回拨（手动改系统时间、NTP 校正）。此时 `at - since` 是负数，
    // 若照常判「还没停够」就会永远 hold——症状是表情再也不换。
    motion = 'switch'
    since = shape.at
    degraded.push('clock-back')
  } else if (prev.state === shape.state) {
    motion = 'hold'
    since = prev.since
  } else if (shape.source === 'text') {
    // 正文里有依据：新的一句就该是新的一张脸，不受停留下限约束。
    motion = 'switch'
    since = shape.at
  } else if (shape.at - prev.since >= shape.minHoldMs) {
    motion = 'switch'
    since = shape.at
  } else {
    motion = 'hold'
    since = prev.since
    degraded.push('held')
  }

  const usesModel = shape.provider === 'live2d'
  const lookup = shape.lookupAsset !== false
  const asset = usesModel || !lookup ? undefined : assetFor(shape.assets, shape.state)

  if (!usesModel && lookup) {
    if (asset === undefined) degraded.push('no-asset')
    else if (asset.key !== shape.state) degraded.push('asset-fallback')
  }

  const model = usesModel ? shape.model : undefined

  return Object.freeze({
    state: shape.state,
    zh: STATE_ZH[shape.state],
    source: shape.source,
    expression: shape.expressionOf(shape.state),
    provider: shape.provider,
    ...(asset === undefined ? {} : { asset }),
    ...(model === undefined ? {} : { model }),
    motion,
    since,
    at: shape.at,
    degraded: uniqueCodes(degraded),
  })
}
