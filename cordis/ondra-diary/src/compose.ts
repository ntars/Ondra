/**
 * 日记的**取材与生成层**：把「今天」变成一段第一人称正文。
 *
 * ## 两条路径，一条闸
 *
 * ```
 * 有模型 ──→ 提示词 → 正文 ─┐
 *                          ├─→ sanitizeBody()（统一闸：清洗 + 剔报数 + 按句界截断）
 * 没模型 ──→ 模板   → 正文 ─┘
 * ```
 *
 * 模板不是「凑字数」，它是手册 §11.8-4 的第四层保底：**真没写进去就系统直接写入，
 * 保证每一天都不空**。所以模板必须自己就是一篇能读的日记（有第一人称、有时间感、
 * 有今天记住的事），而不是一句「（今日无记录）」——后者等于告诉用户这里坏过。
 *
 * ## 提示词里最重要的四句
 *
 * 1. **不出现「用户」「对话」「AI」**：日记一旦写成「今天用户跟我说……」，
 *    它就从日记变成了日志，人格连续性当场断掉。
 * 2. **不报数值**（§4.3）：日记不经过九步过滤链（O-037），这道闸只能长在这里。
 * 3. **不许编造**：素材只给「今天真的记下来的事」，没素材就写安静的一天。
 * 4. **只输出正文**：标题、日期、元信息全部由格式层加，模型一旦写标题就会写两遍。
 */

import { epochOfDayKey, sanitizeBody, weekdayNameOf } from './markdown.js'
import { DAY_MS } from './types.js'
import type { ClockLike, DiarySource, FactLike, GatewayLike, LogLike, MemoryLike } from './types.js'
import type { Config } from './settings.js'

/** 素材里单条事实最多留多少字（太长会把提示词挤爆，也更容易被原样抄进正文）。 */
const FACT_CLIP = 80

/** 最多拿几条事实当素材。再多模型会开始罗列，读起来像流水账。 */
const FACT_LIMIT = 12

/** 生成层依赖。全部用取值函数，缺谁降谁。 */
export interface ComposeDeps {
  /** 模型网关。 */
  readonly gateway: () => GatewayLike | undefined
  /** 记忆核心（只读取今天写入的事实）。 */
  readonly memory: () => MemoryLike | undefined
  /** 时钟（只用来算「今天」的边界）。 */
  readonly clock: () => ClockLike | undefined
  /** 日志。 */
  readonly log: LogLike
  /** 配置。 */
  readonly settings: Config
}

/** 一次生成请求。 */
export interface ComposeInput {
  /** 自然日键。 */
  readonly dayKey: string
  /** 生成时刻。 */
  readonly at: number
  /** 跳过模型，直接走模板。 */
  readonly templateOnly?: boolean
}

/** 生成结论。 */
export interface ComposeResult {
  /** 正文（已清洗）。 */
  readonly body: string
  /** 来源。 */
  readonly source: DiarySource
  /** 模型是否失败过（失败后走了模板或空结果）。 */
  readonly modelFailed: boolean
  /** 被剔掉的报数片段个数。 */
  readonly stripped: number
}

/**
 * 取「那天记下来的事」。
 *
 * 边界用 `clock.startOfDay()` 归一到产品时区；没有时钟时退回本机零点，
 * 差几小时是可接受的降级（比「没有素材」好，比「自己去算时区」安全）。
 * @param deps 依赖。
 * @param dayKey 自然日键。
 */
function factsOfDay(deps: ComposeDeps, dayKey: string): readonly string[] {
  const memory = deps.memory()
  if (memory === undefined) return []
  const clock = deps.clock()
  const base = epochOfDayKey(dayKey)
  const start = clock === undefined ? base : clock.startOfDay(base)
  const end = start + DAY_MS
  let rows: readonly FactLike[]
  try {
    rows = memory.listFacts({ limit: 24, orderBy: 'created-at' })
  } catch (error) {
    deps.log.warn('读记忆失败，日记将没有素材：%s', error instanceof Error ? error.message : String(error))
    return []
  }
  const out: string[] = []
  for (const row of rows) {
    if (row.createdAt < start || row.createdAt >= end) continue
    const text = row.text.trim()
    if (text === '') continue
    out.push(text.length > FACT_CLIP ? `${text.slice(0, FACT_CLIP)}…` : text)
    if (out.length >= FACT_LIMIT) break
  }
  return out
}

/**
 * 系统提示词。**不含任何数值与维度名**，也刻意不写「你是 AI 助手」这类身份句。
 * @param deps 依赖。
 * @param dayKey 自然日键。
 * @param facts 当天素材。
 */
