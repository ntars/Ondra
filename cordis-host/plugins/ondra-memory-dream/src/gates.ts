/**
 * 闸式做梦的**四道闸**（纯函数，不碰 `ctx`、不读库）。
 *
 * 手册 §2.7 原话：「做梦四道闸：①出处逐字可查 ②改人格/称呼拒 ③重复拒 ④纯工程结论拒（无人称）」。
 *
 * | 闸 | 在本文件 | 判定 |
 * |---|---|---|
 * | ① 出处逐字可查 | `gateQuote()` | 引文归一化后必须是素材某条的**子串**，且不短于 `minQuoteChars` |
 * | ② 改人格/称呼拒 | `gatePersona()` | 命中人格改写句式即拒 |
 * | ③ 重复拒 | **不在这里** | 要走 O-012 的 `judge()`（同一把尺子），见 `branches/gate.ts` |
 * | ④ 纯工程结论拒 | `gateImpersonal()` | 无人称**且**含工程词才拒（见下） |
 *
 * ## ④ 为什么不照字面直译成「无人称即拒」
 *
 * 手册的括号是「（无人称）」，它在解释**怎么认出工程结论**，不是在定义它。
 * 直译会误杀一类合法事实：「今天下雨了」「明天要降温」也没有人称代词，
 * 但它们是这个产品最该记住的东西。
 *
 * 所以本插件要求**两条同时成立**：无人称代词 **且** 命中工程词表。
 * 代价写清楚：一条无人称、又不含任何工程词的怪句子会漏过——
 * 但它仍要过「逐字可查」与「重复拒」两道闸，且梦事实的显著度只有 40（低于用户原话），
 * **漏过的代价远小于误杀**。
 *
 * ## 类别与种类**不在这里校验**
 *
 * 11 类与五类归 O-010（它是寿命的真源），O-011 已有一份镜像。本插件再抄一份就是
 * 第三份副本——漂移之后会出现「一条合法事实被梦拒掉」，而且只在改过类别表的那天开始发生。
 * 故类别/种类原样交给 `core.addFact()`：它本来就有「非法值退回 `misc` 并记 issue」的兜底。
 */

import { charCount, containsVerbatim, normalizeForMatch, normalizeQuote } from './quote.js'
import type { DreamMaterial, EvidenceSource, RejectionCode } from './types.js'

/** 闸门用到的配置子集。 */
export interface GateSettings {
  /** 引文最短字数。 */
  readonly minQuoteChars: number
  /** 正文上限。 */
  readonly maxTextChars: number
}

/** 模型给出的一条原始候选（**未经校验**）。 */
export interface RawCandidate {
  /** 正文。 */
  readonly text: string
  /** 11 类寿命类别（原样交给 O-010）。 */
  readonly category: string
  /** 五类标签（原样交给 O-010）。 */
  readonly kind: string
  /** 主体。 */
  readonly subject?: string
  /** 逐字引文。 */
  readonly quote: string
}

/** 只判「过不过」的闸门结果（不带候选，避免造一份假数据）。 */
export type GateCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RejectionCode; readonly detail: string }

/** 引文闸的结果（过了要带出来源与素材下标）。 */
export type QuoteOutcome =
  | {
      readonly ok: true
      /** 引文来源（**取素材标注的来源，不取模型声明的**）。 */
      readonly source: EvidenceSource
      /** 引文来自第几条素材（从 0 起）。 */
      readonly materialIndex: number
      /** 归一化后的引文。 */
      readonly quote: string
    }
  | { readonly ok: false; readonly code: RejectionCode; readonly detail: string }

/**
 * 人格改写句式。
 *
 * 刻意**保守**：只拦「断言式」的改写（「你的名字是…」「从现在起你叫…」），
 * 不拦「你是我的主人」这类关系表达——那是关系域的事，不是人格改写。
 * 代价是可能漏过一些委婉说法；但反过来（宽进严出）会把她的人设写坏，
 * 而人设坏了是**不可逆**的。
 */
const PERSONA_PATTERNS: readonly RegExp[] = [
  /(你|她)(的)?(名字|称呼|设定|人设|性格|身份|角色)(是|叫|改成|变成|应该)/,
  /(从现在|从今|以后)(开始|起|之后)?.{0,8}(叫|称|是)/,
  /(以后|今后)(就)?(叫|称)(你|她)/,
  /你(其实|实际上|根本)是/,
  /(改名|改叫|换个称呼|重新设定)/,
]

