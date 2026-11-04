/**
 * O-080 `ondra-process-host`：**子进程托管的接线层**。档位〔复〕。
 *
 * ## 为什么是〔复〕而不是台账原标的〔研〕
 *
 * 台账那一行写〔研〕，但它要求的四件事里，**最难的一件（组杀）上游已经做好了**：
 * `ctx.subprocess` 的 `SubprocessHandle.terminate()` 作用于 provider 托管的整个进程范围
 * （POSIX 是 scope、win32 是 job object），`waitForExit()` 观察同一范围。
 * 手册 §1.8 的判定纪律是「**能复用却自研 = 违规**」，所以本包只做接线 + 一层护栏
 * （重启预算、世代号、状态文件），一行进程控制代码都不写。档位差异已登记在台账备注。
 *
 * ## 它到底做什么
 *
 * 1. **托管**：`start()` 把 `argv/cwd/stdio/graceMs` 显式交给上游 `spawn()`；
 * 2. **一次重启**：崩了按 `maxRestarts`（默认 1）重放原请求，用完即 `crash-limit`；
 * 3. **组杀**：`stop()` 调 `terminate()` 再 `waitForExit()`，并把「确认静默」单独报出来；
 * 4. **状态文件**：`user/process-host/<name>.json`（0600、原子写），重启预算跨进程存活。
 *
 * ## 三条它刻意不做的事
 *
 * 1. **不做「父死子活」。** master-plan §12.4 禁止常驻后台服务；脱离父生命周期的进程
 *    在插件卸载后没人收尸，端口被占、pid 过期、下次启动 `EADDRINUSE`。
 * 2. **不写假 pid。** 上游不暴露 pid，拿不到就不建文件（`pidfile-skipped`）。
 * 3. **不自己 `kill`。** 见文件头：作业对象那一层自研等于重写。
 */

import type { Context } from '@ntars/cordis'
import { ProcessHost } from './host.js'
import { FileStateStore } from './state.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as Settings } from './settings.js'
import { PROCESS_HOST_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PathLayoutLike,
  ProcessHostService,
  SubprocessPortLike,
} from './types.js'

export type * from './types.js'
export { PROCESS_HOST_SERVICE_KEY, NAME_RE } from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_COLLECT_BYTES,
  DEFAULT_CONFIG,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_MIN_UPTIME_MS,
  DEFAULT_RESTART_DELAY_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export {
  crashedFast,
  decideRestart,
  describePhase,
  describeReason,
  fileNameOf,
  isValidName,
  probePid,
  summarize,
} from './scope.js'
export { FileStateStore } from './state.js'
export { ProcessHost } from './host.js'
export type { ProcessHostDeps } from './host.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-process-host'

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 取上游子进程端口。
 *
 * 用 `as unknown` 而不是直接 `as`：上游 `spawn` 的 `stdio` 类型比本包的
 * `SpawnSpecLike` 更宽（`'pipe' | 'inherit' | {maxBytes}`），直接断言会被
 * 「类型重叠不足」挡下。这里只取 `spawn` 一个方法，取不到就当没有。
 * @param ctx 宿主上下文。
 */
function portOf(ctx: Context): SubprocessPortLike | null {
  const raw: unknown = ctx.get('subprocess')
  if (raw === undefined || raw === null) return null
  const candidate = raw as { readonly spawn?: unknown }
  if (typeof candidate.spawn !== 'function') return null
  return raw as SubprocessPortLike
}

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-process-host: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 子进程托管；未装载本插件时为 undefined。 */
    'ondra-process-host'?: ProcessHostService
  }
}

/**
 * Cordis 入口：解析配置、装状态库、注册服务。**不自动启动任何进程**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('process-host') : 'ondra.process-host')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 配置：有 O-005 就走四层合并。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  const onBad = (text: string, kind: string): void => {
    log.warn('配置条目已丢弃（%s）：%s', kind, text)
  }
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', textOf(error))
    }
  }
  const settings = completeConfig(effective, onBad)

  // 2. 状态库：没配 `stateDir` 就走 O-002 的 `user/process-host`；两者都缺 → 纯内存。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const state = new FileStateStore(layout ?? null, settings.stateDir, log)

  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  // 3. 上游端口延迟取：`ctx.subprocess` 可能比本插件晚装载，早取会把 null 缓存一辈子。
  const service = new ProcessHost({
    settings: () => settings,
    log,
    now,
    port: () => portOf(ctx),
    state,
  })

  // 4. 注册服务（经 `ctx.effect`，卸载即撤销 + 组杀收尾）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(PROCESS_HOST_SERVICE_KEY, service)
      return () => {
        void service.dispose()
        dispose()
      }
    },
    'ondra-process-host: 注册托管服务',
  )

  // 5. 报一次现状。**只报，不启动任何东西。**
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被类型不符丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('进程托管关着：`start()` 会拒绝，`stop()` 仍可收拾已在跑的东西')
    return
  }
  if (portOf(ctx) === null) {
    log.warn('宿主没有 `subprocess` 服务：托管能力不可用（装 `ondra-subprocess` 才有）')
    return
  }
  if (!state.persistent) {
    log.warn('状态只能放内存：缺 `ondra-path-layout` 且 `stateDir` 为空，重启预算不会跨进程存活')
  }
  log.info('进程托管就绪：重启上限 %d 次，状态目录 %s', settings.maxRestarts, state.pathOf('example') === '' ? '（内存）' : settings.stateDir === '' ? 'user/process-host' : settings.stateDir)
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: Settings } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、类型不符回退并计数），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
