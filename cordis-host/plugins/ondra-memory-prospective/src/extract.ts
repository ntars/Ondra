/**
 * 承诺 / 待办的**纯正则抽取**与到期日解析（不碰 ctx、不碰库、不调模型）。
 *
 * 手册 §2.8 原话：「正则认待办与承诺：`记得/待会/明天/答应过/我准备`，**纯正则不调模型**」。
 * 手册 §9.3 又给了承诺抽取的四道闸：「只认明确时间词（后天/明天/大后天/下周/周末/
 * 今晚/晚上/一会儿/下次），长度 4–120 字，疑问句尾排除，过期 3 天清理，最多 20 条」。
 * 两段合起来就是本文件：
 *
 * ```
 * 长度 4–120  ──→ 疑问句尾排除 ──→ 找时间词 ──→ 找标记词 ──→ 判 kind ──→ 解析 dueAt
 * ```
 *
 * 三条刻意的「不做」：
 *
 * 1. **没有时间词的承诺不抽。** §9.3 明写「只认明确时间词」。理由不是懒：
 *    承诺的核心是「什么时候算兑现」，没有时间点的「我答应你」无法结算，
 *    硬记下来只会在 20 条上限里占位，然后永远停在 `open`。
 *    要记这种，请显式调 `remember()`（它允许 `dueAt = 0` 无期限）。
 * 2. **一句话只出一条，承诺优先。** 「我答应明天帮你带书，记得提醒我」里
 *    承诺与待办是同一件事的两个面；出两条会让 20 条上限被同一句话吃掉两次，
 *    且结算时两个状态可能互相矛盾。
 * 3. **不判置信度。** 手册没给置信度的定义。编一个 0–1 的数字，会让人以为
 *    「0.87 的意思是不太确定」——而它其实只是我随手写的常数。命中了哪些词
 *    是事实，`markers` 直接给事实。
 */

import { DONE_MARKERS, PROMISE_MARKERS, TIME_WORDS, TODO_MARKERS } from './types.js'
import type { ClockLike, DetectedItem, ItemKind, TimeWordSpec } from './types.js'

/** 问号结尾（中英文都算）。 */
const QUESTION_TAIL = /[？?]\s*$/

/** 软疑问结尾：吗 / 么 / 呢（可带标点与语气符）。 */
const SOFT_QUESTION_TAIL = /[吗么呢][\s。.!！~～]*$/

/**
 * 本地自然日的 00:00:00。
 *
 * 优先用 O-003 的 `startOfDay()`：它做了墙钟换算与偏移迭代校正，
 * 在产品时区被配置成非系统时区时仍然正确。缺席时退回本地日历。
 * **这是本插件唯一的日历数学**，其余地方一律以它为基准推进。
 * @param at 时间戳。
 * @param clock 时钟服务（可缺席）。
 */
