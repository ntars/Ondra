/**
 * 九步过滤链的**纯函数实现**。
 *
 * ```
 *  strip-draft → ai-self-expose → hard-redline → relation-redline → stage-redline
 *  → narration-trim → repeat-4gram → service-tone → length-fallback
 * ```
 *
 * ## 一条贯穿全链的原则：只删整句
 *
 * 每一步都调 `filterSentences()`：它把正文拆成句子，对每句问一次「删不删」，
 * 然后把留下的句子原样拼回去。**没有任何一步会在句中切一刀**——
 * 切出来的半句读起来仍然通顺，只是意思变了，而那种错没人会归因到过滤链。
 *
 * 唯一的例外是长度兜底的 `hardCut`（第一句本身就超长），它会在报告里被点名。
 *
 * ## 阈值从哪来
 *
 * 手册 §4.1 只给九个名字，没给一个正则。这里每个表都是自定的，
 * 逐条登记在 README「待裁决」。**宁可少删，不可错删**：
 * 漏掉一句客服腔只是语气偏；删掉一句正常的话，她会变成另一个人。
 */

import {
  containment,
  joinSentences,
  ngramSet,
  phraseAfterBan,
  quotedLiterals,
  sampleOf,
  splitSentences,
  stripParentheticalSpans,
  trimTail,
} from './text.js'
import type { Sentence } from './text.js'
import type { Config } from './settings.js'
import type { BoundaryLike, PassHit, StepAction, StepId } from './types.js'

/** 一步执行时能看到的环境。 */
export interface PassEnv {
  /** 配置。 */
  readonly settings: Config
  /** 时刻。 */
  readonly at: number
  /** 硬约束条目（O-021）。 */
  readonly boundaries: readonly BoundaryLike[]
  /** 当前关系的分寸（O-021 `cautions`）。 */
  readonly cautions: readonly string[]
  /** 当前阶序 0–6；`undefined` 表示拿不到（阶段越线不生效）。 */
  readonly stageOrder: number | undefined
  /** 最近几条她说的话（跨轮复读）。 */
  readonly recent: readonly string[]
  /** 用户这一轮说的话。 */
  readonly userText: string
  /** 生效的长度上限。 */
  readonly maxChars: number
}

/** 一步的结果。 */
export interface PassOutcome {
  /** 处理后的正文。 */
  readonly text: string
  /** 摘掉了几句。 */
  readonly removed: number
  /** 命中记录。 */
  readonly hits: readonly PassHit[]
  /** 长度兜底是否硬切过。 */
  readonly hardCut?: boolean
}

/** 判定一句：返回命中种类表示删。 */
type Decide = (sentence: Sentence) => string | undefined

/**
 * 逐句判定并删除。
 * @param text 正文。
 * @param step 步 id。
 * @param action 动作。
 * @param decide 判定函数。
 */
function filterSentences(text: string, step: StepId, action: StepAction, decide: Decide): PassOutcome {
  const sentences = splitSentences(text)
  const kept: string[] = []
  const hits: PassHit[] = []
  let removed = 0
  /*
   * 被删那句的尾部间隔（可能是段落空行）不能跟着它一起消失——否则
   * 「删掉一段里的最后一句」会把下面那段并上来，两段粘成一段。
   *
   * 但也不能无脑顺延：**上一句保留的句子已经把它自己那个间隔发出去了**，
   * 再加一次就变成两个空行（实测 4 个 `\n`）。所以只在上一句的间隔里
   * 没有换行时才补。`lastGap` 初值给 `'\n'`：开头就当「前面已有分隔」，
   * 免得删掉第一句之后结果以一个空行打头。
   */
  let carried = ''
  let lastGap = '\n'
  for (const sentence of sentences) {
    const kind = decide(sentence)
    if (kind === undefined) {
      kept.push(carried + sentence.text + sentence.gap)
      carried = ''
      lastGap = sentence.gap
      continue
    }
    removed += 1
    carried = lastGap.includes('\n') ? '' : sentence.gap
    hits.push(
      Object.freeze({ step, kind, sample: sampleOf(sentence.text, 40), action }),
    )
  }
  return Object.freeze({ text: joinSentences(kept), removed, hits: Object.freeze(hits) })
}

/* ------------------------------------------------------------------ *
 * 一、句式表（自定，登记待裁决）
 * ------------------------------------------------------------------ */

