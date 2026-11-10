/**
 * O-082 `ondra-onboarding`：**四段首启引导的状态机 + 验收基线 + 新手坑诊断**。档位〔研〕。
 *
 * ## 为什么是插件而不是一个安装脚本
 *
 * 台账要的是「四段首启引导」与「宣传片 01 章验收基线」。这两件事在插件层的形态是
 * **状态机 + 判定 + 话术**：谁走到第几段、每一段有没有证据、验收五条各自过没过。
 * 渲染归应用侧，发消息归对话层，装组件归 O-079。
 *
 * 反过来做成一个安装脚本（独立 CLI / 独立前端 / 常驻服务）会同时违反 master-plan
 * §12.4 与手册 §8.3 的插件形态，而且第一件事就是和 O-079 抢「装组件」的活。
 *
 * ## 四段从哪来（必须留痕）
 *
 * 台账写「四段」，手册**没有**展开这个说法（全文检索「四段」只有人格拼装那处）。
 * 本包把 §6.4 的**一键部署四件套**对位成四段：检查 Node≥20 → 复用已装 `ondra` →
 * 挑空闲端口 → 带 token 打开界面。每段 `source` 都标了出处，并在
 * `SEGMENTS_REVERSE_ENGINEERED` 里明写「这是对位，不是手册原文」。
 *
 * ## 它刻意不做什么
 *
 * 1. **不渲染界面。** 那是应用侧的事；硬做一个窗口与 O-081「不创建窗口」的口径分叉。
 * 2. **不发首条消息。** 发了就绕过人设、节奏、防封六道闸。本包只记录「它发了」。
 * 3. **不装组件、不算哈希。** 那是 O-079；重复一份必然分叉，而分叉的表现是
 *    「引导说装好了，安装器说没装」。
 * 4. **不猜人设名。** 首条消息文案取当前人设名，名字由调用方给；没给就报 `no-persona`。
 * 5. **不在加载时 `begin()`。** 开首启会写状态文件；没人点「开始」就不该有副作用。
 */

import type { Context } from '@ntars/cordis'
import { Onboarding } from './service.js'
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
import { FileOnboardingStore } from './store.js'
import { ONBOARDING_SERVICE_KEY, SEGMENTS_REVERSE_ENGINEERED } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  OnboardingService,
  PathLayoutLike,
  PortPickerLike,
} from './types.js'

export type * from './types.js'
export { ONBOARDING_SERVICE_KEY, SEGMENTS_REVERSE_ENGINEERED } from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  DEFAULT_REQUIRED_NODE_MAJOR,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export {
  SEGMENTS,
  SOURCE_NOTE,
  STATUS_PREPARING,
  STATUS_READY,
  STATUS_STOPPED,
  carriesQuery,
  clamp01,
  currentOf,
  declOf,
  describeReason,
  doneCount,
  emptyRecords,
  isLoopbackHost,
  isSegmentId,
  normalizeRecords,
  percentOf,
  phaseOf,
  statusLineOf,
  validateEvidence,
} from './segments.js'
export type { EvidenceVerdict } from './segments.js'
export { acceptanceOf, firstMessageSpecOf, firstMessageTextOf, installerTitleOf } from './acceptance.js'
export type { AcceptanceInput } from './acceptance.js'
export { diagnoseOf } from './diagnose.js'
export { FileOnboardingStore, STATE_VERSION } from './store.js'
export { Onboarding } from './service.js'
export type { OnboardingDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-onboarding'

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 取 O-001 身份（只要产品事实）。取不到就当没有——**不编产品名**。
 * @param ctx 宿主上下文。
 */
function identityOf(ctx: Context): IdentityLike | null {
  const raw: unknown = ctx.get('ondra-identity')
  if (raw === undefined || raw === null) return null
  try {
    const candidate = raw as { readonly product?: unknown }
    const product = candidate.product
    if (typeof product !== 'object' || product === null) return null
    const facts = product as { readonly fullName?: unknown; readonly version?: unknown }
    if (typeof facts.fullName !== 'string' || typeof facts.version !== 'string') return null
    return raw as IdentityLike
  } catch {
    return null
  }
}

/**
 * 取 O-083 挑端口服务。按能力查（有 `pick` 才算），不按包名查。
 * @param ctx 宿主上下文。
 */
function portPickerOf(ctx: Context): PortPickerLike | null {
  const raw: unknown = ctx.get('ondra-port-picker')
  if (raw === undefined || raw === null) return null
  const candidate = raw as { readonly pick?: unknown }
  if (typeof candidate.pick !== 'function') return null
  return raw as PortPickerLike
}

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-onboarding: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 首启引导；未装载本插件时为 undefined。 */
    'ondra-onboarding'?: OnboardingService
  }
}

/**
 * Cordis 入口：解析配置、装状态库、注册服务。**不自动开首启**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = identityOf(ctx)
  const log = ctx.logger(identity ? identity.loggerName('onboarding') : 'ondra.onboarding')

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

  // 2. 状态库：没配 `stateDir` 就走 O-002 的 `user/onboarding`；两者都缺 → 纯内存。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const store = new FileOnboardingStore(layout ?? null, settings.stateDir, log)

  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  // 3. 服务。身份与挑端口都延迟取：它们可能比本插件晚装载。
  const service = new Onboarding({
    settings: () => settings,
    log,
    now,
    store,
    identity: () => identityOf(ctx),
    portPicker: () => portPickerOf(ctx),
  })

  ctx.effect(
    () => {
      const dispose = ctx.provide(ONBOARDING_SERVICE_KEY, service)
      return () => {
        service.dispose()
        dispose()
      }
    },
    'ondra-onboarding: 注册首启引导服务',
  )

  // 4. 报一次现状。**不开首启、不写文件。**
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被类型不符丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('首启引导关着：`begin()` / `advance()` 会返回 `disabled`')
    return
  }

  const progress = service.progress()
  const state = service.state()
  if (state === undefined) {
    log.info('首启还没开始（四段：环境 → 复用 → 端口 → 打开界面）')
  } else if (progress.phase === 'ready') {
    log.info('首启已完成（%s，%d%%）：不会重复打扰', state.runId, progress.percent)
  } else if (progress.phase === 'failed') {
    log.warn('首启停在「%s」：等你处理，本包不会自动重试', progress.current === undefined ? '未知段' : progress.current)
  } else {
    log.info('首启未完成（%d%%）：`begin()` 会接着走，不重置已拿到的证据', progress.percent)
  }

  if (!store.persistent) {
    log.warn('首启状态只能放内存：缺 `ondra-path-layout` 且 `stateDir` 为空，重启后会重新引导')
  }
  if (identity === null) {
    log.warn('缺 `ondra-identity`：安装器标题退回「安装 Ondra」并标 `resolved: false`')
  }
  log.info('四段出处：%s', SEGMENTS_REVERSE_ENGINEERED)
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
