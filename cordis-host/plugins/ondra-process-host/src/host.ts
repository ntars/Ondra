/**
 * 托管编排：**启动 → 观察退出 → 决定是否重启 → 组杀收尾**。
 *
 * ## 为什么组杀不自己写
 *
 * `kill(-pid)` 看着简单，实际要处理：进程组是否存在、Windows 没有进程组、子进程又拉了
 * 孙进程、`SIGTERM` 后多久 `SIGKILL`。上游 `SubprocessHandle.terminate()` 的契约是
 * 「作用于 provider 托管的**整个范围**」，`subprocess-local` 在 POSIX 用 scope、
 * win32 用 job object——这是**做不到就杀不干净**的那一层，自研等于重写一遍作业对象。
 * 所以本文件**一处 `kill` 都没有**，只有 `terminate()` + `waitForExit()`。
 *
 * ## 为什么重启要带「世代号」
 *
 * 重启是异步的：旧句柄的 `done` 可能在新进程已经起来之后才 settle（收集器要抽干管道）。
 * 若回调只看名字，就会把「新进程正在跑」改成「已崩溃」，然后无限重启。
 * 每次 `spawn` 递增 `generation`，退出回调先比世代号，不匹配就整条丢弃。
 *
 * ## 为什么 `stop()` 必须区分「发出了组杀」与「确认静默」
 *
 * `terminate()` 是**请求**，不是事实。上游的 provider 可能分阶段（TERM→等→KILL），
 * 也可能因为观察不到范围而失败。把「已请求」报成「已停止」，下一次启动就会撞上
 * 还在占端口的旧进程，而日志里全是「启动成功」。所以 `confirmed` 单独给。
 */

import { describeReason, crashedFast, decideRestart, isValidName, probePid, summarize } from './scope.js'
import type { FileStateStore } from './state.js'
import type { Config } from './settings.js'
import type {
  ChildHandleLike,
  HostReason,
  HostRequest,
  HostStateRecord,
  HostStats,
  HostedView,
  LogLike,
  ProcessHostService,
  SubprocessPortLike,
} from './types.js'

/** 一个托管项的内部记录。 */
interface Entry {
  /** 首次请求（重启时原样重放，不重新解析调用方的入参）。 */
  readonly request: HostRequest
  /** 解析后的工作目录。 */
  readonly cwd: string
  /** 当前对外视图。 */
  view: HostedView
  handle: ChildHandleLike | null
  /** 我让它停的：退出回调看到它就**不再重启**。 */
  stopping: boolean
  /** 世代号：旧句柄的迟到回调靠它丢弃。 */
  readonly generation: number
  /** 待执行的重启定时器。 */
  timer: ReturnType<typeof setTimeout> | null
}

/** 依赖（全部注入，便于纯逻辑对拍时换掉）。 */
export interface ProcessHostDeps {
  settings: () => Config
  log: LogLike
  now: () => number
  /** 延迟取上游端口：`ctx.subprocess` 可能比本插件晚装载。 */
  port: () => SubprocessPortLike | null
  state: FileStateStore
}

/**
 * 托管实现。
 *
 * 所有公开方法**永不抛**——见 `types.ts`「错误不传播」。
 */
export class ProcessHost implements ProcessHostService {
  readonly #deps: ProcessHostDeps
  readonly #entries = new Map<string, Entry>()
  readonly #counts = { starts: 0, restarts: 0, exits: 0, terminations: 0, refusals: 0 }
  #generation = 0
  #disposed = false

  /**
   * @param deps 依赖。
   */
  constructor(deps: ProcessHostDeps) {
    this.#deps = deps
  }

  /** 有上游端口且没卸载，才算可用。 */
  get available(): boolean {
    return !this.#disposed && this.#deps.port() !== null
  }

