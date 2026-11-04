/**
 * O-070 `ondra-desktop-mcp`：电脑上的**只读能力面**（进程 / 前台 / 剪贴板元信息 / 文件检索 / 系统状态）。
 * 档位〔研〕。
 *
 * ## 手册给了什么、没给什么
 *
 * master-plan §9.11 逐字：`desktop.processes`（不取命令行）/ `foreground` /
 * `clipboardMeta`（只返回长度）/ `findFiles`（关键词必填、深度 ≤2、≤30 条）/ `sysinfo`，timeout 5s。
 * §9.12 又把旧 UI 的 `endpoint` 判成假字段。
 *
 * **没给**的是：五条数据各自的命令、权限声明、返回字段。
 * 本仓也没有可复用的系统信息服务键（`desktop/packages` 里 `totalmem` 只出现在一个内部统计模块，
 * 不是服务）。所以位置很明确：**能力面 + 隐私整形 + 限频 + 沙箱，数据来源是端口。**
 *
 * 现成来源两个，都只用标准库：
 * - `NodeSysBridge`（`node:os`）→ 只有 `desktop-sysinfo` 真能返回数据；
 * - `FsFindBridge`（`node:fs/promises`）→ 只有 `desktop-find-files`。
 * 其余三个如实报 `unsupported` 并**指路**，不返回空数组假装「没有进程」。
 *
 * ## 为什么工具名是连字符
 *
 * §9.11 写 `desktop.processes`，但 §8.4 要求工具名匹配 `^[a-z][a-z0-9_-]{1,63}$`——
 * 点号不匹配，而 §8.4 明确说「模型侧直接拒绝」。这是**手册内部两条规则的冲突**，
 * 按 §8.4（硬约束 + 有事故教训）优先，统一改成 `desktop-processes` 等。
 *
 * ## 为什么本包不 import `@ntars/ondra-tools`
 *
 * 标准写法是 `inject: ['tools']` + `defineTool()`。两件事都有代价：
 * `inject` 会让上游缺席时**整插件停在 PENDING**（手册 §8.3 的静默失败之一），
 * 而那个包不在本仓任何插件的依赖里，import 它等于赌宿主一定装了。
 *
 * 所以注册做成 `useRegistrar()` 注入：宿主侧把注册能力包一层传进来。
 * **没有注册器时服务照常可用**，只是模型看不见这些工具（与 O-036 / O-069 同口径）。
 */

import type { Context } from '@ntars/cordis'
import { CompositeBridge, FsFindBridge, NodeSysBridge } from './bridge.js'
import { DesktopHub } from './service.js'
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
import { CALL_TIMEOUT_MS, DESKTOP_SERVICE_KEY, TITLE_MAX, TOOL_NAMES } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  DesktopService,
  IdentityLike,
  LogLike,
} from './types.js'

export type * from './types.js'
export {
  DESKTOP_SERVICE_KEY,
  TOOL_NAMES,
  TOOL_KEYS,
  NAME_RE,
  CALL_TIMEOUT_MS,
  DEFAULT_LIMIT,
  LIMIT_CEIL,
  FILE_LIMIT_CEIL,
  FILE_DEPTH_CEIL,
  FILE_SCAN_ENTRY_CEIL,
  KEYWORD_MIN,
  KEYWORD_MAX,
  NAME_MAX,
  TITLE_MAX,
  RENDER_CHARS_MAX,
  RENDER_LINES_MAX,
  BATTERY_LOW,
  BATTERY_CRITICAL,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  DEFAULT_TOOLS,
  DEFAULT_ROOTS,
  FIELD_SPECS,
  SECTION_KEYS,
  LIMIT_FLOOR,
  INTERVAL_CEIL,
  SYSINFO_INTERVAL_CEIL,
  PER_MINUTE_CEIL,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { buildDescriptors, normalizeArgs } from './tools.js'
export type { NormalizedArgs, ArgsVerdict } from './tools.js'
export { bandOf, poseBattery, poseClipboard, poseForeground, poseHit, poseProcess, poseSysinfo, truncate } from './privacy.js'
export { renderLines } from './sandbox.js'
export type { RenderResult } from './sandbox.js'
export { CompositeBridge, FsFindBridge, NodeSysBridge } from './bridge.js'
export { DesktopHub } from './service.js'
export type { DesktopHubDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-desktop-mcp'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-desktop-mcp: 注册配置段')
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

declare module '@ntars/cordis' {
  interface Context {
    /** 电脑只读能力；未装载本插件时为 undefined。 */
    'ondra-desktop-mcp'?: DesktopService
  }
}

/**
 * Cordis 入口：解析配置、接数据来源、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.desktop.mcp`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('desktop.mcp') : 'ondra.desktop.mcp')

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

  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  // 2. 数据来源：两个标准库实现拼起来。顺序即优先级（这里没有重叠能力）。
  const bridge = new CompositeBridge([new NodeSysBridge(), new FsFindBridge()])

  const hub = new DesktopHub({ settings, log, now, bridge, registrar: null })

  // 3. 注册服务。撤服务时顺带把已注册的工具撤干净（不留幽灵注册）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(DESKTOP_SERVICE_KEY, hub)
      return () => {
        hub.useRegistrar(null)
        dispose()
      }
    },
    'ondra-desktop-mcp: 注册电脑只读能力服务',
  )

  // 4. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('电脑只读能力默认关闭（enable=false）：打开后模型才能看到这 %d 个只读工具', settings.enabledTools.length)
  } else if (settings.enabledTools.length === 0) {
    log.warn('开关开着但 enabledTools 是空的：一个工具都不会暴露（这是你显式关掉的结果，不是故障）')
  } else {
    log.info(
      '电脑只读能力已打开：%s（超时 %d 毫秒）',
      settings.enabledTools.map(key => TOOL_NAMES[key]).join(' / '),
      settings.callTimeoutMs,
    )
  }

  if (!settings.enabledTools.includes('findFiles')) {
    log.info('文件检索默认关闭：它是唯一会走出固定范围遍历磁盘的能力，要开请显式加到 enabledTools')
  } else {
    log.info('文件检索开着：根目录 %s（深度 %d，最多 %d 条）', settings.findRoots.join(' / ') || '（空）', settings.findDepth, settings.findLimit)
  }
  if (settings.includeWindowTitle) {
    log.info('窗口标题会返回（截断 %d 字）：标题里常有文档名与网址，介意就关掉 include-window-title', TITLE_MAX)
  }
  if (!settings.maskPaths) {
    log.warn('mask-paths 已关闭：文件检索会返回带用户名的绝对路径')
  }
  if (!settings.batteryEvents) {
    log.info('电量事件已关闭：手册 §14 那条「低电量时她该有反应」的链会断开')
  }

  log.info(
    '工具名用连字符（desktop-processes 等）：手册 §9.11 写成点号形式，' +
      '但 §8.4 要求工具名匹配 ^[a-z][a-z0-9_-]{1,63}$，点号会被模型侧拒绝',
  )
  log.info(
    '本包不 import @ntars/ondra-tools：注册走 useRegistrar() 注入。' +
      '没有注册器时服务照常可用，只是模型看不见这些工具（见 README 已知限制 2）',
  )
  log.info('数据来源：%s（进程/前台/剪贴板如实报 unsupported 并指路）', bridge.id)
  if (settings.callTimeoutMs !== CALL_TIMEOUT_MS) {
    log.info('调用超时被改成 %d 毫秒（§9.11 实测值是 %d）', settings.callTimeoutMs, CALL_TIMEOUT_MS)
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
