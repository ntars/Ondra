/**
 * 纯计算层：张力派生、判重相似度、三源判定、四条件合取。
 *
 * **本文件不碰 ctx、不碰存储、不碰时钟**——全部入参显式传入。
 * 这样这一层可以在进程外被逐条推演（本轮就是拿 Python 复刻它跑用例），
 * 而「她心里压着多重的事」这种算错一次就会被用户看出来的量，
 * 必须能被单独对拍。
 */

import {
  DREAM_ENERGY_MIN,
  DREAM_IDLE_HOURS,
  FAILURE_KINDS,
  FAILURE_ZH,
  MAX_TENSION,
  TRUNCATE_CHARS,
  WAKE_COOLDOWN_MINUTES,
  WAKE_ENERGY_MIN,
  WAKE_IDLE_MINUTES,
  WAKE_TENSION,
} from './types.js'
import type {
  DreamBlockReason,
  DreamChecks,
  DreamDecision,
  DriveGap,
  FailureKind,
  GapDetection,
  GapSource,
  GapView,
  WakeBlockReason,
  WakeChecks,
  WakeDecision,
} from './types.js'

/** 判重的最短可比长度：少于 4 个有效字，只有「完全相同」才算重复。 */
const MIN_COMPARE_CHARS = 4

/**
 * 「单字重合」要成立，至少需要多少二元组证据（0–1）。
 *
 * 取 0.3 不是拍的，它落在两个真实用例中间：
 * `她讨厌我吗` / `她是不是讨厌我了` → 二元 0.36（共享 `讨厌`/`厌我`，是真同一件事）；
 * `她讨厌我吗` / `她喜欢我吗`     → 二元 0.25（只共享 `我吗` 这种虚词），
 * 而这一对的**单字**相似度恰好是 0.60 —— 正好卡在阈值上。
 * 没有这道闸，「她讨厌我吗」和「她喜欢我吗」会被判成同一件事，
 * 一条真实的执念被并掉，而且并完看不出来。
 */
const MIN_BIGRAM_EVIDENCE = 0.3

/* ------------------------------------------------------------------ *
 * 数值工具
 * ------------------------------------------------------------------ */

/** 夹到 [lo, hi]。非有限值归 `lo`。 */
export function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, value))
}

/** 夹到 0–100。 */
export function clampTension(value: number): number {
  return clamp(value, 0, MAX_TENSION)
}

/* ------------------------------------------------------------------ *
 * 张力派生
 * ------------------------------------------------------------------ */

/**
 * 已计入的小时数（扣掉休眠）。
 *
 * 负值归零：时钟回拨过一次就会出现「未来创建的缺口」，
 * 让它算出负年龄会让张力比 base 还低，看起来像「她忽然不惦记了」。
 * @param gap 缺口。
 * @param at 当前时刻。
 */
export function elapsedHours(gap: DriveGap, at: number): number {
  const ms = at - gap.createdAt - gap.pausedMs
  return ms <= 0 ? 0 : ms / 3_600_000
}

/**
 * 派生张力：`clamp(base + 小时数 × rate − relief + bump)`（§5.1）。
 *
 * **每次读都重算**，绝不累加。三个加项各自的语义：
 * - `base`：这件事一开始有多重要（写入时定，之后只读）；
 * - `小时数 × rate`：放得越久越压人；
 * - `− relief`：只有真正解决了什么才会降；
 * - `+ bump`：判重命中时的固定加压（手册的 `+10`，见 `types.ts` 待裁决①）。
 * @param gap 缺口。
 * @param at 当前时刻。
 */
export function tensionOf(gap: DriveGap, at: number): number {
  const hours = elapsedHours(gap, at)
  // **衰减项自带天花板**：`base + 放置收益` 最多到 100，不继续累加。
  // 没有这道顶，一条放了三周的执念会算出 1800 分，「张力 −10」永远是空操作——
  // 而手册 §5.1 明写入梦后要 `tension −10`。有了顶，100 分时减 10 就是 90 分，看得见。
  const aging = Math.min(hours * gap.ratePerHour, Math.max(0, MAX_TENSION - gap.base))
  return clampTension(gap.base + aging - gap.relief + gap.bump)
}

/** 存储形态 → 视图（补上两个派生量）。 */
export function toView(gap: DriveGap, at: number): GapView {
  return Object.freeze({
    ...gap,
    tension: tensionOf(gap, at),
    ageHours: elapsedHours(gap, at),
  })
}

/* ------------------------------------------------------------------ *
 * 判重相似度
 * ------------------------------------------------------------------ */

