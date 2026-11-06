/**
 * O-077 `ondra-startup-check`：**十项加载自检，只判定不拦启动**。档位〔研〕。
 *
 * ## 它验的不是「代码对不对」，是「它到底有没有被装上」
 *
 * 手册 §8.3 列了三条静默失败，全都不报错、不影响启动、界面上也看不出来：
 * 漏 `ondra.bundle.patch`、补丁语义写错、入口字段/名字不对。这三条的坏形态是同一个：
 * **日志干净、进程正常、功能不在**。所以本包的核心是第十项——把宿主那套
 * `applyEntryPatches` 的语义移植过来，算出「宿主会看到的那份入口树」，再看自己在不在里面。
 *
 * ## 只判定不拦启动
 *
 * 台账写得很清楚。所以：
 *
 * - `apply()` **不 await 任何检查**，自检在后台跑，结果只进日志；
 * - 检查失败不改任何配置、不 `disabled` 任何入口、不抛错；
 * - `status().reason` 只有两个：`disabled`（用户关了）与 `no-root`（没配扫描根）。
 *
 * 一个会拦启动的自检，在一次误报之后就会被永久关掉——那比没有自检更糟。
 *
 * ## 为什么 `root` 默认空
 *
 * 见 `settings.ts` 文件头：猜出来的根会让自检对着错的目录跑出「全过」，
 * 那是假的安全感。空着就如实报 `no-root`。
 */

import { resolve } from 'node:path'
import type { Context } from '@ntars/cordis'
import { StartupCheck } from './service.js'
import { FsSource } from './source.js'
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
import { STARTUP_CHECK_SERVICE_KEY } from './types.js'
import type {
  CheckResult,
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PackageSource,
  StartupCheckService,
} from './types.js'

export type * from './types.js'
export {
  STARTUP_CHECK_SERVICE_KEY,
  CHECK_IDS,
  NAME_RE,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  DEFAULT_HOST_KEYS,
  FIELD_SPECS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PACKAGES,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { parseYamlSubset } from './yaml.js'
export { ENTRY_FIELDS, PATCH_ONLY_FIELDS, applyPatches, collectRows, composeEntries } from './compose.js'
export { maskComments, maskFile, scanSources } from './scan.js'
export type { MaskedLine, SourceScan } from './scan.js'
export { TITLES, checkHostLoads, runChecks } from './checks.js'
export type { CheckContext } from './checks.js'
export { FsSource, collectFacts, collectSources, isSafeRelative, looksLikePackage, stripDotSlash } from './source.js'
export type { CollectOptions } from './source.js'
export { StartupCheck } from './service.js'
export type { StartupDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-startup-check'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-startup-check: 注册配置段')
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
 * 把一条检查结果说成一行日志。
 * @param log 日志。
 * @param item 结果。
 */
function reportOne(log: LogLike, item: CheckResult): void {
  const line = `第十项（宿主会不会加载我）→ ${item.verdict}：${item.detail}`
  if (item.verdict === 'pass') log.info(line)
  else if (item.verdict === 'unverifiable') log.warn(line)
  else log.error(line)
  if (item.hint !== undefined) log.warn('指路：%s', item.hint)
  for (const finding of item.findings) log.warn('  · %s', finding)
}

declare module '@ntars/cordis' {
  interface Context {
    /** 加载自检；未装载本插件时为 undefined。 */
    'ondra-startup-check'?: StartupCheckService
  }
}

/**
 * Cordis 入口：解析配置、装读端口、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.startup-check`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('startup-check') : 'ondra.startup-check')

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

  // 2. 读端口：`root` 空 = 不建端口（如实报 no-root，不猜路径）。
  let source: PackageSource | null = null
  if (settings.root !== '') {
    try {
      source = new FsSource(resolve(settings.root), settings.maxFileBytes, log)
    } catch (error) {
      log.warn('读端口建不起来（`root` 不可用）：%s', textOf(error))
    }
  }

  // 3. 时钟：每次现取。
  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  const service = new StartupCheck({ settings: () => settings, log, now, source })

  // 4. 注册服务。
  ctx.effect(
    () => {
      const dispose = ctx.provide(STARTUP_CHECK_SERVICE_KEY, service)
      return () => {
        service.dispose()
        dispose()
      }
    },
    'ondra-startup-check: 注册加载自检服务',
  )

  // 5. 报一次现状。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('加载自检关着：不查任何东西（它只判定，不影响加载）')
    return
  }
  if (source === null) {
    log.warn('`root` 是空的：什么都不扫。把它配成插件包所在的父目录（开发仓里是 `cordis/`）')
    return
  }

  log.info('加载自检就绪：根 = %s，宿主键 %d 个', settings.root, settings.hostKeys.length)

  // 6. 启动期只跑第十项，**不 await**（只判定不拦启动）。
  if (!settings.selfCheck) {
    log.info('启动自检关着（`selfCheck=false`）：需要时手动调 `hostLoads()`')
    return
  }
  let disposed = false
  ctx.effect(
    () => () => {
      disposed = true
    },
    'ondra-startup-check: 卸载标记',
  )
  void service
    .hostLoads(name)
    .then(item => {
      if (!disposed) reportOne(log, item)
    })
    .catch((error: unknown) => {
      // 自检自己崩掉不该影响任何东西。
      if (!disposed) log.warn('启动自检没能跑完：%s', textOf(error))
    })
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
      // 全部字段都能安全补全（越界夹紧、坏条目回退并计数），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
