/**
 * O-051 `ondra-tts-gate` 的对外契约。
 *
 * 定位：**「这次要不要出声」的唯一判定处**。四道闸门（开关 / 6–30 字 /
 * 情绪强度 / 3 秒频控）+ 一条连读上限（连续两条后强制留文本）。
 *
 * ## 闸门只在这里，发声不在
 *
 * 手册 §9.4 的四道闸门是一个**判定**，不是一次合成。O-050 `ondra-tts`
 * 只管「怎么说」，本插件只管「要不要说」，中间由对话链把
 * `decision.speak === true` 接到 `tts.speak()` 上。
 *
 * 这样拆的后果是可控的：闸门坏掉最多「该出声时没出声」，合成器坏掉
 * 最多「该出声但没声音」——两种故障在日志里是两行不同的话，
 * 而不是混成一句「语音坏了」。
 *
 * ## 失败方向：**放行还是拒绝，取决于缺的是什么**
 *
 * - **引擎没就绪**（O-050 缺席或 `available=false`）→ `speak:false`。
 *   不是「我决定不说话」，是「没有能出声的东西」，如实报 `unavailable`。
 * - **情绪服务缺席** → 情绪闸**降级为放行**（`degraded='no-emotion'`）。
 *   理由：装好了语音却没装情绪，若一律拒绝，结果是「语音功能永远不出声，
 *   而面板显示已启用」——这是最难查的一种「静默失效」。
 *   反过来「她炸毛时念了一句」的代价小得多，且下一条就会修好。
 *
 * 这两条方向相反，是刻意的（纪律：限制型服务的失败方向要看「漏了什么更贵」）。
 *
 * ## 连续两条的计数：只在**真的出声**时加
 *
 * 一轮里发出三条消息，前两条带语音、第三条只有文字 —— 这是手册要的节奏。
 * 若把「被频控拦下」也算进连读，计数会永远停在 1 而**永远触发不了强制文本**，
 * 症状是「她连着五条都在说话」，而闸门日志每条都写着 cooldown。
 * 所以任何一个 `speak:false` 都把计数清零（「连续」被打破）。
 */

/** 本插件注册的服务键（连字符，非 `ondra:tts-gate`）。全仓唯一归属。 */
export const GATE_SERVICE_KEY = 'ondra-tts-gate'

/** 服务键 / 工具名 / 配置键的硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 判定结果码。
 *
 * 每一个都有分支真的发出（`ok` 之外的八个 = 七道拒绝理由 + 一处不可用）。
 */
export type GateReason =
  /** 放行。 */
  | 'ok'
  /** 配置里关掉了（`enable=false`）。 */
  | 'disabled'
  /** 没有可用的合成通道（O-050 缺席，或它自己报了不可用）。 */
  | 'unavailable'
  /** 去空白后不足 `minChars` 字（默认 6）。含「净化后什么都不剩」。 */
  | 'too-short'
  /** 超过 `maxChars` 字（默认 30）。 */
  | 'too-long'
  /** 情绪强度不足且本轮没有情绪词。 */
  | 'flat'
  /** 六态是「炸毛」，手册明写不朗读。 */
  | 'harsh'
  /** 距上次放行不足 `cooldownMs`（默认 3000ms）。 */
  | 'cooldown'
  /** 已经连读满 `maxConsecutive` 条，这一条强制留文本。 */
  | 'text-only'

/** 降级说明（限定「本来该判、但缺数据所以没判」的三处）。 */
export type DegradedReason =
  /** 情绪服务缺席：情绪闸与强度读数都跳过。 */
  | 'no-emotion'
  /** 表达服务（O-031）缺席：拿不到六态语速、也不知道是不是炸毛。 */
  | 'no-express'

/** 一次判定的结果。**不可变**。 */
export interface GateDecision {
  /** 这次该不该出声。 */
  readonly speak: boolean
  /** 结果码。 */
  readonly reason: GateReason
  /** 去空白后的字数（判长度的依据，也是面板要显示的那个数）。 */
  readonly chars: number
  /** 情绪强度（0–1）。情绪服务缺席时为 `undefined`。 */
  readonly intensity?: number
  /** 本轮文本里有没有情绪词。 */
  readonly emotive: boolean
  /** 判定后（`admit()`）的连读计数。`decide()` 给的是当前值。 */
  readonly streak: number
  /** 语速增量，来自六态。`undefined` 表示「手册没给数，用引擎默认」。 */
  readonly rate?: number
  /** 音量档，来自六态。 */
  readonly volume?: 'normal' | 'low'
  /** 本轮的降级情况。空数组表示全部按正常路径判定。 */
  readonly degraded: readonly DegradedReason[]
  /** 距上次放行的毫秒数（从未放行过为 `undefined`）。 */
  readonly sinceLastMs?: number
  /** 判定时刻。 */
  readonly at: number
}