  /** 不可用的原因。 */
  get reason(): HostReason | undefined {
    if (this.#disposed) return 'disposed'
    if (!this.#deps.settings().enable) return 'disabled'
    if (this.#deps.port() === null) return 'no-subprocess'
    return undefined
  }

  /**
   * 启动并托管。
   * @param request 托管请求。
   */
  async start(request: HostRequest): Promise<HostedView> {
    const settings = this.#deps.settings()
    if (!settings.enable) return this.#refuse(request.name, 'disabled')
    if (!isValidName(request.name)) return this.#refuse(request.name, 'bad-name')
    if (request.argv.length === 0) return this.#refuse(request.name, 'no-argv')

    const existing = this.#entries.get(request.name)
    if (existing !== undefined) {
      if (existing.view.phase === 'running' || existing.view.phase === 'restarting') {
        return { ...existing.view, reason: 'duplicate', detail: describeReason('duplicate') }
      }
      // 已停 / 已崩的同名项：直接重开，旧定时器先撤掉。
      if (existing.timer !== null) {
        clearTimeout(existing.timer)
        existing.timer = null
      }
    }
    return this.#spawn(request, 0)
  }

  /**
   * 组杀并等静默。
   * @param name 托管项名。
   * @param options 覆盖超时。
   */
  async stop(name: string, options?: { readonly timeoutMs?: number }): Promise<HostedView> {
    const entry = this.#entries.get(name)
    if (entry === undefined) return this.#refuse(name, 'not-found')

    // 先立旗：退出回调一旦看到 `stopping` 就不再重启。
    entry.stopping = true
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }

    const settings = this.#deps.settings()
    const timeoutMs = options?.timeoutMs ?? settings.stopTimeoutMs
    const handle = entry.handle
    let confirmed = true

    if (handle !== null) {
      try {
        handle.terminate()
      } catch (error) {
        // 终止请求本身失败：仍然继续等静默，等不到就是 `confirmed: false`。
        this.#deps.log.warn('组杀请求失败（继续等静默）：%s', textOf(error))
      }
      this.#counts.terminations += 1
      confirmed = await this.#waitQuiet(handle, timeoutMs)
    }

    entry.handle = null
    this.#deps.state.removePid(name)
    const exitedAt = this.#deps.now()
    const next: HostedView = confirmed
      ? { ...entry.view, phase: 'stopped', exitedAt, confirmed: true }
      : {
          ...entry.view,
          phase: 'stopped',
          exitedAt,
          confirmed: false,
          reason: 'timeout',
          detail: describeReason('timeout'),
        }
    entry.view = next
    this.#persist(entry)
    this.#deps.log.info('已停止：%s%s', summarize(name, next.phase, next.restarts, next.pid ?? null), confirmed ? '' : '（静默未确认）')
    return next
  }

  /**
   * 停再起（同一 `argv`）。
   * @param name 托管项名。
   */
  async restart(name: string): Promise<HostedView> {
    const entry = this.#entries.get(name)
    if (entry === undefined) return this.#refuse(name, 'not-found')
    const request = entry.request
    await this.stop(name)
    return this.#spawn(request, 0)
  }

  /**
   * 取一个托管项的视图。
   * @param name 托管项名。
   */
  get(name: string): HostedView | undefined {
    const entry = this.#entries.get(name)
    return entry === undefined ? undefined : { ...entry.view }
  }

  /** 全部托管项视图。 */
  list(): readonly HostedView[] {
    return [...this.#entries.values()].map(entry => ({ ...entry.view }))
  }

  /**
   * 状态文件路径；只在内存时为空串。
   * @param name 托管项名。
   */
  stateFileOf(name: string): string {
    return this.#deps.state.pathOf(name)
  }

  /** 计数快照。 */
  stats(): HostStats {
    return Object.freeze({ ...this.#counts })
  }

  /** 卸载：逐个组杀，清空引用。 */
  async dispose(): Promise<void> {
    this.#disposed = true
    for (const name of [...this.#entries.keys()]) {
      await this.stop(name)
    }
    this.#entries.clear()
  }

  /**
   * 真正起一个进程。
   * @param request 请求。
   * @param restarts 本次是第几次重启（首次为 0）。
   */
  async #spawn(request: HostRequest, restarts: number): Promise<HostedView> {
    if (this.#disposed) return this.#refuse(request.name, 'disposed')
    const port = this.#deps.port()
    if (port === null) return this.#refuse(request.name, 'no-subprocess')

    const settings = this.#deps.settings()
    const cwd = request.cwd ?? (settings.cwd === '' ? process.cwd() : settings.cwd)
    const graceMs = request.graceMs ?? settings.graceMs

    let handle: ChildHandleLike
    try {
      handle = port.spawn({
        argv: request.argv,
        cwd,
        // stdio 全显式：上游 seam「applies no defaults」，漏一项就是类型错误，
        // 而运行时漏一项会变成子进程继承父的 fd —— 输出混进宿主日志，排查时找不到源头。
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: settings.collectBytes },
          stderr: { maxBytes: settings.collectBytes },
        },
        graceMs,
        ...(request.env === undefined ? {} : { env: request.env }),
      })
    } catch (error) {
      return this.#fail(request.name, 'spawn-failed', textOf(error), restarts)
    }

    this.#generation += 1
    const generation = this.#generation
    const pid = probePid(handle)
    const startedAt = this.#deps.now()
    const entry: Entry = {
      request,
      cwd,
      view: { name: request.name, phase: 'running', restarts, startedAt, pid },
      handle,
      stopping: false,
      generation,
      timer: null,
    }
    this.#entries.set(request.name, entry)
    this.#counts.starts += 1
    this.#persist(entry)

    if (settings.writePidFile) {
      if (pid === null) {
        // 如实报「没有」，不写假文件：读 pidfile 的脚本会去 kill 那个号。
        this.#deps.log.info('pidfile-skipped：上游未暴露 pid，不写假 pid 文件（%s）', request.name)
      } else if (!this.#deps.state.writePid(request.name, pid)) {
        this.#deps.log.warn('pid 文件没写成（不影响托管）：%s', request.name)
      }
    }

    if (settings.verbose) {
      this.#deps.log.info('已启动：%s', summarize(request.name, 'running', restarts, pid))
    }

    void handle.done.then(
      outcome => {
        this.#onExit(request.name, generation, outcome.exitCode, outcome.signal, undefined)
      },
      error => {
        // 上游说 `done` 可能在 spawn / provider 失败时 reject。这不是「退出」，
        // 但仍要收尾，否则这个托管项会永远停在 `running`。
        this.#onExit(request.name, generation, null, null, textOf(error))
      },
    )

    return { ...entry.view }
  }

  /**
   * 退出回调。
   * @param name 托管项名。
   * @param generation 世代号。
   * @param exitCode 退出码。
   * @param signal 终止信号。
   * @param error 句柄 reject 时的文本。
   */
  #onExit(
    name: string,
    generation: number,
    exitCode: number | null,
    signal: string | null,
    error: string | undefined,
  ): void {
    const entry = this.#entries.get(name)
    if (entry === undefined) return
    if (entry.generation !== generation) return

    entry.handle = null
    this.#counts.exits += 1
    this.#deps.state.removePid(name)

    const settings = this.#deps.settings()
    const exitedAt = this.#deps.now()
    const uptime = exitedAt - (entry.view.startedAt ?? exitedAt)

    if (entry.stopping || this.#disposed) {
      entry.view = { ...entry.view, phase: 'stopped', exitedAt, exitCode, signal, confirmed: true }
      this.#persist(entry)
      return
    }

    const decision = decideRestart(entry.view.restarts, settings.maxRestarts)
    if (decision.restart) {
      entry.view = { ...entry.view, phase: 'restarting', exitedAt, exitCode, signal }
      this.#persist(entry)
      this.#counts.restarts += 1
      entry.timer = this.#delay(() => {
        entry.timer = null
        void this.#respawn(name)
      }, settings.restartDelayMs)
      this.#deps.log.warn(
        '进程退出了（code=%s signal=%s），%d 毫秒后重启（第 %d/%d 次）',
        String(exitCode),
        String(signal),
        settings.restartDelayMs,
        entry.view.restarts + 1,
        settings.maxRestarts,
      )
      return
    }

    const fast = crashedFast(uptime, settings.minUptimeMs)
    const detail = fast
      ? `${describeReason('crash-limit')}；这次只活了 ${uptime} 毫秒，八成是二进制或参数不对`
      : `${describeReason('crash-limit')}${error === undefined ? '' : `（${error}）`}`
    entry.view = {
      ...entry.view,
      phase: 'failed',
      exitedAt,
      exitCode,
      signal,
      reason: 'crash-limit',
      detail,
    }
    this.#persist(entry)
    this.#deps.log.error('托管项失败：%s —— %s', name, detail)
  }

