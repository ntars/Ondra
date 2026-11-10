/**
 * O-081 `ondra-window`：**窗口规格与版本守卫**。档位〔研〕。
 *
 * ## 为什么是〔研〕，以及为什么它不创建窗口
 *
 * 上游 `desktop/packages` 里**没有任何窗口服务键**（全仓 `BrowserWindow` / `titleBarStyle` /
 * `trafficLightPosition` 均 0 命中）——Electron 壳不在这个仓库。既然不能凭空
 * `ctx.get('ondra-browser-window')` 造一个悬空键，本包就退到它确实能做的一层：
 *
 * 1. **规格真源**（`spec.ts`）：48 / 44 / 20 / 19 / 12、三栏 272/≥520/300、五个断点；
 * 2. **两方案分支**（`branch-a.ts` / `branch-b.ts`）：同一接口，各一个文件；
 * 3. **版本边界守卫**（`guard.ts`）：读壳侧补丁，判 `PATCH_EXPECT_ELECTRON` 与版本；
 * 4. **自洽检查**：48 vs 44、25 vs 24、1092 vs 1080 三条口径冲突逐条报出。
 *
 * 「创建窗口」是阻塞点，写进 README「已知限制」第 1 条，**不硬做**。
 *
 * ## 为什么 `apply()` 不自动 `verify()`
 *
 * `verify()` 要读一个外部文件。启动路径上多一次文件读不算贵，但它的结论会被日志抄一遍，
 * 而日志里出现「版本对不上」而窗口其实好好的，会让人开始无视这条检查。
 * 由调用方在需要时调——与 O-079「`apply()` 不自动调 `verify()`」同一条纪律。
 */

import { existsSync, readFileSync } from 'node:fs'
import type { Context } from '@ntars/cordis'
import { PATCH_MARKER } from './guard.js'
import { WindowVault, parseVersions } from './service.js'
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
import { WINDOW_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, IdentityLike, LogLike, TextReader, WindowService } from './types.js'

export type * from './types.js'
export { WINDOW_SERVICE_KEY } from './types.js'
export {
  BRANCH_VALUES,
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  PLATFORM_VALUES,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export {
  BREAKPOINTS,
  COLUMNS,
  DRAG_HEIGHT,
  MIN_WIDTH,
  RIGHT_COLLAPSE_AT,
  TITLE_BAR_HEIGHT,
  TRAFFIC_LIGHT_CENTER_Y,
  TRAFFIC_LIGHT_SIZE,
  TRAFFIC_LIGHT_X,
  TRAFFIC_LIGHT_Y,
  baseSpecOf,
  branchOf,
  hasBlockingIssue,
  platformOf,
  specIssues,
} from './spec.js'
export { PATCH_MARKER, judgePatch, matchesVersion, parseExpectations } from './guard.js'
export type { PatchInput } from './guard.js'
export { BRANCH_A } from './branch-a.js'
export { BRANCH_B } from './branch-b.js'
export { WindowVault, parseVersions } from './service.js'
export type { WindowDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-window'

/**
 * 本地文本读取端口。
 *
 * 只读、不写、不创建目录：本包对磁盘是**纯读者**，所以它不可能弄坏任何东西。
 */
class LocalReader implements TextReader {
  /**
   * 读一个文本文件。
   * @param path 绝对路径。
   */
  read(path: string): string | null {
    try {
      if (!existsSync(path)) return null
      return readFileSync(path, 'utf8')
    } catch {
      // 读不到就是读不到：`judgePatch` 会把它报成 `patch-unreadable`，不猜内容。
      return null
    }
  }
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-window: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 窗口规格与版本守卫；未装载本插件时为 undefined。 */
    'ondra-window'?: WindowService
  }
}

/**
 * Cordis 入口：解析配置、注册服务、报一次规格摘要。**不创建窗口、不读补丁文件**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('window') : 'ondra.window')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

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

  const service = new WindowVault({
    settings: () => settings,
    log,
    platform: () => process.platform,
    reader: new LocalReader(),
  })

  // 注册服务（经 `ctx.effect`，卸载即撤销）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(WINDOW_SERVICE_KEY, service)
      return () => {
        service.dispose()
        dispose()
      }
    },
    'ondra-window: 注册窗口规格服务',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被类型或枚举不符丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('窗口规格关着：`plan()` 报 `disabled`，`spec()` 仍可读')
    return
  }

  // 报一次规格摘要。**不读补丁文件**——`verify()` 由调用方触发。
  const spec = service.spec()
  log.info(
    '窗口规格：%s · 分支 %s · 标题区 %dpx（可拖 %dpx）· 红绿灯 %s(%d,%d) 圆心 %d · 最小宽 %d',
    spec.platform,
    spec.branch,
    spec.titleBar.height,
    spec.titleBar.dragHeight,
    spec.titleBar.trafficLight.mode,
    spec.titleBar.trafficLight.x,
    spec.titleBar.trafficLight.y,
    spec.titleBar.trafficLight.centerY,
    spec.minWidth,
  )

  const warns = service.issues().filter(issue => issue.severity === 'warn')
  for (const issue of warns) {
    log.warn('规格口径（%s）：%s —— 出处：%s', issue.code, issue.message, issue.source)
  }

  if (settings.patchTarget === '') {
    log.info(
      '还没配 `patchTarget`：版本守卫判不了（`no-patch-target`）。壳侧补丁里必须有 `%s="..."`',
      PATCH_MARKER,
    )
    return
  }
  if (parseVersions(settings.expectedVersions).length === 0) {
    log.info('`expectedVersions` 为空：守卫会判 `unverifiable`（不替你声明验证过哪些版本）')
  }
  log.info('壳侧补丁：%s（调 `verify()` 才判定，启动时不读文件）', settings.patchTarget)
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
      // 全部字段都能安全补全（枚举不符回退并计数），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
