/**
 * 调试代理。
 *
 * ## 它是什么
 *
 * 一条从命令行通往界面的单向传送带。宿主把指令排进队列，这里取出来执行，
 * 再把结果送回去（见 `cordis-host/src/debug.ts` 文件头）。
 *
 * 它**不渲染任何东西**，也不改任何业务逻辑：只是在原有的按钮与状态之上
 * 多开一扇门。调试关闭时整条通道不存在，打包体积里留下的也就这几十 KB
 * 的类型与函数，运行时一行都不跑。
 *
 * ## 为什么业务动作要由 App 注册进来
 *
 * 界面状态（当前会话、面板是否展开、主题选择）住在 React 的 state 里，
 * 这里读不到。硬去读 DOM 推断「现在开着哪个面板」会得到一份会漂移的
 * 影子状态——那正是这类调试工具最容易坏的地方。
 *
 * 所以分工是：**业务动作由 App 用闭包注册**（它能直接调 setter），
 * **DOM 动作由本文件实现**（点一个元素、读一个矩形，不需要业务知识）。
 *
 * ## 为什么探测与轮询分开
 *
 * 调试默认关闭。若一上来就长轮询，关闭状态下每 8 秒一条 404，控制台会被
 * 刷满，而且看日志的人会以为哪里坏了。所以先问一次 `/api/debug/ping`，
 * 确认开着才进循环；关闭时退到 30 秒一次的静默重探，让「运行中才打开开关」
 * 这种情况也能在下次重探时接上。
 */

import { getConnection, request } from './host.ts'

/** 一条待执行的界面指令，形状与宿主侧 `UiCommand` 一致。 */
interface UiCommand {
  id: string
  action: string
  args: Record<string, unknown>
  at: number
}

/** 回传给宿主的结果。 */
interface UiResult {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

/** 业务动作。参数是命令行给的对象，返回值会被 JSON 序列化后送回终端。 */
export type DebugAction = (args: Record<string, unknown>) => unknown | Promise<unknown>

/** 动作注册表。 */
type ActionTable = Record<string, DebugAction>

/** 已注册的业务动作。DOM 动作不在这里，见文件头。 */
let actions: ActionTable = {}

/** 是否已经启动。防止 HMR 或重复挂载时开出两条通道。 */
let running = false

/** 长轮询的挂起时长。与宿主侧的默认值一致。 */
const WAIT_MS = 8_000

/** 调试关闭时的重探间隔。 */
const REPROBE_MS = 30_000

/** 连接断开后的退避。 */
const RETRY_MS = 3_000

/**
 * 注册业务动作。返回撤销函数。
 *
 * 用合并而不是替换：将来可能有多处注册（比如设置页单独提供几条），
 * 替换会让后注册的把先注册的抹掉。
 */
export function registerDebugActions(next: ActionTable): () => void {
  actions = { ...actions, ...next }
  return () => {
    for (const key of Object.keys(next)) delete actions[key]
  }
}

/**
 * 启动代理。
 *
 * 幂等：重复调用只会有第一次生效。
 */
export function startDebugAgent(): void {
  if (running) return
  running = true
  void watch()
}

/** 外层循环：没开就等着，开了就进通道，通道断了就回到等待。 */
async function watch(): Promise<void> {
  for (;;) {
    const enabled = await probe()
    if (!enabled) {
      await sleep(REPROBE_MS)
      continue
    }
    try {
      await pipe()
    } catch {
      // 通道断了（宿主重启、应用退出）。退避后重新探测，
      // 不在这里打印错误：界面控制台不该被一条调试通道刷满。
      await sleep(RETRY_MS)
    }
  }
}

/** 问一次宿主：调试开着吗。 */
async function probe(): Promise<boolean> {
  try {
    const result = await request<{ enabled?: unknown }>('/api/debug/ping')
    return result.enabled === true
  } catch {
    return false
  }
}

/** 通道主循环：取一条、执行、回传，如此往复。 */
async function pipe(): Promise<void> {
  for (;;) {
    const command = await next()
    if (command === null) continue
    const result = await run(command)
    // 回传失败不影响下一条：调用方已经超时或断开，指令本身也已执行完。
    await request('/api/debug/ui/result', { method: 'POST', body: result }).catch(() => {})
  }
}

/**
 * 取一条指令。
 *
 * 直接 `fetch` 而不用 `request()`：后者把响应体当 JSON 解析，
 * 而这里要读的是一条 SSE 流（长轮询的挂起就靠流实现）。
 */
async function next(): Promise<UiCommand | null> {
  const connection = getConnection()
  if (connection === undefined) throw new Error('宿主未就绪')

  const response = await fetch(`${connection.url}/api/debug/ui/next?wait=${String(WAIT_MS)}`, {
    headers: { authorization: `Bearer ${connection.token}` },
  })
  if (!response.ok) throw new Error(`取指令失败（${String(response.status)}）`)

  const text = await response.text()
  let payload: unknown
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      payload = JSON.parse(line.slice(6))
    } catch {
      // 解析不了就当作没有指令，下一轮重新取。
    }
  }
  if (payload === null || typeof payload !== 'object') return null
  const candidate = payload as Record<string, unknown>
  if (typeof candidate['id'] !== 'string' || typeof candidate['action'] !== 'string') return null
  const args = candidate['args']
  return {
    id: candidate['id'],
    action: candidate['action'],
    args: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
    at: typeof candidate['at'] === 'number' ? candidate['at'] : 0,
  }
}

