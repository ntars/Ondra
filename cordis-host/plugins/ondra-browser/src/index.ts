/**
 * O-071 `ondra-browser`：浏览器自动化的**护栏与沙箱**。档位〔复〕。
 *
 * ## 「只做接线」到底接哪里（开工前查过，不是猜）
 *
 * 手册 §9.11 对 `browser` 只有一句：「各 27 行左右占位，`enabled` 为真时只 warn『本版未实现』」。
 * 也就是旧项目里它**根本没有实现**。而本仓（`desktop/packages`）里已经有一整套真实实现：
 *
 * ```
 * browser-use/browser-use                    → ctx.browserUse（唯一提供方注册位）
 * experimental/browser-use-playwright-mcp    → Playwright MCP 后端
 * experimental/browser-use-chrome-devtools-mcp → Chrome DevTools 后端
 * experimental/browser-use-stagehand-native  → Stagehand 后端
 * ```
 *
 * 读源码确认：`ctx.browserUse` 只有 `register()` 与 `providerName`，**不提供任何动作**；
 * 动作由各后端以**工具**形式直接交给模型。所以「浏览器自动化」这件事本包**一行都不用重写**——
 * 重写驱动端口等于把仓库里已有的上游再写一遍（手册 §1.8：能复用却自研 = 违规）。
 *
 * 那本包做什么？做宿主后端**不做**的两件事：
 *
 * 1. **红线与目标策略**：Playwright MCP 的 `browser_evaluate` 能在页面里执行任意 JS；
 *    `file://` 与 `127.0.0.1` 也不该由一个陪伴应用随手打开。
 * 2. **结果沙箱**：手册 §10.1 逐字「Playwright 快照 315KB → 5.4KB（98%）」。
 *
 * 这两件事都挂在宿主公开的两个瀑布上（`tools/pre-execute` / `tools/post-execute`）。
 *
 * ## 为什么关着时也要注册服务
 *
 * `enable=false` 时本包不挂监听、不拦不裁，但**服务照常注册**：
 * 面板要能回答「护栏装了吗、浏览器后端是哪个」。
 * 摘掉服务等于让用户失去「它存在但没开」这条信息（与 O-001~O-070 同一口径）。
 */

import type { Context } from '@ntars/cordis'
import { BrowserGuard } from './service.js'
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
import { BROWSER_SERVICE_KEY, TRIM_CHARS, TRIM_LINES } from './types.js'
import type {
  BrowserService,
  BrowserUseLike,
  ConfigSchemaLike,
  HookTarget,
  IdentityLike,
  LogLike,
} from './types.js'

export type * from './types.js'
export {
  BROWSER_SERVICE_KEY,
  NAME_RE,
  DEFAULT_TOOL_PREFIXES,
  DEFAULT_SCRIPT_TOOLS,
  DEFAULT_SCHEMES,
  TRIM_CHARS,
  TRIM_LINES,
  TRIM_CHARS_FLOOR,
  TRIM_CHARS_CEIL,
  TRIM_LINES_FLOOR,
  TRIM_LINES_CEIL,
  PRIVATE_HOSTS,
  PRIVATE_SUFFIXES,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { checkUrl, isBrowserTool, isDeniedHost, isPrivateHost, isScriptTool, judgeTool, parseTarget, scanArgs } from './policy.js'
export { trimText } from './trim.js'
export { installHooks } from './hooks.js'
export type { HookHandles, HookReporter } from './hooks.js'
export { BrowserGuard } from './service.js'
export type { BrowserGuardDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-browser'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-browser: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 把 `ctx` 收成一个「只看得见 `on`」的事件源。
 *
 * 两步转换，各自有理由：
 * 1. **类型**：`tools/pre-execute` 的签名由工具包通过模块增强提供，本仓没有那个依赖；
 * 2. **`this`**：`ctx.on` 是原型方法，脱开 `ctx` 调用会读到空状态（不抛错，只是不生效）。
 * @param ctx 宿主上下文。
 */
function hookTargetOf(ctx: Context): HookTarget {
  const binder = ctx.on as unknown as (event: string, handler: unknown) => () => void
  return {
    on(event, handler) {
      return binder.call(ctx, event, handler)
    },
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 浏览器护栏；未装载本插件时为 undefined。 */
    'ondra-browser'?: BrowserService
  }
}

/**
 * Cordis 入口：解析配置、接事件、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.browser`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('browser') : 'ondra.browser')

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

  // 2. 后端名：每次现取。provider 可能在本插件之后才注册，缓存一次就会永远显示「没后端」。
  const providerName = (): string => {
    const registry = ctx.get('browserUse') as BrowserUseLike | undefined
    if (registry === undefined) return ''
    const value = registry.providerName
    return typeof value === 'string' ? value : ''
  }

  const guard = new BrowserGuard({
    settings,
    log,
    target: hookTargetOf(ctx),
    providerName,
  })

  // 3. 注册服务。撤服务时一并撤掉监听（不留幽灵监听）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(BROWSER_SERVICE_KEY, guard)
      return () => {
        guard.dispose()
        dispose()
      }
    },
    'ondra-browser: 注册浏览器护栏服务',
  )

  // 4. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧（与你设的不一样）：%s', drift.join(' / '))
  }

  const hooks = guard.hooks
  if (!settings.enable) {
    log.info('浏览器护栏默认关闭（enable=false）：不拦也不裁，浏览器按宿主 provider 的配置照常工作')
  } else if (!hooks.pre && !hooks.post) {
    log.warn('护栏开着但两个瀑布都没挂上：浏览器能用，只是没有红线与裁剪（见 README 已知限制 2）')
  } else {
    log.info(
      '浏览器护栏已挂上：pre-execute=%s / post-execute=%s；裁剪预算 %d 字符 / %d 行',
      hooks.pre ? '有' : '无',
      hooks.post ? '有' : '无',
      settings.trimChars,
      settings.trimLines,
    )
  }

  const provider = providerName()
  if (provider === '') {
    log.info('还没有浏览器后端注册（ctx.browserUse 为空）：护栏在位，等一个 provider 就能生效')
  } else {
    log.info('浏览器后端：%s', provider)
  }

  if (!settings.allowScriptExecution) {
    log.info('页面脚本执行默认禁（browser_evaluate 这类工具会被拦）：它能读到用户已登录站点的数据')
  } else {
    log.warn('allow-script-execution 已打开：模型可以在页面里执行任意代码')
  }
  if (settings.allowPrivateHosts) {
    log.warn('allow-private-hosts 已打开：模型可以访问本机与内网地址（127.0.0.1 / localhost / *.local）')
  }
  log.info(
    '本包不实现浏览器驱动：动作归宿主 provider（browserUse + Playwright/DevTools/Stagehand）。' +
      '本包只做红线、目标策略与结果裁剪（见 README 一、职责）',
  )
  if (settings.trimChars !== TRIM_CHARS || settings.trimLines !== TRIM_LINES) {
    log.info('裁剪预算被改成 %d 字符 / %d 行（出厂 %d / %d）', settings.trimChars, settings.trimLines, TRIM_CHARS, TRIM_LINES)
  }
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
      // 全部字段都能安全补全（越界夹紧、坏条目逐条丢弃），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
