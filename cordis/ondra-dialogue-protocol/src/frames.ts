/**
 * 帧的**纯判定**：不碰 ctx、不碰状态、不读写文件。
 *
 * 拆出来单独一个文件，是为了让 O-033（对话链）能在 `ctx.get` 缺席时
 * 用同一份判定做自检，而不必把 service 整个构造出来。
 * 这也是本仓一贯的分层：types（契约）→ 纯算/纯判 → service（门面）→ index（接线）。
 */

import {
  CRISIS_LABELS,
  FRAME_TYPES,
  STOP_REASONS,
} from './types.js'
import type {
  CrisisLabel,
  FrameIssueCode,
  FrameType,
  StopReason,
  ValidateResult,
} from './types.js'

/** 判空对象（不含数组——数组不是「对象」在这里的语义）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 是不是已知帧类型。
 *
 * `includes` 对 `readonly FrameType[]` 需要放宽参数类型；这里显式写
 * `as readonly string[]` 而不是把列表改成 `string[]`——**列表本身要保持窄**，
 * 放宽只发生在这一次比较上。
 * @param value 待判定的值。
 */
export function isFrameType(value: unknown): value is FrameType {
  return typeof value === 'string' && (FRAME_TYPES as readonly string[]).includes(value)
}

/** 是不是已知结束原因。 */
export function isStopReason(value: unknown): value is StopReason {
  return typeof value === 'string' && (STOP_REASONS as readonly string[]).includes(value)
}

/** 是不是已知危机标签。 */
export function isCrisisLabel(value: unknown): value is CrisisLabel {
  return typeof value === 'string' && (CRISIS_LABELS as readonly string[]).includes(value)
}

/**
 * 序号合法性：**≥1 的整数**。
 *
 * 从 1 起而不是 0：`0` 在布尔判断里是假值，任何一处 `if (frame.seq)` 都会
 * 把第一帧吞掉，而且这种 bug 只在「只有一帧」的极短回复里出现，最难复现。
 * @param value 待判定的值。
 */
function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** token 计数合法性：非负有限数（允许 0，上游在极短请求里会给 0）。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 造一个失败结果。 */
function invalid(reason: FrameIssueCode, detail: string): ValidateResult {
  return { ok: false, reason, detail }
}

/**
 * 校验一个未知值是不是合法帧。**纯函数**，同样的输入永远同样的输出。
 *
 * 只校验**单帧结构**，不校验跨帧纪律（终态之后不能再写、usage 只能一次）。
 * 跨帧纪律需要状态，那是 `writer.ts` 的职责——把两者混在一个函数里，
 * 就会有人拿它去做流式校验，而单帧校验天然看不出「写了两帧 done」。
 * @param value 待校验的值。
 */
export function validateFrame(value: unknown): ValidateResult {
  if (!isRecord(value)) return invalid('not-object', '帧不是对象')
  const seq = value['seq']
  if (!isSeq(seq)) return invalid('bad-seq', 'seq 必须是 ≥1 的整数')
  const type = value['type']
  if (!isFrameType(type)) return invalid('unknown-type', 'type 不是五种已知帧之一')

  switch (type) {
    case 'text-delta': {
      const delta = value['delta']
      if (typeof delta !== 'string') return invalid('bad-text', 'delta 必须是字符串')
      return { ok: true, frame: { type, seq, delta } }
    }
    case 'text-replace': {
      const text = value['text']
      if (typeof text !== 'string') return invalid('bad-text', 'text 必须是字符串')
      return { ok: true, frame: { type, seq, text } }
    }
    case 'crisis': {
      const label = value['kindLabel']
      if (!isCrisisLabel(label)) return invalid('bad-label', 'kindLabel 不是三个已知值之一')
      return { ok: true, frame: { type, seq, kindLabel: label } }
    }
    case 'usage': {
      const inputTokens = value['inputTokens']
      const outputTokens = value['outputTokens']
      if (!isCount(inputTokens)) return invalid('bad-tokens', 'inputTokens 必须是非负有限数')
      if (!isCount(outputTokens)) return invalid('bad-tokens', 'outputTokens 必须是非负有限数')
      return { ok: true, frame: { type, seq, inputTokens, outputTokens } }
    }
    case 'done': {
      const stopReason = value['stopReason']
      if (!isStopReason(stopReason)) return invalid('bad-stop-reason', 'stopReason 不是四个已知值之一')
      return { ok: true, frame: { type, seq, stopReason } }
    }
    default: {
      // 理论上不可达：`isFrameType` 已经把五种之外全挡掉了。
      // 但 switch 需要一个兜底分支才不会在加第六种帧时静默返回 undefined。
      // 这里刻意不写 `never` 断言——加帧时希望它编译报错，而不是运行期落空。
      return invalid('unknown-type', '未处理的帧类型')
    }
  }
}

/**
 * 把上游的 `finish.reason.kind` 映射成四值闭集。
 *
 * 映射规则（**这是全仓唯一一份**，O-033 只消费不重写）：
 * - `stop` → `stop`
 * - `max-tokens` → `length`（命中输出上限，界面上必须与「说完了」区分开）
 * - `aborted` → `aborted`
 * - `error` → `error`
 * - `tool-calls` → `stop`（本产品一轮对话不落工具态；硬映射成 `stop` 而不是
 *   新增第五个值，因为界面对未知值只能是「静默按 stop 处理」，多一个值等于多一处分支）
 * - 其它未知值 → `stop`，由调用方记一条日志
 *
 * 反向映射（`length` → `max-tokens`）不存在：本插件不构造上游参数。
 * @param kind 上游结束原因。
 */
export function stopReasonOf(kind: string | undefined): StopReason {
  switch (kind) {
    case 'max-tokens':
      return 'length'
    case 'aborted':
      return 'aborted'
    case 'error':
      return 'error'
    default:
      return 'stop'
  }
}

/**
 * 把计数夹成合法值。
 *
 * 上游在异常路径上可能给 `NaN` / 负数（协议里没有，但适配器实现里出现过）。
 * 夹到 0 而不是抛错：用量统计少记一次，比因为统计把流打断要好。
 * @param value 原始值。
 */
export function clampCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}