/** 执行一条指令，永远返回结果对象（不抛）。 */
async function run(command: UiCommand): Promise<UiResult> {
  try {
    const value = await execute(command.action, command.args)
    return { id: command.id, ok: true, result: value ?? null }
  } catch (error) {
    return {
      id: command.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 分发：先找注册的业务动作，再找内置 DOM 动作。
 *
 * 业务优先：App 注册的动作可以覆盖同名内置动作，这样将来想把
 * `panel.open` 改成走真实按钮点击，只需注册一个同名动作，不必改本文件。
 */
async function execute(action: string, args: Record<string, unknown>): Promise<unknown> {
  const registered = actions[action]
  if (registered !== undefined) return await registered(args)

  switch (action) {
    case 'dom.query':
      return domQuery(args)
    case 'dom.dump':
      return domDump(args)
    case 'dom.click':
      return domClick(args)
    case 'dom.text':
      return domText(args)
    case 'dom.press':
      return domPress(args)
    case 'dom.scroll':
      return domScroll(args)
    case 'wait':
      await sleep(numberArg(args, 'ms', 300))
      return { waited: true }
    case 'reload':
      // 先回结果再刷新：刷新会中断当前文档，晚一步结果就送不回去了。
      setTimeout(() => { window.location.reload() }, 120)
      return { reloading: true }
    default:
      throw new Error(`未知动作：${action}（已注册：${Object.keys(actions).join(', ') || '无'}）`)
  }
}

// ---------------------------------------------------------------------------
// DOM 动作
// ---------------------------------------------------------------------------

/** 取数字参数。 */
function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 取字符串参数，缺省时抛错——静默用空串会让"点了没反应"极难查。 */
function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value === '') throw new Error(`缺少参数 ${key}`)
  return value
}

/** 找元素。选择器写错时给一句人话，而不是让 `querySelector` 抛原始异常。 */
function find(selector: string): Element {
  let element: Element | null
  try {
    element = document.querySelector(selector)
  } catch {
    throw new Error(`选择器不合法：${selector}`)
  }
  if (element === null) throw new Error(`没有匹配的元素：${selector}`)
  return element
}

/** 元素的视口矩形。保留两位小数，避免输出一串浮点尾巴。 */
function rectOf(element: Element): Record<string, number> {
  const box = element.getBoundingClientRect()
  const round = (value: number): number => Math.round(value * 100) / 100
  return {
    x: round(box.x),
    y: round(box.y),
    width: round(box.width),
    height: round(box.height),
    right: round(box.right),
    bottom: round(box.bottom),
  }
}

/** 读指定计算样式。只读点名的属性，避免输出几百行。 */
function styleOf(element: Element, properties: readonly string[]): Record<string, string> {
  const computed = getComputedStyle(element)
  const out: Record<string, string> = {}
  for (const property of properties) {
    out[property] = computed.getPropertyValue(property)
  }
  return out
}

/** 默认要读的样式属性。都是排查布局问题真正会看的几个。 */
const LAYOUT_PROPS = [
  'position',
  'display',
  'width',
  'height',
  'top',
  'right',
  'bottom',
  'left',
  'margin',
  'padding',
  'border-radius',
  'background-color',
  'color',
  'font-size',
  'z-index',
  'overflow',
  'transform',
  'opacity',
  'box-shadow',
] as const

/** `dom.query`：一个元素的矩形、样式与文本。 */
function domQuery(args: Record<string, unknown>): unknown {
  const selector = stringArg(args, 'selector')
  const element = find(selector)
  const extra = args['style']
  const props = Array.isArray(extra)
    ? extra.filter((item): item is string => typeof item === 'string')
    : LAYOUT_PROPS

  return {
    selector,
    tag: element.tagName.toLowerCase(),
    className: typeof element.className === 'string' ? element.className : '',
    rect: rectOf(element),
    style: styleOf(element, props),
    text: (element.textContent ?? '').trim().slice(0, 200),
  }
}

/** `dom.dump`：从某个根节点开始的元素树，带矩形。 */
function domDump(args: Record<string, unknown>): unknown {
  const selector = typeof args['selector'] === 'string' ? args['selector'] : 'body'
  const maxDepth = numberArg(args, 'depth', 6)
  const limit = numberArg(args, 'limit', 400)
  let visited = 0

  interface Node {
    tag: string
    className: string
    rect: Record<string, number>
    text?: string
    children?: Node[]
  }

  const walk = (element: Element, depth: number): Node => {
    visited += 1
    const own: Node = {
      tag: element.tagName.toLowerCase(),
      className: typeof element.className === 'string' ? element.className : '',
      rect: rectOf(element),
    }

    /*
     * 只在「没有元素子节点」时带文本。
     * 父节点的 textContent 是所有后代的拼接，带上它会让输出里出现
     * 大段重复文字，反而看不出结构。
     */
    if (element.children.length === 0) {
      const text = (element.textContent ?? '').trim()
      if (text !== '') own.text = text.slice(0, 80)
      return own
    }

    if (depth >= maxDepth || visited >= limit) return own
    own.children = Array.from(element.children).map((child) => walk(child, depth + 1))
    return own
  }

  return { root: walk(find(selector), 0), visited }
}

/** `dom.click`：派发一次真实点击（走 React 的事件委托）。 */
function domClick(args: Record<string, unknown>): unknown {
  const selector = stringArg(args, 'selector')
  const element = find(selector)

  /*
   * 用 `element.click()` 而不是手造 MouseEvent：前者是浏览器原生的激活行为，
   * 会同时触发指针、鼠标与 click 三条事件，React 的合成事件也能收到。
   * 手造 MouseEvent 需要 `bubbles: true` 才有效，漏掉时表现为"点了没反应"。
   */
  if (element instanceof HTMLElement) element.click()
  else element.dispatchEvent(new MouseEvent('click', { bubbles: true }))

  return { clicked: selector, rect: rectOf(element) }
}

/**
 * `dom.text`：给输入框赋值。
 *
 * ## 为什么要绕开 `element.value = x`
 *
 * React 的受控输入把值记在内部，直接改 DOM 的 value 不会触发 onChange，
 * 于是用户看到框里有字、提交却是空的。必须调原型上的原生 setter 绕过
 * React 的拦截，再手动派发 `input` 事件，它才会更新 state。
 */
function domText(args: Record<string, unknown>): unknown {
  const selector = stringArg(args, 'selector')
  const text = typeof args['text'] === 'string' ? args['text'] : ''
  const element = find(selector)
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    throw new Error(`${selector} 不是输入框`)
  }

  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(element, text)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.focus()
  return { selector, value: element.value }
}

/** `dom.press`：向当前焦点派发一次按键。 */
function domPress(args: Record<string, unknown>): unknown {
  const key = stringArg(args, 'key')
  const target = document.activeElement ?? document.body
  const init: KeyboardEventInit = {
    key,
    bubbles: true,
    cancelable: true,
    // 组合键要真的带上修饰位，否则快捷键处理器里的 `event.metaKey` 判断不成立。
    metaKey: args['meta'] === true,
    ctrlKey: args['ctrl'] === true,
    shiftKey: args['shift'] === true,
    altKey: args['alt'] === true,
  }
  target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  return { key, target: target.tagName.toLowerCase() }
}

/** `dom.scroll`：把某个可滚动容器滚到指定位置。 */
function domScroll(args: Record<string, unknown>): unknown {
  const selector = stringArg(args, 'selector')
  const element = find(selector)
  element.scrollTop = numberArg(args, 'top', 0)
  return { selector, scrollTop: element.scrollTop }
}

/** 等一会儿。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
