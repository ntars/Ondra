/**
 * O-069 `ondra-device-mcp`：手机上的**只读能力面**（通知 / 短信 / 联系人 / 电量 / 前台）。
 * 档位〔研〕。
 *
 * ## 手册给了什么、没给什么
 *
 * master-plan §9.11 逐字：`device.notifications / sms / contacts / battery /
 * foreground，全只读，timeout 8s`。§9.12 又把旧 UI 的 `endpoint` 判成假字段。
 *
 * **没给**的是：五条数据各自的读取命令、权限声明、返回字段。
 * 本仓也没有可复用的设备信息服务键（`cordis/` 与 `desktop/packages` 都没有）。
 *
 * 所以本包的位置很明确：**能力面 + 隐私闸门 + 超时 + 降级，数据来源是端口。**
 * 现成来源只有一个——O-068 `ondra-adb` 的 `readSms()`，故默认只有 `device-sms`
 * 真正能返回数据；其余四个如实报 `unsupported`，**不返回空数组假装「没有通知」**。
 *
 * ## 为什么工具名是连字符
 *
 * §9.11 写 `device.notifications`，但 §8.4 要求工具名匹配
 * `^[a-z][a-z0-9_-]{1,63}$`——点号不匹配，而 §8.4 明确说「模型侧直接拒绝」。
 * 这是**手册内部两条规则的冲突**，按 §8.4（硬约束 + 有事故教训）优先，
 * 统一改成 `device-notifications` 等。台账备注与简报都已记这一条。
 *
 * ## 为什么本包不 import `@ntars/ondra-tools`
 *
 * 注册工具的标准写法是 `inject: ['tools']` + `defineTool()`。两件事都有代价：
 * `inject` 会让上游缺席时**整插件停在 PENDING**（手册 §8.3 的静默失败之一），
 * 而 `dsh-tools` 不在本仓任何插件的依赖里，import 它等于赌宿主一定装了。
 *
 * 所以注册做成 `useRegistrar()` 注入：宿主侧把 `ctx.tools.register` 包一层传进来，
 * 本包按描述表逐个注册。**没有注册器时服务照常可用**，只是模型看不见这些工具。
 * 与 O-036 / O-037 的口径一致：宁可少一个入口，不可让整包静默不加载。
 */

import type { Context } from '@ntars/cordis'
import { AdbSmsBridge } from './bridge.js'
import { DeviceHub } from './service.js'
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
import { CALL_TIMEOUT_MS, DEVICE_SERVICE_KEY, TOOL_NAMES } from './types.js'
import type {
  AdbLike,
  ClockLike,
  ConfigSchemaLike,
  DeviceService,
  IdentityLike,
  LogLike,
} from './types.js'

export type * from './types.js'
export {
  DEVICE_SERVICE_KEY,
  TOOL_NAMES,
  TOOL_KEYS,
  NAME_RE,
  CALL_TIMEOUT_MS,
  DEFAULT_LIMIT,
  LIMIT_CEIL,
  CONTACT_LIMIT_CEIL,
  SMS_BODY_MAX,
  TITLE_MAX,
  QUERY_MIN,
  QUERY_MAX,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  DEFAULT_TOOLS,
  FIELD_SPECS,
  SECTION_KEYS,
  LIMIT_FLOOR,
  BODY_FLOOR,
  BODY_CEIL,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { buildDescriptors, normalizeArgs, keyOf } from './tools.js'
export type { NormalizedArgs, ArgsVerdict } from './tools.js'
export { maskPhone, truncate, shapeContact, shapeNotification, shapeSms } from './privacy.js'
export type { MaskedPhone } from './privacy.js'
export { AdbSmsBridge, CompositeBridge } from './bridge.js'
export { DeviceHub, mapFailure } from './service.js'
export type { DeviceHubDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-device-mcp'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-device-mcp: 注册配置段')
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
    /** 手机只读能力；未装载本插件时为 undefined。 */
    'ondra-device-mcp'?: DeviceService
  }
}

/**
 * Cordis 入口：解析配置、接数据来源、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.device.mcp`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('device.mcp') : 'ondra.device.mcp')

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

  // 2. 数据来源。只认 O-068 的短信能力（它只有那一条通路）。
  //    **每次现取**：adb 晚装载 / 被卸载都能自愈，不缓存服务对象。
  const adbBridge =
    settings.useAdbForSms
      ? new AdbSmsBridge(() => ctx.get('ondra-adb') as AdbLike | undefined)
      : null

  const hub = new DeviceHub({
    settings,
    log,
    now,
    bridge: adbBridge,
    registrar: null,
  })

  // 3. 注册服务。撤服务时顺带把已注册的工具撤干净（不留幽灵注册）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(DEVICE_SERVICE_KEY, hub)
      return () => {
        hub.useRegistrar(null)
        dispose()
      }
    },
    'ondra-device-mcp: 注册设备能力服务',
  )

  // 4. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('手机只读能力默认关闭（enable=false）：打开后模型才能看到这 %d 个只读工具', settings.enabledTools.length)
  } else if (settings.enabledTools.length === 0) {
    log.warn('开关开着但 enabledTools 是空的：一个工具都不会暴露（这是你显式关掉的结果，不是故障）')
  } else {
    log.info(
      '手机只读能力已打开：%s（超时 %d 毫秒）',
      settings.enabledTools.map(key => TOOL_NAMES[key]).join(' / '),
      settings.callTimeoutMs,
    )
  }

  if (!settings.enabledTools.includes('contacts')) {
    log.info('通讯录默认关闭：它是唯一「一次能拿走一群人」的能力，要开请显式加到 enabledTools')
  }
  if (settings.maskPhones) {
    log.info('号码默认打码（保留前 3 后 2）；要原文请把 maskPhones 关掉，并想清楚它会进对话记录')
  } else {
    log.warn('maskPhones 已关闭：联系人号码与短信号码会原样进对话与上下文缓存')
  }
  if (!settings.includeNotificationBody) {
    log.info('通知默认不返回正文：通知正文里常有验证码与私信')
  }
  if (adbBridge === null) {
    log.info('没有接任何数据来源（useAdbForSms=false）：服务照常注册，调用会返回 no-bridge')
  } else if (ctx.get('ondra-adb') === undefined) {
    log.warn('没找到 ondra-adb：device-sms 会以 unsupported 结束，其余四个能力本来就没有来源')
  }

  log.info(
    '工具名用连字符（device-notifications 等）：手册 §9.11 写成 device.notifications，' +
      '但 §8.4 要求工具名匹配 ^[a-z][a-z0-9_-]{1,63}$，点号会被模型侧拒绝',
  )
  log.info(
    '本包不 import @ntars/ondra-tools：注册走 useRegistrar() 注入。' +
      '没有注册器时服务照常可用，只是模型看不见这些工具（见 README 已知限制 1）',
  )
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
