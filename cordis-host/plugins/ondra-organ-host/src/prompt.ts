/**
 * 提示词片段拼装（手册 §8.1「各器官申报片段带 `order / ttl / confidence`，
 * 按 order 排序、过滤过期与低置信度；**疤痕永远在 -1e4，器官不得低于 -1000**」）。
 *
 * ## 三条硬规则与它们各自防的事故
 *
 * 1. **`kind:'scar'` 的 `order` 由宿主强制成 -1e4，不看申报值。** 疤痕是「她被怎样
 *    对待过」的沉淀，位置必须在最前——让器官自己申报就等于让「谁先注册」决定
 *    「谁的伤口更疼」。`forced:true` 记下这件事，界面上能看见「这一段被改过序」。
 * 2. **非疤痕片段的 `order` 低于 -1000 → 拒收，不夹紧。** 夹紧会让作者以为
 *    「我设的 -5000 生效了，只是被调成 -1000」，而实际位置差一个数量级。
 *    拒收 + 明确理由（`order-reserved`）才有办法修。
 * 3. **过期与低置信度都要「可数」。** 「没注入」与「没申报」在界面上同形，
 *    但一个是器官的问题、一个是配置的问题。所以 `dropped` 带原因码。
 *
 * ## 排序键相同时怎么办
 *
 * 按 `(order, id)` 二级排序，`id` 用**码位比较**而不是 `localeCompare`：
 * 后者依赖运行环境的 locale，同一份片段在两台机器上可能排不同顺序，
 * 而顺序变化会让前缀缓存整段失效（§8.5）。
 */

import type {
  DroppedFragment,
  FragmentDropReason,
  OrganPromptDraft,
  OrganPromptSpec,
  PromptFragment,
} from './types.js'
import { KEY_RE, MAX_ORDER, MIN_ORGAN_ORDER, SCAR_ORDER } from './types.js'

/** 一个器官在本次拼装里申报的草稿（带归属）。 */
export interface AttributedDraft {
  readonly organId: string
  readonly spec?: OrganPromptSpec
  readonly draft: OrganPromptDraft
}

/** 拼装输入。 */
export interface AssembleInput {
  /** 全部草稿。 */
  readonly drafts: readonly AttributedDraft[]
  /** 拼装时刻。 */
  readonly at: number
  /** 最低置信度。 */
  readonly minConfidence: number
  /** 最多采纳几片。 */
  readonly maxFragments: number
  /** 单片最大码位数。 */
  readonly maxCharsPerFragment: number
  /** 已申报但取草稿时抛错的器官（算 `provider-error`）。 */
  readonly failedProviders?: readonly string[]
}

/** 拼装输出。 */
export interface AssembleOutput {
  readonly fragments: readonly PromptFragment[]
  readonly dropped: readonly DroppedFragment[]
  readonly text: string
  readonly chars: number
}

/**
 * 按码位数字符串长度（不按 UTF-16 单元）。
 *
 * `'🐱'.length === 2`，用 `length` 判 2000 字上限会让 emoji 多的片段被提前砍掉
 * 一半预算。而截断本身是禁止的（见 `maxCharsPerFragment` 的说明），所以这里
 * 只用来**判超限**，不用来切片。
 * @param text 正文。
 */
export function charCount(text: string): number {
  let count = 0
  for (const _ of text) {
    count += 1
    void _
  }
  return count
}

/**
 * 码位比较（确定性排序，不依赖 locale）。
 * @param a 左。
 * @param b 右。
 */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * 取一片的有效 `order`，并判定是否进了保留区。
 * @param draft 草稿。
 * @param spec 清单里的默认策略。
 * @returns `value` 生效值；`rejected` 为真表示必须拒收。
 */
function resolveOrder(
  draft: OrganPromptDraft,
  spec: OrganPromptSpec | undefined,
): { readonly value: number; readonly rejected: boolean; readonly forced: boolean } {
  // 疤痕恒 -1e4：不看申报值，也不看默认值。
  if (draft.kind === 'scar') return { value: SCAR_ORDER, rejected: false, forced: true }

  const raw = draft.order !== undefined ? draft.order : spec?.order
  if (raw === undefined) return { value: 0, rejected: false, forced: false }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { value: 0, rejected: true, forced: false }
  if (raw < MIN_ORGAN_ORDER || raw > MAX_ORDER) return { value: raw, rejected: true, forced: false }
  return { value: raw, rejected: false, forced: false }
}

/**
 * 取一片的有效 `ttlMs`。
 * @param draft 草稿。
 * @param spec 清单里的默认策略。
 */
function resolveTtl(draft: OrganPromptDraft, spec: OrganPromptSpec | undefined): number | undefined {
  const raw = draft.ttlMs !== undefined ? draft.ttlMs : spec?.ttlMs
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  return raw
}

/**
 * 取一片的有效置信度。
 * @param draft 草稿。
 * @param spec 清单里的默认策略。
 */
