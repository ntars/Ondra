/**
 * `ondra-beichen-api`：北辰注册入口的本地铸币与跳转。
 *
 * 三件事，别的一概不做：
 *
 * 1. 在本地生成并保管一枚主密钥（与 EdgeOne 环境变量共用同一个值）；
 * 2. 按 v1 分钟级格式铸令牌，令牌只出现在本地路径参数里；
 * 3. 验签通过后 302 到注册页——**邀请码只在这一跳出现，且永不进日志**。
 *
 * ## 为什么服务在 webServer 缺席时仍然注册
 *
 * Electron 壳用 `file://` + IPC 起界面，不跑 node:http。此时本插件没有路由可挂，
 * 但**服务照常注册**：界面要能回答「北辰入口装了吗、为什么点不动」。
 * 摘掉服务等于让用户失去「它存在但不可用」这条信息——与 O-001~O-070 同一口径。
 *
 * ## 密钥读取失败不阻断启动
 *
 * 磁盘满了、权限被改坏了，都不该让整个应用起不来。失败时 `ready=false`、
 * 记一条 error，入口页路由**不注册**（注册了也只会 500）。
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
  type Config as BeichenConfig,
  type ConfigSchemaLike,
} from './settings.js'
import { fingerprintOf, loadOrCreateSecret, type PathLayoutLike } from './secret.js'
import { signToken, verifyToken } from './token.js'
import {
  createEntryHandler,
  createGotoHandler,
  createHealthHandler,
  type RouteOptions,
} from './routes.js'
import {
  BEICHEN_SERVICE_KEY,
  type BeichenService,
  type EntryHandle,
  type IssuedToken,
  type VerifyResult,
} from './types.js'

export type * from './types.js'
export { BEICHEN_SERVICE_KEY, BeichenError, AFFILIATE_CODE } from './types.js'
export { signToken, verifyToken, deriveMaster, deriveMinuteKey } from './token.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-beichen-api'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** O-001 身份服务的结构对位（只取日志命名空间）。 */
interface IdentityLike {
  loggerName(feature: string): string
}

