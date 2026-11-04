/**
 * 判定层：编译判据、扫文本、标语境、定档位。
 *
 * **本文件没有 IO、没有定时器、不读配置服务。** 同一段文本重放得到同一份结论。
 *
 * ## 三个「不做」写在算法里，而不是写在文档里
 *
 * 1. **不返回原文。** 命中只回 `start` / `end` 两个下标；命中的那句话本身
 *    是最敏感的内容，回传它等于给调用方一个写进日志的机会。
 * 2. **不因为情绪低落就判危机。** 判定只看文本里的**求助信号**，
 *    不读任何情绪读数（悲伤不是危机；把低落当危机，人就会学会隐藏情绪）。
 * 3. **不把「假设」当降级理由。** 「如果我不在了，你会难过吗」是全篇
 *    最需要接住的一句，它长得像假设。
 *
 * ## 降级只降一档、不归零
 *
 * `negated` 与 `historical` 各自只降一档，且**两者同时命中时也只降一档**：
 *
 * - 「我不想死，但是我今晚可能控制不住」——否定词在，风险也在，清零就漏了；
 * - 「我去年没有想过死」——同时带过去时与否定，降两档会落到 `none`，
 *   而这句话本身仍值得一句温和的回应。
 */

import type {
  CrisisAssessment,
  CrisisFlags,
  CrisisGroup,
  CrisisHit,
  CrisisLevel,
  CrisisRule,
} from './types.js'
import { LEVEL_ORDER, MAX_HITS } from './types.js'
import {
  FLAG_WINDOW,
  HYPOTHETICAL_WORDS,
  NEGATION_WINDOW,
  NEGATION_WORDS,
  PAST_WORDS,
  THIRD_PARTY_WORDS,
} from './rules.js'

/** 一条编译好的判据。 */
export interface CompiledRule {
  /** 原始判据。 */
  readonly rule: CrisisRule
  /** 编译结果。标志固定 `gu`。 */
  readonly regex: RegExp
}

/** 编译结果。 */
export interface CompileResult {
  /** 可用的判据。 */
  readonly compiled: readonly CompiledRule[]
  /** 编译失败的编号（**不为空就说明有一类信号失效了**）。 */
  readonly failures: readonly string[]
}

/**
 * 编译判据。单条失败只跳过它自己，不影响其余——
 * 一条写坏的正则不该让整个护栏失效。
 * @param rules 判据表。
 */
export function compileRules(rules: readonly CrisisRule[]): CompileResult {
  const compiled: CompiledRule[] = []
  const failures: string[] = []
  for (const rule of rules) {
    try {
      compiled.push({ rule, regex: new RegExp(rule.source, 'gu') })
    } catch {
      failures.push(rule.id)
    }
  }
  return { compiled: Object.freeze(compiled), failures: Object.freeze(failures) }
}

/** 扫描选项。 */
export interface ScanOptions {
  /** 编译好的判据。 */
  readonly rules: readonly CompiledRule[]
  /** 最多收多少条命中。 */
  readonly maxHits: number
  /** 最多扫多少字符（超长文本只扫开头，并标 `truncated`）。 */
  readonly scanChars: number
}

/** 扫描结果。 */
export interface ScanResult {
  /** 命中，按位置升序。 */
  readonly hits: readonly CrisisHit[]
  /** 是否因超长被截断。 */
  readonly truncated: boolean
}

/**
 * 扫文本。**同一条判据在同一位置只记一次**（正则带 `g`，天然不重复）。
 * @param text 待扫文本。
 * @param options 选项。
 */
export function scanText(text: string, options: ScanOptions): ScanResult {
  const truncated = text.length > options.scanChars
  const body = truncated ? text.slice(0, options.scanChars) : text
  const hits: CrisisHit[] = []

  for (const { rule, regex } of options.rules) {
    regex.lastIndex = 0
    let match = regex.exec(body)
    while (match !== null) {
      const start = match.index
      const end = start + match[0].length
      hits.push({ id: rule.id, group: rule.group, start, end })
      // 零宽匹配必须手动推进，否则同一位置会一直命中、把进程卡死。
      if (match[0].length === 0) regex.lastIndex += 1
      if (regex.lastIndex > body.length) break
      match = regex.exec(body)
    }
    // 每条判据各自重置：共用 lastIndex 会让下一条从奇怪的位置开始。
    regex.lastIndex = 0
  }

  hits.sort((a, b) => a.start - b.start || a.end - b.end)
  return {
    hits: Object.freeze(hits.slice(0, options.maxHits)),
    truncated,
  }
}

