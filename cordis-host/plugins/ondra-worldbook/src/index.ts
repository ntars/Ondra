/**
 * O-024 `ondra-worldbook`：六层预算 + 常驻段冻结前缀（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 的三档里没有「世界书选择器」。生态里最接近的是
 * SillyTavern 的 lorebook（AGPL，只可读思路、不可复制代码），它给的是
 * 「关键词命中 + 优先级 + 递归」那一套；而本插件的落点是**六层硬分桶预算**，
 * 这套分桶是本仓的产品定案（手册 §1.4 / §2.6 的六个数字），生态里没有。
 * 按 §11 的纪律：机制可以参考，代码独立写；关键词触发与递归不在本插件（归 O-025）。
 *
 * 真正自研的只有三样（其余全是接线）：
 * 1. **六层分桶与「撞限整条丢」**（`layers.ts`）；
 * 2. **常驻段的稳定序**（同文件，防止前缀随话题漂移）；
 * 3. **token 估算的可替换口径**（`meter.ts` + `setMeter()`）。
 *
 * 五条写死在这里、防止下一轮有人顺手改的边界：
 * - **层义不猜**：只有 `l1…l6` 六个桶，语义由作者声明（`types.ts` 文件头第 1 条）。
 * - **总 1600 与六层之和 1480 两个数都保留**，余量 120 不挪用（第 2 条）。
 * - **撞限整条丢，永不切字**（第 3 条）。
 * - **常驻段排序不看分数**，否则前缀每轮都变（第 4 条）。
 * - **不在 `getPromptContext()` 这类每轮都调的地方读盘**（§8.2 反模式②）：
 *   文件只在本插件 `apply()` 与显式 `loadFromFile()` 时读。
 */

import type { Context } from '@ntars/cordis'
import { WorldbookRepository } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as WorldbookConfig } from './settings.js'
import { WORLDBOOK_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PathLayoutLike,
  WorldbookService,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、层 id 表、预算数字），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  ALLOCATED_TOKENS,
  LAYER_BUDGETS,
  LAYER_IDS,
  TOTAL_TOKENS,
  WORLDBOOK_SERVICE_KEY,
} from './types.js'
export { WorldbookRepository } from './service.js'
export type { ServiceDeps } from './service.js'
export { emptyBlock, layerHeading, layerSpecs, packLayers, renderConstant, resolveBudgets } from './layers.js'
export type { PackInput } from './layers.js'
export { charCount, createMeter, digestOf, estimateTokens, foldText } from './meter.js'
export { WorldbookRegistry, describeIssue, isLayerId } from './registry.js'
export {
  CHARS_PER_TOKEN_MAX,
  CHARS_PER_TOKEN_MIN,
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  MAX_ENTRY_TOKENS_MAX,
  SECTION_KEYS,
  clampInteger,
  clampNumber,
  completeConfig,
  meterDoc,
  normalizeFileName,
} from './settings.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-worldbook'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 注册放进 `ctx.effect` 里：段是本插件的资源，卸载时必须一起撤，
 * 否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-worldbook: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 世界书服务；未装载本插件时为 undefined。 */
    'ondra-worldbook'?: WorldbookService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册、按需加载文件。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明后路径服务缺席会让整个插件停在 PENDING，
 * 那时下游拿到的是 `undefined`，分不清「没装世界书」与「世界书插件挂了」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: WorldbookConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(
    identity ? identity.loggerName('worldbook') : 'ondra.worldbook',
  ) as unknown) as LogLike

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

  // 2. 路径：**只经 O-002 取**，不自己拼 `~/.ondra`（缺席则退化成「只在内存里」）。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const filePath = layout === undefined ? undefined : layout.fileIn('user', settings.worldbookFile)
  const fileDisplay =
    layout === undefined ? undefined : layout.display + '/' + settings.worldbookFile

  const repository = new WorldbookRepository({
    config: settings,
    log,
    filePath,
    fileDisplay,
    exists: (path: string) => (layout === undefined ? false : layout.exists(path)),
  })

  ctx.effect(() => ctx.provide(WORLDBOOK_SERVICE_KEY, repository), 'ondra-worldbook: 注册世界书服务')

  // 3. 文件加载放在注册之后：加载失败不影响服务可用性，只影响「有没有条目」。
  if (settings.loadFile) {
    try {
      const result = repository.loadFromFile()
      if (result.issue === undefined) {
        log.info('世界书已从 %s 载入 %d 条', fileDisplay ?? '（内存）', result.loaded)
      } else if (result.issue.code === 'no-file') {
        // 文件不存在是正常状态：只在 debug 说一句，不打 warn 吓人。
        log.debug?.('还没有世界书文件（%s）：先在世界书里登记条目即可', fileDisplay ?? '未配置')
      }
      if (result.rejected.length > 0) {
        log.warn('世界书有 %d 条没通过校验，已跳过（明细见 loadFromFile 返回值）', result.rejected.length)
      }
    } catch (error) {
      // 读盘出任何意外都不许冒泡：世界书是增强能力，挂了主对话照跑（§3.3-3）。
      log.error('加载世界书时出现意外错误：%s', messageOf(error))
    }
  }

  // 4. 报一次现状：六层预算、余量、常驻段多大，都要能被自检与界面读到（§12.2）。
  const stats = repository.stats()
  if (!stats.available) {
    if (stats.reason === 'disabled') {
      log.info('世界书服务已注册但已关闭（enable=false）')
    } else {
      log.info('世界书服务已注册但还没有条目：先登记，或用 %s 文件导入', fileDisplay ?? 'user/worldbook.json')
    }
    return
  }
  log.info(
    '世界书就绪：%d 条（常驻 %d 条），六层预算 %d token，总量上限 %d，余量 %d 不挪用；常驻段 %d token',
    stats.enabled,
    stats.constant,
    stats.allocatedTokens,
    stats.totalTokens,
    stats.slackTokens,
    stats.constantTokens,
  )
  if (stats.constantOverBudget) {
    log.warn('有常驻条目自己就超过了所在层的预算：它们不会被装进提示词（见 pack().dropped）')
  }
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
    ) => { readonly value: WorldbookConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // `completeConfig` 永不抛错：越界值被夹紧、类型错回退默认，都是「能补的」。
      return { value: completeConfig(value) }
    },
  },
}
