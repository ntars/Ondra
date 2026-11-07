/**
 * 主动消息的投递判定（`POST /api/proactive`）。
 *
 * ## 这一层做什么，不做什么
 *
 * | 做 | 不做 |
 * | --- | --- |
 * | 问 `ondra-proactive-gate` 此刻能不能说 | **不自己判**静默时段、额度、冷却 |
 * | 把判定结果翻成界面能用的形状 | 不生成正文（那是内核的事） |
 * | 记账（放行时消耗额度、拒绝时记一次拒绝） | 不装定时器、不主动推送 |
 *
 * ## 为什么判据必须走插件，不能在这里重写一份
 *
 * `ondra-proactive-gate` 是那九道闸的唯一真源：静默时段、深夜窗口、
 * 每日预算、会话冷却、内容红线、令牌桶、熔断退避……任何一条在这里
 * 抄一遍，都会在两处慢慢漂开。漂开的表现是「设置里关掉了深夜不发，
 * 她半夜照样说话」——而代码里两处都写着「已判断」。
 *
 * 插件缺席时**如实说缺席**，不退回「放行」：不知道能不能发的时候，
 * 不发比发出去安全（那条红旗是封号）。
 *
 * ## 为什么是「拉」不是「推」
 *
 * 界面在每次会话稳定后问一次（零常驻，§14.2）。宿主不装定时器：
 * 一个每 60 秒跑一次的定时器在应用没人用的时候照样烧电，而且它无法
 * 知道用户此刻在不在看——那恰恰是打扰预算里最关键的一个变量。
 */

/**
 * 让她开口的临时提示。
 *
 * ## 为什么这几句是这个形状
 *
 * 1. **说「不用回应用户」**。历史里最后一条是她自己的话，模型最容易的
 *    误读是「用户刚才说了那句，我接着答」。主动开口的语义正相反。
 * 2. **给长度上限**。不写上限时模型倾向写三段，而 §7.4 的打扰预算是
 *    「一条」，长了就是一次打扰读了半分钟。
 * 3. **不写人设**。人设由 `persona-*` 那一套注入，这里若再写一遍，
 *    两处人设会互相打架，而症状是「她有时说话像换了个人」。
 * 4. **不改标题、不提系统**。这句话用户看不到，但它会进模型的上下文。
 *    任何「你是 AI 助手」一类元叙述都会污染她说话的口气。
 *
 * 这段文字**不进会话历史**（内核把它当本次运行的临时 system 消息），
 * 所以下次读消息时它不会变成「她每隔一轮都被要求主动开口」。
 */
export const PROACTIVE_NUDGE = [
  '现在没有新消息。请主动开口说一句。',
  '要求：只用一到两句，不超过 40 字；不要复述上文；不要提「主动」「系统」这类词；',
  '像平常聊天那样自然地接着刚才的气氛说，不要提问式地追问对方在不在。',
].join('')

/** 门控服务的最小形状。只声明用到的两项，避免把插件的完整契约抄进来。 */
export interface GateLike {
  readonly available: boolean
  readonly reason?: string
  gate(request: {
    reason: 'active'
    text: string
    conversationId?: string
    idleMinutes?: number
    at?: number
  }, at?: number): {
    readonly allowed: boolean
    readonly action: string
    readonly code: string
    readonly detail: string
    readonly deferMs: number
    readonly budget: {
      readonly quota: number
      readonly used: number
      readonly remaining: number
      readonly silentDays: number
    }
  }
  reportSuccess(at?: number): void
}

/** 判定结果（直接作为响应体）。 */
export interface ProactiveVerdict {
  /** 能不能说。 */
  readonly allow: boolean
  /** 稳定原因码，界面据此决定要不要显示原因（`pass` 不显示）。 */
  readonly code: string
  /**
   * 一句中文说明。
   *
   * 这句会直接进「她主动开口 · {判据}」那一行（§6.4 E），所以必须是
   * **人话**而不是原因码。插件给的 `detail` 就是为此写的，原样透传。
   */
  readonly reason: string
  /** 今日还剩几条。界面用它决定「安静」态（§7.4：连续拒绝 3 次 → 当日停止）。 */
  readonly remaining: number
  /** 今日额度。 */
  readonly quota: number
  /** 今日已用。 */
  readonly used: number
  /** 需要等多久再说（毫秒，`0` = 不用等）。 */
  readonly deferMs: number
  /**
   * 门控本身缺席（插件没装或关掉了）。
   *
   * 与 `allow:false` 分开表达：前者是「这套机制现在不存在」，
   * 后者是「机制在，但此刻不该说」。界面给的话不一样。
   */
  readonly gateMissing: boolean
}

