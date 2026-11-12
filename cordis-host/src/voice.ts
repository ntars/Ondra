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
  /**
   * 本轮**整段回复**是否含情绪词。
   *
   * 要往下传给 `admit()`：句长闸按单句判，情绪词旁路按整轮判（手册 §9.4）。
   * 少了这一项，情绪词落在没被挑中的那一句时，旁路就悄悄失效。
   */
  readonly emotive?: boolean
  readonly rate?: number
  readonly volume?: 'normal' | 'low'
  readonly streak: number
  readonly degraded: readonly string[]
}

/**
 * 闸门入参的结构对位子集。
 *
 * 只留宿主真的要传的那一项。完整定义在插件侧 `GateOptions`，
 * 那边多出来的字段宿主一律不碰——镜像得越少，越不容易漂。
 */
interface GateOptionsLike {
  readonly emotive?: boolean
}

/**
 * 把「可能是 undefined 的整轮情绪词结论」收敛成一份入参。
 *
 * `exactOptionalPropertyTypes` 下 `{ emotive: undefined }` 与「不传这一项」
 * 不是一回事：前者会报类型错。没探过的时候就该什么都不传，让闸门自己判。
 * @param value 整段是否含情绪词；`undefined` = 没探过。
 */
function emotiveOption(value: boolean | undefined): GateOptionsLike | undefined {
  return value === undefined ? undefined : { emotive: value }
}

