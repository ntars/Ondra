/**
 * 声音链的**宿主侧调度** —— 「她说完一句话，这一句要不要念出来」。
 *
 * ## 它补的是哪条断掉的边
 *
 * `ondra-tts`（O-050）与 `ondra-tts-gate`（O-051）两个插件本身都是完整的：
 * 合成通道、缓存、四道闸门、情绪语速，一行没少。但它们之间**从来没连过**：
 *
 * | 谁 | 本来该做的事 |
 * | --- | --- |
 * | `ondra-tts` | 只被调用，自己不发消息、不判该不该念 |
 * | `ondra-tts-gate` | 只判定，README 明写「本插件不调它的 `speak()`」 |
 * | **没有人** | 把「判定 → 合成 → 出声」这三步串起来 |
 *
 * 于是两个包都只在自检里跑过，产品里一次都没有出过声：闸门的 `admit()`、
 * TTS 的 `speak()` 在宿主侧都是零调用方。两处都不报错——因为它们各自
 * 都「按设计」只做自己那一段。这是本仓最容易漏判的形态：**两个完好的
 * 组件，中间少一根线，而日志完全干净。**
 *
 * ## 为什么判据放在宿主，而不是塞进任一个插件
 *
 * 串起两段需要一个「一轮对话结束了」的时刻，而这个时刻只有宿主知道
 * （`inference.run` 返回之后）。塞进 `ondra-tts` 就得让它监听会话事件，
 * 那是通道层的事；塞进闸门则违背它「只判定、不出声」的边界。
 *
 * ## 顺序为什么不能换
 *
 * ```
 * 闸门 admit()  →  speak()      ← 对
 * speak()      →  闸门 admit()  ← 错：钱已花、声已出，拦不回来了
 * ```
 *
 * `admit()` 会记账（频控时刻、连读计数）。放在 `speak()` 之后，
 * 合成失败的那一条也算「念过了」，连读计数虚高、频控时刻被无谓推后，
 * 症状是「她连着好几轮不出声，过一会儿又突然出声」。
 *
 * ## 为什么宿主不自建一个「朗读开关」
 *
 * 那会是第二个真源。用户关朗读就是 `tts` 段的 `enable=false`，
 * 插件自己会把 `available` 置 false 并给出 `disabled` 原因码。
 * 宿主再存一个布尔值，就会出现「设置页关了、那个值还开着」这类
 * 谁都说不清的两处不一致。所以本文件**只读**插件状态，不持有开关。
 */

import type { Context } from '@ntars/cordis'

/** 闸门判定的结构对位子集（不 import 插件源码，只按形状取）。 */
interface GateDecisionLike {
  readonly speak: boolean
  readonly reason: string
  readonly chars: number
  readonly rate?: number
  readonly volume?: 'normal' | 'low'
  readonly streak: number
  readonly degraded: readonly string[]
}

/** 语音闸门服务。 */
interface GatePort {
  readonly available: boolean
  readonly reason?: string
  admit(text: string): GateDecisionLike
  reset(): void
  stats(): {
    readonly decisions: number
    readonly spoken: number
    readonly blocked: Readonly<Partial<Record<string, number>>>
    readonly streak: number
    readonly lastReason?: string
    readonly lastSpokenAt: number
  }
}

/** 合成结果的结构对位子集。 */
interface UtteranceLike {
  readonly ok: boolean
  readonly reason: string
  readonly engine: string
  readonly played?: boolean
}

/** 语音合成服务。 */
interface TtsPort {
  readonly available: boolean
  readonly reason?: string
  readonly engine: string
  speakable(text: string): string
  speak(text: string, options?: { readonly rate?: number; readonly volume?: 'normal' | 'low' }): Promise<UtteranceLike>
  stats(): {
    readonly calls: number
    readonly ok: number
    readonly failures: number
    readonly cachedHits: number
    readonly played: number
    readonly lastOkAt: number
    readonly lastError?: string
    readonly cacheFiles: number
  }
}

/** 一次朗读尝试的结果。 */
export interface VoiceOutcome {
  /** 这一句走到哪一步了。 */
  readonly status:
    /** 念出来了。 */
    | 'spoken'
    /** 闸门拦下了。 */
    | 'held'
    /** 合成或播放失败。 */
    | 'failed'
    /** 插件缺席。 */
    | 'absent'
    /** 用户在设置里关了朗读。 */
    | 'off'
  /** 闸门或 TTS 给的原因码。 */
  readonly reason?: string
  /** 真正参与判定的字数。 */
  readonly chars?: number
  /** 实际生效的通道。 */
  readonly engine?: string
  /** 判完之后的连读计数。 */
  readonly streak?: number
}