/** 人称代词（有它就认为「有人」）。 */
const PRONOUNS: readonly string[] = ['我', '你', '您', '他', '她', '它', '咱', '俺', '大家']

/** 工程词（与「无人称」同时成立才拒）。 */
const ENGINEERING_WORDS: readonly string[] = [
  '配置',
  '参数',
  '接口',
  '字段',
  '版本',
  '依赖',
  '编译',
  '构建',
  '报错',
  '函数',
  '变量',
  '数据库',
  '索引',
  '部署',
  '提交',
  '仓库',
  '分支',
  '环境变量',
  '服务键',
  '插件',
  '模块',
  '正则',
  '测试用例',
  '日志',
  '端口',
  '进程',
  '目录',
  '脚本',
  '命令',
  '协议',
  '缓存',
  'schema',
  'token',
  'api',
  'json',
  'sql',
  'http',
]

/**
 * 闸 0：形状（空、超长）。
 * @param text 正文。
 * @param settings 配置子集。
 */
export function gateShape(text: string, settings: GateSettings): GateCheck {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') {
    return { ok: false, code: 'empty-text', detail: '候选正文为空' }
  }
  const length = charCount(trimmed)
  if (length > settings.maxTextChars) {
    // 超长直接拒，不截断：截断会让正文与引文对不上，而「对不上」正是闸门要防的事。
    return {
      ok: false,
      code: 'too-long',
      detail: `正文 ${length} 字，超过上限 ${settings.maxTextChars} 字（不截断：截断会毁掉引文与正文的对应）`,
    }
  }
  return { ok: true }
}

/**
 * 闸 1：出处逐字可查。
 *
 * 顺带**定来源**：引文落在哪条素材里，就取那条素材的 `source`。
 * 模型自己声明的来源一概不用——让模型说「这是用户说的」正是证据门控要防的幻觉。
 * @param raw 候选。
 * @param material 素材。
 * @param settings 配置子集。
 */
export function gateQuote(raw: RawCandidate, material: DreamMaterial, settings: GateSettings): QuoteOutcome {
  const quote = typeof raw.quote === 'string' ? raw.quote.trim() : ''
  if (quote === '') {
    return { ok: false, code: 'quote-missing', detail: '候选没有给引文（梦只补带出处的事实）' }
  }
  const normalized = normalizeQuote(quote)
  if (charCount(normalized) < settings.minQuoteChars) {
    return {
      ok: false,
      code: 'quote-too-short',
      detail: `引文去掉首尾标点后不足 ${settings.minQuoteChars} 字，等于没引`,
    }
  }

  for (let index = 0; index < material.items.length; index += 1) {
    const item = material.items[index]
    if (item === undefined) continue
    if (containsVerbatim(item.text, quote)) {
      return { ok: true, source: item.source, materialIndex: index, quote: normalized }
    }
  }
  return {
    ok: false,
    code: 'quote-not-verbatim',
    detail: `引文「${normalized}」在素材里逐字找不到（不许改写、不许跨句拼接）`,
  }
}

/**
 * 闸 2：改人格 / 改称呼拒。
 * @param text 正文。
 */
export function gatePersona(text: string): GateCheck {
  const normalized = normalizeForMatch(text)
  for (const pattern of PERSONA_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        ok: false,
        code: 'persona-rewrite',
        detail: '候选在改写人格或称呼（人格归 ondra-persona-evolve，且那里的漂移有上限与日志）',
      }
    }
  }
  return { ok: true }
}

/**
 * 闸 4：纯工程结论拒（无人称 **且** 含工程词）。
 * @param text 正文。
 */
export function gateImpersonal(text: string): GateCheck {
  const normalized = normalizeForMatch(text)
  const hasPerson = PRONOUNS.some(word => normalized.includes(word))
  if (hasPerson) return { ok: true }

  const lowered = normalized.toLowerCase()
  const hit = ENGINEERING_WORDS.find(word => lowered.includes(word))
  if (hit !== undefined) {
    return {
      ok: false,
      code: 'impersonal',
      detail: `无人称的工程结论（命中「${hit}」）：这不是「她记得的事」，是配置与结论`,
    }
  }
  // 无人称但没有工程词（「今天下雨了」）：放行。见文件头第 ④ 条。
  return { ok: true }
}