  /**
   * 重启一次（重放原请求）。
   * @param name 托管项名。
   */
  async #respawn(name: string): Promise<void> {
    const entry = this.#entries.get(name)
    if (entry === undefined || this.#disposed) return
    const next = entry.view.restarts + 1
    const view = await this.#spawn(entry.request, next)
    if (view.reason !== undefined && view.phase === 'failed') {
      this.#deps.log.warn('重启也没起来：%s（%s）', name, view.reason)
    }
  }

  /**
   * 等托管范围静默。
   * @param handle 句柄。
   * @param timeoutMs 上限。
   */
  async #waitQuiet(handle: ChildHandleLike, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // 句柄用 `unref` 探测：浏览器 / Worker 里 setTimeout 返回数字，直接调会抛。
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
    try {
      return await handle.waitForExit(controller.signal)
    } catch (error) {
      this.#deps.log.warn('等静默时出错：%s', textOf(error))
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 延迟执行（定时器不阻止进程退出）。
   * @param run 回调。
   * @param ms 延迟。
   */
  #delay(run: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(run, ms)
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
    return timer
  }

  /**
   * 写一次状态。
   * @param entry 内部记录。
   */
  #persist(entry: Entry): void {
    const view = entry.view
    const record: HostStateRecord = {
      name: view.name,
      phase: view.phase,
      argv: entry.request.argv,
      cwd: entry.cwd,
      startedAt: view.startedAt ?? this.#deps.now(),
      restarts: view.restarts,
      pid: view.pid ?? null,
      ...(view.exitedAt === undefined ? {} : { exitedAt: view.exitedAt }),
    }
    this.#deps.state.write(record)
  }

  /**
   * 拒绝一个请求（计数 + 视图）。
   * @param name 托管项名。
   * @param reason 原因码。
   */
  #refuse(name: string, reason: HostReason): HostedView {
    this.#counts.refusals += 1
    return { name, phase: 'idle', restarts: 0, reason, detail: describeReason(reason) }
  }

  /**
   * 起不来（计数 + 视图）。
   * @param name 托管项名。
   * @param reason 原因码。
   * @param detail 具体原因。
   * @param restarts 已重启次数（**如实带出**：丢掉它会让统计里少算一次重启）。
   */
  #fail(name: string, reason: HostReason, detail: string, restarts: number): HostedView {
    this.#counts.refusals += 1
    this.#deps.log.error('托管项起不来：%s —— %s', name, detail)
    return {
      name,
      phase: 'failed',
      restarts,
      reason,
      detail: `${describeReason(reason)}（${detail}）`,
    }
  }
}

/**
 * 异常折成一句。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
