/**
 * O-059 `ondra-adapter-qq-napcat`：QQ 的 NapCat / OneBot v11 通道（**高危**）。
 *
 * ## 装载期只做五件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. 算出凭据 / 状态 / 确认档案三个路径；
 * 3. 把能力登记进 `ondra-router`；
 * 4. **真的注册升级路由**（`ctx.webServer.registerUpgrade`）——反向 WS 的入口在这里；
 * 5. `provide` 服务，把「还缺什么才能真的连上」讲清楚。
 *
 * **装载期不连网、不监听自己的端口。** 默认 `enable=false`（§9.11：适配器默认全关）。
 * 打开之后还要 `confirmed`、确认档案、传输实现、凭据四样齐，才真的开始收连接。
 *
 * ## 为什么这里没有 WS 握手代码
 *
 * 手册 §6.1 给了链路与方向（NapCat 主动连入、OneBot v11），但**没有给事件字段、
 * 动作名与帧格式**；本仓 `desktop/docs`、`desktop/packages` 检索 `onebot` 零命中，
 * 且本仓禁装依赖。自己补一版会「看起来能跑」：握手成功、事件收不到，或字段名猜错——
 * 两种都表现为「她不回话」，与「根本没接」同形。
 *
 * 所以接线做到最后一厘米：**升级路由真的注册、socket 真的交出去**，
 * 编解码留给 `NapCatTransport` 端口。`start()` 在端口为空时报 `no-transport`，
 * 路由对任何来信回 503 并写明原因，绝不挂着假监听。
 */

import type { Context } from '@ntars/cordis'
import { NapCatAdapter, conversationOf, parseConversation, rejectUpgrade } from './adapter.js'
import type { LogLike } from './adapter.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
  type Config as Settings,
} from './settings.js'
import type {
  ChannelSpecLike,
  ClockLike,
  ConfigSchemaLike,
  HealthLike,
  HttpRequestLike,
  IdentityLike,
  KitLike,
  NapCatDuplexLike,
  NapCatService,
  PathLayoutLike,
  RouterLike,
} from './types.js'
import {
  CHANNEL_ID,
  CHANNEL_LABEL,
  CONFIRM_FILE_SUFFIX,
  CREDENTIAL_FILE_SUFFIX,
  NAPCAT_SERVICE_KEY,
  RISK_NOTICE_ZH,
  STATE_FILE_SUFFIX,
} from './types.js'

export type * from './types.js'
export {
  NAPCAT_SERVICE_KEY,
  CHANNEL_ID,
  CHANNEL_LABEL,
  NAME_RE,
  CHUNK_MAX,
  CHUNK_CEIL,
  CHUNK_MIN,
  CONTENT_MAX_LEN,
  RISK_CODES,
  RISK_NOTICE_ZH,
  BACKOFF_SECONDS,
  QUIET_START,
  QUIET_END,
  TZ_OFFSET_MIN,
  DEFAULT_LIST_HOST,
  DEFAULT_LIST_PORT,
  DEFAULT_LIST_PATH,
  CREDENTIAL_FILE_SUFFIX,
  STATE_FILE_SUFFIX,
  CONFIRM_FILE_SUFFIX,
  START_FAILURE_ZH,
  GATE_REASON_ZH,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  PORT_MIN,
  PORT_MAX,
  DEDUPE_CEIL,
  COOLDOWN_CEIL,
  JITTER_CEIL,
  STRIKES_CEIL,
  CIRCUIT_CEIL,
  completeConfig,
  configDriftOf,
  parseClock,
  isUsableHost,
  isUsablePath,
} from './settings.js'
export {
  Gate,
  emptyGateState,
  parseGateState,
  hashOf,
  minuteOfDay,
  inQuietHours,
  windowAllows,
  isRiskCode,
  SEEN_LIMIT,
} from './gate.js'
export type { GateDeps, GateInput, GateState, RateWindow, SeenEntry } from './gate.js'
export {
  readToken,
  credentialTemplate,
  maskToken,
  readConfirmRecord,
  writeConfirmRecord,
  emptyConfirmRecord,
} from './credential.js'
export { NapCatAdapter, conversationOf, parseConversation, rejectUpgrade, messageOf } from './adapter.js'
export type { AdapterDeps, LogLike } from './adapter.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-adapter-qq-napcat'

