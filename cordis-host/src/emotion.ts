/**
 * 情感投影的**宿主侧调用方** —— 情绪的唯一文本出口。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-emotion-project` 的六态模板、四条护栏词表、四道拒绝闸、配置段、
 * 启动自检、README 全部写完了，缺的是四样东西，而四样全都不报错：
 *
 * ```
 * ondra-emotion-project          ← 不在默认启用名单，服务不注册
 * project()                      ← 全仓零调用方
 * 投影文本                        ← 没有消费者（系统提示词只拼人格 + 器官片段）
 * constraint                     ← 也没有消费者
 * ```
 *
 * 于是「她怎么说出自己此刻的状态」这件事从来没有发生过。症状不是报错，
 * 是**她永远用同一种语气说话**——而六态模板缺席时，模型只会拿到一份
 * 纯人格提示词，那份提示词里没有一个字关于「今天该怎么开口」。
 *
 * 这是本仓第九次踩同一个形态（A 写、B 读、中间少根线）。前八次分别是
 * `session/event` / `ctx.get('llm')` / `feel()` / `claim()` / `touch()` /
 * `noteInteraction()` / `thresholdOf()` / `adjust()`。它们的共同点是：
 * **缺席的那一端永远给得出一个合法值**（空数组、0、常量表、基语文案），
 * 所以没有任何一处会报错。
 *
 * ## 为什么落笔在宿主，不在插件
 *
 * 插件不知道「一轮对话正要发出去」这件事：它没有内核句柄，也不该有
 * （§18.5 不 import 邻居、不碰传输层）。宿主是唯一同时知道「这一轮开始了」
 * 与「投影服务在位」的位置——与弥散（`src/diffuse.ts`）、关系
 * （`src/relation.ts`）同一条理由。
 *
 * 界面更不行：主动开口那一轮**没有用户输入**，界面此时甚至不一定活着，
 * 它拼不出整段提示词（详见 `system-prompt.ts` 的归属判定）。
 *
 * ## 为什么排在系统提示词的**最尾部**
 *
 * 插件把 `projectionOrder` 定成 `+800`（正数），依据是手册 §8.5：
 * 稳定段在会话开头，易变段追加尾部。人格四段是「她是谁」，跨会话不变；
 * 器官片段（疤痕 / 执念 / 感知 / 规矩）变，但慢；投影每轮都变。
 *
 * 需要说清一件事：本仓的 `system` 是**每轮整段重传**（内核不落盘），
 * 所以这里做不到「只追加增量」那种字面意义上的缓存友好。把易变段放
 * 最后能拿到的收益是另一层：供应商侧的 prompt caching 按**前缀**匹配，
 * 前两段逐字相同的那部分仍可命中，而情绪段每次都在尾部、
 * 不会把前面几千字的稳定前缀搅掉。若把它塞进开头，就是每轮重算全部前缀。
 *
 * ## 为什么不猜「用户是不是在问数值」
 *
 * 插件把这件事做成 `askedForNumbers` 入参、默认 `false`，并写明
 * 「猜错一次就是她突然开始报数，而那是明文禁止的；猜漏一次只是用户问了
 * 没得到数字，影响小得多」。本文件**沿用这个判断，不从对话里猜**——
 * 宿主若在这里加一份关键词表（「多少」「几分」「数值」），就成了插件
 * 刻意避开的那种猜测，而且是更难审计的一处（宿主侧没有护栏兜底）。
 *
 * 代价是那个唯一例外出口目前恒不触发。这一点在诊断里如实报出来
 * （`askedForNumbersWired: false`），不让下一个人以为它接好了。
 */

import type { Context } from '@ntars/cordis'
import type { SystemPromptPart } from './system-prompt.js'

/**
 * 投影服务的结构对位子集。
 *
 * 只声明用得到的成员：抄一遍完整契约等于在这里维护第二份形状，
 * 插件加字段时要改两处，漏一处就编译不过——那还是好的，更坏的是
 * 形状对得上、语义已经漂了。
 */
export interface ProjectServiceLike {
  readonly available: boolean
  readonly reason?: string
  project(request?: { readonly askedForNumbers?: boolean; readonly at?: number }): ProjectionLike
  guard(text: string): { readonly pass: boolean; readonly hits: readonly unknown[] }
  stats(): Record<string, unknown>
}