/** 声音链的探针读数。给设置页与诊断接口用。 */
export interface VoiceProbe {
  /** `ondra-tts` 在不在。 */
  readonly ttsLoaded: boolean
  /** `ondra-tts-gate` 在不在。 */
  readonly gateLoaded: boolean
  /** 用户在设置里关没关朗读（`tts` 段的 `enable`）。 */
  readonly enabled: boolean
  /** 合成通道是否可用（插件自报）。 */
  readonly ttsAvailable: boolean
  /** 当前通道；缺席时为 `unknown`。 */
  readonly engine: string
  /** 闸门是否可用（只看它自己的总开关）。 */
  readonly gateAvailable: boolean
  /** 一句话说清「为什么现在不能出声」。能出声时为空串。 */
  readonly note: string
  /**
   * 闸门记的账：`decisions` / `spoken` / `blocked`（按理由分桶）/ `streak`。
   *
   * 这是判断「链子真的通了吗」的唯一硬证据：
   * - `decisions` 长期为 0 → `admit()` 一次都没被调过，宿主那条线断了；
   * - `decisions` 涨而 `spoken` 不涨 → 闸门在拦，看 `blocked` 是哪道；
   * - `spoken` 涨 → 真的放行过，声音出去了。
   *
   * 三者混成一句「语音正常」，就会把「没接线」和「被拦下」说成同一件事。
   */
  readonly gateStats?:
    | {
        readonly decisions: number
        readonly spoken: number
        readonly blocked: Readonly<Partial<Record<string, number>>>
        readonly streak: number
        readonly lastReason?: string
        readonly lastSpokenAt: number
      }
    | undefined
  /** 合成侧记账：真的调了几次、成了几次、缓存里几个文件。 */
  readonly ttsStats?:
    | {
        readonly calls: number
        readonly ok: number
        readonly failures: number
        readonly played: number
        readonly lastError?: string
        readonly cacheFiles: number
      }
    | undefined
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 读两个服务。 */
function portsOf(ctx: Context): { gate: GatePort | undefined; tts: TtsPort | undefined } {
  return {
    gate: ctx.get('ondra-tts-gate') as GatePort | undefined,
    tts: ctx.get('ondra-tts') as TtsPort | undefined,
  }
}

/**
 * 读一次声音链状态。**只读**，不合成、不改任何状态。
 *
 * `note` 只在真的说得出原因时填。四个原因分开写，因为它们对应四种
 * 完全不同的用户动作：去设置里打开、去装插件、去查引擎、去修配置。
 * @param ctx 宿主上下文。
 */
export function voiceProbe(ctx: Context): VoiceProbe {
  const { gate, tts } = portsOf(ctx)
  if (tts === undefined) {
    return Object.freeze({
      ttsLoaded: false,
      gateLoaded: gate !== undefined,
      enabled: false,
      ttsAvailable: false,
      engine: 'unknown',
      gateAvailable: gate?.available === true,
      note: '语音合成插件没装载',
    })
  }
  if (gate === undefined) {
    return Object.freeze({
      ttsLoaded: true,
      gateLoaded: false,
      enabled: tts.reason !== 'disabled',
      ttsAvailable: tts.available,
      engine: tts.engine,
      gateAvailable: false,
      note: '语音闸门没装载，不知道这一句该不该念',
    })
  }

  /*
   * 「用户关了朗读」与「通道坏了」必须分开：前者是他自己的选择，
   * 后者是要修的故障。合成一处的 `disabled` 加通道自报，就能区分。
   */
  const disabledByUser = tts.reason === 'disabled'
  if (disabledByUser) {
    return Object.freeze({
      ttsLoaded: true,
      gateLoaded: true,
      enabled: false,
      ttsAvailable: false,
      engine: tts.engine,
      gateAvailable: gate.available,
      note: '朗读关着（在设置里打开「语音合成」的总开关就出声）',
      ...gateStatsOf(gate),
      ...ttsStatsOf(tts),
    })
  }
  if (tts.available !== true) {
    return Object.freeze({
      ttsLoaded: true,
      gateLoaded: true,
      enabled: true,
      ttsAvailable: false,
      engine: tts.engine,
      gateAvailable: gate.available,
      note: tts.reason === undefined ? '合成通道不可用' : `合成通道不可用（${tts.reason}）`,
      ...gateStatsOf(gate),
      ...ttsStatsOf(tts),
    })
  }
  return Object.freeze({
    ttsLoaded: true,
    gateLoaded: true,
    enabled: true,
    ttsAvailable: true,
    engine: tts.engine,
    gateAvailable: gate.available,
    note: '',
    ...gateStatsOf(gate),
    ...ttsStatsOf(tts),
  })
}

/**
 * 读闸门账本。读不到就整格省掉，不编一个全零的假账本。
 *
 * 全零与「读不到」是两件事：前者说「没被调过」，后者说「服务形状不对」。
 * 补一个零会让「接线断了」伪装成「链路正常但还没说话」。
 * @param gate 闸门服务。
 */
function gateStatsOf(gate: GatePort): { gateStats?: VoiceProbe['gateStats'] | undefined } {
  try {
    return { gateStats: gate.stats() }
  } catch {
    return {}
  }
}

/** 读合成账本。理由同上。 */
function ttsStatsOf(tts: TtsPort): { ttsStats?: VoiceProbe['ttsStats'] | undefined } {
  try {
    const s = tts.stats()
    return {
      ttsStats: {
        calls: s.calls,
        ok: s.ok,
        failures: s.failures,
        played: s.played,
        ...(s.lastError === undefined ? {} : { lastError: s.lastError }),
        cacheFiles: s.cacheFiles,
      },
    }
  } catch {
    return {}
  }
}

/**
 * 念一句她刚说完的话。
 *
 * **永不抛错**：朗读是增强能力，它挂了这一轮对话必须照常成立
 * （插件 README 的「唯一一条硬规矩」在宿主这一层同样适用）。
 *
 * @param ctx 宿主上下文。
 * @param text 要念的正文（会做可朗读净化）。
 */
export async function speakReply(ctx: Context, text: string): Promise<VoiceOutcome> {
  const { gate, tts } = portsOf(ctx)
  if (tts === undefined || gate === undefined) return Object.freeze({ status: 'absent' })
  // 用户关掉朗读：一次净化、一次判定都不做，别动闸门的计数。
  if (tts.reason === 'disabled') return Object.freeze({ status: 'off' })
  if (tts.available !== true) {
    return Object.freeze({ status: 'failed', reason: tts.reason ?? 'unavailable', engine: tts.engine })
  }

  /*
   * 净化一次，让闸门按「真正会念的字数」判。
   *
   * 不净化就判，一段 40 字的代码块会被判 `too-long` 而拒绝；净化后只剩
   * 3 个字，其实可以念。反过来更糟：闸门说「该念」、引擎说「没东西念」——
   * 两处各数一次的结果就是这种自相矛盾。`speakable()` 抛错时退回原文：
   * 判长可能不准，但总比整条链断掉好。
   */
  let clean = text
  try {
    clean = tts.speakable(text)
  } catch (error) {
    process.stderr.write(`[host] 可朗读净化失败（按原文判长）：${messageOf(error)}\n`)
  }

  let decision: GateDecisionLike
  try {
    decision = gate.admit(clean)
  } catch (error) {
    process.stderr.write(`[host] 语音闸门判定异常（本轮不出声）：${messageOf(error)}\n`)
    return Object.freeze({ status: 'failed', reason: 'gate-error' })
  }

  if (!decision.speak) {
    return Object.freeze({
      status: 'held',
      reason: decision.reason,
      chars: decision.chars,
      streak: decision.streak,
    })
  }

  try {
    const utterance = await tts.speak(clean, {
      ...(decision.rate === undefined ? {} : { rate: decision.rate }),
      ...(decision.volume === undefined ? {} : { volume: decision.volume }),
    })
    if (!utterance.ok) {
      return Object.freeze({
        status: 'failed',
        reason: utterance.reason,
        chars: decision.chars,
        engine: utterance.engine,
        streak: decision.streak,
      })
    }
    return Object.freeze({
      status: 'spoken',
      chars: decision.chars,
      engine: utterance.engine,
      streak: decision.streak,
    })
  } catch (error) {
    process.stderr.write(`[host] 语音合成异常（本轮不出声）：${messageOf(error)}\n`)
    return Object.freeze({ status: 'failed', reason: 'tts-error', chars: decision.chars })
  }
}

/**
 * 换一场会话时把闸门的连读计数归零。
 *
 * 插件 README 第 3 条已知限制写得很清楚：`sessionId` 在它那里「目前不生效」，
 * 因为它不知道什么算一场会话。宿主知道，所以由宿主在切会话时调一次。
 *
 * 不调的症状：连读计数跨会话累加，「连着两条之后强制留文本」于是在
 * 第二个会话里一开口就被触发——她明明刚开始说话却不出声，且没有任何日志。
 * @param ctx 宿主上下文。
 */
export function resetVoiceGate(ctx: Context): void {
  const { gate } = portsOf(ctx)
  if (gate === undefined) return
  try {
    gate.reset()
  } catch (error) {
    process.stderr.write(`[host] 语音闸门归零失败：${messageOf(error)}\n`)
  }
}