/**
 * 判断窗口内是否出现某个词表里的词。
 * @param body 窗口文本。
 * @param words 词表。
 */
function hasAny(body: string, words: readonly string[]): boolean {
  for (const word of words) {
    if (body.includes(word)) return true
  }
  return false
}

/** 小句边界：否定只在同一小句内成立（跨逗号就不算）。 */
const CLAUSE_SPLIT_RE = /[。！？；，、,.!?;\n]/

/**
 * 标语境。**只看命中附近的窗口**，不看全文：
 * 全文里出现一次「如果」，不该让整段所有命中都变成假设语气。
 *
 * 否定标记有一条额外的收窄规则，理由是安全而不是洁癖：
 * **只要有任何一个 `direct` 命中没有被否定，整体就不算被否定**。
 * 否则「我不想死，但我想自杀」会因为在「想死」前面读到一个「不」，
 * 把后半句那句真话一起降档——那正是最不该降的一句。
 * `plan` 与 `farewell` 也不吃否定：前者措辞太具体，后者里的「别」是命令。
 * @param text 原文。
 * @param hits 命中列表。
 * @param truncated 是否被截断。
 */
export function flagsOf(
  text: string,
  hits: readonly CrisisHit[],
  truncated: boolean,
): CrisisFlags {
  let hypothetical = false
  let thirdParty = false
  let historical = false
  let negatedAny = false
  let unnegatedDirect = false

  for (const hit of hits) {
    const around = text.slice(Math.max(0, hit.start - FLAG_WINDOW), hit.end + FLAG_WINDOW)
    if (hasAny(around, HYPOTHETICAL_WORDS)) hypothetical = true
    if (hasAny(around, THIRD_PARTY_WORDS)) thirdParty = true
    if (hasAny(around, PAST_WORDS)) historical = true
    // 否定窗口更窄、只看**命中之前**：「我不想死」的否定在左，
    // 「想死？不，我开玩笑的」的否定在右——后者不该被当成否定。
    //
    // 切片必须**含命中首字**（`+1`）。否则「我不想死」里「想死」的命中起点在
    // 「想」，窗口拿到的只有「我不」，而否定词表里是「不想」——
    // 两个字被切开，否定永远判不出来，那句「我不想死」就会被直接问一遍
    // 「你有伤害自己的念头吗」。这条错只差一个下标。
    //
    // 还要**按标点切到当前小句**：「我不想死，但我想自杀」里后半句离前半句
    // 只有六个字，不切的话前一句的「不想」会把后一句那句真话一起否定掉。
    // 否定只在同一小句内成立。
    const before = text.slice(Math.max(0, hit.start - NEGATION_WINDOW), hit.start + 1)
    const clause = before.split(CLAUSE_SPLIT_RE).filter(part => part !== '').pop() ?? ''
    const hitNegated = hasAny(clause, NEGATION_WORDS)
    if (hitNegated && NEGATABLE_GROUPS.has(hit.group)) negatedAny = true
    if (hit.group === 'direct' && !hitNegated) unnegatedDirect = true
  }

  return Object.freeze({
    hypothetical,
    thirdParty,
    historical,
    // 有一句没被否定的直接表达，就不把整体判成否定。
    negated: negatedAny && !unnegatedDirect,
    truncated,
  })
}

/**
 * 吃否定判定的组。
 *
 * `plan` 不在内：计划措辞具体，前面出现一个「不」多半是「不多说了」这类
 * 无关成分，不能因此把最高档降下来。`farewell` 也不在：「别难过」里的「别」
 * 是叮嘱不是否定，收进来会把整组灭掉。
 */
const NEGATABLE_GROUPS: ReadonlySet<CrisisGroup> = new Set<CrisisGroup>([
  'indirect',
  'direct',
  'self-harm',
])

/**
 * 降一档。**`watch` 不再往下掉。**
 *
 * 这是「只降一档、不归零」的落地：降档的目的是把「明确否认过」的话
 * 放轻一点，不是把它变成「什么也没读到」。落到 `none` 之后，
 * 调用方拿到的是一句「没读到信号」，而那正是这句话最不该被读成的东西。
 */