function resolveConfidence(draft: OrganPromptDraft, spec: OrganPromptSpec | undefined): number {
  const raw = draft.confidence !== undefined ? draft.confidence : spec?.confidence
  if (raw === undefined || typeof raw !== 'number' || !Number.isFinite(raw)) return 0.5
  return Math.min(1, Math.max(0, raw))
}

/**
 * 拼装。**纯函数**：无 IO、无定时器、无状态（每次组装提示词都会被调用，
 * 手册 §8.2 反模式② 说的就是这件事）。
 * @param input 输入。
 */
export function assemble(input: AssembleInput): AssembleOutput {
  const fragments: PromptFragment[] = []
  const dropped: DroppedFragment[] = []
  const seen = new Set<string>()

  /**
   * 记一条丢弃。`detail` 必须是「能拿去修」的信息，不能只说「不合法」。
   */
  const drop = (id: string, organId: string, reason: FragmentDropReason, detail: string): void => {
    dropped.push({ id, organId, reason, detail })
  }

  // 取草稿阶段就抛错的器官：先记一条，避免「它明明在但什么都没出」。
  for (const organId of input.failedProviders ?? []) {
    drop(organId + ':provider', organId, 'provider-error', '取片段时抛错（C3 已吞掉），本次一片都不注入')
  }

  for (const item of input.drafts) {
    const draft = item.draft
    const id =
      typeof draft.id === 'string' && draft.id !== ''
        ? draft.id
        : item.organId + ':' + String(fragments.length + dropped.length)

    const text = typeof draft.text === 'string' ? draft.text : ''
    if (text.trim() === '') {
      drop(id, item.organId, 'empty-text', '正文是空白：空白注入等于占预算')
      continue
    }

    const chars = charCount(text)
    if (chars > input.maxCharsPerFragment) {
      // 不截断：截断出来的半句话比整片不要更难查（语义断了但看起来像正常内容）。
      drop(
        id,
        item.organId,
        'too-long',
        '正文 ' + String(chars) + ' 字，超过单片上限 ' + String(input.maxCharsPerFragment) + '：整片拒收',
      )
      continue
    }

    if (seen.has(id)) {
      drop(id, item.organId, 'duplicate', '同一轮里出现两次同 id：只留第一片')
      continue
    }

    const order = resolveOrder(draft, item.spec)
    if (order.rejected) {
      const why =
        order.value < MIN_ORGAN_ORDER
          ? 'order ' + String(order.value) + ' 落在疤痕保留区（下限 ' + String(MIN_ORGAN_ORDER) + '）'
          : 'order ' + String(order.value) + ' 超出上限 ' + String(MAX_ORDER)
      drop(id, item.organId, order.value < MIN_ORGAN_ORDER ? 'order-reserved' : 'order-out-of-range', why)
      continue
    }

    const confidence = resolveConfidence(draft, item.spec)
    if (confidence < input.minConfidence) {
      drop(
        id,
        item.organId,
        'low-confidence',
        '置信度 ' + confidence.toFixed(2) + ' 低于门槛 ' + input.minConfidence.toFixed(2),
      )
      continue
    }

    const at = typeof draft.at === 'number' && Number.isFinite(draft.at) ? draft.at : input.at
    const ttl = resolveTtl(draft, item.spec)
    if (ttl !== undefined && input.at - at >= ttl) {
      drop(
        id,
        item.organId,
        'expired',
        '已存活 ' + String(Math.max(0, input.at - at)) + 'ms，超过 ttl ' + String(ttl) + 'ms',
      )
      continue
    }

    seen.add(id)
    fragments.push({
      id,
      organId: item.organId,
      text,
      order: order.value,
      confidence,
      kind: draft.kind ?? 'note',
      at,
      forced: order.forced,
    })
  }

  // 排序：order 升序 → id 码位升序（确定性，跨机器一致）。
  fragments.sort((a, b) => (a.order !== b.order ? a.order - b.order : compareCodePoints(a.id, b.id)))

  // 超量：按排序后的顺序取前 N，其余的记 `over-limit`。
  const kept: PromptFragment[] = []
  for (let i = 0; i < fragments.length; i += 1) {
    const item = fragments[i]
    if (i < input.maxFragments) {
      kept.push(item)
    } else {
      drop(item.id, item.organId, 'over-limit', '排在第 ' + String(i + 1) + ' 位，超过本轮上限 ' + String(input.maxFragments))
    }
  }

  const body = kept.map(item => item.text).join('\n')
  return {
    fragments: Object.freeze(kept),
    dropped: Object.freeze(dropped),
    text: body,
    chars: charCount(body),
  }
}

/**
 * 校验一个片段 id 是否符合 §8.4（器官给的稳定 id 会被用作去重键）。
 * @param id 片段 id。
 */
export function isValidFragmentId(id: string): boolean {
  return KEY_RE.test(id)
}