/**
 * 归一化：去掉空白与标点、统一小写。
 *
 * **这不是引文归一化。** O-011 / O-019 / O-140 那一套要求「逐字可查」，
 * 连标点的位置都要能对上；这里只求「两句说的是不是同一件事」，
 * 所以可以粗暴地全剥。两件事共用一套函数，才是真的错。
 * @param text 原文。
 */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    // 空白
    .replace(/\s+/gu, '')
    // ASCII 标点
    .replace(/[!-/:-@[-`{-~]/gu, '')
    // 中文标点与常见符号（不追求完备：漏一个只是让相似度略低）
    .replace(/[\u3000-\u303f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/gu, '')
}

/** 单字集合。 */
function unigrams(text: string): Set<string> {
  return new Set(Array.from(text))
}

/** 二元组集合（相邻两字）。 */
function bigrams(text: string): Set<string> {
  const chars = Array.from(text)
  const out = new Set<string>()
  for (let i = 0; i + 1 < chars.length; i += 1) {
    out.add(`${chars[i]}${chars[i + 1]}`)
  }
  return out
}

/** 两个集合的交集大小。 */
function overlap(a: Set<string>, b: Set<string>): number {
  let hit = 0
  for (const item of a) {
    if (b.has(item)) hit += 1
  }
  return hit
}

/** Dice 系数。 */
function diceOf(a: Set<string>, b: Set<string>, inter: number): number {
  const total = a.size + b.size
  return total === 0 ? 0 : (2 * inter) / total
}

/**
 * 判重相似度（0–1）。
 *
 * ## 为什么取「单字 Dice」与「二元 Dice」的较大值
 *
 * 中文没有词边界，两个量各自会犯一类错：
 * - 只看二元组：「她讨厌我吗」vs「她是不是讨厌我了」只有 `讨厌`/`厌我` 两组重合，
 *   算出来 0.36——明明是同一件事却判不出重复。
 * - 只看单字：短句里撞两三个常用字就能到 0.6 以上，容易误并。
 *
 * 取较大值 = 偏向「判定为重复」。这不是偷懒，是两类错误代价不对等：
 * **误并**只是少一条措辞变体（手册还要求保留最早那一条的措辞，所以正文不丢），
 * **漏并**会让同一件事在池子里记两笔、各自往 80 涨，她就为同一件事被叫醒两次，
 * 而且张力虚高之后没有任何自动手段能发现。两害相权，宁可并。
 *
 * ## 为什么短句只认完全相同
 *
 * 少于 4 个有效字时（「嗯」「为什么」），任何相似度都是巧合。
 * 判成重复会让一个没头没尾的残句把一条真执念「加压」。
 * @param a 正文甲。
 * @param b 正文乙。
 */
export function similarity(a: string, b: string): number {
  const left = normalizeForCompare(a)
  const right = normalizeForCompare(b)
  if (left.length === 0 || right.length === 0) return 0
  if (left === right) return 1
  if (left.length < MIN_COMPARE_CHARS || right.length < MIN_COMPARE_CHARS) return 0

  const uniA = unigrams(left)
  const uniB = unigrams(right)
  const uniInter = overlap(uniA, uniB)
  // 只撞一个字不算相似：单字 Dice 会给出 2/(n+m) 这种「看起来有一点像」的假分。
  if (uniInter < 2) return 0

  const biA = bigrams(left)
  const biB = bigrams(right)
  const biScore = diceOf(biA, biB, overlap(biA, biB))

  // 二元证据不足时，**不承认单字重合**：中文短句里「她 / 我 / 吗」这类虚词
  // 就能把单字相似度撑到 0.6，而它们对「说的是不是同一件事」毫无信息量。
  if (biScore < MIN_BIGRAM_EVIDENCE) return biScore

  return Math.max(diceOf(uniA, uniB, uniInter), biScore)
}

/* ------------------------------------------------------------------ *
 * 三源判定
 * ------------------------------------------------------------------ */

/**
 * 「她自己没答上来」的标记词（§5.1 第一源）。
 *
 * 刻意收窄到「自认不知道」这一类。像「我觉得」「大概」这种含糊表达**不收**——
 * 含糊是修辞，不知道是缺口，把修辞当缺口会让池子一天长出三十条执念。
 *
 * ## 为什么这份表要容得下「不太确定」
 *
 * 中文里承认自己不知道，**极少直说「我不知道」**。实测十句最自然的说法，
 * 原表只命中两句：`不太确定` / `不太清楚` / `记不清` / `想不起来` /
 * `没有把握` 全部漏掉（`不确定` 是 `不太确定` 的子串，看似能中，
 * 实际「不**太**确定」中间插了一个「太」，子串匹配直接落空）。
 *
 * 这份表决定的是「池子会不会长东西」：覆盖不到日常说法，池子就永远空，
 * 而症状不是报错——是「她心里从来没有放不下的事」，与「这个功能没做」同形。
 * 故按「中文承认无知的常用句式」补齐，仍**不碰含糊修辞**（「可能」「也许」
 * 「大概」说的是概率，不是缺口）。
 */
const UNSURE_MARKERS: readonly string[] = Object.freeze([
  '不知道',
  '不晓得',
  '不清楚',
  '不确定',
  '不太确定',
  '不太清楚',
  '不太明白',
  '搞不清',
  '记不清',
  '想不起来',
  '没把握',
  '没有把握',
  '无法回答',
  '无法确定',
  '不能确定',
  '说不准',
  '说不好',
  '答不上来',
  '没查到',
  '查不到',
  'not sure',
  "don't know",
  'no idea',
])

/**
 * 紧贴在标记词前面的字，出现则**否决**（纪律 #25：句式 + 邻近窗口）。
 *
 * 「你不知道我在想什么」是在说用户，不是在承认自己无知。
 * 这类句子在撒娇语境里极常见，误判一次就多一条假执念。
 */
const UNSURE_VETO_PREFIX: readonly string[] = Object.freeze(['你', '您', '他', '她'])

/**
 * 紧跟在标记词后面的字，出现则**否决**。
 *
 * 「我不知道**你**今天这么早回来」不是「有个问题我没答上来」，而是一句
 * 口语里的惊讶——它没有留下任何待解的问题，却会被判成一条执念。
 * 而执念在话由表里是**最高优先级**（`KIND_ORDER` 第一位），
 * 一条假执念会把真实的承诺与待办全部压到后面：症状是「她老提那句
 * 你早回家的事，你交代的事她一次没提」。
 *
 * 判据是「标记词说的是谁」：接「你 / 您 / 他 / 她」时，宾语是对方，
 * 语义是「（我原先）不知道你的某个情况」，属于对话里的反应；
 * 接「这个 / 那个 / 为什么 / 怎么」时，宾语是一件事，那才是缺口。
 *
 * **为什么放在后面而不是前面**：前面那个窗口挡的是「你不知道我在想什么」
 * （主语是对方），后面这个窗口挡的是「我不知道你这么早回来」（宾语是对方）。
 * 两个窗口挡的是两类完全不同的误判，缺一个都会漏。
 */
const UNSURE_VETO_FOLLOW: readonly string[] = Object.freeze(['你', '您', '他', '她', '原来', '居然', '竟'])

/** 分句用的边界（含中英文）。 */
const SENTENCE_BOUNDARY = /[。！？!?；;\n]/

/**
 * 取命中的**整句**（§5.1「取整句（截断 120 字）」）。
 * @param text 模型输出。
 */
export function detectUnsure(text: string): GapDetection | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  const sentences = text.split(SENTENCE_BOUNDARY)
  for (const raw of sentences) {
    const sentence = raw.trim()
    if (sentence.length === 0) continue
    const lower = sentence.toLowerCase()
    for (const marker of UNSURE_MARKERS) {
      const index = lower.indexOf(marker)
      if (index < 0) continue
      const before = index === 0 ? '' : sentence.slice(index - 1, index)
      if (UNSURE_VETO_PREFIX.includes(before)) continue
      // 标记词之后那一个字：宾语若指向对方，这句是反应不是缺口。
      const afterIndex = index + marker.length
      const after = afterIndex >= sentence.length ? '' : sentence.slice(afterIndex, afterIndex + 1)
      if (UNSURE_VETO_FOLLOW.includes(after)) continue
      return Object.freeze({ text: truncate(sentence, TRUNCATE_CHARS), marker })
    }
  }
  return undefined
}

/**
 * 截断到 `max` 个字符（按码位算，不按 UTF-16 单元）。
 *
 * 按码位而不是 `slice`：一个 emoji 占两个单元，`slice` 会切出半个字符，
 * 存进 SQLite 之后读回来是 U+FFFD，日志里看就是「乱码」。
 * @param text 原文。
 * @param max 上限。
 */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text.trim())
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 归并键（§5.1「请求失败按失败分类归并」）。
 *
 * 三源各有一套键：
 * - `model-unsure` 没有键（空串），只能按正文相似度判重；
 * - `tool-empty` 用归一化后的搜索词（同一个词查两次是同一件事）；
 * - `request-failed` 用失败分类，**不认自定义值**（认不出来归 `unknown`）。
 *
 * 为什么失败要单独给一个键，而不是靠正文相似度：
 * 报错文案以后可能带上细节（`请求失败：网络断了（ECONNRESET）`），
 * 那样两句话的相似度会掉到阈值以下，于是「断了五次网」变成五条执念。
 * 分类归并是手册的硬要求，不能靠文本巧合达成。
 * @param source 来源。
 * @param query 原始键。
 */
export function classifySourceQuery(source: GapSource, query?: string): string {
  if (source === 'request-failed') {
    const kind = typeof query === 'string' ? query.trim().toLowerCase() : ''
    return (FAILURE_KINDS as readonly string[]).includes(kind) ? kind : 'unknown'
  }
  if (source === 'tool-empty') {
    const raw = typeof query === 'string' ? query : ''
    return normalizeForCompare(truncate(raw, 40))
  }
  return ''
}

/**
 * 失败正文（三源里唯一由本插件代写正文的一种）。
 *
 * 正文**只写分类、不写细节**：细节进日志。同类的两次失败必须长得一模一样，
 * 否则「按分类归并」在 `bump` 那一步就断了。
 * @param kind 失败分类。
 */
export function buildFailureText(kind: FailureKind): string {
  return `请求失败：${FAILURE_ZH[kind]}`
}

/* ------------------------------------------------------------------ *
 * 唤醒 / 做梦的四条件
 * ------------------------------------------------------------------ */

/**
 * 唤醒四条件（§5.1：`tension ≥ 80 且 energy > 30 且闲置 > 30min 且不在冷却期(60min)`）。
 *
 * **判定顺序即「最便宜的先判」**：配置 → 有没有事 → 张力 → 能量 → 闲置 → 冷却。
 * 前两条不读任何外部服务，绝大多数调用会在这里返回，
 * 而 `dueForWake` 是每个 tick 都会调的。
 * @param checks 四个读数。
 * @param enabled 总开关。
 * @param hasGap 池里有没有 open 条目。
 */
export function judgeWake(checks: WakeChecks, enabled: boolean, hasGap: boolean): WakeDecision {
  const blocked = (reason: WakeBlockReason): WakeDecision =>
    Object.freeze({ wake: false, checks, blockedBy: reason })

  if (!enabled) return blocked('disabled')
  if (!hasGap) return blocked('no-open-gap')
  if (checks.tension < WAKE_TENSION) return blocked('tension-low')
  // 能量读不到时**不动**：唤醒是外发动作，宁可少叫一次，也不要在她累垮时叫她说话。
  if (checks.energy === undefined) return blocked('energy-unknown')
  if (checks.energy <= WAKE_ENERGY_MIN) return blocked('energy-low')
  if (checks.idleMinutes <= WAKE_IDLE_MINUTES) return blocked('idle-short')
  if (checks.cooldownLeftMinutes > 0) return blocked('cooldown')
  return Object.freeze({ wake: true, checks })
}

/**
 * 做梦条件（§5.1：「深夜 02:00–05:00 **或** 超 2 小时无交互」+ `energy > 30` + 有 open 缺口）。
 * @param checks 三个读数。
 * @param enabled 总开关。
 * @param hasGap 池里有没有 open 条目。
 */
export function judgeDream(checks: DreamChecks, enabled: boolean, hasGap: boolean): DreamDecision {
  const blocked = (reason: DreamBlockReason): DreamDecision =>
    Object.freeze({ dream: false, checks, blockedBy: reason })

  if (!enabled) return blocked('disabled')
  if (!hasGap) return blocked('no-open-gap')
  if (checks.energy === undefined) return blocked('energy-unknown')
  if (checks.energy <= DREAM_ENERGY_MIN) return blocked('energy-low')
  const idleEnough = checks.idleMinutes > DREAM_IDLE_HOURS * 60
  if (!checks.deepNight && !idleEnough) return blocked('not-night-nor-idle')
  return Object.freeze({ dream: true, checks })
}

/**
 * 是否落在梦境窗口 `[02:00, 05:00)`。
 *
 * 与 O-003 的「不提供 `isDeepNight()`」是同一条纪律的延续：
 * 手册里「深夜」有两套定义（能量域 0–6 点、节奏域 23:00–06:00、梦境窗口 02:00–05:00），
 * 所以这个判定**只在本插件内部、只服务梦境**，不对外暴露，
 * 免得下游拿它去判精力恢复或静默时段。
 * @param hour 小时 0–23。
 */
export function isDreamWindow(hour: number): boolean {
  return hour >= 2 && hour < 5
}

/** 冷却期还剩多少分钟。 */
export function cooldownLeft(lastWakeAt: number, at: number, minutes: number = WAKE_COOLDOWN_MINUTES): number {
  if (lastWakeAt <= 0) return 0
  const passed = (at - lastWakeAt) / 60_000
  if (!Number.isFinite(passed)) return 0
  return Math.max(0, minutes - passed)
}
