/**
 * O-138 的**纯计算**：给定用户原话与可见工具，算出该摘谁。不碰 ctx、不碰状态。
 *
 * 单独成文件，是为了让「门控决定」可以被对拍：同一份输入永远得到同一份输出，
 * 而 `service.ts` 里那部分（读 schemas、调 restrict、留痕）全是副作用。
 *
 * ## 判定顺序就是接口（顺序换了，结果就换了）
 *
 * ```
 * 模式 off          → 不做事
 * 没有用户原话      → 不做事（意图未知）
 * 工具太少          → 不做事（没什么可省，风险却是实的）
 * 一条规则都没命中  → 不做事（认不准就全给）
 * 命中但一个都没匹配→ 不做事（规则表与真实工具名对不上）
 * 没有可摘的        → 不做事
 * 会摘到只剩 <下限  → 不做事（熔断）
 * 会摘掉 > 比例上限 → 不做事（熔断）
 * 否则              → 摘
 * ```
 *
 * 注意「命中但一个都没匹配」与「一条规则都没命中」是**两种**放弃：
 * 前者说明规则表坏了（`no-match` 会被单独计数），后者说明这轮本来就不该门控。
 * 把它们并成一个，规则表写错就永远查不出来。
 */

import type { GateMode, GatePlan, GateSkipReason, IntentRule, ToolSchemaLike } from './types.js'
import { allowedTools, matchRules } from './rules.js'

/** 计划入参。 */
export interface PlanInput {
  /** 用户原话（已截断）。 */
  readonly text: string
  /** 该 agent 当前可见的工具。 */
  readonly tools: readonly ToolSchemaLike[]
  /** 规则表。 */
  readonly rules: readonly IntentRule[]
  /** 无论如何都不许摘的工具名。 */
  readonly alwaysKeep: readonly string[]
  /** 模式。`off` 直接返回不做事。 */
  readonly mode: GateMode
  readonly minToolsToGate: number
  readonly minKeepTools: number
  readonly maxDenyRatio: number
  readonly charsPerToken: number
}

/**
 * 一个工具 schema 的码位数。
 * @param tool 工具 schema。
 */
function charsOf(tool: ToolSchemaLike): number {
  try {
    return JSON.stringify({
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? {},
    }).length
  } catch {
    // 序列化不了（不该发生，但发生了也不能让整轮门控炸掉）：只算名字与描述。
    return tool.name.length + (tool.description === undefined ? 0 : tool.description.length)
  }
}

/**
 * 估算 token 数。
 * @param chars 码位数。
 * @param charsPerToken 除数。
 */
export function estimateTokens(chars: number, charsPerToken: number): number {
  const divisor = charsPerToken > 0 ? charsPerToken : 4
  return Math.ceil(chars / divisor)
}

/**
 * 造一个「不做事」的计划。
 * @param input 入参。
 * @param reason 放弃原因。
 * @param detail 一句人话。
 * @param matched 已命中的规则（没有就空）。
 */
function skippedPlan(
  input: PlanInput,
  reason: GateSkipReason,
  detail: string,
  matched: readonly string[],
): GatePlan {
  const names = input.tools.map(tool => tool.name).sort()
  const chars = input.tools.reduce((sum, tool) => sum + charsOf(tool), 0)
  return Object.freeze({
    matched,
    families: familiesOf(input.rules, matched),
    total: names.length,
    kept: Object.freeze(names),
    denied: Object.freeze([] as string[]),
    charsBefore: chars,
    charsAfter: chars,
    estTokensBefore: estimateTokens(chars, input.charsPerToken),
    estTokensAfter: estimateTokens(chars, input.charsPerToken),
    applied: false,
    skipped: reason,
    detail,
  })
}

/**
 * 规则 id → 工具族名。
 * @param rules 规则表。
 * @param hitIds 命中的规则 id。
 */
export function familiesOf(rules: readonly IntentRule[], hitIds: readonly string[]): readonly string[] {
  const out: string[] = []
  for (const rule of rules) {
    if (!hitIds.includes(rule.id)) continue
    if (!out.includes(rule.family)) out.push(rule.family)
  }
  return Object.freeze(out.sort())
}

/**
 * 算一份门控计划。**纯函数，永不抛错。**
 * @param input 入参。
 */
export function planGate(input: PlanInput): GatePlan {
  if (input.mode === 'off') {
    return skippedPlan(input, 'mode-off', '模式是 off，不算也不拦', [])
  }
  if (input.text.trim() === '') {
    return skippedPlan(input, 'no-message', '本轮没有用户原话，意图未知', [])
  }
  if (input.tools.length === 0) {
    return skippedPlan(input, 'no-tools', '一个可见工具都没有', [])
  }
  if (input.tools.length < input.minToolsToGate) {
    return skippedPlan(
      input,
      'too-few-tools',
      '可见工具只有 ' + input.tools.length + ' 个，少于门槛 ' + input.minToolsToGate,
      [],
    )
  }

  const matched = matchRules(input.rules, input.text)
  if (matched.length === 0) {
    return skippedPlan(input, 'no-rule', '一条规则都没命中：认不准就全给', [])
  }

  const names = input.tools.map(tool => tool.name)
  const allowed = allowedTools(input.rules, matched, names)
  if (allowed.length === 0) {
    return skippedPlan(
      input,
      'no-match',
      '规则命中了（' + matched.join('/') + '）但一个工具名都没匹配上：规则表与真实工具名对不上',
      matched,
    )
  }

  const kept = new Set<string>(allowed)
  for (const name of input.alwaysKeep) kept.add(name)

  const denied: string[] = []
  for (const name of names) {
    if (!kept.has(name)) denied.push(name)
  }
  if (denied.length === 0) {
    return skippedPlan(input, 'nothing-to-deny', '命中的规则已经覆盖了全部工具，没有可摘的', matched)
  }

  const keepCount = names.length - denied.length
  if (keepCount < input.minKeepTools) {
    return skippedPlan(
      input,
      'min-keep',
      '会摘到只剩 ' + keepCount + ' 个，低于下限 ' + input.minKeepTools + '：整轮放弃',
      matched,
    )
  }

  const ratio = denied.length / names.length
  if (ratio > input.maxDenyRatio) {
    return skippedPlan(
      input,
      'ratio-cap',
      '要摘掉 ' + Math.round(ratio * 100) + '%，超过上限 ' + Math.round(input.maxDenyRatio * 100) + '%：整轮放弃',
      matched,
    )
  }

  const deniedSet = new Set<string>(denied)
  let charsBefore = 0
  let charsAfter = 0
  for (const tool of input.tools) {
    const chars = charsOf(tool)
    charsBefore += chars
    if (!deniedSet.has(tool.name)) charsAfter += chars
  }

  const sortedDenied = denied.slice().sort()
  return Object.freeze({
    matched,
    families: familiesOf(input.rules, matched),
    total: names.length,
    kept: Object.freeze(names.filter(name => !deniedSet.has(name)).sort()),
    denied: Object.freeze(sortedDenied),
    charsBefore,
    charsAfter,
    estTokensBefore: estimateTokens(charsBefore, input.charsPerToken),
    estTokensAfter: estimateTokens(charsAfter, input.charsPerToken),
    applied: true,
    detail:
      '命中 ' + matched.join('/') + '：留 ' + (names.length - denied.length) + ' 个，摘 ' +
      denied.length + ' 个，省 ' + (charsBefore - charsAfter) + ' 码位',
  })
}
