/**
 * O-097 `ondra-grow`：养成系统（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 把四样**已经存在的读数**（相处天数、互动次数、活跃记忆条数、关系阶序）
 * 归一化加权成一条里程分，落进五档（萌芽 / 抽枝 / 成荫 / 开花 / 结果），
 * 并回答两个问题：
 *
 * 1. 「现在到哪一步了」——`view().level` / `levelZh` / `levelDoc`；
 * 2. 「下一步往哪儿走」——`view().hint`，**一句话、不含任何数字**。
 *
 * ## 它刻意不做什么（四条，每条都是踩过的坑）
 *
 * - **不建第二套数值**。养成最诱人的错误是单开一张 `growth_point` 表，
 *   每次对话 +3 分。那样立刻就有三个真源（关系四维 / 记忆条数 / 相处天数），
 *   而且它们会慢慢漂开且**界面上都说得通**。本插件只读不造。
 * - **不报分数、不报比例、不报「还差多少」**。这是内感受铁律（P0 第 3 条）
 *   的同一条道理：一旦可量化，人就开始刷数据，而养成本来要的是「自然过日子」。
 *   `score` 与 `toNext` 留在结构里只给应用外壳画进度条，**不进任何话术**。
 * - **不改关系**。`adjust()` 归 O-029 / O-031；本插件连那个方法都不镜像进契约。
 * - **不画界面、不播报**。`fresh` 只交「刚达成、还没庆祝」的清单，
 *   弹不弹、怎么弹归应用外壳（L8 已下线，插件不补界面）。
 *
 * ## 依赖纪律
 *
 * 三项依赖（阶段 / 记忆 / 时钟）**全是软依赖**，因此刻意不声明插件级 `inject`：
 * 缺席时正确表现是「少一项读数 + 说清少了什么」，而不是整包停在 PENDING——
 * 停在 PENDING 会让 `levels()` 都读不到，看起来像「这个功能没装」。
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
import type { Config as GrowConfig } from './settings.js'
import { Grow } from './service.js'
import { GROW_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  GrowService,
  IdentityLike,
  LogLike,
  MemoryLike,
  PathLike,
  StageLike,
} from './types.js'

export type * from './types.js'
export { GROW_SERVICE_KEY, GROW_LEVELS, LEVEL_SPECS, FACTOR_WEIGHTS, FACTOR_TARGETS, MILESTONES, MILESTONE_SPECS, GrowError } from './types.js'
export { CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS, SECTION_KEYS, CONFIG_SECTION, completeConfig } from './settings.js'
export {
  clamp01,
  countOf,
  factorOf,
  factorsOf,
  scoreOf,
  levelOf,
  nextLevelOf,
  toNextOf,
  hintOf,
  milestoneViewsOf,
  freshOf,
} from './score.js'
export { STATE_FILE, STATE_VERSION, CELEBRATED_MAX, emptyState, normalizeState, readState, writeState } from './store.js'
export { Grow } from './service.js'
export type { GrowDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-grow'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-grow: 注册配置段')
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
    /** 养成服务；未装载本插件时为 undefined。 */
    'ondra-grow'?: GrowService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：三项依赖全软（见文件头）。写进 `inject` 会把
 * 「养成读数少一项」升级成「连五档表都读不到」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: GrowConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('grow') : 'ondra.grow')

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
          // 回退是静默的危险动作：不报数等于埋雷（O-005 原话）。
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
  //    服务键都是 Cordis 的字符串重载，类型声明在别的包里，本插件不许 import（§18.5）。
  const grow = new Grow({
    settings,
    log,
    stage: () => ctx.get('ondra-emotion-stage') as StageLike | undefined,
    memory: () => ctx.get('ondra-memory-core') as MemoryLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(GROW_SERVICE_KEY, grow), 'ondra-grow: 注册养成服务')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱。
  const sample = grow.view()
  log.info('养成就绪：%s（当前「%s」）', sample.available ? '可用' : `不可用（${sample.reason ?? '未知'}）`, sample.levelZh)
  if (sample.missing.length > 0) {
    log.info('养成读数缺这几项上游（按 0 计，不猜）：%s', sample.missing.join(' / '))
  }
  if (!settings.enable) {
    log.warn('养成已关闭（enable=false）：服务照常注册，view() 一律不可用')
  }
  if (!settings.celebrate) {
    log.info('里程碑播报已关闭（celebrate=false）：fresh 恒为空，ack() 仍可用')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。三个字段都是布尔且可安全补全，
 * 因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: GrowConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      return { value: completeConfig(value) }
    },
  },
}
