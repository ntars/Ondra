/**
 * O-084 `ondra-dev-rebrand`：**改名点位地图 + 逐层重签清单 + 残留审计**。
 *
 * ## 档位：〔薄〕（台账原标〔研〕，本轮按手册 §1.8 下调，理由见下）
 *
 * 手册 §1.8 的纪律是「能复用却自研 = 违规」。这个项动手前先查了生态，
 * 上游把重签这件事已经写完了：
 *
 * - `scripts/verify-macos-signature.mjs`：`codesign` 参数、身份断言、时间戳与 hardened runtime 检查、
 *   公证与 Gatekeeper 校验，一整套；
 * - `scripts/electron-builder-config.mjs`：`identity` / `hardenedRuntime` / `entitlements` /
 *   `signIgnore` / `dmg.sign` / `notarize` 全在配置里，`afterSign` 立刻回验；
 * - `scripts/development-app.ts`：开发包的改名、plist 改写、ad-hoc 重签；
 * - `scripts/product-name.mjs`：显示名的单一真源。
 *
 * 所以本包**不重写任何签名流程**，只做四件上游没有的事：
 * 把散在三处的名字收成一张点位地图、把「逐层重签」编成有序步骤、
 * 把签名输出翻成结构化问题、把「不许动的东西」写成不变量。
 *
 * ## 为什么 `apply()` 不自动 `audit()`
 *
 * `audit()` 要一份包事实，而事实得有人去读 `.app`（解析 plist、跑 `codesign`）。
 * 那些都不该发生在插件进程里。启动时凭空跑一次「没有事实的审计」，
 * 结论只会是 `unverifiable`，然后这条结论会被日志抄一遍，让人开始无视它。
 * 与 O-079「`apply()` 不自动 `verify()`」同一条纪律：**由调用方在需要时调**。
 */

import type { Context } from '@ntars/cordis'
import { RebrandVault } from './service.js'
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
import { REBRAND_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, IdentityLike, LogLike, RebrandService } from './types.js'

export type * from './types.js'
export { REBRAND_SERVICE_KEY } from './types.js'
export {
  BRANCH_VALUES,
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  isReverseDns,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { INVARIANTS, LAYERS, PRESIGNED_RULES, SITES, presignedRuleOf, rebrandSpec } from './spec.js'
export { auditBundle, judgeSignatureDetails, parseSignatureFields } from './audit.js'
export type { AuditContext } from './audit.js'
export { planBuilder } from './branch-builder.js'
export { planManual } from './branch-manual.js'
export { RebrandVault } from './service.js'
export type { RebrandDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-dev-rebrand'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-dev-rebrand: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 品牌与重签规格；未装载本插件时为 undefined。 */
    'ondra-dev-rebrand'?: RebrandService
  }
}

/**
 * Cordis 入口：解析配置、注册服务、报一次规格摘要。**不读文件、不跑命令、不改任何东西**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('rebrand') : 'ondra.rebrand')

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

  const service = new RebrandVault({ settings: () => settings, log })

  // 注册服务（经 `ctx.effect`，卸载即撤销）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(REBRAND_SERVICE_KEY, service)
      return () => {
        service.dispose()
        dispose()
      }
    },
    'ondra-dev-rebrand: 注册品牌与重签服务',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被类型或枚举不符丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('品牌与重签关着：`plan()` 报 `disabled`，`spec()` / `audit()` 仍可用')
    return
  }

  const spec = service.spec()
  const secondary = spec.sites.filter(site => !site.singleSource)
  log.info(
    '改名点位 %d 处（其中 %d 处是名字的副本，不是真源）· 重签 %d 层（%d 层预签不碰）· 不变量 %d 条',
    spec.sites.length,
    secondary.length,
    spec.layers.length,
    spec.layers.filter(layer => layer.action !== 'sign').length,
    spec.invariants.length,
  )

  if (settings.displayName === '') {
    log.info('还没配 `display-name`：`plan()` 只给「先声明品牌名」一步，不替你编名字')
  } else {
    const plan = service.plan()
    log.info(
      '改名计划：分支 %s，%d 步，原因码 %s（`applied` 恒 false——改名发生在打包链里，不在插件进程里）',
      plan.branch,
      plan.steps.length,
      plan.reason,
    )
  }

  log.info(
    '`audit()` 需要调用方提供包事实（plist 字段、图标文件、品牌词、签名输出），本包不自己去读——读 `.app` 要解析 plist 或跑 `codesign`，两件都不该发生在插件进程里',
  )
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
