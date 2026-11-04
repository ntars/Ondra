/**
 * 事件接线：把护栏挂到宿主的两个瀑布上。
 *
 * ```
 * tools/pre-execute   → 拦红线工具与危险目标（allow / deny）
 * tools/post-execute  → 裁超长结果（accept + 新的 content）
 * ```
 *
 * ## 三条接线纪律
 *
 * 1. **永远调用 `next()`**（除非明确拒绝）。瀑布是链式的，漏掉一次调用
 *    就把后面所有监听器一起断了——别的插件的超时包装、审计、权限门都会静默失效。
 * 2. **处理器永不抛错**。异常在瀑布里会变成「这次工具调用失败」，
 *    而本包的错不该有机会影响用户点按钮。
 * 3. **上游决策优先**。`post-execute` 里先 `await next()`，只在它返回 `accept`
 *    且带正文时才替换正文；它说 `block` 就原样返回，不自作主张。
 *
 * ## 为什么参数类型是 `unknown`
 *
 * 本包不 import 工具包（理由见 `types.ts` 文件头）。签名由 `HookTarget` 描述成
 * 三个 `unknown`，处理器内部用 `isRecord` / `typeof === 'function'` 逐个收窄。
 * 代价是「上游改签名后要手工同步」，收益是「不装那个包也能挂上」。
 */

import type { Config } from './settings.js'
import { isRecord } from './settings.js'
import type { HookTarget, LogLike, TrimResult } from './types.js'
import { judgeTool } from './policy.js'
import { trimText } from './trim.js'

/** 计数回调（由服务实现，hooks 不持有计数状态）。 */
export interface HookReporter {
  /** 见过一次浏览器工具调用。 */
  seen(): void
  /** 放行了一次。 */
  allowed(): void
  /** 拒绝了一次。 */
  denied(code: string): void
  /** 裁剪了一次。 */
  trimmed(result: TrimResult): void
}

/** 接线结果。 */
export interface HookHandles {
  /** 撤除两个监听（幂等）。 */
  dispose(): void
  /** 哪几个真的挂上了。 */
  attached(): { readonly pre: boolean; readonly post: boolean }
}

/**
 * 取一个字符串字段。
 * @param node 对象。
 * @param key 键。
 */
function stringOf(node: Readonly<Record<string, unknown>>, key: string): string {
  const value = node[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 调 `next()` 并把它可能抛出的异常折成 `undefined`。
 * @param next 上游的下一步。
 */
async function callNext(next: unknown): Promise<unknown> {
  if (typeof next !== 'function') return undefined
  try {
    return await (next as () => unknown)()
  } catch {
    return undefined
  }
}

/**
 * 挂上两个瀑布。
 * @param target 事件源（通常是 `ctx`）。
 * @param settings 配置。
 * @param log 日志。
 * @param reporter 计数回调。
 */
export function installHooks(
  target: HookTarget,
  settings: Config,
  log: LogLike,
  reporter: HookReporter,
): HookHandles {
  const disposers: (() => void)[] = []
  let pre = false
  let post = false

  /** pre-execute：先判名字与目标。 */
  const onPre = async (exec: unknown, next: unknown): Promise<unknown> => {
    try {
      if (!isRecord(exec)) return await callNext(next)
      const name = stringOf(exec, 'name')
      if (name === '') return await callNext(next)

      const verdict = judgeTool(name, exec['arguments'], settings)
      if (verdict.kind === 'skip') return await callNext(next)

      reporter.seen()
      if (verdict.kind === 'deny') {
        reporter.denied(verdict.code)
        if (settings.verbose) log.info('拦下浏览器工具 %s（%s）', name, verdict.code)
        return Object.freeze({ kind: 'deny' as const, reason: verdict.reason })
      }
      reporter.allowed()
      return await callNext(next)
    } catch (error) {
      // 护栏自己出错时放行：拦错的代价（浏览器突然不能用）比漏一次的代价更贵。
      log.warn('浏览器护栏判定抛错，本次放行：%s', error instanceof Error ? error.message : String(error))
      return await callNext(next)
    }
  }

  /** post-execute：先让上游定，再裁它的正文。 */
  const onPost = async (exec: unknown, _result: unknown, next: unknown): Promise<unknown> => {
    try {
      const decision = await callNext(next)
      if (!isRecord(decision)) return decision
      if (decision['kind'] !== 'accept') return decision
      if (!isRecord(exec)) return decision

      const name = stringOf(exec, 'name')
      if (name === '') return decision

      // 只裁浏览器工具：别的插件的输出有自己的预算（O-036 / O-070 各管一段）。
      const verdict = judgeTool(name, exec['arguments'], settings)
      if (verdict.kind === 'skip') return decision

      const content = decision['content']
      if (!Array.isArray(content)) return decision

      let changed = false
      let last: TrimResult | null = null
      const rebuilt: unknown[] = []
      for (const block of content) {
        if (!isRecord(block) || block['type'] !== 'text') {
          rebuilt.push(block)
          continue
        }
        const text = block['text']
        if (typeof text !== 'string') {
          rebuilt.push(block)
          continue
        }
        const result = trimText(text, 'snapshot', settings.trimChars, settings.trimLines)
        if (!result.trimmed) {
          rebuilt.push(block)
          continue
        }
        changed = true
        last = result
        rebuilt.push({ ...block, text: result.text })
      }

      if (!changed) return decision
      if (last !== null) {
        reporter.trimmed(last)
        if (settings.verbose) log.info('裁掉浏览器结果：%d → %d 字符（%s）', last.before, last.after, name)
      }
      return { ...decision, content: rebuilt }
    } catch (error) {
      log.warn('浏览器结果裁剪抛错，原样放行：%s', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  // 一次挂一个，分别记录成败：一个挂不上不该连累另一个。
  try {
    disposers.push(target.on('tools/pre-execute', onPre))
    pre = true
  } catch (error) {
    log.warn(
      '挂 tools/pre-execute 失败（护栏不生效，浏览器照常可用）：%s',
      error instanceof Error ? error.message : String(error),
    )
  }
  try {
    disposers.push(target.on('tools/post-execute', onPost))
    post = true
  } catch (error) {
    log.warn('挂 tools/post-execute 失败（结果不裁剪）：%s', error instanceof Error ? error.message : String(error))
  }

  return {
    dispose() {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // 撤除失败无害：宿主卸载插件时会整体回收。
        }
      }
      disposers.length = 0
    },
    attached() {
      return { pre, post }
    },
  }
}
