/**
 * 执行层的纯函数部分：**目标解析、单面结果构造、残余行构造、完成判定**。
 *
 * 一句话纪律：**本文件不许出现任何 `ctx`、任何服务调用、任何 IO。**
 * 需要 IO 的部分全在 `service.ts`。分开的理由是「判定」必须能被单独读、单独核对——
 * 一旦判定和执行写在一起，改判定就会改执行，而这里最不能被随手改的恰恰是判定：
 * 少判一面，用户就以为清干净了。
 */

import { ForgetRightError, SURFACE_SPECS } from './types.js'
import type {
  ForgetRun,
  ForgetTarget,
  ResolvedTarget,
  ScrubOutcome,
  ScrubStatus,
  SurfaceId,
  SurfaceSpec,
} from './types.js'

/** 目标里一条值最长多少字（主体名不会太长，超出多半是粘错了一段话）。 */
export const MAX_VALUE_CHARS = 120

/**
 * 解析目标：把「主体名 / id」摊成要删的 id 列表。
 *
 * 这里只做**纯字符串判定**，真正查库由调用方做（`service.ts` 传入 `rows`）。
 * @param target 目标。
 * @param rows 按 target 查出来的候选行（`fact` / `subject` 用）。
 * @param extraCapsules 胶囊候选（`capsule` 用；只有未开封的会进来）。
 * @param extraTodos 待办候选（`todo` 用）。
 */
export function resolveTarget(
  target: ForgetTarget,
  rows: readonly { readonly id: string }[],
  extraCapsules: readonly string[],
  extraTodos: readonly string[],
): ResolvedTarget {
  if (target.kind === 'capsule') {
    const ids = dedupe(extraCapsules)
    return Object.freeze({
      kind: target.kind,
      ids,
      hit: ids.length > 0,
      note: ids.length > 0 ? `找到 ${String(ids.length)} 颗未开封的胶囊` : '没有匹配的未开封胶囊',
    })
  }

  if (target.kind === 'todo') {
    const ids = dedupe(extraTodos)
    return Object.freeze({
      kind: target.kind,
      ids,
      hit: ids.length > 0,
      note: ids.length > 0 ? `找到 ${String(ids.length)} 条待办` : '没有匹配的待办',
    })
  }

  const ids = dedupe(rows.map(row => row.id))
  const what = target.kind === 'subject' ? '记忆' : '记忆 id'
  return Object.freeze({
    kind: target.kind,
    ids,
    hit: ids.length > 0,
    note: ids.length > 0 ? `找到 ${String(ids.length)} 条${what}` : `没有匹配的${what}`,
  })
}

/**
 * 去重保序。空串一律丢掉（空 id 拿去删会删出错东西）。
 * @param values 原始值。
 */
export function dedupe(values: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return Object.freeze(out)
}

/**
 * 校验目标，非法就抛 `bad-target`。
 *
 * **不做宽容修正**：目标里夹着一条超长乱码，宁可整份拒掉让人重填，
 * 也不要悄悄丢掉那一条——那会删出一份「看起来成功、其实少了一条」的结果。
 * @param target 目标。
 */
export function assertTarget(target: ForgetTarget): void {
  if (target.values.length === 0) {
    throw new ForgetRightError('bad-target', '目标为空：至少要给一个 id 或一个主体名')
  }
  for (const value of target.values) {
    if (value.trim() === '') {
      throw new ForgetRightError('bad-target', '目标里有空字符串')
    }
    if (value.length > MAX_VALUE_CHARS) {
      throw new ForgetRightError(
        'bad-target',
        `目标里有一项超过 ${String(MAX_VALUE_CHARS)} 字，看着不像 id 或主体名：${value.slice(0, 20)}…`,
      )
    }
  }
}

/**
 * 造一条面结果。
 * @param surface 面 id。
 * @param status 状态。
 * @param affected 实际动了几条。
 * @param detail 人话说明。
 */