/** 一次投影的结果（只取装配要用的字段）。 */
export interface ProjectionLike {
  /** 主体文本（`command + hint`）。被拒绝时为空串。 */
  readonly text: string
  /** §4.4 约束句，**独立字段**，不并入 `text`。 */
  readonly constraint: string
  /** 六态之一；被拒绝时可能是 `undefined`。 */
  readonly state?: string
  /** 是否允许输出。 */
  readonly allowed: boolean
  /** 拒绝原因码（机器可读）。 */
  readonly refusal?: string
}

/** 一次装配出来的情绪块。 */
export interface EmotionBlock {
  /** 系统提示词里的那一段；`undefined` 表示这一轮不该有情绪块。 */
  readonly part?: SystemPromptPart
  /** 是否真的产出了可注入的正文。 */
  readonly applied: boolean
  /** 六态之一（没产出时为 `undefined`）。 */
  readonly state?: string
  /** 拒绝原因码（`applied === false` 时给出）。 */
  readonly refusal?: string
  /** 一句人话，只进日志与诊断，**不进提示词**（§4.3 禁报数）。 */
  readonly note: string
}

/**
 * 约束句缺席时的处理。
 *
 * §4.4 要求「每条情绪注入块都必须带这句约束」。若插件给的 `constraint`
 * 是空串（契约升级、字段改名），**不带约束就不注入投影**——
 * 一句「你今天话可以多一点」而没有「情绪不影响判断」的限定，
 * 会让模型把语气建议当成行为授权。宁可这一轮没有情绪块。
 */
function hasConstraint(text: unknown): text is string {
  return typeof text === 'string' && text.trim() !== ''
}

/**
 * 装配这一轮的情绪块。
 *
 * 四道拒绝闸（开关 / 报数例外 / 无状态 / 模板自检）全部归插件，
 * 本函数**一道都不重写**。它只做三件事：取服务、取投影、判「能不能拼」。
 *
 * 永不抛错：投影是附带内容，它失败不该让整轮对话发不出去。
 *
 * @param ctx 宿主上下文。
 * @param at 时刻，省略用系统时间（让调用方与 `diffuse` 用同一个时刻）。
 */
export function assembleEmotionBlock(ctx: Context, at?: number): EmotionBlock {
  const service = ctx.get('ondra-emotion-project') as ProjectServiceLike | undefined

  if (service === undefined) {
    // 服务没装载 → 查默认启用名单。这一句必须与「装了但拿不到状态」分开：
    // 前者的兜底是「别注入情绪块」，后者的兜底可能是「等下一轮」。
    return Object.freeze({ applied: false, refusal: 'not-loaded', note: '没有装载 ondra-emotion-project' })
  }
  if (service.available !== true) {
    return Object.freeze({
      applied: false,
      refusal: service.reason ?? 'disabled',
      note: `投影不可用（${service.reason ?? '未知原因'}）`,
    })
  }

  let projection: ProjectionLike
  try {
    /*
     * `askedForNumbers` 恒为 false，理由见文件头最后一节。
     * 不传 `undefined` 而是显式传 `false`：插件的判据是 `=== true`，
     * 两者行为相同，但显式写出来能让「谁决定这一格」在代码里看得见。
     */
    projection = service.project(at === undefined ? { askedForNumbers: false } : { askedForNumbers: false, at })
  } catch (error) {
    // C3：器官错误不得传播。插件内部已经兜过一层，这里再兜一层防它自己出意外。
    return Object.freeze({
      applied: false,
      refusal: 'threw',
      note: `投影抛错（${error instanceof Error ? error.message : String(error)}）`,
    })
  }

  if (projection.allowed !== true) {
    const refusal = projection.refusal ?? 'unknown'
    /*
     * 拒绝是**正常产品行为**，不是故障：用户问了数值、她此刻没有状态、
     * 模板被改坏，三种都不该有情绪块。这里只把原因码带出去，不打日志——
     * 每分钟刷一行「没有情绪块」会把真正该看的那行淹掉（配额那一支踩过）。
     */
    return Object.freeze({
      applied: false,
      refusal,
      ...(projection.state === undefined ? {} : { state: projection.state }),
      note: `这一轮不出情绪块（${refusal}）`,
    })
  }

  const body = typeof projection.text === 'string' ? projection.text.trim() : ''
  if (body === '') {
    // 「允许输出但正文为空」是插件不该出现的状态，必须报出来而不是静默跳过。
    return Object.freeze({ applied: false, refusal: 'empty-text', note: '投影允许输出但正文为空' })
  }
  if (!hasConstraint(projection.constraint)) {
    return Object.freeze({
      applied: false,
      refusal: 'no-constraint',
      note: '投影缺 §4.4 约束句，按「不带约束就不注入」处理',
    })
  }

  /*
   * 正文与约束句之间用 `\n` 而不空行：它们是**同一个块**的两部分
   * （一段话 + 一句限定），不是两段独立内容。段与段之间才用 `\n\n`。
   */
  const text = `${body}\n${projection.constraint.trim()}`

  return Object.freeze({
    part: Object.freeze({
      id: 'emotion' as const,
      label: '情绪',
      chars: [...text].length,
      text,
    }),
    applied: true,
    ...(projection.state === undefined ? {} : { state: projection.state }),
    note: '情绪块已拼入',
  })
}

