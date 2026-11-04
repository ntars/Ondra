/**
 * O-073 `ondra-minecraft`：Minecraft 接入的**能力入口 + 闸门 + 端口**。档位〔复〕。
 *
 * ## 本版的诚实定位：`skeleton`
 *
 * 台账职责写「Mineflayer 接入（占位）」，档位〔复〕——思路是复用 `mineflayer`、不自写协议。
 * 但本轮开工前查证的三件事决定了它只能是骨架：
 *
 * 1. 手册全文 `minecraft` / `Mineflayer` **0 命中**（没有参数、没有风控口径、没有能力清单）；
 * 2. `desktop/packages/**` 里 `mineflayer|minecraft` **0 命中**，也没有可复用服务键；
 * 3. 本仓禁装依赖，`mineflayer` 不在任何 `dependencies` 里。
 *
 * 所以本版**不写猜参数的连接代码**（那种代码的坏形态是「连上了但什么也收不到」，
 * 与「没连」在界面上完全同形，纪律 101）。做的是三件不需要 Mineflayer 也能做对的事：
 * 话术闸门、文本整形、端口与状态机。
 *
 * ## 为什么这件事比「先随便接一版」更值得做
 *
 * 假设真接上了，风险最高的三处**恰好都不在协议层**：
 *
 * - **聊天长度**超 256 → 服务端不是报错，是直接断开（现象是「她突然掉线」）；
 * - **指令参数**可以塞选择器（`/kill @a` 杀掉全服的人），白名单只回答「指令名许不许」，不够；
 * - **刷屏**会被判异常，而「她的号被服务器封了」是不可逆的。
 *
 * 这三处正好是闸门的职责。所以先做闸门，接驱动时只需要一条 `useDriver()`。
 *
 * ## 出厂：只读状态、一个指令都不许
 *
 * `enabledTools=['status']`、`commandAllowList=[]`。装上之后她能在游戏里「看见」，
 * 但不能说话、更不能发指令——那两条都是以她的名义对**别人**产生影响。
 */

import type { Context } from '@ntars/cordis'
import { MinecraftHub } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  targetOf,
  valuesToConfigShape,
} from './settings.js'
import type { Config as Settings } from './settings.js'
import { CHAT_MAX, MINECRAFT_SERVICE_KEY, TOOL_NAMES } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  MinecraftService,
} from './types.js'

export type * from './types.js'
export {
  MINECRAFT_SERVICE_KEY,
  NAME_RE,
  TOOL_NAMES,
  TOOL_KEYS,
  LINK_STATES,
  CHAT_MAX,
  CHAT_CEIL,
  CHAT_FLOOR,
  COMMAND_MAX,
  SEND_INTERVAL_MS,
  INTERVAL_CEIL,
  PER_MINUTE,
  PER_MINUTE_CEIL,
  CONNECT_TIMEOUT_MS,
  TIMEOUT_FLOOR,
  TIMEOUT_CEIL,
  HOST_MAX,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  DEFAULT_TOOLS,
  FIELD_SPECS,
  SECTION_KEYS,
  PORT_FLOOR,
  PORT_CEIL,
  RECENT_KEEP,
  RECENT_KEEP_CEIL,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  targetOf,
  valuesToConfigShape,
} from './settings.js'
export { commandNameOf, judgeChat, judgeCommand } from './policy.js'
export { sanitize, sanitizeCommand, stripColors } from './sanitize.js'
export { MissingDriver, describeSnapshot, driverReady, normalizeSnapshot } from './driver.js'
export { descriptorOf, textOfArgs, toolKeyOf } from './tools.js'
export { MinecraftHub } from './service.js'
export type { McDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-minecraft'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-minecraft: 注册配置段')
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
    /** Minecraft 接入；未装载本插件时为 undefined。 */
    'ondra-minecraft'?: MinecraftService
  }
}

/**
 * Cordis 入口：解析配置、装服务。**永不阻断宿主**。
 *
 * 刻意**不声明插件级 `inject`**：四个上游（identity / config-schema / clock / 注册器）
 * 全是软依赖，声明成 inject 会让上游缺席时整插件停在 PENDING（手册 §8.3 静默失败）。
 *
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.minecraft`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('minecraft') : 'ondra.minecraft')

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

  // 2. 时钟：每次现取（上游晚装载能自愈）。
  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  const hub = new MinecraftHub({ settings, log, now })

  // 3. 注册服务。撤服务时一并撤掉已注册工具。
  ctx.effect(
    () => {
      const dispose = ctx.provide(MINECRAFT_SERVICE_KEY, hub)
      return () => {
        hub.dispose()
        dispose()
      }
    },
    'ondra-minecraft: 注册 Minecraft 接入服务',
  )

  // 4. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('Minecraft 接入默认关闭（enable=false）：出厂只开放读状态，指令一个都不许')
  } else {
    log.warn(
      '本版是骨架：话术闸门、文本整形与状态机都已就位，但没有 Mineflayer 驱动——' +
        '不会连接、不会假装在线（README 限制 1 写了接入方式）',
    )
    const target = targetOf(settings)
    if (target === null) {
      log.warn('服务器地址或用户名是空的：连也连不了。填 server 与 username 之后才谈得上连接')
    } else {
      log.info('目标服务器：%s:%d（用户 %s，版本 %s）', target.host, target.port, target.username, target.version)
    }
  }

  if (settings.enabledTools.includes('chat')) {
    log.info(
      '发聊天已开放：单条上限 %d 字符（协议上限 %d，超过会被服务端直接断开），间隔 ≥%d 毫秒，每分钟 ≤%d 条',
      settings.chatMax,
      CHAT_MAX,
      settings.minSendIntervalMs,
      settings.maxPerMinute,
    )
  } else {
    log.info('发聊天没开（enabled-tools 里没有 chat）：她不会在游戏里说话')
  }

  if (settings.enabledTools.includes('command')) {
    if (settings.commandAllowList.length === 0) {
      log.warn(
        '指令能力开着但白名单是空的：一个指令都发不出去。这是明确默认，不是故障——' +
          '`/` 是服务器管理员接口，要点名放行',
      )
    } else {
      log.info('允许的指令：%s（不允许选择器与串联字符）', settings.commandAllowList.join(' / '))
    }
  } else {
    log.info('发指令没开（enabled-tools 里没有 command）：这是出厂默认，也是最安全的一档')
  }

  log.info(
    '工具名用连字符（%s）：手册没有给这一项的工具名，是本轮自定并登记待裁决',
    Object.values(TOOL_NAMES).join(' / '),
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
      // 全部字段都能安全补全（越界夹紧、坏条目逐条丢弃），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
