/**
 * O-032 `ondra-emotion-project`：情感投影（〔研〕自研）。
 *
 * ## 一句话
 *
 * **情绪的唯一文本出口**：一段「行为指令句 + 一条暗示」，不含数字、不点情绪名。
 *
 * ## 为什么这一项必须自研
 *
 * 手册 §2.6 / §4.3 的出处是 `digital-life-core` 的一个真实事故：
 * 模型每次开口都先复读读数——「我现在能量 80，皮质醇 20，所以……」。
 * 手册给的对策不是「调整提示词」，而是**四层铁律 + 固定模板 + 唯一例外出口**。
 * 生态里没有任何一个库会替你守住「不许报数」这件事，
 * 因为那是**产品口径**，不是技术能力。
 *
 * 本插件真正自研的东西只有三样：
 * 1. 六态的两段模板（`TEMPLATES`）；
 * 2. 护栏词表（数字 / 维度名 / 六态名 / 激素名）；
 * 3. 四道拒绝闸的顺序（开关 → 报数例外 → 无状态 → 模板自检）。
 *
 * ## 与邻居的边界
 *
 * - **不判六态**：状态归 O-031，本插件只 `stateOf()` 读一个字符串。
 *   一旦它也读 mood/energy/tension，就有了「自己再判一次」的能力，那是第二真源。
 * - **不报数**：只读状态出口归应用侧（L8 已下线，不再有插件版 `/status`）。
 * - **不进稳定前缀**：片段 `order` 默认 `+800`（尾部）。手册 §8.5 的前缀缓存
 *   要求「稳定段在头、易变段追加尾部」，情绪每轮都变。
 * - **不 import 任何邻居的源码**（§18.5）：只用结构对位镜像。
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
import type { Config as ProjectConfig } from './settings.js'
import { ProjectRepository } from './service.js'
import { CONSTRAINT_LINE, PROJECT_SERVICE_KEY, STATES, TEMPLATES } from './types.js'
import type { ConfigSchemaLike, ExpressLike, IdentityLike, LogLike, ProjectService } from './types.js'

export type * from './types.js'
export {
  CONSTRAINT_LINE,
  PROJECT_SERVICE_KEY,
  STATES,
  TEMPLATES,
  isStateLike,
} from './types.js'
export { guardText } from './guard.js'
export { CONFIG_SECTION, CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS, SECTION_KEYS } from './settings.js'
export { ProjectRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-emotion-project'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 注册放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤，
 * 否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-emotion-project: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 情感投影服务；未装载本插件时为 undefined。 */
    'ondra-emotion-project'?: ProjectService
  }
}

/**
 * Cordis 入口：接上六态、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`inject: ['ondra-emotion-express']` 会让六态缺席时
 * 整个插件停在 PENDING（静默不加载，宿主只在 stderr 留一行）。
 * 而本插件的正确降级是「照常注册 + 每次现取」：六态缺席时
 * `project()` 返回 `refusal: 'no-state'`，调用方一看就知道「是她的状态拿不到」，
 * 而不是「投影插件没装」——两者的兜底完全不是一回事。
 *
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ProjectConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('emotion-project') : 'ondra.emotion.project') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
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
  const settings = completeConfig(effective)

  // 2. 六态读数用**延迟取值**：装载顺序不确定，构造时拿不到不代表以后拿得到。
  const service = new ProjectRepository(settings, log, () => Date.now(), () => {
    const express = ctx.get('ondra-emotion-express') as ExpressLike | undefined
    return express
  })
  ctx.effect(() => ctx.provide(PROJECT_SERVICE_KEY, service), 'ondra-emotion-project: 注册情感投影')

  // 3. 报一次现状（§12.2：可用性、降级原因都要能被自检读到，不许黑箱）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('情感投影已注册但不可用（%s）：一律不出投影', stats.reason ?? '未知原因')
    return
  }

  const probe = service.project()
  log.info(
    '情感投影就绪：排序 %d（尾部）、存活 %d 分钟、置信度 %s/%s；本次 %s',
    settings.projectionOrder,
    settings.projectionTtlMinutes,
    settings.confidenceMatched.toFixed(2),
    settings.confidenceFallback.toFixed(2),
    probe.allowed ? `产出「${TEMPLATES[probe.state ?? 'calm'].zh}」` : `不出投影（${probe.refusal ?? '未知原因'}）`,
  )
  if (!stats.hasExpress) {
    log.warn('六态服务（ondra-emotion-express）未就绪：投影会一律返回 no-state，调用方需自备兜底文案')
  }
  log.debug?.('本插件认识的状态全集：%s', STATES.map(id => `${id}=${TEMPLATES[id].zh}`).join(' / '))
  log.debug?.('约束句（独立片段，不并入投影正文）：%s', CONSTRAINT_LINE)
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。配置错不该让插件不加载，
 * 只该让某个字段回退默认并被记下来。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: ProjectConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // `completeConfig` 永不抛错：非法值一律回退默认，都是「能补的」。
      return { value: completeConfig(value) }
    },
  },
}
