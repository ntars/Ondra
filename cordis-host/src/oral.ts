/**
 * 声音链的**前半段**：她心里想好的那句话，到嘴边该是什么口气。
 *
 * ## 它补的是哪条断掉的边
 *
 * `ondra-oral`（O-040）是一个完整的插件：口头禅池、不完整句 8%、
 * 标点习惯、语气词按情绪做减法，六条手册参数一条不少。但它**没有调用方**：
 *
 * ```
 * 情绪内核 → 表达档（O-031）→ （空）→ 字面 → 语音闸门 → 合成
 *                              ↑
 *                        断在这里
 * ```
 *
 * `styleOf()` 会去问 `ondra-emotion-express`，那条边插件自己已经修好了；
 * 真正缺的是「谁来对整段回复说一句 applyTurn()」。全仓零调用方，
 * 所以 `stats().messages` 从装载起一直是 0，而日志完全干净——
 * 与本仓此前的 `speakReply()`、`publishTurn()` 是同一个形态：
 * **组件完好，中间少一根线，两边都不报错。**
 *
 * ## 为什么由宿主调，而不是让插件自己去听
 *
 * 口语化要在**一句话已经成型之后**才有意义：它改的是句末标点、句末语气词、
 * 有没有主语。流式增量里句子还没成形，逐帧改会把「我们」拆成「我」+「们」。
 * 而「一句话说完了」这个时刻只有宿主知道（`inference.run` 返回之后）。
 *
 * ## 为什么必须在发 `done` 帧之前
 *
 * 界面用 `done` 里的完整文本**覆盖**流式正文（`useAppState.ts` 的 `onDone`），
 * 所以塑形放在那之后就会变成「界面上是原文、实际念的是改过的」——
 * 两处不一致，且谁都看不出来。放在之前，则是同一句话走完三条路：
 *
 * ```
 * 塑形一次 ─┬→ done 帧（用户看到的）
 *           ├→ publishTurn（记忆里存的）
 *           └→ speakReply（念出来的）
 * ```
 *
 * 三条路必须是同一个字符串。各改一次就会出现「她记得自己没说过的话」。
 *
 * ## 为什么带代码块的一律不塑形
 *
 * 口语化会去句号、省主语、插口头禅。这三件事落在散文上是语感，
 * 落在 ` ``` ` 里就是**改坏用户要复制的东西**。判据取「整条回复里有没有
 * 代码块围栏」而不是「逐行判」：混排的答案逐行改，等于把代码块外面
 * 那半句也放弃塑形，而分不清哪里是代码正是这件事的难点。
 */

import type { Context } from '@ntars/cordis'

/** 塑形结果（结构对位子集，不 import 插件源码）。 */
interface OralResultLike {
  readonly text: string
  readonly changed: boolean
  readonly marks: readonly { readonly code: string; readonly detail?: string }[]
}

/** 整轮塑形结果。 */
interface OralTurnLike {
  readonly messages: readonly OralResultLike[]
  readonly incompleteAt: number
  readonly median: number
  readonly notes: readonly string[]
}

/** 口语化服务。 */
interface OralPort {
  readonly available: boolean
  readonly reason?: string
  readonly expressReady: boolean
  applyTurn(request: {
    readonly texts: readonly string[]
    readonly sessionId?: string
    readonly at?: number
  }): OralTurnLike
  beginSession(sessionId: string): void
  stats(): {
    readonly turns: number
    readonly messages: number
    readonly habits: number
    readonly incompletes: number
    readonly particles: number
    readonly puncts: number
    readonly skipped: number
    readonly pools: number
    readonly sessions: number
    readonly expressErrors: number
  }
}

/** 一次塑形的结果，连同「为什么没改」。 */
export interface OralOutcome {
  /** 真正该说出口的那句。插件缺席、关掉、或不该塑形时原样返回。 */
  readonly text: string
  /** 走的是哪条路。`shaped` 才算真改过。 */
  readonly status: 'shaped' | 'unchanged' | 'skipped' | 'absent' | 'off'
  /** 没改的原因码，或改动的机器码列表。 */
  readonly reason?: string
  /** 这一条被记下的塑形动作（`punct-drop-period` 等）。 */
  readonly marks: readonly string[]
}