export function outcomeOf(
  surface: SurfaceId,
  status: ScrubStatus,
  affected: number,
  detail: string,
): ScrubOutcome {
  const spec = specOf(surface)
  return Object.freeze({ surface, zh: spec.zh, status, affected, detail })
}

/**
 * 取面说明书。
 * @param surface 面 id。
 */
export function specOf(surface: SurfaceId): SurfaceSpec {
  const found = SURFACE_SPECS.find(spec => spec.id === surface)
  if (found === undefined) throw new ForgetRightError('bad-target', `未知清算面：${surface}`)
  return found
}

/**
 * 完成判定：**只有「该删的都删掉了」才算 complete**。
 *
 * 逐条规则（顺序无关，全部要满足）：
 * 1. 不许有 `failed`；
 * 2. 不许有「本该 `done` 却 `skipped`」——跳过只有在「本来就没东西可删」时才合法；
 * 3. `blind` / `absent` **不影响** `complete`（它们不是失败，是如实的上限），
 *    但会进 `residue`。
 *
 * 第 2 条是这里唯一有争议的一条。取严的理由：一次「删了 9 面、跳过 1 面」的执行，
 * 如果报成 complete，用户就再也不会去看那第 10 面了。
 * @param outcomes 逐面结果。
 * @param expected 本该动的面（计划里 `capability === 'erase'` 且 `targets > 0`）。
 */
export function isComplete(
  outcomes: readonly ScrubOutcome[],
  expected: readonly SurfaceId[],
): boolean {
  for (const outcome of outcomes) {
    if (outcome.status === 'failed') return false
  }
  for (const surface of expected) {
    const found = outcomes.find(outcome => outcome.surface === surface)
    if (found === undefined) return false
    if (found.status !== 'done') return false
  }
  return true
}

/**
 * 残余面：**删不掉的面 + 执行失败的面**。
 *
 * `partial` 也算残余：删了大半不等于删干净了，而「以为删干净」正是本插件要防的事。
 * @param outcomes 逐面结果。
 */
export function residueOf(outcomes: readonly ScrubOutcome[]): readonly SurfaceId[] {
  const out: SurfaceId[] = []
  for (const outcome of outcomes) {
    if (outcome.status === 'blind' || outcome.status === 'failed' || outcome.status === 'partial') {
      out.push(outcome.surface)
    } else if (outcome.status === 'absent') {
      out.push(outcome.surface)
    } else if (outcome.status === 'skipped' && outcome.affected === 0) {
      // 跳过且没动东西：只有「本来就没东西」才算干净，这里无法区分，
      // 故一律不算残余——具体原因写在 `detail`，报告里逐行可见。
      continue
    }
  }
  return Object.freeze(out)
}

/**
 * 一次执行的人话总结。**不报比例、不鼓励**。
 * @param run 执行结果。
 */
export function runSummaryOf(run: Omit<ForgetRun, 'summary'>): string {
  const done = run.outcomes.filter(outcome => outcome.status === 'done').length
  const blind = run.outcomes.filter(outcome => outcome.status === 'blind').length
  const failed = run.outcomes.filter(outcome => outcome.status === 'failed').length
  const parts = [`清了 ${String(done)} 面、共 ${String(run.erasedItems)} 条`]
  if (blind > 0) parts.push(`${String(blind)} 面删不掉（见残余清单）`)
  if (failed > 0) parts.push(`${String(failed)} 面失败`)
  if (run.complete) return `${parts.join('，')}。该删的都删掉了。`
  return `${parts.join('，')}。**还没清干净**，请按残余清单继续处理。`
}

/**
 * 把「这一面该不该在计划里」算出来（`targets > 0` 且能力为 `erase`）。
 * @param scrubs 逐面计划。
 */
export function expectedSurfacesOf(
  scrubs: readonly { readonly surface: SurfaceId; readonly capability: string; readonly targets: number }[],
): readonly SurfaceId[] {
  const out: SurfaceId[] = []
  for (const scrub of scrubs) {
    if (scrub.capability === 'erase' && scrub.targets > 0) out.push(scrub.surface)
  }
  return Object.freeze(out)
}
