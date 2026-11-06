/**
 * O-076 `ondra-privacy`：**出站清单 + 合规告知 + 三层风控提醒**。档位〔研〕。
 *
 * ## 它解决的不是「加密」，是「你不知道数据去哪了」
 *
 * 手册 §9.4 只有一段：vision 默认关闭、出站前提示、桌面感观刻意不暴露项、日记本地化。
 * 这一段里能落成代码的只有一件：**出站前说清楚**。所以本包不加密（master-plan §17-3
 * 已裁「不给记忆库加密」）、不做代理、不做网络拦截——它只回答一个问题：
 *
 * > 这一次，能不能发？发给谁？谁点过头？
 *
 * ## 为什么不做「出站网关」
 *
 * 做成网关（所有请求都过本包转发）看起来更彻底，但会立刻长出第二条密钥通路：
 * 值必须经过本包才能发出去，于是它进了本包的内存、错误上下文、乃至日志。
 * O-035 已经因为同一个理由把「密钥注入」改成「存在性预检 + 引用登记」。
 * 本包沿用那个口径：**只登记变量名，值永不经过这里**。
 *
 * ## 为什么关掉闸门仍然拦红线
 *
 * 见 `egress.ts` 的 `evaluateWith`：`enable=false` 只取消「告知与确认」，
 * 密钥出域 / 凭据写成值 / 未声明主机 / 未登记能力这四件事**照样拒**。
 * 一条能被开关关掉的红线，等于没有。
 *
 * ## 不注册任何工具
 *
 * 「我要不要同意把截图发出去」是**人**的动作。让模型能自己 `grant()`，
 * 告知就退化成自问自答，而日志里写着「用户已同意」（与 O-072 的
 * `approve()` 刻意不做成工具是同一条理由）。
 */

import type { Context } from '@ntars/cordis'
import { PrivacyGate } from './service.js'
import { ConsentStore } from './consent.js'
import { FileLedger } from './ledger.js'
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
import { PRIVACY_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  ConsentLedger,
  IdentityLike,
  LogLike,
  PathLayoutLike,
  PrivacyService,
} from './types.js'

export type * from './types.js'
export {
  PRIVACY_SERVICE_KEY,
  NAME_RE,
  CREDENTIAL_REF_RE,
  PAYLOAD_KINDS,
  APPROVAL_MODES,
  MAX_SPECS,
  MAX_HOSTS_PER_SPEC,
  CONSENT_TTL_MS,
  SAMPLE_MAX_CHARS,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  TTL_MAX_MS,
  approvalModeOf,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { ConsentStore, FORMAT_VERSION, consentKeyOf, parse, serialize, splitKey } from './consent.js'
export type { ConsentLogLike, ConsentStoreDeps, GrantOutcome } from './consent.js'
export {
  MAX_HITS,
  evaluateWith,
  hostAllowed,
  hostMatches,
  normalizeHost,
  normalizeHostPattern,
  scanSecrets,
  specIssue,
} from './egress.js'
export type { EvalFacts, ScanResult } from './egress.js'
export { FileLedger, codeOf } from './ledger.js'
export { TIERS, buildNotice } from './notice.js'
export { PrivacyGate } from './service.js'
export type { PrivacyDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-privacy'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-privacy: 注册配置段')
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
    /** 出站闸门；未装载本插件时为 undefined。 */
    'ondra-privacy'?: PrivacyService
  }
}

/**
 * Cordis 入口：解析配置、装账本、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.privacy`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('privacy') : 'ondra.privacy')

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

  // 2. 账本：路径归 O-002。缺席 = 只放内存（重启会重新问，如实上报）。
  let ledger: ConsentLedger | null = null
  let ledgerDisplay: string | undefined
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  if (layout !== undefined) {
    try {
      // `prepareFile` 负责建父目录并以 0600 建文件（权限真源在 O-002）。
      const file = layout.prepareFile(layout.fileIn('user', 'privacy', 'consent.json'))
      ledgerDisplay = 'user/privacy/consent.json'
      ledger = new FileLedger(file, ledgerDisplay, log)
    } catch (error) {
      log.warn('同意账本建不出来，退回内存（重启会重新问一遍）：%s', textOf(error))
    }
  } else {
    log.warn('没有 ondra-path-layout：同意只存在内存里，重启会重新问一遍')
  }

  // 3. 时钟：每次现取（上游晚装载能自愈）。
  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  const store = new ConsentStore({ ledger, now, log })
  const gate = new PrivacyGate({
    settings: () => settings,
    log,
    now,
    store,
    ledgerDisplay: () => ledgerDisplay,
  })

  // 4. 注册服务。
  ctx.effect(
    () => {
      const dispose = ctx.provide(PRIVACY_SERVICE_KEY, gate)
      return () => {
        gate.dispose()
        dispose()
      }
    },
    'ondra-privacy: 注册出站闸门服务',
  )

  // 5. 报一次现状。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.warn('隐私闸门关着：不做告知与确认。**红线仍然拦**（密钥出域 / 未声明主机 / 未登记能力）')
  } else {
    log.info(
      '隐私闸门已开（档位 %s）：出站清单为空时，任何 evaluate() 都会被拒——等能力方 declare()',
      settings.approvalMode,
    )
  }

  if (!settings.strictHosts) {
    log.warn('strictHosts 关着：目标主机不在声明清单里时只问一次，不再直接拒')
  }

  log.info('不注册任何工具：同意是人的动作，模型不该能自己点头')
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