/** 判定入参。 */
export interface GateOptions {
  /** 时刻，省略用 `clock.now()`。 */
  readonly at?: number
  /**
   * 会话 id。
   *
   * 目前**不按会话分开计数**：手册只说「连续两条」，没说「每个会话各自两条」。
   * 字段先留着，等真实会话多起来再决定（写进 README「待裁决」）。
   */
  readonly sessionId?: string
}

/** 拒绝理由的计数表（面板要能看出「主要是哪道闸在拦」）。 */
export interface GateStats {
  readonly decisions: number
  readonly spoken: number
  /** 每个拒绝理由各拦了几次（只含被拦过的理由）。 */
  readonly blocked: Readonly<Partial<Record<GateReason, number>>>
  /** 当前连读计数。 */
  readonly streak: number
  /** 最近一次判定结果。 */
  readonly lastReason?: GateReason
  /** 最近一次放行的时刻，0 表示还没放过。 */
  readonly lastSpokenAt: number
}

/** 闸门服务。 */
export interface GateService {
  /** 是否可用：开关打开即可用（缺情绪/表达只是降级，不是不可用）。 */
  readonly available: boolean
  /** 不可用的唯一原因。 */
  readonly reason?: 'disabled'

  /**
   * 纯判定：**不改任何状态**。面板预览、调试、单测都走这个。
   * @param text 这一条要念的原文（内部自己做去空白与净化后计数）。
   * @param options 入参。
   */
  decide(text: string, options?: GateOptions): GateDecision

  /**
   * 判定并记账（放行则刷新频控时刻与连读计数）。**真正的一句话只调这个一次**。
   * @param text 原文。
   * @param options 入参。
   */
  admit(text: string, options?: GateOptions): GateDecision

  /** 重置连读计数与频控时刻（换会话、重启对话时调用）。 */
  reset(): void

  /** 读数。 */
  stats(): GateStats
}

/* ------------------------------------------------------------------ *
 * 相邻服务的结构对位（§18.5：不 import 源码，只按形状取）
 * ------------------------------------------------------------------ */

/** 日志器。 */
export interface LogLike {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/** O-003 时间服务的子集。 */
export interface ClockLike {
  now(): number
}

/** O-001 身份服务的子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/**
 * O-026 情绪快照的子集。
 *
 * 只取 `normalized`（六维除以量纲后的 0–1 视图）与 `tensionHigh`：
 * 前者让 `energy` 不必在这里再做一次 `/100`（两处各做一次除法，
 * 迟早有一处忘了改），后者是 O-026 已经判好的阈值，不要在这里重判。
 */
export interface EmotionSnapshotLike {
  readonly normalized: Readonly<Record<string, number>>
  readonly tensionHigh: boolean
}

/** O-026 情绪服务子集。 */
export interface EmotionLike {
  state(at?: number): EmotionSnapshotLike
}

/**
 * O-031 语音侧参数的子集（`TtsProfile`）。
 *
 * `readAloud` 是「炸毛不朗读」的判据，`speechRateDelta` 是手册给过数字的
 * 两档（雀跃 +10% / 蔫 −15%），其余状态为 `undefined`（= 手册没给数）。
 */
export interface TtsProfileLike {
  readonly speechRateDelta?: number
  readonly volume?: 'normal' | 'low'
  readonly readAloud: boolean
}

/** O-031 表达服务子集。 */
export interface ExpressLike {
  tts(at?: number): TtsProfileLike
}

/** O-050 合成服务的子集（闸门只读它「能不能出声」，不调它合成）。 */
export interface TtsLike {
  readonly available: boolean
  /**
   * 可朗读净化（可选）。
   *
   * 有就走它、没有就按原文判字数。**不在这里自己实现一份净化**：
   * 两份实现迟早分叉，而分叉的症状是「闸门按 20 字放行、引擎净化后只剩 2 字」。
   */
  speakable?(text: string): string
}

/** 字段声明（与 O-005 对位）。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}

/** O-005 段声明。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}
