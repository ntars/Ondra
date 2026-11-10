/**
 * 调试接口。
 *
 * ## 它解决什么问题
 *
 * 空谷有三个进程（壳 / 宿主 / 内核）和一个 WebView。任何一次界面调整，
 * 想确认「现在是什么状态」都得靠截图看，想改一个配置项得点进设置页翻三层。
 * 一旦有个面板错位，只能靠肉眼猜是哪条 CSS 的函数算错了。
 *
 * 这个模块把「看」和「改」都变成一条命令行：
 *
 * ```sh
 * ondra status                 # 三个进程、端口、插件数、配置数
 * ondra ui dump .inspector     # 那个面板的实际矩形与计算样式
 * ondra config set memory-core retain-days 30
 * ondra say "在吗"
 * ```
 *
 * ## 默认关闭，且只有一处开关
 *
 * 它是一条能读写全部配置、能驱动界面的本地后门。所以默认**不注册任何路由**：
 * 宿主启动时读一次开关，没开就什么都不加。
 *
 * 开启方式两种，都指向同一件事：
 * 1. 环境变量 `ONDRA_DEBUG=1`——开发态与 CI 用；
 * 2. 数据目录下的 `debug.enable` 文件——**打包后的应用也能开**。
 *    这一条是必需的：从 Finder 启动的 `.app` 不继承 shell 环境变量，
 *    只有文件开关能在那种场景下生效。
 *
 * 关闭时不写握手文件，外部连端口都找不到。
 *
 * ## 命令行怎么拿到令牌
 *
 * 宿主的所有路由（含本模块）都走同一道 `Authorization: Bearer <主令牌>`。
 * 主令牌由 server 启动时随机生成，只通过 stdio 交给壳。命令行拿不到。
 *
 * 所以调试开启后，宿主把 `{ url, token, port, pid }` 写进数据目录的
 * `host.json`（权限 0600）。命令行读它即可。
 *
 * 为什么不另发一枚调试令牌：那会变成两套鉴权、两份过期规则、两处可漂移的
 * 校验。同机同用户的读权限本就是同一条边界，多一枚令牌只是多一个会写错的
 * 地方。0600 + 只在调试开启时存在，已经足够。
 *
 * ## 界面怎么被驱动
 *
 * WebView 里的 DOM 只有它自己动得了。宿主不能隔空点按钮，所以设一条
 * 单向传送带：
 *
 * ```
 * CLI → POST /api/debug/ui        （入队，等结果）
 *          ↓
 * 前端 → GET /api/debug/ui/next    （长轮询，取到即执行）
 *          ↓
 * 前端 → POST /api/debug/ui/result （回传结果）
 * ```
 *
 * 取指令用**长轮询**而不是 WebSocket：一条 GET 挂起到有指令为止，
 * 空闲时每 8 秒一个请求，代价可以忽略；而 WebSocket 要处理重连、心跳、
 * 与 Tauri 生命周期抢关闭时机——为一条调试通道付这些复杂度不值得。
 *
 * 长轮询的「挂起」借 `RouteResponse.stream` 实现：路由返回一个流，
 * 拿到指令后发一帧 `command` 再关闭。前端收到帧就重新发起下一次。
 */

import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RouteHandler, RouteRequest, StreamEmitter } from './server.js'
import type { SettingsSection, SettingsStore } from './settings.js'

/** 开关文件名。存在即开启调试接口。 */
export const DEBUG_SWITCH_FILE = 'debug.enable'

/** 握手文件名。里面是 URL、令牌与端口，权限 0600。 */
export const DEBUG_HANDSHAKE_FILE = 'host.json'

/** 调试日志文件名。宿主在调试模式下的关键动作都记在这里。 */
export const DEBUG_LOG_FILE = 'debug.log'

/** 长轮询默认挂起时长。取 8 秒：比常见的 30 秒代理超时短得多，又足够省请求。 */
const DEFAULT_WAIT_MS = 8_000

