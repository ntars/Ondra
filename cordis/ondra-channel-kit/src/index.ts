/**
 * O-056 `ondra-channel-kit`：通道公共段（问人格 / 切条 / 对端历史）。
 *
 * ## 装载期只做三件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. `provide` 服务；
 * 3. 把「此刻能做什么、缺什么」逐条打出来。
 *
 * **装载期不做任何调用**：此刻对话链可能还没起来，算出的「没有对话链」
 * 会被当成结论，而它其实只是「那会儿还没装好」（与 O-049 / O-052 同一条纪律）。
 * 所以 `callPersona()` 每次都现取 `ctx.get('ondra-dialogue')`。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * 消费 `ondra-dialogue`（软）/ `ondra-config-schema`（软）/ `ondra-identity`（软）。
 * 全软。声明 `inject` 会让缺一个就整包停 PENDING——而
 * 「为什么通道收得到消息却没人回」的答案就是那个缺席，插件没装载连日志都没有。
 *
 * ## 刻意不读人格、不读记忆、不读情绪
 *
 * 人格四段已经在对话链的**冻结前缀**里（手册 §8.5）。这里再读一次
 * `persona.buildPrompt()`，就会有两个人格通路，而且第二遍会动到已经冻结的
 * 前缀——命中率在一个没人注意的路径上掉下去。这是与手册 §9.11 的
 * 「运行期只取人格服务并调 `buildPrompt?.()`」的**刻意偏离**，
 * 理由写在这里与 README「已知限制」里。
 */

import type { Context } from '@ntars/cordis'
import { ChannelKit } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as KitConfig } from './settings.js'
import { CHANNEL_KIT_SERVICE_KEY, NAME_RE, PEER_HISTORY_LIMIT } from './types.js'
import type { ChannelKitService, ConfigSchemaLike, DialogueLike, IdentityLike, LogLike } from './types.js'

export type * from './types.js'
export {
  CHANNEL_KIT_SERVICE_KEY,
  NAME_RE,
  PEER_HISTORY_LIMIT,
  PEER_TEXT_MAX,
  CALL_FAILURES,
  FAILURE_ZH,
  toConversationId,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  PEER_HISTORY_FLOOR,
  CALL_TIMEOUT_FLOOR,
  CALL_TIMEOUT_CEIL,
  completeConfig,
  configDriftOf,
} from './settings.js'
export { chunkText } from './chunk.js'
export { PeerHistoryBuffer } from './history.js'
export { callPersona, clampTimeout } from './call.js'
export type { CallDeps } from './call.js'
export { ChannelKit } from './service.js'
export type { KitDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-channel-kit'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-channel-kit: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 通道公共段服务；未装载本插件时为 undefined。 */
    'ondra-channel-kit'?: ChannelKitService
  }
}

/**
 * Cordis 入口：解析配置、注册服务、报一次现状。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: KitConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('channel-kit') : 'ondra.channel-kit')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
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

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  const kit = new ChannelKit({
    settings,
    log,
    // **每次现取**：对话链晚装载时能自愈，不需要重启插件。
    dialogue: (): DialogueLike | undefined => ctx.get('ondra-dialogue') as DialogueLike | undefined,
  })

  // 3. 注册服务。卸载即撤销（§3.3-4）。
  ctx.effect(() => ctx.provide(CHANNEL_KIT_SERVICE_KEY, kit), 'ondra-channel-kit: 注册通道公共段服务')

  // 4. 报一次现状。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.warn('通道公共段已关闭（enable=false）：callPersona() 一律给 disabled，服务照常注册')
  } else {
    log.info(
      '通道公共段就绪：对端历史 %d 条 · 单轮超时 %dms · 每通道一份历史（实例归适配器）',
      settings.maxPeerHistory,
      settings.callTimeoutMs,
    )
  }

  if (settings.maxPeerHistory < PEER_HISTORY_LIMIT) {
    log.info(
      '对端历史按配置压到 %d 条（手册上限 %d）：省上下文，代价是「更早那句」会被挤掉',
      settings.maxPeerHistory,
      PEER_HISTORY_LIMIT,
    )
  }

  // 「此刻没有」只报 info：后装载是正常的。
  if (ctx.get('ondra-dialogue') === undefined) {
    log.warn('此刻没有 ondra-dialogue：callPersona() 只能给 no-dialogue（装好之后自动恢复，无需重启插件）')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
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
    ) => { readonly value: KitConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（越界夹紧、非法枚举回退），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
