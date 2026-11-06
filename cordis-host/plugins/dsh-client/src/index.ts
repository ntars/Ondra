/**
 * `dsh-client` 插件入口。
 *
 * 按 Cordis 的插件契约暴露：`name` 固定，`apply(ctx, config)` 在装载时执行。
 * 插件把 {@link DshClient} 挂成上下文服务 `ctx.dsh`，其余插件通过服务键访问，
 * 而不是各自 spawn 一份内核——那会导致多个内核进程读写同一批会话文件。
 */

import type { Context } from '@ntars/cordis'
import { DshClient } from './client.js'

/** 服务键。其他插件用 `ctx.dsh` 取用。 */
export const DSH_SERVICE_KEY = 'dsh'

/** 插件名，须与 package.json 的 name 一致，日志里靠它定位。 */
export const name = 'dsh-client'

/** 插件配置。 */
export interface Config {
  /** 内核入口脚本绝对路径。 */
  entryPath: string
  /** Node 可执行文件路径，默认当前进程。 */
  nodePath?: string
  /** 是否在宿主启动时自动拉起内核。默认 true。 */
  autoStart?: boolean
}

/**
 * Cordis 声明：本插件提供的服务。
 *
 * 写成 `provide` 而不是在 apply 里 `ctx.set()`：前者让框架在装载期就知道
 * 服务存在，依赖它的插件才能正确排序；后者只在运行期生效，依赖方可能早于本插件装载。
 */
export const provide = [DSH_SERVICE_KEY]

/**
 * 装载插件。
 *
 * @param ctx Cordis 上下文。
 * @param config 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const client = new DshClient({
    entryPath: config.entryPath,
    ...(config.nodePath === undefined ? {} : { nodePath: config.nodePath }),
  })

  // Cordis 4 要求服务必须经 `provide` 注册，直接给上下文赋属性会被框架拒绝
  // （报错 `cannot set property "x" without provide`）。provide 同时把清理动作
  // 挂到当前插件的 effect 上，插件卸载时服务会自动撤销。
  ctx.provide(DSH_SERVICE_KEY, client)

  const shouldAutoStart = config.autoStart ?? true
  if (shouldAutoStart) {
    // 不 await：插件装载应尽快返回，否则内核启动慢会拖住整个宿主启动。
    // 启动失败通过 logger 报告，调用方用 `getState()` 判断可用性。
    void client.start().then(
      (result) => { logInfo(ctx, `dsh 内核就绪：${result.version}`) },
      (error: unknown) => { logError(ctx, `dsh 内核启动失败：${String(error)}`) },
    )
  }

  // 宿主关闭时一并关闭内核。用 Cordis 的 effect 注册清理动作：
  // 它会随插件生命周期自动执行，不依赖自定义事件名——框架并没有 'dispose' 事件。
  // 不注册的话，宿主退出会留下孤儿内核进程。
  ctx.effect(() => () => client.stop())
}

/** 取框架 logger，缺失时退回 stderr。骨架阶段不假设 logger 一定存在。 */
function logInfo(ctx: Context, message: string): void {
  const logger = (ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger
  if (logger?.info !== undefined) logger.info(message)
  else process.stderr.write(`[dsh-client] ${message}\n`)
}

/** 同上，错误级别。 */
function logError(ctx: Context, message: string): void {
  const logger = (ctx as unknown as { logger?: { error?: (msg: string) => void } }).logger
  if (logger?.error !== undefined) logger.error(message)
  else process.stderr.write(`[dsh-client] ${message}\n`)
}
