/**
 * O-071 `ondra-browser` 的对外契约。**档位〔复〕**（浏览器自动化：生态成熟，只做接线）。
 *
 * ## 开工前查过的生态（决定「接线」接哪里）
 *
 * 本仓**没有** `playwright` / `puppeteer` 依赖（全仓 grep 0 命中），
 * 但宿主自带一整套浏览器能力，而且分成两层：
 *
 * ```
 * desktop/packages/browser-use/browser-use           → ctx.browserUse（唯一提供方注册位）
 * desktop/packages/experimental/
 *   browser-use-playwright-mcp                       → Playwright MCP（自实现 IDENTIFY 那一层不用我们写）
 *   browser-use-chrome-devtools-mcp                  → Chrome DevTools
 *   browser-use-stagehand-native                     → Stagehand（AI 辅助）
 * ```
 *
 * 关键事实（读源码确认，不是猜）：
 *
 * 1. `ctx.browserUse` 只有两件事——`register(name)` 占位、`providerName` 读当前后端名。
 *    **它不提供 navigate / click 这类动作**，动作由各 provider 以**工具**形式直接交给模型。
 * 2. 所以本包**不实现浏览器驱动端口**。写一个「BrowserDriver + no-driver」的假端口，
 *    等于重写一个已经在仓库里的上游（手册纪律：能复用却自研 = 违规）。
 * 3. 真正属于 Ondra 的那一层是**护栏与沙箱**，宿主的 provider 不管这两件事：
 *    - Playwright MCP 的 `browser_evaluate` 能在页面里执行**任意 JS**；
 *    - 浏览器快照是最大的上下文杀手（手册 §10.1：Playwright 快照 315KB → 5.4KB，98%）。
 *
 * 这两件事都落在宿主已经公开的两个瀑布事件上（`desktop/packages/core/tools/src/events.ts`）：
 *
 * ```
 * 'tools/pre-execute'(exec, next)  → allow / deny / ask  （本包在这里拦红线与危险目标）
 * 'tools/post-execute'(exec, result, next) → accept / block（本包在这里裁剪超长结果）
 * ```
 *
 * ## 为什么用 `ctx.on()` 而不 import 工具包的类型
 *
 * `tools/pre-execute` 的类型由 `@ntars/ondra-tools` 通过模块增强提供。
 * 本仓**没有任何插件的依赖里**有那个包（禁装依赖），硬 import 等于赌宿主一定装了；
 * 而不声明 `inject: ['tools']` 是刻意的——`inject` 缺席时整插件停在 PENDING（§8.3）。
 *
 * 所以事件名与处理器签名在 `types.ts` 里做**结构对位镜像**，接入时用一次显式的窄化转换。
 * 代价（上游改签名后要手工同步）写在 README「已知限制」里。
 *
 * ## 工具名从哪来
 *
 * Playwright MCP 的工具名形如 `browser_navigate` / `browser_snapshot`。
 * 本包**不硬编一份完整名单**（上游一升级就漏），而是按前缀认：
 * `browser_` / `browser-` 两条前缀覆盖两种命名习惯，前缀本身可配。
 * 认不出来时最坏结果是「没拦」或「没裁」——两者都不影响浏览器能不能用，
 * 所以这个兜底是安全的（与「拦错」相反）。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const BROWSER_SERVICE_KEY = 'ondra-browser'

/** 名字合规正则（服务键 / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 出厂认作「浏览器工具」的名字前缀。
 *
 * 两条覆盖两种命名习惯：Playwright MCP 用下划线（`browser_navigate`），
 * 某些封装用连字符（`browser-navigate`）。工具名合规正则本身**允许**下划线，所以两种都可能出现。
 */
export const DEFAULT_TOOL_PREFIXES: readonly string[] = Object.freeze(['browser_', 'browser-'])

/**
 * 出厂红线工具：**在页面里执行任意代码**。
 *
 * 为什么它比「点坏一个按钮」严重得多：页面里能读到用户已登录的站点数据、
 * 能发同源请求、能改 DOM 骗下一张快照。而 Ondra 的产品定位是陪伴，
 * 不是「给模型一个任意代码执行入口」。
 */
export const DEFAULT_SCRIPT_TOOLS: readonly string[] = Object.freeze([
  'browser_evaluate',
  'browser_eval',
  'browser_run_code',
  'browser-evaluate',
  'browser-run-code',
])

/** 允许的协议（出厂 http / https）。 */
export const DEFAULT_SCHEMES: readonly string[] = Object.freeze(['http', 'https'])

/** 单次裁剪的字符预算（默认 4000）。 */
export const TRIM_CHARS = 4_000

/** 单次裁剪的行预算（默认 80）。 */
export const TRIM_LINES = 80

/** 字符预算下界：400（再小会把一次快照压成几个标签）。 */
export const TRIM_CHARS_FLOOR = 400

/** 字符预算上界：40000（再大就等于没裁）。 */
export const TRIM_CHARS_CEIL = 40_000

/** 行预算下界：10。 */
export const TRIM_LINES_FLOOR = 10

/** 行预算上界：500。 */
export const TRIM_LINES_CEIL = 500

/**
 * 视为「私有/本地目标」的主机名后缀与整名。
 *
 * 拦住它们不是洁癖：`http://127.0.0.1:8080` 后面往往是用户自己的路由器后台、
 * 数据库控制台、打印机面板——让模型去「看一眼」这类地址，是 SSRF 的入门形态。
 */
export const PRIVATE_HOSTS: readonly string[] = Object.freeze([
  'localhost',
  'localhost.localdomain',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'host.docker.internal',
  'gateway.docker.internal',
])