/** 心跳间隔（毫秒）。与 O-058 同值：探针的 `expectMs` 默认按 30 秒看。 */
export const HEARTBEAT_MS = 30_000

/**
 * 宿主的 webServer 服务（结构对位，只声明本插件会用的一条）。
 *
 * 真实签名见 `desktop/docs/subsystems/web-server.zh.md`：
 * `registerUpgrade({ path, handler: (req, socket, head) => void })`。
 */
interface WebServerLike {
  registerUpgrade(route: {
    readonly path: string
    readonly handler: (req: HttpRequestLike, socket: NapCatDuplexLike, head: Uint8Array) => void
  }): () => void
}

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 让定时器不阻止进程退出。
 * @param handle 定时器句柄。
 */
function unrefTimer(handle: ReturnType<typeof setInterval>): void {
  const maybe = handle as unknown as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
}

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-adapter-qq-napcat: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** QQ（NapCat）通道；未装载本插件时为 undefined。 */
    'ondra-adapter-qq-napcat'?: NapCatService
  }
}

/**
 * Cordis 入口：解析配置、算路径、登记能力、注册服务、注册升级路由。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('adapter.qq-napcat') : 'ondra.adapter.qq-napcat')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并。坏条目在这里提示一次。
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
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }
  const settings = completeConfig(effective, onBad)

  // 2. 算三个路径。都必须落在数据根内部（O-002 会拦越界）。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const fileIn = (name: string, suffix: string): string =>
    layout === undefined ? '' : layout.fileIn('user', 'channels', name + suffix)
  const files = {
    token: settings.tokenFile !== '' ? settings.tokenFile : fileIn(CHANNEL_ID, CREDENTIAL_FILE_SUFFIX),
    state: settings.stateFile !== '' ? settings.stateFile : fileIn(CHANNEL_ID, STATE_FILE_SUFFIX),
    confirm: settings.confirmFile !== '' ? settings.confirmFile : fileIn(CHANNEL_ID, CONFIRM_FILE_SUFFIX),
  }

  const webServer = ctx.get('webServer') as WebServerLike | undefined

  const adapter = new NapCatAdapter({
    settings,
    log,
    now: (): number => {
      const clock = ctx.get('ondra-clock') as ClockLike | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
    random: (): number => Math.random(),
    files,
    canAcceptUpgrade: () => webServer !== undefined,
    router: () => ctx.get('ondra-router') as RouterLike | undefined,
    kit: () => ctx.get('ondra-channel-kit') as KitLike | undefined,
    health: () => ctx.get('ondra-channel-health') as HealthLike | undefined,
  })

  // 3. 登记能力。能力表归适配器（master-plan §9.12），公共层不内置。
  ctx.effect(
    () => {
      const router = ctx.get('ondra-router') as RouterLike | undefined
      if (router === undefined) return () => {}
      const spec: ChannelSpecLike = {
        id: CHANNEL_ID,
        label: CHANNEL_LABEL,
        caps: {
          maxChars: settings.chunkMax,
          privateChat: true,
          groupChat: true,
          // 群消息必须被 @ 或命中关键词才回；再退一步要求点名，避免「关键词也回」。
          mentionRequired: true,
          // 只做文字：图/语音/贴纸/文件都还没验证过协议，不写「能发」。
          features: [],
        },
      }
      try {
        const result = router.registerChannel(spec)
        if (!result.ok) {
          log.warn('通道能力登记失败（%s）：不影响收发，但面板会查不到本通道能力', result.reason ?? '未知')
          return () => {}
        }
        return result.dispose ?? (() => {})
      } catch (error) {
        log.warn('通道能力登记抛错：%s', messageOf(error))
        return () => {}
      }
    },
    'ondra-adapter-qq-napcat: 登记通道能力',
  )

  // 4. 注册服务 + 心跳与落盘定时器。卸载时一起撤，不残留 socket / 定时器。
  ctx.effect(
    () => {
      const dispose = ctx.provide(NAPCAT_SERVICE_KEY, adapter)
      const heartbeatTimer = setInterval(() => {
        try {
          adapter.tick()
        } catch {
          // 心跳失败不影响通道。
        }
      }, HEARTBEAT_MS)
      unrefTimer(heartbeatTimer)
      const persistTimer = setInterval(() => {
        try {
          adapter.flush()
        } catch {
          // 落盘失败已由适配器内部计数。
        }
      }, settings.persistMs)
      unrefTimer(persistTimer)
      return () => {
        clearInterval(heartbeatTimer)
        clearInterval(persistTimer)
        adapter.stop()
        dispose()
      }
    },
    'ondra-adapter-qq-napcat: 注册通道服务',
  )

  // 5. 真的注册升级路由。**没有 webServer 时如实说清楚**，不假装在听。
  if (webServer === undefined) {
    log.warn(
      '没有 webServer 服务：反向 WS 的入口注册不上。' +
        'NapCat 连不进来（除非注入的传输实现自带监听器，且 requiresUpgradeRoute=false）',
    )
  } else {
    ctx.effect(
      () => {
        try {
          const dispose = webServer.registerUpgrade({
            path: settings.path,
            handler: (req, socket, head) => {
              try {
                adapter.acceptUpgrade({ url: req.url, headers: req.headers }, socket, head)
              } catch (error) {
                log.warn('升级处理抛错：%s', messageOf(error))
                rejectUpgrade(socket, 500, '升级处理抛错')
              }
            },
          })
          return dispose
        } catch (error) {
          log.error(
            '升级路由注册失败（%s）：%s 可能已被别的插件占用',
            settings.path,
            messageOf(error),
          )
          return () => {}
        }
      },
      'ondra-adapter-qq-napcat: 注册反向 WS 升级路由',
    )
  }

  // 6. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('QQ（NapCat）通道默认关闭（enable=false）：这一路是高危通道，默认关是有意为之')
  } else if (!settings.confirmed) {
    log.warn('通道已打开但 confirmed 不是 true：高危通道要两道闸同时为真才启动')
  } else {
    log.info(
      '启动条件：enable + confirmed + 确认档案（requireConfirmRecord=%s）+ 传输实现 + 凭据，缺一样都会给出原因码',
      String(settings.requireConfirmRecord),
    )
  }

  log.info(RISK_NOTICE_ZH)

  if (settings.allowUsers.length === 0 && settings.allowGroups.length === 0) {
    log.warn('白名单为空 → 她谁也不理。这是高危通道的安全默认值：先填上自己的 QQ 号再打开')
  }
  if (settings.blockPatterns.length === 0) {
    log.info('内容闸正则为空（手册未给三类原文，未编造）：当前只拦「空正文」与「超 %d 字」', settings.contentMaxLen)
  }
  if (!settings.persist) {
    log.warn('防封状态不落盘（persist=false）：重启即清零，等于给防封开后门')
  }
  log.info(
    '反向 WS 是「NapCat 连进本端」：NapCat 侧填 ws://%s:%d%s。若 NapCat 在容器/另一台机器里，127.0.0.1 不成立，必须填宿主可达地址',
    settings.listHost,
    settings.port,
    settings.path,
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
      // 全部字段都能安全补全（越界夹紧、坏正则逐条丢弃、坏地址回退默认），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}

/** 供外部按会话 id 拼发送目标时复用（不复制前缀）。 */
export const toConversationId = conversationOf

/** 供 UI 反解会话 id（`qq-napcat:private:<号>`）。 */
export const fromConversationId = parseConversation
