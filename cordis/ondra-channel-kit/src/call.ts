/**
 * 问一次人格：**走对话链，不自己拼提示词**。
 *
 * ## 为什么必须走 O-033
 *
 * 老做法是「拿人格 `buildPrompt()` + 网关流式」，看起来少一跳，实际是把
 * 对话链的三件事重做一遍：冻结前缀、历史提交、收尾判定。真做了就会有
 * 两条对话通路，而它们的差异只会在很晚才暴露——比如通道里那几句
 * 进了历史、主界面那几句没进，于是「她在两个地方记得的事不一样」。
 *
 * ## 为什么超时用 `abort()` 而不是 `Promise.race`
 *
 * `race` 只是「不再等」，请求还在跑、token 还在烧，且那一轮仍会写进历史。
 * `abort()` 是对话链自己的取消语义：本轮以 `aborted` 结束、**整轮不写入历史**。
 * 这才是「真的停下来了」。
 *
 * ## 为什么失败也要把半截正文带出去
 *
 * 不带的话，日志里只剩一句「timeout」，没人知道她刚才说到哪、是不是
 * 模型在胡言乱语。带出去但**不给调用方发**——`ok=false` 就是那句提醒。
 */

import type { CallFailure, CallInput, CallResult, DialogueLike, LogLike } from './types.js'
import { FAILURE_ZH, toConversationId } from './types.js'
import { chunkText } from './chunk.js'
import type { Config } from './settings.js'
import { CALL_TIMEOUT_CEIL, CALL_TIMEOUT_FLOOR } from './settings.js'

/** 构造依赖。 */
export interface CallDeps {
  /** 已补全的配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 现取对话链（每次现取，晚装载能自愈）。 */
  readonly dialogue: () => DialogueLike | undefined
}

/**
 * 给句柄调 `unref`，别让一个定时器把进程钉住。
 *
 * 用「探测再 `call`」而不是直接 `handle.unref()`：浏览器/Worker 里
 * `setTimeout` 返回的是数字，直接调会抛 `TypeError`。
 * @param handle `setTimeout` 的返回值。
 */
function unref(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null) return
  const fn = (handle as { unref?: unknown }).unref
  if (typeof fn === 'function') fn.call(handle)
}

/**
 * 夹超时。
 * @param value 请求里给的值。
 * @param fallback 配置值。
 */
export function clampTimeout(value: unknown, fallback: number): number {
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(CALL_TIMEOUT_CEIL, Math.max(CALL_TIMEOUT_FLOOR, base))
}

/**
 * 造一份结果。
 * @param text 正文。
 * @param failure 失败原因（成功时不传）。
 * @param partial 是否不完整。
 * @param maxChars 平台上限（可选）。
 */
function make(text: string, failure: CallFailure | undefined, partial: boolean, maxChars?: number): CallResult {
  const pieces =
    typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0 && text !== ''
      ? chunkText(text, maxChars).pieces
      : text === ''
        ? []
        : [text]

  return Object.freeze({
    ok: failure === undefined,
    text,
    chars: text.length,
    pieces: Object.freeze(pieces) as readonly string[],
    failure,
    partial,
    reason: failure === undefined ? undefined : FAILURE_ZH[failure],
  })
}

/**
 * 问一次人格。**永不抛出**——所有异常都折成 `CallResult`。
 * @param deps 依赖。
 * @param input 入参。
 */
export async function callPersona(deps: CallDeps, input: CallInput): Promise<CallResult> {
  const maxChars = input.maxChars

  if (!deps.settings.enable) return make('', 'disabled', false, maxChars)

  const dialogue = deps.dialogue()
  if (dialogue === undefined) return make('', 'no-dialogue', false, maxChars)

  const conversationId = toConversationId(input.conversationId)

  // 开会话（幂等：同 id 已存在时原样返回，**不重拼前缀**）。
  // 失败不阻断——`turn()` 自己也会开会话，这一步只是为了把 id 定下来。
  try {
    dialogue.begin({ id: conversationId })
  } catch (error) {
    deps.log.debug?.(
      '开会话 %s 失败（继续跑这一轮）：%s',
      conversationId,
      error instanceof Error ? error.message : String(error),
    )
  }

  const timeoutMs = clampTimeout(input.timeoutMs, deps.settings.callTimeoutMs)
  let text = ''
  let stopReason = 'stop'
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    try {
      dialogue.abort(conversationId)
    } catch {
      // 取消失败不影响结果判定：超时这件事已经发生了。
    }
  }, timeoutMs)
  unref(timer)

  try {
    for await (const frame of dialogue.turn({
      text: input.text,
      conversationId,
      signal: input.signal,
    })) {
      if (frame.type === 'text-delta' && typeof frame.delta === 'string') {
        text += frame.delta
      } else if (frame.type === 'text-replace' && typeof frame.text === 'string') {
        // 整段替换帧（O-037 的收尾闸会用它）。**必须覆盖**，不能累加，
        // 否则屏幕上与日志里都会出现「同一句话两遍」。
        text = frame.text
      } else if (frame.type === 'done' && typeof frame.stopReason === 'string') {
        stopReason = frame.stopReason
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    deps.log.warn('对话链报错（会话 %s）：%s', conversationId, detail)
    return make(text, 'error', text.length > 0, maxChars)
  } finally {
    clearTimeout(timer)
  }

  let failure: CallFailure | undefined
  if (input.signal?.aborted === true) failure = 'aborted'
  else if (timedOut) failure = 'timeout'
  else if (stopReason === 'error') failure = 'error'
  else if (stopReason === 'aborted') failure = 'aborted'
  else if (text.trim() === '') failure = 'empty'

  if (failure === 'timeout') {
    deps.log.warn('会话 %s 这一轮超时（%dms），已中止；已收到 %d 字', conversationId, timeoutMs, text.length)
  }

  const partial =
    failure === undefined ? stopReason === 'length' : failure !== 'empty' && text.length > 0

  return make(text, failure, partial, maxChars)
}
