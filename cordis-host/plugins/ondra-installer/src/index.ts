/**
 * O-079 `ondra-installer`：**清单制九步安装**。档位〔研〕。
 *
 * ## 它为什么必须是自研
 *
 * 手册 §1.8 的「必须自研」清单里没有安装器，但手册 §4.6 把它的问题点得很细：
 * 旧项目的 `manifest.ts` 是平铺 `NODE_ARTIFACTS`，「**只有哈希、无记账本、无自检命令**」。
 * 生态里没有「带记账本 + `bootstrap-ok` 的 Cordis 插件」可直接复用——插件市场管的是
 * 插件包安装，不是运行时组件安装，语义不同。所以按〔研〕写，但**只写差异部分**：
 * 文件复制、爬哈希、原子改名全用 Node 内建，不引任何依赖。
 *
 * ## 三条它刻意不做的事
 *
 * 1. **不猜路径。** `manifestPath` / `sourceDir` / `destDir` 默认全空，空着就如实报
 *    `no-manifest` / `no-source` / `no-dest`。猜出来的目标目录会在用户机器上凭空长出一棵树。
 * 2. **不自动回滚。** 装失败就停在失败处，已装成功的文件保留。回滚属 O-009 快照还原——
 *    一个会自己删文件的安装器，第二次误删就没人敢用了。
 * 3. **不解压归档。** 本仓禁装依赖，`node:zlib` 只认 gzip/deflate，不认 zip/tar。
 *    所以 `kind: archive` 的组件在 `install` 步如实报「不支持」，**不假装解开**。
 *
 * ## 默认演练
 *
 * `dryRun: true` 是默认值。安装是唯一会写用户目录的能力，把不可逆操作放到
 * 明确的第二次确认之后，符合 master-plan §12 的「正确 > 稳定」。
 */

import { resolve } from 'node:path'
import type { Context } from '@ntars/cordis'
import { Installer } from './service.js'
import { LedgerStore } from './ledger.js'
import { LocalRuntime, LocalSink, LocalSource } from './local.js'
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
import { INSTALLER_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  InstallerService,
  LogLike,
  PathLayoutLike,
} from './types.js'

export type * from './types.js'
export { INSTALLER_SERVICE_KEY, COMPONENT_KINDS, NAME_RE, STEP_IDS } from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  LEDGER_FILE,
  MAX_COMPONENT_BYTES,
  MAX_COMPONENTS,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { hashFile, isSha256Hex, sha256OfBytes, sha256OfText } from './hash.js'
export { MAX_DEPTH, digestOf, isSafeRelative, parseManifest } from './manifest.js'
export type { ParseOptions } from './manifest.js'
export { LEDGER_VERSION, LedgerStore, emptyLedger, findComponent, ledgerPaths, upsert } from './ledger.js'
export type { LedgerRead } from './ledger.js'
export { STEP_DECLS, destPathOf, runPipeline } from './steps.js'
export type { PipelineDeps, StepDecl } from './steps.js'
export { LocalRuntime, LocalSink, LocalSource } from './local.js'
export { Installer } from './service.js'
export type { InstallerDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-installer'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-installer: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 清单制安装器；未装载本插件时为 undefined。 */
    'ondra-installer'?: InstallerService
  }
}

/**
 * Cordis 入口：解析配置、装三个本地端口、注册服务。**不自动安装、不建定时器**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.installer`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('installer') : 'ondra.installer')

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

  // 2. 三个本地端口。来源目录没配就不建（`reason` 会如实报 `no-source`）。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const store = new LedgerStore(layout ?? null, settings.ledgerPath, log)
  let source: LocalSource | null = null
  if (settings.sourceDir !== '') {
    try {
      source = new LocalSource(resolve(settings.sourceDir))
    } catch (error) {
      log.warn('来源目录不可用：%s', textOf(error))
    }
  }
  const sink = new LocalSink()
  const runtime = new LocalRuntime()

  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  const service = new Installer({
    settings: () => settings,
    log,
    now,
    store,
    source,
    sink,
    runtime,
  })

  // 3. 注册服务（经 `ctx.effect`，卸载即撤销）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(INSTALLER_SERVICE_KEY, service)
      return () => {
        service.dispose()
        dispose()
      }
    },
    'ondra-installer: 注册安装器服务',
  )

  // 4. 报一次现状。**只报，不拦，不自动装。**
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被类型不符丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  const status = service.status()
  if (!settings.enable) {
    log.info('安装器关着：`run()` 直接拒绝，`verify()` 仍可读账本')
    return
  }
  if (status.reason !== undefined) {
    log.warn('安装器还装不了（%s）：见 README「配置」一节', status.reason)
    return
  }

  const existing = store.read()
  if (existing.corrupt) {
    log.warn('账本读不懂，已按「没有账本」处理：下次安装会把所有组件重装一遍')
  } else if (existing.ledger === undefined) {
    log.info('还没有账本：第一次安装会写一份到 %s', status.ledgerPath ?? '（内存）')
  } else {
    log.info(
      '账本 %d 条%s',
      existing.ledger.components.length,
      existing.ledger.bootstrapAt === undefined ? '，但没完成过一整轮' : '，上一轮已完成',
    )
  }

  log.info(
    '安装器就绪%s：来源 %s → 目标 %s',
    settings.dryRun ? '（**演练模式**，不写盘）' : '',
    settings.sourceDir,
    settings.destDir,
  )
  if (settings.dryRun) {
    log.info('要真装：把 `dryRun` 关掉，再调 `run()`')
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
      // 全部字段都能安全补全（越界夹紧、类型不符回退并计数），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
