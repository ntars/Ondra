/**
 * O-098 `ondra-persona-workshop`：人格包工坊（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 两件事，都**只出结构、不出文案**：
 *
 * 1. **体检**（`audit()`）：八项元数据判据，逐项给「过 / 警告 / 不合格 / 跳过」+ 证据 + 该往哪儿改；
 * 2. **派生草案**（`draft()`）：把体检的不合格项翻译成「改哪个文件、哪个位置、为什么」的清单，
 *    外加新包骨架（只有路径）与「必须自己定的三件事」。
 *
 * ## 它刻意不做什么（四条，每条都是红线）
 *
 * - **不写人设包，一个字节都不写**。`cordis/ondra-persona-skills/` 是产品资产（master-plan §17-7），
 *   用户根下的包属于用户。工坊全程只读。
 * - **不生成新包文件**。落盘成 `.skill.zip` 需要 ZIP **编码**（写中央目录 + deflate），
 *   而仓内只有 O-020 自写的**读取**器、没有写入器；禁装依赖、禁引第三方库。
 *   这不是偷懒不做，是当前约束下做不了——写进 README「明确不负责」与「已知限制」。
 * - **不生成文案**。草案里没有一句改写后的句子。写文案是创作，要么归人，
 *   要么归模型（那要走 O-035 网关并计费）；插件自己编的句子会被人当成产品资产抄进包里。
 * - **不做「像不像」的判定**。文笔、OOC、语气一致性需要读正文或跑评测集，
 *   那是 O-118 `ondra-consistency-bench` 与人的事。本插件只判元数据。
 *
 * ## 依赖
 *
 * O-020（有哪些包）是**必须**的，缺席即 `available=false`——连包都列不出来，谈何体检。
 * O-021（包里有几个槽位、几条红线）是**软**的：缺席时那两项记 `skip` 而不是 `fail`，
 * 且 `skip` 不进健康分分母。这个区别是本节最要紧的设计，见 `audit.ts` 的 `scoreOf()`。
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
import type { Config as WorkshopConfig } from './settings.js'
import { Workshop } from './service.js'
import { WORKSHOP_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  CoreLike,
  IdentityLike,
  LoaderLike,
  LogLike,
  WorkshopService,
} from './types.js'

export type * from './types.js'
export {
  WORKSHOP_SERVICE_KEY,
  CHECK_IDS,
  DRAFT_ACTIONS,
  SKILL_CHARS_MIN,
  SKILL_CHARS_MAX,
  TRIGGER_WORDS_MAX,
  PROFILE_FIELDS_MIN,
  MAX_AUDIT,
  WorkshopError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  MAX_PERSONAS_MIN,
  MAX_PERSONAS_MAX,
  completeConfig,
} from './settings.js'
export { auditOf, tallyOf, scoreOf, problemsOf } from './audit.js'
export { draftOf, skeletonOf, mustChangeOf } from './draft.js'
export { Workshop } from './service.js'
export type { WorkshopDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-persona-workshop'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-persona-workshop: 注册配置段')
    return true
  } catch (error) {
    log.warn(
      '向 ondra-config-schema 注册配置段失败（四层合并与来源追溯不可用，退回插件实例配置）：%s',
      messageOf(error),
    )
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 人格包工坊服务；未装载本插件时为 undefined。 */
    'ondra-persona-workshop'?: WorkshopService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：O-020 缺席时正确表现是「服务照常注册 + 说清 no-loader」，
 * 而不是整包停在 PENDING。停在 PENDING 会让 `available=false` 都读不到，
 * 外观上分不清「这个功能没装」与「装了但加载器没起来」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: WorkshopConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('persona-workshop') : 'ondra.persona-workshop')

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

  // 2. 补全。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  const workshop = new Workshop({
    settings,
    log,
    loader: () => ctx.get('ondra-persona-loader') as LoaderLike | undefined,
    core: () => ctx.get('ondra-persona-core') as CoreLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(WORKSHOP_SERVICE_KEY, workshop), 'ondra-persona-workshop: 注册工坊服务')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱。
  const ids = workshop.ids()
  log.info(
    '人格包工坊就绪：%s（可体检 %d 个包）',
    workshop.available ? '可用' : `不可用（${workshop.reason ?? '未知'}）`,
    ids.length,
  )
  if (ctx.get('ondra-persona-core') === undefined) {
    log.info('人格内核（ondra-persona-core）未装载：槽位覆盖与硬红线两项将记为「跳过」，不算不合格')
  }
  if (!settings.enable) {
    log.warn('工坊已关闭（enable=false）：服务照常注册，audit() 会抛 no-loader')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：能补的全补，补不了的才报 issue。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: WorkshopConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      const issues: { message: string }[] = []
      const raw = isRecord(value) ? value : {}
      if (typeof raw['maxPersonas'] === 'number') {
        const max = raw['maxPersonas']
        if (!Number.isInteger(max) || max < 1) {
          issues.push({ message: '配置项 maxPersonas 必须是正整数' })
        }
      }
      if (issues.length > 0) return { issues }
      return { value: completeConfig(value) }
    },
  },
}