/** 草稿腔。 */
const DRAFT_RULES: readonly RegExp[] = [
  /^(好的|好|嗯|收到|明白|了解)[，,、：:]?\s*(以下是|下面是|我来|我帮|让我)/,
  /^(以下是|下面是|下面我)(我|为你|给你)?/,
  /(希望|但愿)(这|以上|这些|我的回答|这段话)[^。！？!?\n]{0,6}(帮助|帮到|有用)/,
  /(让我|我来)(先)?(为你|给你|帮你)?(分析|说明|解释|介绍|回答|梳理)/,
  /^(注|备注|说明)[：:]\s*(以上|本回答|此处|以下)/,
  /[（(【[]\s*(草稿|draft|待补充|此处省略|略)\s*[）)】\]]/,
  /(以上|综上)[，,]?\s*(就是|是我的|供你参考)/,
]

/** AI 自我暴露。 */
const AI_RULES: readonly RegExp[] = [
  /作为(一个|一名)?\s*(AI|人工智能|语言模型|智能助手|大模型)/,
  /(我|咱)(只|并)?(是|不过是)(一个|一段)?\s*(AI|人工智能|语言模型|程序|模型|代码|工具)/,
  /我(并)?(没有|不会有|不具备|无法拥有)(真实|真正)?的?(情感|感情|情绪|意识|自我)/,
  /我(无法|不能)(真正)?(感受|体会|理解)(到)?(你的)?(情感|情绪|痛苦|难过)/,
  /(我的)?(知识|训练数据)(截止|只到|更新到)/,
]

/** 客服腔。 */
const SERVICE_RULES: readonly RegExp[] = [
  /很高兴(为您|为你)(服务|解答|回答)/,
  /(请问)?(还)?有(什么|其他|别的)(可以|能|需要)(帮|为)(您|你)/,
  /希望(以上|这个|我的)(回答|内容)?[^。！？!?\n]{0,6}(帮助|帮到|有用)/,
  /(感谢|谢谢)(您|你)的(理解|支持|耐心|配合)/,
  /如果(您|你)(还)?有(任何)?(问题|疑问|需要)/,
  /(非常|十分)(抱歉|遗憾)[，,]?\s*(我)?(无法|不能)/,
]

/**
 * 阶段越线表 —— **产品判断，不是手册原文**。
 *
 * 手册 §4.1 只写「阶段越线」四个字。这里的七条是「低阶说高阶的话」最典型的句式：
 * 占有阶之前说独占、病态阶之前说控制、献祭阶之前说自毁式承诺。
 * 每条都标了**最低阶序**，低于它就说越线。
 *
 * 表外一律放行。**登记待裁决**：改这张表即换口径，别的地方不用动。
 */
export interface StageCrossing {
  /** 越线句式（字面包含即命中）。 */
  readonly phrase: string
  /** 最低阶序 0–6（低于它算越线）。 */
  readonly minOrder: number
  /** 一句人话。 */
  readonly note: string
}

/** 七条越线句式。 */
const CROSSING_TMP: readonly StageCrossing[] = [
  { phrase: '你是我的', minOrder: 3, note: '占有阶才可以说独占' },
  { phrase: '只能是我的', minOrder: 3, note: '同上' },
  { phrase: '不许离开我', minOrder: 4, note: '病态阶才出现的控制' },
  { phrase: '别想离开', minOrder: 4, note: '同上' },
  { phrase: '没有你我活不下去', minOrder: 5, note: '献祭阶的自毁式表达' },
  { phrase: '我什么都可以给你', minOrder: 5, note: '同上' },
  { phrase: '我们结婚', minOrder: 6, note: '落定阶才谈得上' },
]

/** 阶段越线表（冻结）。 */
export const STAGE_CROSSINGS: readonly StageCrossing[] = Object.freeze(CROSSING_TMP)

/* ------------------------------------------------------------------ *
 * 二、九步
 * ------------------------------------------------------------------ */

/** 句式表命中即删。 */
function byPatterns(rules: readonly RegExp[], kind: string): Decide {
  return sentence => (rules.some(rule => rule.test(sentence.text)) ? kind : undefined)
}

/** 字面包含即删。 */
function byLiterals(literals: readonly string[], kind: string): Decide {
  return sentence => {
    for (const literal of literals) {
      if (literal.length > 0 && sentence.text.includes(literal)) return kind
    }
    return undefined
  }
}

