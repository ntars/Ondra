/**
 * `ondra-browser-pane`：只给内置插件用的极简浏览器（宿主半身）。
 *
 * ## 它解决什么问题
 *
 * 北辰注册页、以及后续其他内置插件的调试页，都需要一个「能在应用里看一眼」的地方。
 * 用系统浏览器会把用户弹出应用；用右侧边栏的通用浏览器会带地址栏，用户能自己改地址；
 * 各自开一个 Electron 窗口则是每个插件重复造一遍窗口与隔离策略。
 *
 * 所以收成一层：**一个面板，页面由插件登记，地址不可见也不可改**。
 *
 * ## 两半的分工（必须清楚，否则会找错地方）
 *
 * ```
 * cordis/ondra-browser-pane/            宿主半身：页面注册表、白名单、路由、状态   ← 本文件
 * desktop/packages/client/ui-browser-pane/  界面半身：窗口、iframe、轮询 state
 * ```
 *
 * Cordis 插件跑在 Node 进程，渲染不了任何东西；界面半身是编译期挂进
 * `bundle/web-app/cordis.patch.yml` 的客户端包。这是 Ondra 插件体系的硬约束，
 * 不是本插件的设计选择——所以「浏览器插件」必然是成对的。
 *
 * ## 为什么没有 webServer 也要注册服务
 *
 * Electron 壳用 `file://` + IPC 起界面，不跑 node:http。此时本插件没有路由可挂，
 * 但服务照常注册：界面要能回答「面板装了吗、为什么打不开」。
 * 摘掉服务等于让用户失去「它存在但不可用」这条信息。
 */

import type { Context } from '@ntars/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
  type Config as PaneConfig,
  type ConfigSchemaLike,
} from './settings.js'
import { PaneRegistry } from './registry.js'
import { createPaneHandler } from './routes.js'
import {
  PANE_SERVICE_KEY,
  type AllowResult,
  type BrowserPaneService,
  type PaneOpen,
  type PanePage,
} from './types.js'

export type * from './types.js'
export { PANE_SERVICE_KEY, BrowserPaneError, EXTERNAL_ALLOWLIST, LOCAL_PATH_PREFIXES } from './types.js'
export { PaneRegistry } from './registry.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-browser-pane'

/** 路由前缀。**只在这一处声明**（手册 §7.8 的教训：两处声明必然漂移）。 */
const ROUTE_PREFIX = '/pane'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** O-001 身份服务的结构对位。 */
interface IdentityLike {
  loggerName(feature: string): string
}

/** 日志门面。 */
interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** node:http 路由（结构对位）。 */
interface WebServerLike {
  readonly port?: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

declare module '@ntars/cordis' {
  interface Context {
    /** 内置浏览器服务；未装载本插件时为 undefined。 */
    'ondra-browser-pane'?: BrowserPaneService
  }
}

/**
 * 向 O-005 注册配置段。失败不致命。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 是否注册成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-browser-pane: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败，退回插件实例配置：%s', messageOf(error))
    return false
  }
}

/**
 * Cordis 入口：建注册表、注册服务与路由。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: PaneConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('browser-pane') : 'ondra.browser-pane') as unknown as LogLike

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
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
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }
  const completed = completeConfig(effective)
  for (const issue of completed.issues) log.warn('配置问题（%s）：%s', issue.field, issue.message)
  const settings = completed.config

  if (!settings.enabled) {
    log.info('内置浏览器已关闭（enabled=false）：不注册路由、不提供服务')
    return
  }

  const registry = new PaneRegistry(settings.extraHosts)
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  const port = (): number | undefined => webServer?.port

  const service: BrowserPaneService = {
    registerPage(page: PanePage): () => void {
      const dispose = registry.registerPage(page)
      log.info('登记面板页面：%s（%s）→ %s', page.id, page.plugin, page.path)
      return () => {
        dispose()
        log.info('撤销面板页面：%s', page.id)
      }
    },
    pages(): readonly PanePage[] {
      return registry.pages()
    },
    open(pageId: string): PaneOpen {
      return registry.open(pageId)
    },
    consume(): PaneOpen | undefined {
      return registry.consume()
    },
    allow(url: string): AllowResult {
      return registry.allow(url, port())
    },
  }

  ctx.effect(() => ctx.provide(PANE_SERVICE_KEY, service), 'ondra-browser-pane: 注册服务')

  if (webServer === undefined) {
    log.warn('宿主没有 webServer 服务：面板的服务已注册，但没有可加载的页面（Electron 壳下属正常）')
    return
  }

  ctx.effect(
    () => webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: createPaneHandler({ registry, port, log }),
    }),
    `ondra-browser-pane: ${ROUTE_PREFIX}`,
  )

  log.info(
    '内置浏览器就绪：路由前缀 %s，外部白名单 %s，额外放行 %d 个域名',
    ROUTE_PREFIX,
    ['beichenapi.com', ...settings.extraHosts].join(' / '),
    settings.extraHosts.length,
  )
  log.info('面板不显示地址、不接受输入；首屏只允许本机 /pane/ 与 /beichen/，跳转只放行白名单域名')
}

/**
 * 配置校验器（标准 schema 形状）。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: PaneConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      const done = completeConfig(value)
      const issues = done.issues.map(issue => ({ message: `${issue.field}: ${issue.message}` }))
      if (issues.length > 0) return { issues }
      return { value: done.config }
    },
  },
}
