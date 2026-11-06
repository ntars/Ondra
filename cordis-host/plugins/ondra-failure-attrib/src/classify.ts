/**
 * 八类归因的**判定表**。纯函数，不读配置、不记账、不碰 ctx。
 *
 * ## 判定顺序就是接口
 *
 * 先看上游给的 `error.info.code`（结构化、可靠），再看 `error.message`（文本、易变）。
 * 这个顺序不能反：文本匹配是启发式，一旦让它先跑，`UNKNOWN_TOOL` 那句
 * `unknown tool "foo"` 会被「not found」类抢走，归因就变成了 `not_found`——
 * 而这两类的处方完全不同（一个是「缺件要装」，一个是「路径写错了」）。
 *
 * ## 为什么不用 `info.name`
 *
 * `info.name` 是错误**类名**（`ToolNotFoundError` / `HarnessError`…），随重构改名；
 * `info.code` 是**协议码**（`UNKNOWN_TOOL` / `INVALID_TOOL_OUTPUT`），上游文档把它
 * 写成「internal error class/code used by policy and durable diagnostics」，
 * 是给策略层用的那一层。归因读协议码，不读类名。
 *
 * ## 文本匹配的三个已知偏差（写在 README「已知限制」里）
 *
 * 1. 一条消息同时像两类时，按下面的顺序取第一个——顺序是**取舍**，不是真理。
 * 2. 中文关键词按子串，英文按词边界（`read` 不该命中 `already` 那类问题）。
 * 3. 完全不像任何一类就落 `unknown`，**不硬猜**。`unknown` 的处方是「只试一次」，
 *    代价小；猜错成 `timeout` 会让一个真错被反复重试。
 */

import type { Attribution, Cause, FailureInput } from './types.js'

/** 消息文本最多看多少码位（正则不跑在长文上）。 */
const MESSAGE_SCAN_CHARS = 2_000

/** 一条文本判据。 */
interface TextRule {
  readonly cause: Cause
  /** 判据 id，进 `matched`。 */
  readonly id: string
  readonly pattern: RegExp
}

/**
 * 文本判据表。**顺序即优先级。**
 *
 * 排序依据：越「具体」的越靠前。`timeout` 放在 `network` 之前，因为
 * `ETIMEDOUT` 两个都像，而超时的处方是「退避重试」、网络也是——所以这一对
 * 排错也不改变行为；真正要排对的是 `arg_error` 与 `not_found`：
 * 「参数里写的路径不存在」应当归 `not_found`（改路径），不是 `arg_error`（改参数）。
 */
const TEXT_RULES: readonly TextRule[] = Object.freeze([
  Object.freeze({
    cause: 'permission' as Cause,
    id: 'msg:permission',
    pattern: /permission|denied|forbidden|unauthorized|not allowed|EACCES|EPERM|权限|拒绝访问|无权/i,
  }),
  Object.freeze({
    cause: 'timeout' as Cause,
    id: 'msg:timeout',
    pattern: /timeout|timed out|ETIMEDOUT|deadline exceeded|超时|响应超时/i,
  }),
  Object.freeze({
    cause: 'not_found' as Cause,
    id: 'msg:not_found',
    pattern: /ENOENT|no such file|not found|does not exist|no longer exists|找不到|不存在|没有这个文件/i,
  }),
  Object.freeze({
    cause: 'conflict' as Cause,
    id: 'msg:conflict',
    pattern: /EEXIST|already exists|conflict|locked|occupied|stale|冲突|已存在|被占用|不一致/i,
  }),
  Object.freeze({
    cause: 'network' as Cause,
    id: 'msg:network',
    pattern: /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket|network|DNS|网络|连接失败|断网|连不上/i,
  }),
  Object.freeze({
    cause: 'arg_error' as Cause,
    id: 'msg:arg_error',
    pattern: /invalid argument|arguments? (is|are) invalid|missing required|required property|schema validation|参数|缺少必填|类型不匹配|格式不对/i,
  }),
])

/** 协议码判据表。**顺序即优先级。** */
const CODE_RULES: readonly { readonly cause: Cause; readonly id: string; readonly code: string }[] =
  Object.freeze([
    Object.freeze({ cause: 'tool_missing' as Cause, id: 'code:UNKNOWN_TOOL', code: 'UNKNOWN_TOOL' }),
    // 工具返回的值不合它自己声明的输出契约——这是**两方不一致**，不是参数写错。
    Object.freeze({ cause: 'conflict' as Cause, id: 'code:INVALID_TOOL_OUTPUT', code: 'INVALID_TOOL_OUTPUT' }),
  ])

/**
 * 把 code 归一到大写，便于比对。
 * @param code 原始 code。
 */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase()
}

/**
 * 归因。**纯函数，永不抛错。**
 * @param input 失败输入。
 */
export function classify(input: FailureInput): Attribution {
  const tool = input.tool
  const code = typeof input.code === 'string' && input.code.trim() !== '' ? input.code : undefined

  if (code !== undefined) {
    const upper = normalizeCode(code)
    for (const rule of CODE_RULES) {
      if (upper === rule.code) {
        return Object.freeze({
          tool,
          cause: rule.cause,
          matched: rule.id,
          detail: '按协议码 ' + rule.code + ' 归为 ' + rule.cause,
          code,
        })
      }
    }
    // 取消不是故障：用户点了停、或回合被中断。归 unknown，处方是「不重试」。
    if (upper === 'ABORTED' || upper === 'ABORTED_BEFORE_DISPATCH') {
      return Object.freeze({
        tool,
        cause: 'unknown' as Cause,
        matched: 'code:ABORTED',
        detail: '调用被取消（' + upper + '）：不是故障，不重试',
        code,
      })
    }
  }

  const raw = typeof input.message === 'string' ? input.message : ''
  const text = raw.length > MESSAGE_SCAN_CHARS ? raw.slice(0, MESSAGE_SCAN_CHARS) : raw
  if (text !== '') {
    for (const rule of TEXT_RULES) {
      if (rule.pattern.test(text)) {
        return Object.freeze({
          tool,
          cause: rule.cause,
          matched: rule.id,
          detail: '按失败文本归为 ' + rule.cause,
          code,
        })
      }
    }
  }

  return Object.freeze({
    tool,
    cause: 'unknown' as Cause,
    matched: 'fallback',
    detail: code === undefined ? '没有协议码也没有可识别的文本：归 unknown' : '协议码 ' + code + ' 未收录：归 unknown',
    code,
  })
}