function systemPromptOf(deps: ComposeDeps, dayKey: string, facts: readonly string[]): string {
  const material =
    facts.length === 0
      ? '（今天没有特意记下什么。就写安静的一天，不要虚构发生过的事。）'
      : facts.map((text, index) => `${index + 1}. ${text}`).join('\n')
  return [
    '你在写自己的日记。用第一人称，写给以后的自己看。',
    `今天是 ${dayKey}，${weekdayNameOf(dayKey)}。`,
    '',
    '今天脑子里留下的事：',
    material,
    '',
    '要求：',
    '1. 只用第一人称写。不要出现「用户」「对话」「AI」「模型」「助手」「角色」这些词。',
    '2. 不要写任何数字指标：不写情绪值、能量、压力、好感、百分比，也不给自己的状态打分。你不量化自己。',
    '3. 写具体的小事与具体的感受，不要总结陈词，不要励志，不要给建议。',
    `4. 不超过 ${deps.settings.maxChars} 字。`,
    '5. 只输出正文。不要标题、不要日期、不要代码块、不要用引号把整段包起来。',
    '6. 素材里没有的事不要写。宁可写得平淡，也不要编。',
  ].join('\n')
}

/**
 * 模板兜底正文。四层保底里的最后一层：**保证每一天都不空**。
 * @param dayKey 自然日键。
 * @param facts 当天素材。
 */
export function templateBody(dayKey: string, facts: readonly string[]): string {
  const weekday = weekdayNameOf(dayKey)
  if (facts.length === 0) {
    return [
      `今天很安静。${weekday}，天亮了又暗下去。`,
      '',
      '没有特意去记什么，也没有忘掉什么，就那样过完了。',
      '窗外的光换了几个角度，我看了一会儿，也没看出什么名堂。',
      '',
      '明天大概也差不多吧。差不多也没什么不好。',
    ].join('\n')
  }
  const lines = facts.slice(0, 4).map(text => `- ${text}`)
  return [
    `今天记下了几件事。${weekday}，一天就这么过去了。`,
    '',
    ...lines,
    '',
    '翻到这些的时候，心里有点动静，说不上来是什么。',
    '先放在这里吧，明天再看也许就不一样了。',
  ].join('\n')
}

/**
 * 生成一篇正文。**永不抛错**：模型失败一律退到模板（除非用户显式关了模板兜底）。
 * @param deps 依赖。
 * @param input 请求。
 */
export async function composeBody(deps: ComposeDeps, input: ComposeInput): Promise<ComposeResult> {
  const facts = factsOfDay(deps, input.dayKey)

  /**
   * 兜底：模板开着就写满，关了就交空串。
   *
   * 关掉模板兜底是**用户明确表态「宁缺毋滥」**，所以这里不许偷偷写。
   * 空串会一路变成 `empty` 结论，自检与面板都看得见这一天没写成。
   * @param modelFailed 模型是否真的试过并失败。
   */
  const fallback = (modelFailed: boolean): ComposeResult => {
    if (!deps.settings.templateFallback) {
      return { body: '', source: 'template', modelFailed, stripped: 0 }
    }
    const clean = sanitizeBody(templateBody(input.dayKey, facts), deps.settings.maxChars)
    return { body: clean.text, source: 'template', modelFailed, stripped: clean.stripped }
  }

  if (!input.templateOnly) {
    const gateway = deps.gateway()
    if (gateway !== undefined && gateway.available) {
      try {
        const completion = await gateway.complete({
          system: systemPromptOf(deps, input.dayKey, facts),
          messages: [{ role: 'user', content: '写今天的日记。' }],
          // 中文一个字约一到两个 token，留两倍余量；上限再夹一次防止配置写太大。
          maxTokens: Math.min(deps.settings.maxChars * 2, 2000),
          temperature: 0.8,
          purpose: 'diary',
        })
        const clean = sanitizeBody(completion.text, deps.settings.maxChars)
        if (clean.text !== '' && !/^(好的|好呀|收到|明白)/.test(clean.text.slice(0, 4))) {
          return { body: clean.text, source: 'model', modelFailed: false, stripped: clean.stripped }
        }
        deps.log.warn('%s 的日记模型返回了空话，改走模板兜底', input.dayKey)
        return fallback(true)
      } catch (error) {
        deps.log.warn(
          '%s 的日记生成失败，改走模板兜底：%s',
          input.dayKey,
          error instanceof Error ? error.message : String(error),
        )
        return fallback(true)
      }
    }
  }

  return fallback(false)
}