function startOfLocalDay(at: number, clock: ClockLike | undefined): number {
  if (clock !== undefined) {
    try {
      return clock.startOfDay(at)
    } catch {
      // 时钟服务自己炸了不该让抽取失败，退回本地日历即可。
    }
  }
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * 「第 n 天结束前」的时间戳（`n = 0` 是今天）。
 *
 * 用 `setDate()` 推进而不是加 `DAY_MS`：夏令时切换那天只有 23 或 25 小时，
 * 加固定毫秒数会落到 22:59 或 00:59，而「明天结束前」在用户看来必须是 23:59:59。
 * `Date.setDate()` 走的是日历字段，天然跳过这个坑。
 * @param at 基准时刻。
 * @param n 往后推几天（0 = 今天）。
 * @param clock 时钟服务。
 */
export function endOfDayAfter(at: number, n: number, clock?: ClockLike): number {
  const start = startOfLocalDay(at, clock)
  const d = new Date(start)
  d.setDate(d.getDate() + n + 1)
  return d.getTime() - 1
}

/**
 * 把时间词解析成到期时刻。
 * @param spec 时间词规格。
 * @param at 参照时刻。
 * @param soonHours 「一会儿」折算的小时数。
 * @param clock 时钟服务。
 * @returns 到期时间戳；`null` 表示无期限。
 */
export function resolveDue(
  spec: TimeWordSpec,
  at: number,
  soonHours: number,
  clock?: ClockLike,
): number | null {
  switch (spec.mode) {
    case 'day':
      return endOfDayAfter(at, spec.days ?? 0, clock)
    case 'today':
      // 「今晚」指当日结束前。刻意**不做**「过了 23:59 就顺延到明天」的兜底：
      // 那需要判断「用户说这话时是不是已经过了今晚」，而 23:59:59 之后的边界
      // 只会让同一句话在跨秒时算出两个答案。当日结束前就是当日结束前。
      return endOfDayAfter(at, 0, clock)
    case 'weekend': {
      // 最近的周日；今天就是周日则算今天。
      const day = new Date(at).getDay()
      return endOfDayAfter(at, (7 - day) % 7, clock)
    }
    case 'next-week': {
      const day = new Date(at).getDay()
      return endOfDayAfter(at, ((7 - day) % 7) + 7, clock)
    }
    case 'soon':
      return at + soonHours * 60 * 60 * 1000
    case 'open':
      // 「下次」没有日期。**不编一个**：编了就会在某个夜里突然弹出「你答应过下次」。
      return null
    default:
      return null
  }
}

/**
 * 找第一个命中的时间词（**长词优先**，见 `TIME_WORDS` 的顺序约束）。
 * @param text 原文。
 */
export function findTimeWord(text: string): TimeWordSpec | undefined {
  for (const spec of TIME_WORDS) {
    if (text.includes(spec.word)) return spec
  }
  return undefined
}

/**
 * 找出命中的全部标记词。
 * @param text 原文。
 * @param markers 词表。
 */
function findMarkers(text: string, markers: readonly string[]): string[] {
  return markers.filter(marker => text.includes(marker))
}

/**
 * 把一段话切成句子。
 *
 * ## 为什么必须切
 *
 * `detectIn` 原先对**整段**判一次。用户说
 *
 * ```
 * 明天提醒我把合同打印出来。后天记得给妈妈打电话。下周要交房租。
 * ```
 *
 * 得到的是一条待办，正文是那三句连在一起的原话。后果有两层：
 *
 * 1. **漏记**：三件事只留一件。用户以为三件都记下了，到日子只被提醒一件，
 *    而另外两件从未存在过——她"忘"了，但库里根本没有那两条。
 * 2. **正文失真**：待办正文成了「明天提醒我把合同打印出来。后天记得给妈妈
 *    打电话。」这样一串。它会被当成**一句话**塞进主动开口的由头里，
 *    于是她开口时念的是一整段，而不是一件事。
 *
 * 第二层还带来一个隐蔽后果：话由的冷却按 `topic` 记，整段文本成了同一个
 * topic，于是**三件事共用一次冷却**——放行一次之后三件都不能再说，
 * 而用户那边只是「她提过一回，之后再没提过」。
 *
 * ## 切分规则
 *
 * 只按句末标点切：`。！？；` 与英文 `.!?;`，外加换行。
 *
 * 不用逗号：中文口语里逗号连接的是同一件事的分句（「明天提醒我，把合同
 * 打印出来」），切开会把一件事拆成两件——那比漏记更糟，因为她会分两次
 * 催同一件事。
 *
 * 空句丢掉；切完只有一句时原样返回，不引入额外路径。
 */
function splitSentences(text: string): string[] {
  const parts = text
    .split(/[。！？；!?;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  return parts.length === 0 ? [] : parts
}

/**
 * 从一句话里认出承诺 / 待办。**纯函数**：同一个入参永远给同一个结果。
 *
 * 多句输入会逐句判定、把各句的结果合并返回（顺序与原文一致）。
 * 切分理由见 `splitSentences()`。
 *
 * @param text 原文。
 * @param at 参照时刻。
 * @param options 长度上下界、「一会儿」折算小时、时钟服务。
 */
export function detectIn(
  text: string,
  at: number,
  options: {
    readonly minChars: number
    readonly maxChars: number
    readonly soonHours: number
    readonly clock?: ClockLike | undefined
  },
): DetectedItem[] {
  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') return []
  const sentences = splitSentences(body)
  /*
   * 只有一句时走原路径。
   *
   * 这不只是省一次循环：单句是**最常见**的输入，而它必须与改造前
   * 逐字一致（包括「长度超限就整句丢掉」那条）。多句时逐句判，
   * 单句时行为不变——这样这次改动不会动到既有语料的表现。
   */
  if (sentences.length <= 1) return detectOne(body, at, options)
  const out: DetectedItem[] = []
  for (const sentence of sentences) {
    out.push(...detectOne(sentence, at, options))
  }
  return out
}

/**
 * 单句判定（改造前的 `detectIn` 本体，逐字保留）。
 *
 * @param body 已 trim 的一句原文。
 * @param at 参照时刻。
 * @param options 同 `detectIn()`。
 */
function detectOne(
  body: string,
  at: number,
  options: {
    readonly minChars: number
    readonly maxChars: number
    readonly soonHours: number
    readonly clock?: ClockLike | undefined
  },
): DetectedItem[] {
  // 按码点数长度：中文一个字算一个，emoji 不会因为代理对被算成两个。
  const length = Array.from(body).length
  if (length < options.minChars || length > options.maxChars) return []

  // 疑问句尾排除：问句是在问，不是在答应。把「明天你有空吗」记成承诺，
  // 到了明天就会以「你说好的」为由去催用户——这是最伤信任的一类误判。
  if (QUESTION_TAIL.test(body) || SOFT_QUESTION_TAIL.test(body)) return []

  const timeWord = findTimeWord(body)
  const promiseMarkers = findMarkers(body, PROMISE_MARKERS)
  const todoMarkers = findMarkers(body, TODO_MARKERS)

  let kind: ItemKind | null = null
  if (promiseMarkers.length > 0 && timeWord !== undefined) {
    // 承诺必须有明确时间词（§9.3）。
    kind = 'promise'
  } else if (todoMarkers.length > 0) {
    // 待办允许没有时间词（「记得买牛奶」）。
    kind = 'todo'
  }
  if (kind === null) return []

  const markers = kind === 'promise' ? promiseMarkers : todoMarkers
  const dueAt =
    kind === 'promise' && timeWord !== undefined
      ? resolveDue(timeWord, at, options.soonHours, options.clock)
      : null

  return [
    {
      kind,
      text: body,
      timeWord: timeWord === undefined ? null : timeWord.word,
      dueAt,
      markers,
    },
  ]
}

/**
 * 否定词**紧贴**完成语才算否定：`还没做好` / `没弄完` / `没有完成`。
 *
 * 刻意不用「出现『没/未/别』就否定」：那样 `做好了，不错` 会被「不」误伤，
 * 而它明明是一句完成汇报。窗口取 3 个字，是因为中文否定与动词之间最多隔
 * 「有 / 能 / 弄 / 做完」这类两三个字。
 */
const NEGATED_DONE = /(没|未|别)[^，。！？,.!?]{0,3}(好|完|搞定|交)/

/**
 * 完成语的**句式尾巴**：`X好了` / `X完了` / `搞定了` / `交了`。
 *
 * 为什么不能只列固定词：口语里「买好了」「写完了」「看完了」「弄好了」都是同一个句式，
 * 逐个往词表里加永远加不完（而且每加一个都要改一次契约）。用句式兜住，
 * 再靠「否定词拦截 + 待办相似度门槛」两道闸防误判。
 */
const DONE_TAIL = /(好了|完了|搞定|交了)[\s。.!！~～]*$/

/**
 * 这句话是不是在说「做好了 / 发过去了」（手册 §2.8：说了就删相关那条待办）。
 *
 * 三道闸，顺序不能换：
 * 1. **否定拦截**：`还没做好` / `没弄完` 直接不认。若被判成完成，会静默删掉一条
 *    真待办，而用户再也看不到它——这是本插件最不能犯的错。
 * 2. **固定完成词**：手册逐字给的 `做好了 / 发过去了` 一族。
 * 3. **句式尾巴**：`X好了 / X完了` 这类通用形态。
 *
 * 三道闸之后还有一道在 `service.completeByText()` 里：**必须与某条待办足够像**。
 * 所以「我心情好了」不会删掉「记得买牛奶」——它过得了本函数，过不了相似度门槛。
 * @param text 原文。
 */
export function saysDone(text: string): boolean {
  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') return false
  if (NEGATED_DONE.test(body)) return false
  if (DONE_MARKERS.some(marker => body.includes(marker))) return true
  return DONE_TAIL.test(body)
}

/**
 * 剥掉待办正文开头的**标记词**（`记得` / `待会` / `提醒我` …），只留内容。
 *
 * 为什么要剥：`记得买牛奶` 里的「记得」不是内容，是提醒语。把它算进相似度分母，
 * 会让 `牛奶买好了`（一个很自然的说法）只拿到 0.25 而被门槛挡掉——
 * 分母被两个与内容无关的字撑大了。
 *
 * 剥到不能再剥为止（`记得提醒我买牛奶` 要连剥两次），但**剥空就退回原文**：
 * 一条正文只有标记词时（`记得`），退回原文至少还能按字面比。
 * @param text 正文。
 */
export function stripTodoMarkers(text: string): string {
  const original = typeof text === 'string' ? text.trim() : ''
  let body = original
  // 最多剥 4 轮：标记词最多叠三层（`记得提醒我…`），留一轮余量防死循环。
  for (let round = 0; round < 4; round += 1) {
    const before = body
    for (const marker of TODO_MARKERS) {
      if (body.startsWith(marker)) body = body.slice(marker.length).trim()
    }
    if (body === before) break
  }
  return body === '' ? original : body
}

/**
 * 两条正文的相似度（字符二元组的**双向包含度，取较大者**），
 * 用于「说做好了」时找相关的那条待办。
 *
 * 为什么是双向取大而不是单向：用户说「做好了」的那句话**天然比待办长**
 * （「买牛奶做好了」对「记得买牛奶」）。单向按「用户那句被待办覆盖多少」算，
 * 分母是用户句子的长度，句子越长分越低——「买牛奶做好了」只有 0.4，
 * 被门槛挡掉，而它其实是最自然的一种说法。取两个方向里较大的那个，
 * 等于问「两条里更短的那条，有多大比例出现在另一条里」，与长度无关。
 *
 * 与 O-012 判重**不是同一把尺子**：那边是「要不要合并两条记忆」（阈值 0.4），
 * 这边是「这句话是不是在说这条待办」（阈值 0.5）。口径不同不可互搬（裁决⑥）。
 * 这里只用于待办这一张最多 3 行的表，误判代价是「删错一条待办」，
 * 故阈值偏高，且仍然只认完成语（否定式一律不认）。
 * @param a 正文甲。
 * @param b 正文乙。
 */
export function overlapScore(a: string, b: string): number {
  const left = Array.from(a.trim())
  const right = Array.from(b.trim())
  if (left.length === 0 || right.length === 0) return 0
  if (a.trim() === b.trim()) return 1
  if (left.length < 2 || right.length < 2) return 0

  /** 一组二元组。 */
  const gramsOf = (units: readonly string[]): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < units.length - 1; i += 1) set.add(`${units[i]}${units[i + 1]}`)
    return set
  }
  const leftGrams = gramsOf(left)
  const rightGrams = gramsOf(right)
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0

  /** 甲的二元组有多少出现在乙里。 */
  const coveredBy = (from: ReadonlySet<string>, into: ReadonlySet<string>): number => {
    let hit = 0
    for (const gram of from) if (into.has(gram)) hit += 1
    return hit / from.size
  }

  return Math.max(coveredBy(leftGrams, rightGrams), coveredBy(rightGrams, leftGrams))
}