/** 口语化探针读数。给设置页与诊断接口用。 */
export interface OralProbe {
  /** `ondra-oral` 在不在。 */
  readonly loaded: boolean
  /** 用户在设置里关没关（`oral` 段的 `enable`）。 */
  readonly enabled: boolean
  /** 插件自报可用。 */
  readonly available: boolean
  /** 六态语域此刻在不在位（`ondra-emotion-express` 到了才算）。 */
  readonly expressReady: boolean
  /** 一句话说清「为什么现在不改字」。能改时为空串。 */
  readonly note: string
  /**
   * 插件自己的账本。
   *
   * 这是判断「链子真的通了吗」的唯一硬证据：
   * - `turns` 长期为 0 → `applyTurn()` 一次都没被调过，宿主那条线断了；
   * - `turns` 涨而 `puncts`/`particles` 不涨 → 在跑但一个动作都没做
   *   （多半是情绪档没到位，`expressReady` 会说）；
   * - `pools` 为 0 → 口头禅池是空的，她不会插口癖（这是设计，不是故障）。
   */
  readonly stats?: ReturnType<OralPort['stats']> | undefined
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 读口语化服务。 */
function portOf(ctx: Context): OralPort | undefined {
  return ctx.get('ondra-oral') as OralPort | undefined
}

/**
 * 只读探针。
 *
 * 与 `voiceProbe()` 同一条纪律：四种「不改字」的原因必须分开说，
 * 因为它们对应四种完全不同的动作（装插件 / 去设置里打开 / 聊天让情绪起来 /
 * 什么都不用做）。
 * @param ctx 宿主上下文。
 */
export function oralProbe(ctx: Context): OralProbe {
  const oral = portOf(ctx)
  if (oral === undefined) {
    return Object.freeze({
      loaded: false,
      enabled: false,
      available: false,
      expressReady: false,
      note: '口语化插件没装载',
    })
  }
  if (oral.reason === 'disabled' || oral.available !== true) {
    return Object.freeze({
      loaded: true,
      enabled: false,
      available: false,
      expressReady: oral.expressReady,
      note: '口语化关着（在设置里打开「口语化」的总开关才会改字）',
      ...statsOf(oral),
    })
  }
  return Object.freeze({
    loaded: true,
    enabled: true,
    available: true,
    expressReady: oral.expressReady,
    note: oral.expressReady ? '' : '情绪表达档没到位：只做标点习惯，语气词不动',
    ...statsOf(oral),
  })
}

/** 读账本。读不到就整格省掉，不编一个全零的假账本。 */
function statsOf(oral: OralPort): { stats?: ReturnType<OralPort['stats']> | undefined } {
  try {
    return { stats: oral.stats() }
  } catch {
    return {}
  }
}

/**
 * 把一句回复塑形成「她真会说出口的样子」。
 *
 * **永不抛错**：口语化是语感增强，它挂了这一轮对话必须照常成立。
 *
 * ## 为什么用 `applyTurn()` 而不是 `apply()`
 *
 * 这里的入参就是整段回复，也就是「一整轮」。`apply()` 逐条判概率，
 * 会让 8% 的不完整句变成「整段里每个空行 8%」——一段五段落的回答
 * 会有三成概率出现半句话。`applyTurn()` 明确「整轮最多一处」。
 *
 * @param ctx 宿主上下文。
 * @param text 她的原文。
 * @param sessionId 会话 id（口头禅「单场」按它计数）。
 */
export function shapeReply(ctx: Context, text: string, sessionId: string): OralOutcome {
  const pass = Object.freeze({ text, marks: Object.freeze([]) as readonly string[] })
  const oral = portOf(ctx)
  if (oral === undefined) return Object.freeze({ ...pass, status: 'absent' })
  if (oral.available !== true || oral.reason === 'disabled') {
    return Object.freeze({ ...pass, status: 'off' })
  }
  /*
   * 代码块不塑形。理由见文件头：改的是用户要复制的东西，不是语感。
   * 用信息级跳过而不是静默返回：静默会让「为什么不改字」在日志里没有一行。
   */
  if (text.includes('```')) {
    return Object.freeze({ ...pass, status: 'skipped', reason: 'has-code' })
  }
  if (text.trim() === '') return Object.freeze({ ...pass, status: 'skipped', reason: 'empty' })

  try {
    const result = oral.applyTurn({ texts: [text], sessionId })
    const first = result.messages[0]
    if (first === undefined || typeof first.text !== 'string' || first.text === '') {
      // 插件回了空串：宁可用原文，也不要发出一句空话。
      return Object.freeze({ ...pass, status: 'skipped', reason: 'empty-result' })
    }
    const marks = Object.freeze(first.marks.map((mark) => mark.code))
    return Object.freeze({
      text: first.text,
      status: first.changed ? 'shaped' : 'unchanged',
      marks,
    })
  } catch (error) {
    process.stderr.write(`[host] 口语化塑形异常（按原文发出）：${messageOf(error)}\n`)
    return Object.freeze({ ...pass, status: 'skipped', reason: 'error' })
  }
}

/**
 * 换一场会话时把「口头禅本场已用几次」归零。
 *
 * ## 为什么必须由宿主调
 *
 * 插件的账本按 `sessionId` 分桶，但它**不知道什么算一场会话**——
 * 建会话这件事发生在宿主的路由里。不调的症状与闸门那条一模一样：
 * 上一场用满了 2 次口头禅，新会话第一句就再也插不进去，而日志里一行都没有。
 *
 * @param ctx 宿主上下文。
 * @param sessionId 新会话 id。
 */
export function beginOralSession(ctx: Context, sessionId: string): void {
  const oral = portOf(ctx)
  if (oral === undefined || sessionId === '') return
  try {
    oral.beginSession(sessionId)
  } catch (error) {
    process.stderr.write(`[host] 口语化会话归零失败：${messageOf(error)}\n`)
  }
}