/** 私有主机后缀（`*.local` / `*.internal` 走内网解析）。 */
export const PRIVATE_SUFFIXES: readonly string[] = Object.freeze(['.local', '.internal', '.lan', '.home'])

/** 认不出的原因（闭集）。 */
export type BrowserReason =
  /** 插件关着。 */
  | 'disabled'
  /** 没有任何浏览器后端注册（`ctx.browserUse.providerName` 为空）。 */
  | 'no-provider'

/** URL 判定结论（闭集）。 */
export type UrlVerdict =
  /** 放行。 */
  | { readonly kind: 'allow' }
  /** 拒绝。 */
  | {
      readonly kind: 'deny'
      /** 原因码。 */
      readonly code: UrlCode
      /** 给模型看的一句话（含替代做法）。 */
      readonly reason: string
    }

/** URL 拒绝原因码（闭集，每个码一个排查方向）。 */
export type UrlCode =
  /** 完全不是 URL（没有协议头）。 */
  | 'not-url'
  /** 协议不在白名单（`file:` / `javascript:` / `data:` / `chrome:` …）。 */
  | 'bad-scheme'
  /** 私有网段 / 本地地址（SSRF 入门形态）。 */
  | 'private-host'
  /** 明确列在拒绝名单里。 */
  | 'denied-host'
  /** 没有主机名（`http://` 后面是空的）。 */
  | 'no-host'

/** 工具调用的判定结论（pre-execute 用）。 */
export type ToolVerdict =
  /** 放行。 */
  | { readonly kind: 'allow' }
  /** 不是浏览器工具，本包不管。 */
  | { readonly kind: 'skip' }
  /** 拒绝。 */
  | { readonly kind: 'deny'; readonly code: ToolCode; readonly reason: string }

/** 工具拒绝原因码。 */
export type ToolCode =
  /** 红线：在页面里执行任意代码。 */
  | 'script-tool'
  /** 参数里的 URL 没过策略。 */
  | 'bad-target'

/** 裁剪方式。 */
export type TrimKind = 'text' | 'snapshot'

/** 裁剪结果。 */
export interface TrimResult {
  /** 裁剪后的正文。 */
  readonly text: string
  /** 原文长度。 */
  readonly before: number
  /** 裁剪后长度。 */
  readonly after: number
  /** 是否发生过裁剪。 */
  readonly trimmed: boolean
  /** 被丢掉的行数。 */
  readonly droppedLines: number
}

/** 事件接入形状（结构对位：只描述本包用到的三件事）。 */
export interface HookTarget {
  /**
   * 挂一个瀑布监听。返回撤除函数。
   *
   * 用 `unknown` 而不是照抄上游签名：本包不 import 工具包的类型，
   * 参数在处理器内部按 `isRecord` 收窄（见 `hooks.ts`）。
   */
  readonly on: (event: string, handler: (first: unknown, second: unknown, third?: unknown) => unknown) => () => void
}

/** 决策（pre-execute 的返回值，结构对位）。 */
export interface PreDecision {
  readonly kind: 'allow' | 'deny'
  readonly reason?: string
}

/** 插件现状。 */
export interface BrowserStatus {
  /** 开关。 */
  readonly enabled: boolean
  /** 能不能用（开关 + 有后端）。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: BrowserReason
  /** 当前后端名（空 = 没有后端）。 */
  readonly provider: string
  /** 两个瀑布是否都挂上了。 */
  readonly hooks: { readonly pre: boolean; readonly post: boolean }
  /** 认作浏览器工具的前缀。 */
  readonly prefixes: readonly string[]
  /** 红线工具名单。 */
  readonly scriptTools: readonly string[]
}

/** 计数。 */
export interface BrowserStats {
  /** 见过的浏览器工具调用数。 */
  readonly seen: number
  /** 放行数。 */
  readonly allowed: number
  /** 拒绝数（按码分桶）。 */
  readonly denied: Readonly<Record<string, number>>
  /** 裁剪过的次数。 */
  readonly trimmed: number
  /** 累计裁掉的字符数。 */
  readonly trimmedChars: number
}

/** 本插件对外提供的服务。 */
export interface BrowserService {
  /** 现在能不能用。 */
  readonly available: boolean
  /** 不能用的原因。 */
  readonly reason?: BrowserReason
  /** 当前后端名（空 = 没有后端）。 */
  readonly provider: string
  /** 两个瀑布是否都挂上了。 */
  readonly hooks: { readonly pre: boolean; readonly post: boolean }
  /**
   * 单独判一个 URL（纯函数）。面板、测试、上游调用都用这一处。
   * @param url 待判 URL。
   */
  check(url: string): UrlVerdict
  /**
   * 单独裁一段文本（纯函数）。
   * @param text 原文。
   * @param kind 体裁（快照与普通文本的裁法不同）。
   */
  trim(text: string, kind: TrimKind): TrimResult
  /** 现状。 */
  status(): BrowserStatus
  /** 计数。 */
  stats(): BrowserStats
}

/* ------------------------------------------------------------------ *
 * 依赖服务的结构对位（不 import 任何 ondra-* 包 / 上游包，master-plan §18.5）
 * ------------------------------------------------------------------ */

/** 日志子集。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/** O-001 的日志名前缀子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/**
 * 宿主 `ctx.browserUse` 的子集：**只读** `providerName`。
 *
 * 刻意不调 `register()`：那是 provider 的职责，而且只有一个名额
 * （重复注册会抛错）。本包是观察者，不是提供方。
 */
export interface BrowserUseLike {
  readonly providerName?: string
}

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly advancedOnly?: boolean
  readonly sensitive?: boolean
  readonly doc?: string
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 的解析结果形状。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 的服务形状。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