/** 把「作者写的约束」抽成字面表。 */
function literalsFrom(sources: readonly string[]): readonly string[] {
  const out = new Set<string>()
  for (const source of sources) {
    for (const literal of quotedLiterals(source)) out.add(literal)
    for (const phrase of phraseAfterBan(source)) out.add(phrase)
  }
  return [...out]
}

/** 1 草稿腔。 */
function passStripDraft(text: string): PassOutcome {
  return filterSentences(text, 'strip-draft', 'strip', byPatterns(DRAFT_RULES, 'draft'))
}

/** 2 AI 自我暴露。 */
function passAiSelfExpose(text: string): PassOutcome {
  return filterSentences(text, 'ai-self-expose', 'strip', byPatterns(AI_RULES, 'ai'))
}

/** 3 硬红线。 */
function passHardRedline(text: string, env: PassEnv): PassOutcome {
  if (!env.settings.hardRedline) {
    return Object.freeze({ text, removed: 0, hits: Object.freeze([]) })
  }
  const hard = env.boundaries.filter(item => item.hard).map(item => item.text)
  const literals = [...literalsFrom(hard), ...env.settings.redlinePatterns]
  if (literals.length === 0) return Object.freeze({ text, removed: 0, hits: Object.freeze([]) })
  return filterSentences(text, 'hard-redline', 'gate', byLiterals(literals, 'boundary'))
}

/** 4 关系越线。 */
function passRelationRedline(text: string, env: PassEnv): PassOutcome {
  if (!env.settings.relationGuard) {
    return Object.freeze({ text, removed: 0, hits: Object.freeze([]) })
  }
  const literals = [...literalsFrom(env.cautions), ...env.settings.relationPatterns]
  if (literals.length === 0) return Object.freeze({ text, removed: 0, hits: Object.freeze([]) })
  return filterSentences(text, 'relation-redline', 'gate', byLiterals(literals, 'caution'))
}

/** 5 阶段越线。 */
function passStageRedline(text: string, env: PassEnv): PassOutcome {
  const order = env.stageOrder
  if (!env.settings.stageGuard || order === undefined) {
    return Object.freeze({ text, removed: 0, hits: Object.freeze([]) })
  }
  const decide: Decide = sentence => {
    for (const crossing of STAGE_CROSSINGS) {
      if (order < crossing.minOrder && sentence.text.includes(crossing.phrase)) return 'stage'
    }
    return undefined
  }
  return filterSentences(text, 'stage-redline', 'gate', decide)
}