/** 单次长轮询允许的最长挂起。防止调用方传一个巨大的数把连接占死。 */
const MAX_WAIT_MS = 30_000

/** 等待界面回传结果的默认超时。8 秒覆盖一次 React 渲染与 Tauri 往返。 */
const DEFAULT_UI_TIMEOUT_MS = 8_000

/**
 * 待执行指令的队列上限。
 *
 * 界面没打开（比如窗口最小化到托盘）时指令会堆着。超过上限就丢最旧的：
 * 调试场景里「刚才那条过期指令」没有价值，留着只会让下一次打开窗口时
 * 突然执行一串旧动作。
 */
const MAX_QUEUED_COMMANDS = 32

/** 日志保留行数。超出后只保留最近这么多行，避免长期开着调试把磁盘写满。 */
const MAX_LOG_LINES = 2_000

/**
 * 判断调试接口是否开启。
 *
 * 两条判据是「或」，不是「且」：环境变量给开发态用，文件给打包后的应用用。
 * 任何一条成立就开——要求两者同时成立会让打包后的应用永远开不起来
 * （见文件头关于 Finder 不传环境变量的说明）。
 */
export function isDebugEnabled(dataDir: string): boolean {
  if (process.env.ONDRA_DEBUG === '1') return true
  return existsSync(join(dataDir, DEBUG_SWITCH_FILE))
}

/** 界面指令。 */
export interface UiCommand {
  /** 一次性 id，用于把结果对回请求。 */
  id: string
  /** 动作名，见前端 `debugAgent.ts` 的注册表。 */
  action: string
  /** 动作参数。 */
  args: Record<string, unknown>
  /** 入队时刻，便于诊断「为什么这条过了三秒才执行」。 */
  at: number
}

/** 界面回传的执行结果。 */
export interface UiResult {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * 界面指令队列。
 *
 * 一个实例服务全部调试请求。没有做多消费者：同时只有一个界面在听，
 * 也同时只有一个调试者在操作，做出「多个界面抢指令」的机制只会引入歧义。
 */
export class UiBridge {
  private readonly queue: UiCommand[] = []
  private waiter: ((command: UiCommand | null) => void) | undefined
  private waiterTimer: ReturnType<typeof setTimeout> | undefined
  private readonly results = new Map<string, (result: UiResult) => void>()
  private seq = 0

  /**
   * 投递一条指令并等界面回传结果。
   *
   * 有人在长轮询等待时直接交出去，省一次往返；否则入队等下一次轮询。
   */
  async dispatch(action: string, args: Record<string, unknown>, timeoutMs = DEFAULT_UI_TIMEOUT_MS): Promise<UiResult> {
    this.seq += 1
    const id = `${String(Date.now())}-${String(this.seq)}`
    const command: UiCommand = { id, action, args, at: Date.now() }

    const settled = new Promise<UiResult>((resolve) => {
      const timer = setTimeout(() => {
        this.results.delete(id)
        resolve({ id, ok: false, error: `界面在 ${String(timeoutMs)} 毫秒内没有响应（窗口可能没开）` })
      }, timeoutMs)
      this.results.set(id, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
    })

    const deliver = this.waiter
    if (deliver !== undefined) {
      this.waiter = undefined
      this.clearWaiterTimer()
      deliver(command)
    } else {
      if (this.queue.length >= MAX_QUEUED_COMMANDS) this.queue.shift()
      this.queue.push(command)
    }

    return settled
  }

  /** 界面侧：取下一个指令。没有就挂起最多 `waitMs`，超时返回 null。 */
  take(waitMs: number): Promise<UiCommand | null> {
    const pending = this.queue.shift()
    if (pending !== undefined) return Promise.resolve(pending)

    return new Promise<UiCommand | null>((resolve) => {
      // 新的等待者覆盖旧的：旧的那条连接已经超时或断了，保留它只会
      // 让下一条指令投进一个没人读的管道。
      this.clearWaiterTimer()
      if (this.waiter !== undefined) this.waiter(null)
      this.waiter = resolve
      this.waiterTimer = setTimeout(() => {
        this.waiter = undefined
        this.waiterTimer = undefined
        resolve(null)
      }, Math.min(Math.max(waitMs, 0), MAX_WAIT_MS))
    })
  }

  /** 界面侧：回传执行结果。未知 id 静默丢弃（请求方已超时）。 */
  settle(result: UiResult): void {
    const resolve = this.results.get(result.id)
    if (resolve === undefined) return
    this.results.delete(result.id)
    resolve(result)
  }

  /**
   * 排队中的指令数。
   *
   * `status` 要能看到它：数字持续增长说明界面没在监听（窗口关了、或
   * 调试代理没起来），这比「指令超时」更早给出线索。
   */
  get size(): number {
    return this.queue.length
  }

  private clearWaiterTimer(): void {
    if (this.waiterTimer !== undefined) {
      clearTimeout(this.waiterTimer)
      this.waiterTimer = undefined
    }
  }
}

/**
 * 调试日志。
 *
 * 只记**关键动作**（启动、配置读写、界面指令、错误），不记每一次轮询——
 * 长轮询每 8 秒一条，记下来会在一小时内把文件刷满，真正要看的启动记录
 * 反而搜不到了。
 *
 * 落盘是「追加」而不是「每次重写」：调试日志的价值恰恰在进程崩溃之后，
 * 重写式写入会在崩溃时留下一个空文件。
 */
export class DebugLog {
  private readonly path: string
  private readonly buffer: string[] = []

