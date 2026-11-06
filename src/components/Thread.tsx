/**
 * 中栏：会话区。
 *
 * ## 三段结构
 *
 * 1. **头部**（`padding: 10px 28px 10px 20px`，下边框 0.5px，实测高 51px）
 *    - 只有一行面包屑：当前会话标题，右侧留工具位
 * 2. **消息区**（唯一滚动容器，内容列居中）
 * 3. **输入区**（不滚动，贴底）
 *
 * ## 头部为什么没有标签行
 *
 * 「对话 / 运行日志」这个切换开关在左栏（那个 38px 的分段控件），
 * 它管的就是这一栏显示什么。在这里再放一行标签，等于把同一个开关
 * 画了两遍——而且两处的选中态必须同步，一旦有一处漏同步就会
 * 出现"左栏显示日志、中栏显示对话"的矛盾。
 *
 * 原版是同一个判断：它虽然写了 tabs 的样式，但那个容器只在一个会话
 * 有多个视图时才出现。当前每个会话只有一个视图，所以头部实际高 51px，
 * 没有标签行。照着这个做，头部才不会凭空多出 25px。
 *
 * ## 面包屑为什么只有一段
 *
 * 原版的面包屑是「工作区 › 会话」的层级表达，只在会话属于某个
 * 命名工作区时才多出一段。默认工作区不显示——否则每一条会话上面
 * 都顶着一个「workspace ›」，纯属噪音。
 *
 * ## 消息样式为什么不对称
 *
 * - **用户消息**：淡蓝圆角气泡，右对齐。用户必须能一眼找到"我刚说了什么"。
 * - **助手消息**：无气泡，正文直接铺在纸面上，左对齐。
 *
 * 不对称的理由：助手回复通常很长，给它套一个底色框会让整屏都是色块，
 * 阅读时视线不断被边框打断。用户消息通常很短，气泡反而有助于快速定位。
 *
 * ## 两个标签与左栏的分段控件是同一个开关
 *
 * 这里的「对话 / 运行日志」不自己管状态，而是读 `view` 再写回
 * `onViewChange`。左栏那个分段控件写的是同一份状态，所以点哪边都一样。
 * 两处各自维护一个 state 会导致"左栏显示日志、中栏显示对话"这种矛盾。
 *
 * ## 读日志时输入框消失
 *
 * 日志是回顾，不是对话。留着输入框会让人以为可以边看日志边说话，
 * 而实际上说了话会切回对话视图，输入框里的字就跑到另一屏去了。
 * 干脆藏起来，语义更干净。
 *
 * ## 自动滚动
 *
 * 生成过程中新内容不断追加，需要跟到底部。但**用户手动往上翻时不能拽回来**——
 * 那会让用户想回看前文时被反复打断。判据是"当前是否已接近底部"。
 */

import { useEffect, useRef } from 'react'
import { Composer } from './Composer.tsx'
import type { Attachment, ComposerUsage } from './Composer.tsx'
import { LogView } from './LogView.tsx'
import type { LogEntry, SidebarView } from './Sidebar.tsx'
import type { ModelDescriptor, PermissionLevel } from '../lib/api.ts'

/** 一条待渲染的消息。`pending` 表示正在生成中。 */
export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 正在生成中。用于显示光标与呼吸点。 */
  pending?: boolean
  /** 推理模型的思考过程。仅在生成期有值。 */
  reasoning?: string
}

/** 组件属性。 */
export interface ThreadProps {
  title: string
  messages: DisplayMessage[]
  value: string
  onChange(value: string): void
  onSend(): void
  busy: boolean
  onStop(): void
  permission: PermissionLevel
  onPermissionClick(): void
  error: string | undefined
  onDismissError(): void

  /** 当前视图。与左栏分段控件共用同一份状态。 */
  view: SidebarView
  /** 切换视图。 */
  onViewChange(view: SidebarView): void
  /** 日志行。切到「运行日志」时渲染。 */
  logs: LogEntry[]

  models: ModelDescriptor[]
  modelId: string | undefined
  onModelChange(id: string): void
  onAddFile?(): void
  attachments: Attachment[]
  onRemoveAttachment(id: string): void
  onVoice?(): void
  voiceActive?: boolean
  /** 本轮用量。 */
  usage?: ComposerUsage
  /**
   * 上报一条顶部提示。
   *
   * 复核阶段加：附件读取失败、复制失败这类事在正文里没有位置显示，
   * 静默处理会让用户以为"点了没动"。统一走根节点的提示条。
   */
  onNotify?(text: string, tone?: 'error' | 'info'): void
}

/**
 * 渲染对话。
 *
 * 头部不再有标签行，因此这里也不需要标签定义：
 * 「对话 / 运行日志」的切换只有左栏那一个分段控件。
 */