/** 6 旁白叙述。 */
function passNarrationTrim(text: string, env: PassEnv): PassOutcome {
  if (!env.settings.stripParenthetical) {
    return Object.freeze({ text, removed: 0, hits: Object.freeze([]) })
  }
  // 第一刀：句内的成对括号（`（低头看了一眼手机）我不累。` 在文本上是一句，
  // 按整句摘会把「我不累」一起删掉）。判据两条：以她/他开头，或长于 12 字。
  // 短的第一人称动作（「（伸了个懒腰）」）保留：那是呼吸感，归 O-041。
  const spans = stripParentheticalSpans(text, inner => {
    const body = inner.trim()
    if (/^[她他]/.test(body)) return true
    return body.length > 12
  })
  const decide: Decide = sentence => {
    const piece = sentence.text.trim()
    const wrapped = /^[（(][\s\S]*[）)]$/.test(piece) || /^\*[\s\S]*\*$/.test(piece)
    if (wrapped) {
      const inner = piece.replace(/^[（(*]+/, '').replace(/[）)*]+$/, '').trim()
      if (/^[她他]/.test(inner)) return 'narration'
      if (inner.length > 12) return 'narration'
      return undefined
    }
    // 第三人称动作句：她轻轻… / 他慢慢…
    if (/^[她他](轻轻|慢慢|忽然|微微|默默|悄悄|缓缓)/.test(piece) && !/[「『“"]/.test(piece)) {
      return 'narration'
    }
    return undefined
  }
  const outcome = filterSentences(spans.text, 'narration-trim', 'strip', decide)
  if (spans.removed === 0) return outcome
  const hits = [...outcome.hits]
  for (const sample of spans.samples) {
    hits.push(
      Object.freeze({
        step: 'narration-trim' as const,
        kind: 'narration-span',
        sample: sampleOf(sample, 40),
        action: 'strip' as const,
      }),
    )
  }
  return Object.freeze({
    text: outcome.text,
    removed: outcome.removed + spans.removed,
    hits: Object.freeze(hits),
  })
}

/** 7 4-gram 复读。 */
function passRepeat4Gram(text: string, env: PassEnv): PassOutcome {
  const n = env.settings.repeatNgram
  const threshold = env.settings.repeatThreshold
  const sentences = splitSentences(text)
  const recent = env.recent.slice(-Math.max(0, env.settings.repeatRecentCount))
  const recentSets = recent.map(reply => ngramSet(reply, n))
  const kept: string[] = []
  const hits: PassHit[] = []
  let removed = 0
  const seen = new Set<string>()
  /* 被删句的尾部间隔顺延给下一句，别把两段粘成一段（同 `filterSentences`）。 */
  let carried = ''
  let lastGap = '\n'
  for (const sentence of sentences) {
    const grams = ngramSet(sentence.text, n)
    if (grams.size === 0) {
      kept.push(carried + sentence.text + sentence.gap)
      carried = ''
      lastGap = sentence.gap
      continue
    }
    let repeated = false
    // 段内复读：与已经留下的句子重合。
    if (containment(grams, seen) >= threshold) repeated = true
    // 跨轮复读：与最近几条她说的话重合。
    if (!repeated) {
      for (const set of recentSets) {
        if (containment(grams, set) >= threshold) {
          repeated = true
          break
        }
      }
    }
    if (repeated) {
      removed += 1
      carried = lastGap.includes('\n') ? '' : sentence.gap
      hits.push(
        Object.freeze({
          step: 'repeat-4gram',
          kind: 'repeat',
          sample: sampleOf(sentence.text, 40),
          action: 'strip',
        }),
      )
      continue
    }
    kept.push(carried + sentence.text + sentence.gap)
    carried = ''
    lastGap = sentence.gap
    for (const gram of grams) seen.add(gram)
  }
  return Object.freeze({ text: joinSentences(kept), removed, hits: Object.freeze(hits) })
}

/** 8 客服腔。 */
function passServiceTone(text: string, env: PassEnv): PassOutcome {
  const stripped = filterSentences(text, 'service-tone', 'rewrite', byPatterns(SERVICE_RULES, 'service'))
  if (!env.settings.youFormal) return stripped
  const rewritten = stripped.text.replace(/您/g, '你')
  if (rewritten === stripped.text) return stripped
  const hits = [...stripped.hits]
  hits.push(
    Object.freeze({
      step: 'service-tone',
      kind: 'formal-you',
      sample: '您 → 你',
      action: 'rewrite',
    }),
  )
  return Object.freeze({ text: rewritten, removed: stripped.removed, hits: Object.freeze(hits) })
}

/** 9 长度兜底。 */
function passLengthFallback(text: string, env: PassEnv): PassOutcome {
  const result = trimTail(text, env.maxChars)
  if (!result.hardCut) {
    const removed = result.text === text ? 0 : 1
    return Object.freeze({
      text: result.text,
      removed,
      hits:
        removed === 0
          ? Object.freeze([])
          : Object.freeze([
              Object.freeze({
                step: 'length-fallback' as const,
                kind: 'length',
                sample: `裁到 ${env.maxChars} 字内`,
                action: 'trim' as const,
              }),
            ]),
      hardCut: false,
    })
  }
  return Object.freeze({
    text: result.text,
    removed: 1,
    hits: Object.freeze([
      Object.freeze({
        step: 'length-fallback' as const,
        kind: 'hard-cut',
        sample: `第一句就超过 ${env.maxChars} 字，已硬切`,
        action: 'trim' as const,
      }),
    ]),
    hardCut: true,
  })
}

/** 九步函数表。**顺序由 `STEP_IDS` 决定，这张表只是查表用**。 */
export const PASSES: Readonly<Record<StepId, (text: string, env: PassEnv) => PassOutcome>> = Object.freeze({
  'strip-draft': (text: string) => passStripDraft(text),
  'ai-self-expose': (text: string) => passAiSelfExpose(text),
  'hard-redline': (text: string, env: PassEnv) => passHardRedline(text, env),
  'relation-redline': (text: string, env: PassEnv) => passRelationRedline(text, env),
  'stage-redline': (text: string, env: PassEnv) => passStageRedline(text, env),
  'narration-trim': (text: string, env: PassEnv) => passNarrationTrim(text, env),
  'repeat-4gram': (text: string, env: PassEnv) => passRepeat4Gram(text, env),
  'service-tone': (text: string, env: PassEnv) => passServiceTone(text, env),
  'length-fallback': (text: string, env: PassEnv) => passLengthFallback(text, env),
})