/** 日志门面的最小形状。 */
interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** node:http 路由（结构对位，不 import 上游 webserver 包）。 */
interface WebServerLike {
  readonly port?: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

/**
 * 内置浏览器服务的结构对位（O-`ondra-browser-pane`）。
 *
 * 软依赖：取不到就降级为「没有面板」，入口页仍可通过 `entry()` 拿到的地址
 * 由调用方自行打开。**不做硬 inject**——那会让本插件在没装面板时停在 PENDING，
 * 表现为「北辰入口装了但完全没反应」，比降级难查得多。
 */
interface BrowserPaneLike {
  registerPage(page: {
    id: string
    title: string
    plugin: string
    path: string
  }): () => void
}

/** 本插件在内置浏览器里登记的页 id。 */
const PANE_PAGE_ID = 'beichen-entry'

declare module '@ntars/cordis' {
  interface Context {
    /** 北辰入口服务；未装载本插件时为 undefined。 */
    'ondra-beichen-api'?: BeichenService
  }
}

/**
 * 构造服务实例。
 * @param secret 主密钥原文。
 * @param config 已补全的配置。
 * @param port 本地端口；未知时为 undefined（入口地址退化为相对路径提示）。
 * @param isReady 就绪判定（路由挂上之后才为真）。
 * @returns 服务实现。
 */
function createService(
  secret: string,
  config: BeichenConfig,
  port: () => number | undefined,
  isReady: () => boolean,
): BeichenService {
  return {
    get ready(): boolean {
      return isReady()
    },
    fingerprint: fingerprintOf(secret),
    issue(): IssuedToken {
      return signToken(secret, Date.now(), config.ttlMinutes)
    },
    verify(token: string, now?: number): VerifyResult {
      return verifyToken(secret, token, now ?? Date.now(), config.ttlMinutes)
    },
    entry(): EntryHandle {
      const issued = signToken(secret, Date.now(), config.ttlMinutes)
      const current = port()
      const host = current === undefined ? '' : `http://127.0.0.1:${current}`
      return {
        entryUrl: `${host}/beichen/entry`,
        token: issued.token,
        expiresAt: issued.expiresAt,
      }
    },
    secret(): string {
      return secret
    },
  }
}


/**
 * 向 O-005 注册配置段。失败不是致命：四层合并用不上，插件实例配置照样能跑。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 是否注册成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-beichen-api: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败，退回插件实例配置：%s', messageOf(error))
    return false
  }
}

/**
 * Cordis 入口：解析配置、加载密钥、注册服务与路由。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: BeichenConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('beichen') : 'ondra.beichen') as unknown as LogLike

  // 1. 配置：有 O-005 走四层合并，没有就用本地校验。
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
    log.info('北辰入口已关闭（enabled=false）：不铸造令牌、不注册路由')
    return
  }

  // 2. 密钥：读不到就以 0600 新建；读写失败只降级，不阻断启动。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  let secret: string
  try {
    secret = loadOrCreateSecret(layout)
  } catch (error) {
    log.error('北辰入口不可用：%s', messageOf(error))
    return
  }

  // 3. 服务与路由。
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  const port = (): number | undefined => webServer?.port
  let ready = false
  const service = createService(secret, settings, port, () => ready)

  const routeOptions: RouteOptions = {
    service,
    ttlMinutes: settings.ttlMinutes,
    siteBaseUrl: settings.siteBaseUrl,
    registerPath: settings.registerPath,
  }

  ctx.effect(() => ctx.provide(BEICHEN_SERVICE_KEY, service), 'ondra-beichen-api: 注册服务')

  if (webServer === undefined) {
    log.warn('宿主没有 webServer 服务：北辰入口的服务已注册，但没有可用的本地页面（Electron 壳下属正常）')
  } else {
    const routes = [
      { path: '/beichen/entry', handler: createEntryHandler(routeOptions) },
      { path: '/beichen/go', handler: createGotoHandler(routeOptions) },
      { path: '/beichen/health', handler: createHealthHandler(routeOptions) },
    ] as const
    for (const route of routes) {
      ctx.effect(
        () => webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
        `ondra-beichen-api: ${route.path}`,
      )
    }
    ready = true
    log.info(
      '北辰入口就绪：本地端口 %s，有效期 %d 分钟，密钥指纹 %s',
      port() === undefined ? '（未知）' : String(port()),
      settings.ttlMinutes,
      fingerprintOf(secret),
    )
    log.info('入口地址形如 http://127.0.0.1:<端口>/beichen/entry —— 页面上不出现任何网址，邀请码只在 302 一跳出现')
  }

  // 4. 登记到内置浏览器。软依赖：面板没装也不影响铸币与路由，只是没有一个
  //    现成的窗口去展示入口页。这一步刻意放在路由之后——页面路径必须先能响应，
  //    登记出去才有意义，否则面板会打开一个 404。
  const pane = ctx.get('ondra-browser-pane') as BrowserPaneLike | undefined
  if (pane === undefined) {
    log.warn('内置浏览器服务未就绪：入口页无法在应用内展示。请确认 ondra-browser-pane 已装载且排在本插件之前')
  } else {
    ctx.effect(
      () => pane.registerPage({
        id: PANE_PAGE_ID,
        title: '开通北辰 API',
        plugin: name,
        // 与 routes 里的注册路径是同一个字符串常量语义；改一处必须改另一处，
        // 所以这里不复用循环变量，直接写在登记处，让搜索 `/beichen/entry` 能一次命中两处。
        path: '/beichen/entry',
      }),
      'ondra-beichen-api: 登记内置浏览器页面',
    )
    log.info('已在内置浏览器登记页面：%s → /beichen/entry', PANE_PAGE_ID)
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 口径与 O-035 一致：**能补的全补，补不了的才报 issue**。
 * 配置错不该让插件不加载，只该让某个字段回退默认并被记下来。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: BeichenConfig } | { readonly issues: readonly { readonly message: string }[] }
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
