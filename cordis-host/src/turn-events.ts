/**
 * 把「一轮真实对话」送进插件事件总线（`session/event`）。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-memory-intake` 订阅 `session/event`，靠 `user/message` /
 * `assistant/message` 攒轮次草稿、靠 `turn/end` 收尾落盘。这三个名字
 * 在整仓里**只有订阅方，没有任何发出方**：
 *
 * ```
 * 用户说「明天提醒我打印合同」
 *   → 内核生成回复（宿主只知道 delta/done）
 *   → （空）            ← 断在这里
 *   → 待办表空 → 话由源空 → 她主动开口时没有任何由头
 * ```
 *
 * 症状不是报错，是**六张表从建库起一直是 0 行**：`memory_raw`、
 * `memory_fact`、`memory_promise`、`working_todo`、`drive_gap`、
 * `emotion_state`。而所有单元级检查都绿——它们各自直接调 `intake.ingest()`，
 * 绕过了「谁触发」这一环。这正是本仓反复踩的形态：A 写、B 读、中间少根线。
 *
 * ## 为什么由宿主发，而不是让插件自己去问内核
 *
 * | 候选 | 为什么不行 |
 * | --- | --- |
 * | 插件订阅内核事件 | 插件拿不到内核客户端（那是宿主独占的 RPC 通道），硬塞会把传输层依赖带进插件 |
 * | 插件定时拉 `/api/sessions/:id/messages` | 落成常驻轮询，违反 §14.2 零常驻；且要自己判「哪几条是新的」 |
 * | **宿主在推理结束时发** | 宿主此刻手里同时握着**真实入参**与**真实产出**，不需要再猜 |
 *
 * 选第三条还有一个更硬的理由：`/api/sessions/:id/messages` 读回来的历史
 * 与新消息混在一起，宿主得自己维护游标去重；而这两个值它刚刚才用过，
 * 直接发出去是零推断。
 *
 * ## 为什么只在「用户真说了话」的轮次发
 *
 * 主动开口（`proactive`）那一轮 `input` 为空，只有她自己的一句。若也发，
 * 记忆链会把她的自言自语当成一轮对话去提炼事实——`SELF` 来源的事实
 * 在召回时会变成「她记得自己说过什么」，而这不是用户交代过的事。
 * 那一条链有独立的注入口（`proactive-reason`），不必借道记忆。
 */

import type { Context } from '@ntars/cordis'

/** 会话事件的形状（与 `ondra-memory-intake` 认的那三支一致）。 */
interface TurnEvent {
  readonly type: 'user/message' | 'assistant/message' | 'turn/end'
  readonly time: number
  readonly data: unknown
}

/** 一条消息事件的数据：intake 认「`data` 本身就是消息」。 */
function messageData(role: 'user' | 'assistant', text: string): unknown {
  return Object.freeze({
    role,
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    /*
     * `source.kind` 必须给：intake 用它挡掉宿主每轮重注入的上下文快照
     * （`runtime-context` / `time-context`）。缺这个字段时它按「放行」处理，
     * 于是注入段里的旧记忆会被当成用户新说的话再抽一遍——记忆自我回灌。
     */
    source: Object.freeze({ kind: role === 'user' ? 'user' : 'model' }),
  })
}

/** 本进程内已发出的轮次序号。只用于 `turn/end` 的 `turn` 字段。 */
let sequence = 0

/** 发出事件的最小总线面。Cordis 的 `Events` 里没有这个名字，故按结构取。 */
interface EventBusLike {
  emit(name: string, ...args: unknown[]): void
}

/**
 * 把一轮对话发进总线。
 *
 * ## 顺序不可换
 *
 * `user/message` → `assistant/message` → `turn/end`。前两条往草稿里追加，
 * 最后一条才触发落盘。把 `turn/end` 提前会让这一轮的助手回复永远落不进库
 * （草稿已被取走并删除），而症状是「用户交代的事记下了，她答的那句没有」。
 *
 * ## 为什么吞掉异常
 *
 * 发事件是**附带动作**：这一轮回复已经生成、已经流给界面了。总线里某个
 * 监听器抛错不该让一次成功的对话变成失败——`ctx.emit` 同步派发，
 * 异常会直接冒到路由里。
 *
 * @param ctx 宿主上下文。
 * @param turn 这一轮的实况。
 */
export function publishTurn(
  ctx: Context,
  turn: {
    readonly sessionId: string
    /** 用户这一轮说的话。空串表示不是用户轮（主动开口），此时不发。 */
    readonly input: string
    /** 她这一轮的完整回复。 */
    readonly reply: string
  },
): void {
  const input = turn.input.trim()
  if (input === '') return

  const bus = ctx as unknown as EventBusLike
  const at = Date.now()
  sequence += 1
  /*
   * 会话身份用 `{ id }` 包一层：intake 的 `identityOf()` 优先读 `.id`，
   * 拿不到才退回对象本身。直接传字符串会让「同一个会话」在两次事件里
   * 变成两个不同的键（字符串原始值相等，但那要看它怎么存），
   * 而症状是草稿永远攒不齐、`turn/end` 找不到对应的那一半。
   */
  const session = Object.freeze({ id: turn.sessionId })

  const events: TurnEvent[] = [
    { type: 'user/message', time: at, data: messageData('user', input) },
    { type: 'assistant/message', time: at, data: messageData('assistant', turn.reply) },
    { type: 'turn/end', time: at, data: Object.freeze({ turn: sequence }) },
  ]

  for (const event of events) {
    try {
      bus.emit('session/event', session, event)
    } catch (error) {
      process.stderr.write(`[host] 会话事件派发失败（${event.type}）：${String(error)}\n`)
      return
    }
  }
}