/** 投影域的诊断读数。 */
export interface ProjectionProbe {
  /** 服务在不在。 */
  readonly present: boolean
  /** 降级原因。 */
  readonly reason?: string
  /** 有没有六态服务（等价于「能不能出投影」）。 */
  readonly hasExpress?: boolean
  /** 最近一次产出的状态。 */
  readonly lastState?: string
  /** 累计计数（投影 / 拒绝 / 护栏 / 护栏拦下 / 读六态抛错）。 */
  readonly counters?: Record<string, unknown>
  /** 最近一次错误。 */
  readonly lastError?: string
  /**
   * 唯一例外出口接上了没有。
   *
   * 恒 `false`，如实回答。宿主刻意不从对话里猜「用户是不是在问数值」，
   * 理由见文件头。这一格存在的意义就是**不让它看起来像接好了**。
   */
  readonly askedForNumbersWired: false
}

/**
 * 读一次投影诊断。
 *
 * ## 为什么需要它
 *
 * 「她永远用同一种语气说话」有四种成因，症状完全相同（提示词里没有情绪块）：
 *
 * | 读到什么 | 结论 |
 * | --- | --- |
 * | `present: false` | 服务没装 → 查默认启用名单 |
 * | `hasExpress: false` | 六态缺席 → 投影一律 `no-state` |
 * | `counters.projects === 0` 而 `present: true` | 装上了但没人调 `project()` |
 * | `counters.projects > 0` 而提示词里没有这一段 | 装配那一处没取它 |
 *
 * 前三格并排，「没装 / 没写 / 没读」才分得开；第四格靠 `system-prompt`
 * 的 `parts` 与「宿主上次装配的快照」对账，不在这里自证。
 *
 * @param ctx 宿主上下文。
 */
export function projectionProbe(ctx: Context): ProjectionProbe {
  const service = ctx.get('ondra-emotion-project') as ProjectServiceLike | undefined
  if (service === undefined) {
    return Object.freeze({ present: false, reason: 'not-loaded', askedForNumbersWired: false })
  }

  try {
    const stats = service.stats()
    const counters = stats['counters']
    const hasExpress = stats['hasExpress']
    const lastState = stats['lastState']
    const lastError = stats['lastError']
    return Object.freeze({
      present: true,
      ...(service.reason === undefined ? {} : { reason: service.reason }),
      ...(typeof hasExpress === 'boolean' ? { hasExpress } : {}),
      ...(typeof lastState === 'string' ? { lastState } : {}),
      ...(counters !== null && typeof counters === 'object' ? { counters: counters as Record<string, unknown> } : {}),
      ...(typeof lastError === 'string' ? { lastError } : {}),
      askedForNumbersWired: false,
    })
  } catch (error) {
    // 诊断自己失败也要说得出来，不能把整条路由拖垮。
    return Object.freeze({ present: true, reason: String(error), askedForNumbersWired: false })
  }
}
