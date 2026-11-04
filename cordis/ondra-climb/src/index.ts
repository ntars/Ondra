/**
 * O-134 `ondra-climb`：群未读积压的补读清单。
 *
 * ## 它在哪一段链路上
 *
 * ```
 * 通道适配器（O-055~O-067）把积压交出来 → 本插件（洗净、判重、限量、排序）
 *   → 私聊回合里拼进提示词 → 她自己决定提不提 → O-042 门控决定这一轮发不发
 * ```
 *
 * ## 明确不做
 *
 * - **不调模型做概括**：摘要是确定性截取（去链接、并空白、句界截断）。
 *   真概括归对话链的模型；在插件里调模型会把延迟与费用绑到每一次爬楼。
 * - **不在群里说话**：`plan({chatKind:'group'})` 恒返回空计划。积压是主人
 *   没看见的话，不是群里该被复读的话。
 * - **不判「此刻能不能发」**：静默时段、额度、冷却全在 O-042。本包只说
 *   「这一轮可以提」，说不说由门控。
 * - **不存群聊原文**：只落游标（读到哪、哪些指纹读过）。重启靠通道重推补齐。
 * - **不装定时器、不订阅事件**：零常驻，所有时刻从入参或 `now()` 取。
 * - **不画界面**：清单视图、未读角标、Toast 全归应用外壳（`desktop/`）。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as ClimbConfig } from './settings.js'
import { Climb, STATE_FILE_NAME } from './service.js'
import { CLIMB_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PathLike,
  ClimbService,
} from './types.js'

export type * from './types.js'
export {
  CLIMB_SERVICE_KEY,
  NAME_RE,
  CHAT_KINDS,
  CLIMB_REASONS,
  REASON_ZH,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  completeConfig,
} from './settings.js'
export {
  buildLines,
  charsOf,
  clipText,
  clockLabel,
  composeText,
  fingerprintOf,
  fnv1a64,
  groupLabel,
  lineOf,
  normalizeItem,
  squeeze,
} from './digest.js'
export type { BuildLimits, LineOptions } from './digest.js'
export {
  GROUPS_MAX,
  SEEN_PER_GROUP,
  STATE_VERSION,
  emptyState,
  keyOf,
  normalizeState,
  readState,
  splitKey,
  writeState,
} from './state.js'
export type { ClimbState, GroupCursor } from './state.js'
export { Climb, STATE_FILE_NAME } from './service.js'
export type { ClimbOptions } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-climb'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-climb: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 爬楼服务；未装载本插件时为 undefined。 */
    'ondra-climb'?: ClimbService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`ondra-path-layout` / `ondra-clock` 缺席时，
 * 正确表现是「降级并告警」，而不是「整个插件停在 PENDING」——
 * 停在 PENDING 会让调用方拿不到 `plan()`，而它连一句原因都说不出。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ClimbConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('climb') : 'ondra.climb')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并（出问题时能说出「哪一层的哪个字段」）。
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

  // 2. 补全 + 夹紧。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  //    服务键都是 Cordis 的字符串重载，类型声明在别的包里，本插件不许 import（§15.5）。
  const climb = new Climb({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => {
      const clock = ctx.get('ondra-clock') as ClockLike | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
  })

  ctx.effect(() => ctx.provide(CLIMB_SERVICE_KEY, climb), 'ondra-climb: 注册爬楼服务')

  // 4. 报一次现状。上限、落盘、待补读都要能被自检读到（§12.2）。
  const view = climb.stats()
  log.info(
    '爬楼就绪：一轮最多 %d 个群 / %d 行 / %d 字 · 单条 %d 字 · 过期 %d 小时 · 游标落盘 %s',
    settings.maxGroups,
    settings.maxItemsPerDigest,
    settings.maxDigestChars,
    settings.maxCharsPerItem,
    settings.maxAgeHours,
    climb.stored ? `是（${STATE_FILE_NAME}）` : '否（重启会重读一遍积压）',
  )
  if (!settings.enable) {
    log.warn('爬楼已关闭（enable=false）：服务照常注册，plan() 一律返回 disabled 的空计划')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (ctx.get('ondra-path-layout') === undefined) {
    log.warn('路径服务未装载：游标只在内存里，重启后会把已经说过的积压再说一遍')
  }
  if (ctx.get('ondra-clock') === undefined) {
    log.info('时间服务未装载：清单里的时刻退回本机时区（跨时区部署时可能差几小时）')
  }
  if (ctx.get('ondra-proactive-gate') === undefined) {
    log.info('主动门控未装载：本包只出清单，发不发由调用方决定（没有门控时请调用方自己守住静默时段）')
  }
  if (view.pending > 0) {
    log.info('启动时已有 %d 条待补读，分布在 %d 个群', view.pending, view.groups)
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: ClimbConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法值回退默认、数值夹紧），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