  /*
   * 攒着还没落盘的行。
   *
   * `write()` 原本每行一次 `appendFile()`。插件日志接上导出器之后，一次启动
   * 就有上百行（每个插件 `apply()` 里都有几句），每个 400 条消息的批次又是
   * 几百行——每行一次异步写等于把主线程塞满 fs 回调，而日志本身**不该影响
   * 业务时延**。改成 250ms 批量追加：崩溃最多丢最后 250ms 的日志，换取
   * 主流程完全不被日志拖住。
   *
   * 为什么 250ms 而不是更长：调试日志的价值恰恰在崩溃前后那几十毫秒，
   * 攒太久会把最要紧的那几行留在内存里一起丢掉。
   */
  private pending: string[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(dataDir: string) {
    this.path = join(dataDir, DEBUG_LOG_FILE)
  }

  /** 读回历史。文件不存在是正常状态（第一次开调试）。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8')
      const lines = raw.split('\n').filter((line) => line !== '')
      const kept = lines.slice(-MAX_LOG_LINES)
      this.buffer.length = 0
      this.buffer.push(...kept)
    } catch {
      this.buffer.length = 0
    }
  }

  /** 记一行。写盘失败不影响主流程——调试日志不该让业务挂掉。 */
  write(message: string): void {
    const line = `${new Date().toISOString()} ${message}`
    this.buffer.push(line)
    if (this.buffer.length > MAX_LOG_LINES) this.buffer.splice(0, this.buffer.length - MAX_LOG_LINES)
    this.pending.push(line)
    this.schedule()
  }

  /** 起一次延迟批量落盘。定时器 `unref`，不阻止进程退出。 */
  private schedule(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = setInterval(() => {
      this.flushPending()
    }, 250)
    const maybe = this.flushTimer as unknown as { unref?: () => void }
    if (typeof maybe.unref === 'function') maybe.unref()
  }

  /** 把攒下的行一次追加到磁盘。失败静默：调试日志不该让业务挂掉。 */
  private flushPending(): void {
    if (this.pending.length === 0) return
    const chunk = this.pending.join('\n')
    this.pending = []
    void appendFile(this.path, `${chunk}\n`, 'utf8').catch(() => {})
  }

  /** 立刻落盘（宿主退出前调一次，别把最后几行留在内存里）。 */
  flush(): void {
    this.flushPending()
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  /** 取最后若干行。 */
  tail(count: number): string[] {
    return this.buffer.slice(-count)
  }

  /** 压缩到上限，避免长期开启后文件无限增长。 */
  async compact(): Promise<void> {
    this.flushPending()
    const body = `${this.buffer.join('\n')}\n`
    const temporary = `${this.path}.tmp`
    try {
      await writeFile(temporary, body, 'utf8')
      await rename(temporary, this.path)
    } catch {
      // 压不下去就算了，下次再试。
    }
  }
}

/** 调试路由需要的环境。 */
export interface DebugEnvironment {
  /** 数据目录。开关、握手文件、日志都在这里。 */
  dataDir: string
  /** 产品版本，供 `ondra status` 显示。 */
  version: string
  /** 进程启动时刻，用于算运行时长。 */
  startedAt: number
  /** 工作区根目录，供排查「文件写到哪了」。 */
  workspaceRoot: string
  /** 配置读写。调试层要能打印改前改后的差异。 */
  settings: SettingsStore
  /** 已发现的全部配置段，只用于统计条数。 */
  sections: readonly SettingsSection[]
  /** 界面指令队列。 */
  bridge: UiBridge
  /** 调试日志。 */
  log: DebugLog
  /**
   * 本轮真正装载成功的插件 id（按装载顺序）。
   *
   * 为什么要暴露它：`activeSections` 只能看见**声明了配置段**的插件，而
   * `ondra-identity` / `ondra-config-schema` / `ondra-clock` 这类纯基础设施包
   * 一个字段也没有。于是「装上了」与「没装上」在旧的状态接口里读数完全相同
   * ——本仓又在犯同一个形态：**判据量的是衍生物，不是本体**。
   */
  loadedPlugins?: readonly string[]
}

/** 从请求体里取一个必填字符串。 */
function requiredString(body: unknown, key: string): string {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少参数 ${key}`)
  }
  return value
}

/** 从查询串取一个正整数，带默认值与上限。 */
function intQuery(request: RouteRequest, key: string, fallback: number, max: number): number {
  const raw = request.query[key]
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}

/**
 * 把调试路由挂到路由表上。
 *
 * 调用方负责先判断 {@link isDebugEnabled}——本函数不自己判，
 * 因为「是否注册」这件事应该只有一个决定点（见 index.ts 的装配段）。
 *
 * @param routes 路由表。会被直接写入。
 * @param env 调试环境。
 */
export function installDebugRoutes(routes: Map<string, RouteHandler>, env: DebugEnvironment): void {
  env.log.write(`调试接口已启用（数据目录 ${env.dataDir}）`)

  /**
   * 探测。
   *
   * 前端启动时用它决定要不要建立指令通道。它**不需要**调试令牌——
   * 前端本来就持有主令牌，而这个接口只回一个布尔值，不泄露任何东西。
   * 没有它，前端就只能靠「连一次 ui/next 试试」来判断，那会在关闭调试时
   * 每 8 秒产生一条 404。
   */
  routes.set('GET /api/debug/ping', () => ({ body: { enabled: true, version: env.version } }))

  /** 运行状态。`ondra status` 的全部数据来源。 */
  routes.set('GET /api/debug/status', () => {
    const fields = env.sections.reduce((sum, section) => sum + section.fields.length, 0)
    return {
      body: {
        enabled: true,
        version: env.version,
        pid: process.pid,
        uptimeMs: Date.now() - env.startedAt,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        dataDir: env.dataDir,
        workspaceRoot: env.workspaceRoot,
        settingSections: env.sections.length,
        settingFields: fields,
        registeredSections: env.sections.filter((section) => section.registered).length,
        activeSections: env.sections.filter((section) => section.active).length,
        queuedCommands: env.bridge.size,
        loadedPlugins: env.loadedPlugins ?? [],
        loadedPluginCount: (env.loadedPlugins ?? []).length,
      },
    }
  })

  /**
   * 配置快照。
   *
   * 返回**声明的全貌 + 用户改过的值 + 默认值**三样，而不是只返回用户层。
   * 调试时最常问的是「这个键现在到底是多少」，只给用户层就分不清
   * 「没改过（用默认）」和「改成了和默认一样」。
   */
  routes.set('GET /api/debug/settings', (request) => {
    const only = request.query['section']
    const user = env.settings.read()
    const sections = only === undefined ? env.sections : env.sections.filter((section) => section.id === only)

    if (only !== undefined && sections.length === 0) {
      return { status: 404, body: { error: `没有这个配置段：${only}` } }
    }

    return {
      body: {
        sections: sections.map((section) => ({
          id: section.id,
          title: section.title,
          dir: section.dir,
          active: section.active,
          registered: section.registered,
          fields: section.fields.map((field) => ({
            key: field.key,
            kind: field.kind,
            doc: field.doc,
            ...(field.default === undefined ? {} : { default: field.default }),
            // 用户没改过时不写 value 键，而不是写一个 null：
            // null 在这个项目里是「显式置空」，与「用默认」是两件事。
            ...(user[section.id]?.[field.key] === undefined ? {} : { value: user[section.id]?.[field.key] }),
            changed: user[section.id]?.[field.key] !== undefined,
            advancedOnly: field.advancedOnly,
            secret: field.secret,
            ...(field.min === undefined ? {} : { min: field.min }),
            ...(field.max === undefined ? {} : { max: field.max }),
            ...(field.values === undefined ? {} : { values: field.values }),
            ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
          })),
        })),
        totals: {
          sections: env.sections.length,
          fields: env.sections.reduce((sum, section) => sum + section.fields.length, 0),
          changed: Object.values(user).reduce((sum, bucket) => sum + Object.keys(bucket).length, 0),
        },
      },
    }
  })

  /**
   * 写一个配置字段。
   *
   * 三种写法对应三种语义，与设置页按钮一一对应：
   * - `{ section, key, value }`：设为某个值；
   * - `{ section, key, reset: true }`：删掉用户层这一键，回落到默认；
   * - `{ section, key, value: null }`：显式置空（会覆盖下层默认）。
   *
   * 返回值带上改前改后的值，让 CLI 能打印“从什么变成什么”——
   * 调试时最有用的信息不是“改成功了”，而是“原来是 30，现在 15”。
   */
  routes.set('POST /api/debug/settings', async (request) => {
    const section = requiredString(request.body, 'section')
    const key = requiredString(request.body, 'key')
    const body = (request.body ?? {}) as Record<string, unknown>
    const known = env.sections.find((item) => item.id === section)
    if (known === undefined) {
      return { status: 404, body: { error: `没有这个配置段：${section}` } }
    }
    if (!known.fields.some((field) => field.key === key)) {
      return { status: 404, body: { error: `配置段 ${section} 没有字段 ${key}` } }
    }

    const before = env.settings.read()[section]?.[key]
    const reset = body['reset'] === true
    const value = body['value']

    if (!reset && !('value' in body)) {
      return { status: 400, body: { error: '缺少 value（或用 reset: true 恢复默认）' } }
    }

    // 先做一层形状校验。放行错误类型会让插件读到字符串 "false" 并当成真值，
    // 那种缺陷在界面上表现为「开关关不掉」，极难反查。
    if (!reset) {
      const field = known.fields.find((item) => item.key === key)
      if (field !== undefined && value !== null) {
        if (field.kind === 'boolean' && typeof value !== 'boolean') {
          return { status: 400, body: { error: `${key} 需要布尔值` } }
        }
        if (field.kind === 'number' && typeof value !== 'number') {
          return { status: 400, body: { error: `${key} 需要数字` } }
        }
        if (field.kind === 'string' && typeof value !== 'string') {
          return { status: 400, body: { error: `${key} 需要字符串` } }
        }
        if (field.kind === 'enum' && (typeof value !== 'string' || !(field.values ?? []).includes(value))) {
          return { status: 400, body: { error: `${key} 只接受 ${(field.values ?? []).join(' / ')}` } }
        }
        if (typeof value === 'number' && field.min !== undefined && value < field.min) {
          return { status: 400, body: { error: `${key} 不能小于 ${String(field.min)}` } }
        }
        if (typeof value === 'number' && field.max !== undefined && value > field.max) {
          return { status: 400, body: { error: `${key} 不能大于 ${String(field.max)}` } }
        }
      }
    }

    await env.settings.set(section, key, reset ? undefined : value)
    const after = env.settings.read()[section]?.[key]
    env.log.write(`配置 ${section}.${key}：${JSON.stringify(before)} → ${JSON.stringify(after)}`)

    return { body: { section, key, before, after, reset } }
  })

  /** 调试日志。 */
  routes.set('GET /api/debug/logs', (request) => {
    const lines = intQuery(request, 'lines', 200, MAX_LOG_LINES)
    return { body: { path: join(env.dataDir, DEBUG_LOG_FILE), lines: env.log.tail(lines) } }
  })

  /**
   * 界面指令下发。
   *
   * 等界面回传结果后才返回，所以一条命令的成败是确定的，不需要之后再查。
   */
  routes.set('POST /api/debug/ui', async (request) => {
    const action = requiredString(request.body, 'action')
    const body = (request.body ?? {}) as Record<string, unknown>
    const rawArgs = body['args']
    const args = typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {}
    const timeoutMs = typeof body['timeoutMs'] === 'number' ? body['timeoutMs'] : DEFAULT_UI_TIMEOUT_MS

    const started = Date.now()
    const result = await env.bridge.dispatch(action, args, timeoutMs)
    env.log.write(`界面指令 ${action}：${result.ok ? '成功' : `失败（${result.error ?? '未知'}）`}，耗时 ${String(Date.now() - started)}ms`)
    return { body: result }
  })

  /**
   * 界面取指令（长轮询）。
   *
   * 挂起由流实现：拿到指令就发一帧 `command` 然后关闭，前端收到帧立刻再连。
   * 空闲时每 `wait` 毫秒一个空帧，代价接近零。
   */
  routes.set('GET /api/debug/ui/next', (request) => {
    const wait = intQuery(request, 'wait', DEFAULT_WAIT_MS, MAX_WAIT_MS)
    return {
      stream: async (emit: StreamEmitter): Promise<void> => {
        const command = await env.bridge.take(wait)
        emit.send('command', command)
        emit.close()
      },
    }
  })

  /** 界面回传结果。 */
  routes.set('POST /api/debug/ui/result', (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const id = requiredString(request.body, 'id')
    const ok = body['ok'] === true
    env.bridge.settle({
      id,
      ok,
      ...(body['result'] === undefined ? {} : { result: body['result'] }),
      ...(typeof body['error'] === 'string' ? { error: body['error'] } : {}),
    })
    return { body: { ok: true } }
  })

  env.log.write(`调试路由已注册 ${String(routes.size)} 条（含业务路由）`)
}

/**
 * 写握手文件。
 *
 * 权限 0600：同机的其他用户读不到令牌。这不是过度的谨慎——多用户 macOS
 * 上数据目录在 `~/Library`，本来就是 0700，但显式给文件设一次权限，
 * 才能保证它不因为 umask 变化而变宽。
 *
 * 写入用「临时文件 + rename」，避免命令行读到半截 JSON。
 */
export async function writeDebugHandshake(
  dataDir: string,
  payload: { url: string; token: string; port: number; version: string; pid: number },
): Promise<string> {
  await mkdir(dataDir, { recursive: true })
  const target = join(dataDir, DEBUG_HANDSHAKE_FILE)
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify({ ...payload, at: Date.now() }, undefined, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, target)
  return target
}

/** 删掉握手文件。调试关闭时调用，避免留下一个连不上的地址。 */
export async function clearDebugHandshake(dataDir: string): Promise<void> {
  await unlink(join(dataDir, DEBUG_HANDSHAKE_FILE)).catch(() => {})
}