/** 门控缺席时的结论。 */
function missing(detail: string): ProactiveVerdict {
  return Object.freeze({
    allow: false,
    code: 'gate-missing',
    reason: detail,
    remaining: 0,
    quota: 0,
    used: 0,
    deferMs: 0,
    gateMissing: true,
  })
}

/**
 * 判一次「此刻能不能主动开口」。
 *
 * @param gate 门控服务，缺席时传 undefined。
 * @param sessionId 目标会话。冷却按它记，缺了会让同一会话被连着打扰。
 * @param idleMinutes 目标会话已闲置多少分钟。`undefined` = 不知道，
 *   此时插件会放行空闲闸并在说明里写 `unknown`——刻意不按「不知道就拦」，
 *   否则一次字段漏传就变成「她永远不主动」。
 * @param text 准备说的正文。内容闸与去重都看它。
 *   传一句占位（如 `'（主动开口）'`）会让去重闸拿到一个永远相同的串，
 *   于是第一条之后全部判成重复——所以这里必须让调用方给真实的意图描述。
 */
export function checkProactive(
  gate: GateLike | undefined,
  sessionId: string,
  idleMinutes: number | undefined,
  text: string,
): ProactiveVerdict {
  if (gate === undefined) {
    return missing('主动门控没装上：现在不会主动开口')
  }
  if (!gate.available) {
    return missing('主动门控已关闭：现在不会主动开口')
  }

  try {
    const verdict = gate.gate({
      reason: 'active',
      text,
      ...(sessionId === '' ? {} : { conversationId: sessionId }),
      ...(idleMinutes === undefined ? {} : { idleMinutes }),
    })
    return Object.freeze({
      allow: verdict.allowed,
      code: verdict.code,
      reason: verdict.detail,
      remaining: verdict.budget.remaining,
      quota: verdict.budget.quota,
      used: verdict.budget.used,
      deferMs: verdict.deferMs,
      gateMissing: false,
    })
  } catch (error) {
    // 判定抛错说明插件有 bug。按「不发」处理并如实说明，
    // 不复用 `missing`：那样会把「插件坏了」说成「插件没装」。
    return Object.freeze({
      allow: false,
      code: 'gate-error',
      reason: `主动门控判错了一下：${error instanceof Error ? error.message : String(error)}`,
      remaining: 0,
      quota: 0,
      used: 0,
      deferMs: 0,
      gateMissing: false,
    })
  }
}

/**
 * 撤回一次主动开口（§6.4 E 的「这次不用」）。
 *
 * ## 为什么只是 `reportSuccess()`
 *
 * 额度的记账发生在 `gate()` 放行的那一刻（插件内部 `commit`）：放行即
 * 「这句话已经说出去了」，从那一刻起当天剩余额度就少了一条。用户点
 * 「这次不用」时，正确的语义是**退回那条额度**，而插件没有 minus 操作。
 *
 * 于是这里做的是唯一诚实的事：不去伪造一个「没说过」，而是把这次
 * 接触记为一次**成功**（清掉可能存在的退避与失败计数）。额度仍消耗，
 * 因为额度防的是「一天说了太多句」，而这一句确实已经被用户看见了——
 * 它已经构成了打扰。少算它会让「连点三次这次不用」变成三次白说的机会。
 *
 * 连续拒绝 3 次 → 当日停止（§7.4）由界面侧计数实现，不在这里伪造。
 *
 * @param gate 门控服务。
 */
export function declineProactive(gate: GateLike | undefined): void {
  if (gate === undefined || !gate.available) return
  try {
    gate.reportSuccess()
  } catch {
    // 撤回是用户的清理动作，它失败不该反过来打扰用户。
  }
}