export function Thread(props: ThreadProps): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  /** 是否应该跟随到底部。用户往上翻时置 false。 */
  const follow = useRef(true)
  const readingLog = props.view === 'log'

  // 记录用户的滚动位置：只有接近底部才继续跟随。
  useEffect(() => {
    const node = body.current
    if (node === null) return
    const handleScroll = (): void => {
      // 48px 的容差：太小的话，一次惯性滚动的抖动就会关掉跟随；
      // 太大的话，用户往上翻了两行仍然会被拽回底部。
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
      follow.current = distance < 48
    }
    node.addEventListener('scroll', handleScroll, { passive: true })
    return () => { node.removeEventListener('scroll', handleScroll) }
  }, [])

  // 内容变化时滚到底。用 bottom 锚点而不是 scrollHeight：
  // 后者在内容高度尚未稳定时（图片、字体加载）会算错。
  useEffect(() => {
    if (!follow.current) return
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [props.messages])

  return (
    <div className="thread">
      {/* --- 头部：单行面包屑 ------------------------------------- */}
      {/*
        头部是第二块拖拽区。

        原版这个 `<header>` 上确实挂着 `data-window-drag`——它同时承担
        "标题栏"和"面包屑"两个角色。只留侧栏那条 52px 的话，
        用户把鼠标移到中间那片空白想拖窗口时会拖不动，与 macOS 上
        "按住标题栏挪窗口"的直觉不符。

        用 `"deep"` 而不是裸属性：裸属性只认直接点在 header 本身上的按下，
        而这块区域里铺满了面包屑文字与工具按钮，直接按到 header 本体的
        概率很低。`"deep"` 让子树里任何非交互元素都能起拖。
      */}
      <header className="thread__header" data-tauri-drag-region="deep">
        <div className="thread__headerLeading">
          <div className="thread__titleRow">
            <nav className="thread__crumbs" aria-label="会话">
              <span className="thread__crumbSeg">
                <span className="thread__crumb thread__crumb--current" title={props.title}>
                  {props.title}
                </span>
              </span>
            </nav>
            <div className="thread__headerUtilities" />
          </div>
        </div>
      </header>

      {/* --- 消息区 / 运行日志 ---------------------------------- */}
      {readingLog ? (
        /* 日志自己滚，不再套一层 thread__body：
           它的行高与内边距是另一套尺度，混在消息流的滚动容器里
           会让两边的滚动行为互相干扰。 */
        <LogView logs={props.logs} />
      ) : (
        <div className="thread__body scroller" ref={body}>
          <div className="thread__content">
            <div className="thread__list">
              {props.messages.map((message) =>
                message.role === 'user' ? (
                  <article key={message.id} className="msg msg--user">
                    <p className="msg__bubble selectable">{message.content}</p>
                  </article>
                ) : (
                  <article key={message.id} className="msg msg--assistant">
                    {message.content === '' && message.pending === true ? (
                      // 还没收到第一个字：显示呼吸点而不是空行，
                      // 否则用户无法判断是"在想了"还是"没反应"。
                      //
                      // 对话区不显示思考内容：思考可能上千字且逐字滚动，
                      // 会让整屏内容不停上下晃，而用户此刻要的只是
                      // "它还在动"这一个信息。三个呼吸点恰好表达这件事，
                      // 且不占版面。完整的思考过程去「运行日志」看——
                      // 那里的定位就是"这一轮发生过什么"。
                      <span className="thinking" aria-label="正在思考">
                        <span /><span /><span />
                      </span>
                    ) : (
                      <div className="msg__plain selectable">
                        {message.content}
                        {message.pending === true ? <span className="caret" aria-hidden /> : null}
                      </div>
                    )}
                  </article>
                ),
              )}
              <div ref={bottom} />
            </div>
          </div>
        </div>
      )}

      {/* --- 输入区 ---------------------------------------------- */}
      {readingLog ? null : (
        <div className="thread__dock">
          {props.error === undefined ? null : (
            <div className="notice">
              <span>{props.error}</span>
              <button
                type="button"
                className="notice__close"
                onClick={props.onDismissError}
                aria-label="关闭提示"
              >
                ×
              </button>
            </div>
          )}
          <Composer
            value={props.value}
            onChange={props.onChange}
            onSend={props.onSend}
            busy={props.busy}
            onStop={props.onStop}
            permission={props.permission}
            onPermissionClick={props.onPermissionClick}
            models={props.models}
            modelId={props.modelId}
            onModelChange={props.onModelChange}
            {...(props.onAddFile === undefined ? {} : { onAddFile: props.onAddFile })}
            attachments={props.attachments}
            onRemoveAttachment={props.onRemoveAttachment}
            {...(props.onVoice === undefined ? {} : { onVoice: props.onVoice })}
            {...(props.voiceActive === undefined ? {} : { voiceActive: props.voiceActive })}
            {...(props.usage === undefined ? {} : { usage: props.usage })}
            autoFocus
          />
        </div>
      )}
    </div>
  )
}