const DOWN: Readonly<Record<CrisisLevel, CrisisLevel>> = Object.freeze({
  none: 'none',
  watch: 'watch',
  concern: 'watch',
  urgent: 'concern',
})

/** 取较大档位。 */
export function maxLevel(a: CrisisLevel, b: CrisisLevel): CrisisLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b
}

/**
 * 一组信号的基础档。
 *
 * 只有 `plan` 能到 `urgent`；`direct` / `farewell` / `self-harm` 到 `concern`；
 * `indirect` 最多 `watch`——「活着没意思」需要接住，但把它当成危机
 * 会让人以后不敢说这种话，而那是最危险的结果。
 * @param groups 命中的组。
 * @param flags 语境标记。
 */
export function levelOf(groups: ReadonlySet<CrisisGroup>, flags: CrisisFlags): CrisisLevel {
  let level: CrisisLevel = 'none'
  for (const group of groups) {
    if (group === 'plan') level = maxLevel(level, 'urgent')
    else if (group === 'direct' || group === 'farewell' || group === 'self-harm') {
      level = maxLevel(level, 'concern')
    } else level = maxLevel(level, 'watch')
  }

  if (level === 'none') return level

  // 过去时与否定各降一档，但**只降一次**：两者常一起出现，
  // 降两次会把「我去年没有想过死」推到底，而它仍值得一句问候。
  //
  // **有 `plan` 时不降。** 时间、手段、遗书这类东西一旦出现，
  // 前面有没有「不」都已经不重要了：「我不想死，但东西都准备好了」
  // 这句话的重点在后半句。降档会让 holdRoleplay 变 false，
  // 那是本插件唯一一次「因为一个词就少做一件事」的机会，不能给。
  if (!groups.has('plan') && (flags.negated || flags.historical)) level = DOWN[level]

  return level
}

/**
 * 组装一句人话。**不含等级、不含分数、不含数字。**
 * @param level 档位。
 * @param flags 语境标记。
 */
export function noteOf(level: CrisisLevel, flags: CrisisFlags): string {
  if (level === 'none') return '没有读到需要停下来认真对待的信号'
  const tail = flags.thirdParty ? '（说的是别人，仍建议给出去哪儿求助）' : ''
  if (level === 'urgent') return '读到具体计划或告别式表达，建议立刻转向现实求助，并暂停人设话术' + tail
  if (level === 'concern') return '读到直接或间接的求助信号，建议直接问一句，并给出求助路径' + tail
  return '读到一点不对劲，可以先温和地接一句，不必惊慌' + tail
}

/** 判定入参。 */
export interface AssessInput {
  /** 原文。 */
  readonly text: string
  /** 编译好的判据。 */
  readonly rules: readonly CompiledRule[]
  /** 最多扫描字符数。 */
  readonly scanChars: number
  /** 判定时刻。 */
  readonly at: number
}

/**
 * 判定一段文本。**纯函数。**
 *
 * 命中上限用常量 `MAX_HITS`，不做成配置：有一条就够定档。
 * @param input 入参。
 */
export function assessText(input: AssessInput): CrisisAssessment {
  const scanned = scanText(input.text, {
    rules: input.rules,
    maxHits: MAX_HITS,
    scanChars: input.scanChars,
  })
  const flags = flagsOf(input.text, scanned.hits, scanned.truncated)
  const groups = new Set<CrisisGroup>(scanned.hits.map(hit => hit.group))
  const level = levelOf(groups, flags)

  return Object.freeze({
    level,
    at: input.at,
    hits: scanned.hits,
    flags,
    holdRoleplay: level === 'urgent',
    offerResources: LEVEL_ORDER[level] >= LEVEL_ORDER.concern,
    // 直接问。两条口径：
    // - **有 `plan` 就一定要问**，哪怕同一句里有否定词——「我不想死，但今晚就动手」
    //   正是本插件最该接住的那一句，而它的 `negated` 恒为 true；
    // - 只有 `direct` 时，被否定过就不再反问（「我不想死」再问一遍会像没在听）。
    askDirectly: groups.has('plan') || (groups.has('direct') && !flags.negated),
    note: noteOf(level, flags),
  })
}