/** 语音闸门服务。 */
interface GatePort {
  readonly available: boolean
  readonly reason?: string
  /**
   * 只判不记账的那一次（插件 `decide()`）。
   *
   * 有它是为了「先试几个候选、只对选中的那个记一次账」。没有它就只能
   * 每试一个候选都 `admit()` 一次，`decisions` 与连读计数会被一轮里
   * 的试探撑爆，探针从此读不出真实情况。旧版闸门没这个方法，故可选。
   */
  decide?(text: string, options?: GateOptionsLike): GateDecisionLike
  admit(text: string, options?: GateOptionsLike): GateDecisionLike
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
 * 断句用的标点（中文句读 + 逗号顿号 + 换行；问号叹号含全角半角）。
 *
 * 逗号也切：中文口语里一句 40 字的话常常**只用逗号**，全句没有句号。
 * 只按句号切的话，「硬盘里又不会出门，能不在嘛寂寞就寂寞一会儿，
 * 不用急着找话说」会整条算一句，仍然超长念不出来——那正是这次要修的
 * 那个症状换了个位置复发。切到分句再往后拼（`pickUtterance` 最多拼 4 段），
 * 拼出来的仍然是完整意思，不是半截话。
 */
const CLAUSE_END = /[。！？!?…；;，,、\n]+/u

/**
 * 把一段整话切成候选朗读分句。
 * @param text 已净化的正文。
 */
function clausesOf(text: string): readonly string[] {
  const parts: string[] = []
  for (const raw of text.split(CLAUSE_END)) {
    const piece = raw.trim()
    if (piece !== '') parts.push(piece)
  }
  return parts
}

/**
 * 在一段「太长念不了」的整话里，挑出**第一句能念的**。
 *
 * ## 它补的是哪条断掉的边
 *
 * `ondra-tts-gate` 的句长闸口径是「一句话 6–30 字」（`max-chars` 段），
 * README 第 2 条表格原话，配置说明里写着「超过就该拆条，不该硬念」。
 * 也就是说：**拆条是调用方的活**，闸门只负责判它拿到的那一句。
 *
 * 但宿主此前是整段回复一次交给闸门（见本文件 `speakReply`）。于是一段
 * 四十字的正常回复必然被判 `too-long`——而且这不是偶发：只要回复超过
 * 30 字就念不出来，与情绪、频控、连读一概无关。实测一轮真实会话里
 * `decisions=4`、`spoken=0`，四条全是 `too-long` / `flat` 拦下。
 *
 * 这里只做「挑一句」，不做「全部念完」：一轮念一句，连读上限与频控
 * 才有意义；攒着念三段那是播客，不是说话。
 *
 * ## 为什么不用 `admit()` 试
 *
 * `admit()` 会记账（`decisions`、连读计数、频控时刻）。拿它试探几个
 * 候选，等于一轮里自己把频控撞响。所以试探走 `decide()`（纯），
 * 选中之后回到 `speakReply` 里 **只 `admit()` 一次**。
 * @param gate 语音闸门。
 * @param text 已净化的正文。
 * @returns `picked` 是可念的那一句；挑不出来时给 `fallback`——被拦下的那个
 *   候选原文，供调用方记账用（理由归因靠它）。两者都没有时返回空对象。
 */
function pickUtterance(
  gate: GatePort,
  text: string,
  note: (message: string) => void,
  turnEmotive: boolean | undefined,
): { readonly picked?: string; readonly fallback?: string } {
  /*
   * 必须 `gate.decide(...)` 这样调，不能先 `const decide = gate.decide`。
   *
   * `decide()` 是类方法，内部用 `this.shape()` / `this.draft()`。取成局部
   * 变量再调，`this` 就丢了，抛 `Cannot read properties of undefined
   * (reading 'shape')`——而外面那层 `catch` 会把它降级成「本轮不出声」，
   * 于是一个空指针变成了一次静默的沉默。这条踩过一次，留在这里当路标。
   */
  if (typeof gate.decide !== 'function') return {}
  const clauses = clausesOf(text)
  if (clauses.length === 0) return {}

  /* 第一段能念的候选被哪道闸拦下（只用于挑不出来时留一行诊断）。 */
  let firstBlock: string | undefined
  /*
   * 是否出现过「候选本身就太长」。
   *
   * 这一个标记专为一种情形存在：整段没有任何标点，`clausesOf()` 切出来
   * 只有一段，于是 `too-long` 一命中就 `break`，`firstBlock` 永远填不上，
   * 函数返回空对象——调用方既没有可念的句子，也拿不到任何理由，探针上
   * 只看到 `blocked.too-long` 一直涨。那是本轮巡检里唯一仍然「纯静默」
   * 的一条路：主人听不到声音，日志也读不到原因。
   */
  let sawTooLong = false
  /*
   * 被拦下的那个候选**原文**。
   *
   * 留住它，是因为调用方还要拿它去 `admit()` 记一次账。此前这里返回
   * `undefined`，调用方只能拿整段去记，于是「整段 too-long、分句后全是
   * flat」这种情形被记成 `too-long`——而真因是 `flat`。实测日志就是这样
   * 一对相邻行：`整段过长，且分句后仍无可念句（flat）` 紧跟
   * `语音未放行（too-long，72 字）`。本仓明令禁止「两种原因混成一句」，
   * 而设置页读的正是 `blocked` 这个桶：它会告诉主人「你的话太长」，
   * 真正该看的是「她太平了」。归因错了，修法就全错。
   */
  let firstBlockedText: string | undefined

  /*
   * 从前往后，逐段往后拼。
   *
   * - 拼出来还 `too-short`：继续往后加，短句拼成长句本来就是这么回事；
   * - 拼出来 `too-long`：这条路的后续只会更长，直接换下一个起点；
   * - 拼出来能念：就是它，第一个能念的优先（先说的那句最像开场白）。
   *
   * 上限 4 段：再多就已经是整段了，念出来赶得上念课文。
   */
  for (let start = 0; start < clauses.length; start += 1) {
    let candidate = ''
    for (let end = start; end < clauses.length && end < start + 4; end += 1) {
      candidate = end === start ? clauses[end] as string : `${candidate}${clauses[end] as string}`
      let decision: GateDecisionLike
      try {
        // 整轮的情绪词结论一路带下来：候选只是整段的一部分，但它是不是
        // 「该出声的一轮」取决于整段（见 `GateOptions.emotive`）。
        decision = gate.decide(candidate, emotiveOption(turnEmotive))
      } catch (error) {
        note(`挑句判定异常（本轮不出声）：${messageOf(error)}`)
        return {}
      }
      if (decision.speak) return { picked: candidate }
      // 太长了：从这个起点往后拼只会更长，换下一个起点。
      if (decision.reason === 'too-long') {
        sawTooLong = true
        break
      }
      // 太短了：接着往后拼。其余理由（flat / harsh / cooldown …）拼多长都一样。
      if (decision.reason !== 'too-short') {
        if (firstBlock === undefined) {
          firstBlock = decision.reason
          firstBlockedText = candidate
        }
        break
      }
    }
  }
  /*
   * 一句都挑不出来时留一行。
   *
   * 这一段最容易变成「什么都不发生」：整段 `too-long`、候选又全被别的闸
   * 拦着，探针上只看到 `too-long` 一条，看不出是长度问题还是情绪问题。
   * 一行足够分清这两件事，且一轮最多一行。
   */
  if (firstBlock !== undefined) {
    note(`整段过长，且分句后仍无可念句（${firstBlock}）`)
  } else if (sawTooLong) {
    /*
     * 落到这里的只有一种情形：切出来的每一段候选**自己**就超长。
     *
     * 最常见的是整段没有标点（英文长句、一串型号、一段没断句的碎碎念），
     * `clausesOf()` 只切出一段，于是无句可挑。**不硬切**是刻意的：按字数
     * 拦腰截断会念出「硬盘还剩一百二十个」这种半截话，比不出声更糟——
     * 手册对朗读的要求是「一句完整的话」，宁可沉默也不要断句错。
     *
     * 但沉默必须留痕。此前这条路一行诊断都不写，症状在探针上和「她今天
     * 不想说话」完全同形，只能靠读源码猜。留一行把「切不动」与「不想说」
     * 分开，是这一处唯一该做的事。
     */
    note(`整段 ${String(Array.from(text).length)} 字无标点可切，单句超长不硬切（会念出半截话）`)
  }
  return firstBlockedText === undefined ? {} : { fallback: firstBlockedText }
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

  /*
   * 整段念不了「太长」时，退一步挑一句能念的。
   *
   * 闸门的句长口径是单句（6–30 字），而这里拿到的是**一整段回复**。
   * 不挑的话，「回复超过 30 字就永远不出声」会成为一条静默的死规则：
   * 不报错、不影响文字、探针上只看到 `too-long` 一直涨。挑一句之后
   * 行为变成「她说最开始那句短的」——正是闸门文档里「该拆条」的本意。
   *
   * 只在 `too-long` 这一种理由上退让。`flat` / `harsh` / `cooldown`
   * 是「这一轮就是不该出声」，换一句也一样，不该绕过。
   *
   * 先 `decide()` 探一次是唯一不多记账的探法（见 `pickUtterance`）。
   */
  let spokenText = clean
  /*
   * 整段回复是否含情绪词的结论。挑句之后要把它带下去，否则旁路会按
   * 「被挑中的那一句」重新判——而手册说的是「本轮」。
   * `undefined` 表示没探过（没有 `decide()` 的旧闸门），此时交给闸门自己判。
   */
  let turnEmotive: boolean | undefined
  if (typeof gate.decide === 'function') {
    /*
     * 诊断走 `ctx.logger` 而不是 stderr。
     *
     * 本仓插件习惯用 `process.stderr` 留痕，但宿主里 stderr 不进
     * `debug.log`——调试接口读不到，等于没写。这一处要能被
     * `ondra logs` 看到，所以走日志器。
     */
    const note = (message: string): void => {
      try {
        ctx.logger('ondra.voice').debug('%s', message)
      } catch {
        // 日志器不可用不该让朗读这条路断掉。
      }
    }
    try {
      const whole = gate.decide(clean)
      if (!whole.speak && whole.reason === 'too-long') {
        /*
         * 只在切句这条路上才需要它：整段能念时，`admit(clean)` 本来就是按整段判。
         *
         * 取值来源必须是**整段**的判定结果（`whole` 就是 `decide(clean)`），
         * 不能取被挑中那一句的。这一项正是「旁路按整轮算」的全部实现：
         * 少了它，情绪词落在没被挑中的短句里时，`admit(候选)` 会重新按
         * 候选判 `emotive=false`，被 `flat` 拦下——不出声、不报错。
         *
         * 曾经为做 A/B 在此临时置过 `undefined`，收尾时忘了还原；那会让
         * `check:voice` 的 C 段失去被测对象（旁路根本收不到整轮结论）。
         * 不要在这里写死 `undefined`。
         */
        turnEmotive = whole.emotive
        const { picked, fallback } = pickUtterance(gate, clean, note, turnEmotive)
        if (picked !== undefined) {
          spokenText = picked
          note(`整段 ${String(whole.chars)} 字念不了，改念其中 ${String(Array.from(picked).length)} 字那句`)
        } else if (fallback !== undefined) {
          /*
           * 一句都挑不出来，但知道为什么。
           *
           * 拿那个候选去 `admit()`，让闸门的 `blocked` 桶记下真因
           * （`flat` / `harsh` / `cooldown`），而不是笼统的 `too-long`。
           * 结果一样都是不出声——这一处只换「记账的口径」，不换行为：
           * 候选本来就是从这段回复里切出来的，`admit()` 只判一次、只记一次。
           */
          spokenText = fallback
        }
      }
    } catch (error) {
      // 探路失败就当没探过：照原路 `admit()` 一次，行为与改动前一致。
      note(`挑句探路失败（按整段判）：${messageOf(error)}`)
    }
  }

  let decision: GateDecisionLike
  try {
    decision = gate.admit(spokenText, emotiveOption(turnEmotive))
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
    const utterance = await tts.speak(spokenText, {
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
