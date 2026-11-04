/**
 * O-020 `ondra-persona-loader`：人设包的只读加载器（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 的复用档列了「通道 / 语音 / 视觉 / 桌宠 / 市场 / 图标 /
 * 农历 / 记忆底层」，**没有「人设包加载」这一项**；而上游 `dsh-skill` 那套是
 * 「给模型的技能目录」，它的 `SkillDefinition` 里没有 `trigger_words`、
 * 没有「出厂/示例」的角色标记、也没有「五关系变体」的位置——语义对不上，
 * 硬套进去的结果是「人设」变成一堆名字很难看的 skill。
 *
 * 真正自研的只有两样（其余全是接线）：
 * 1. **`.skill.zip` 的读取**：上游只发现目录包与扁平 md（读源码确认），
 *    而本仓不能装依赖，故用 `node:zlib` 读中央目录（`zip.ts`，约 340 行）。
 * 2. **「哪些包算人设、哪个是出厂、同 id 谁胜出」这套判定**（`service.ts`）。
 *
 * 三条写死在这里、防止下一轮有人顺手改的边界：
 * - **人设包只读。** 本插件没有任何写文件调用；`cordis/ondra-persona-skills/`
 *   是产品资产（master-plan §17-7 禁动）。
 * - **不持久化当前人设。** 落盘归 O-005 用户层或界面（§3.3-5 单一真源）。
 * - **`active()` 找不到就是 `undefined`。** 不退回「第一个」——
 *   悄悄换人比报错更伤，用户会以为「我配的那个就长这样」。
 */

import type { Context } from '@ntars/cordis'
import { PersonaRegistry } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as PersonaConfig } from './settings.js'
import { PERSONA_LOADER_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, IdentityLike, LogLike, PathLayoutLike, PersonaLoaderService } from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、id 常量），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  PERSONA_LOADER_SERVICE_KEY,
  PERSONA_ARCHIVE_SUFFIX,
  PERSONA_ID_PATTERN,
  FACTORY_PERSONA_ID,
  SAMPLE_PERSONA_ID,
  PersonaError,
} from './types.js'
export { PersonaRegistry, KNOWN_PERSONA_IDS } from './service.js'
export { META_FILE, SKILL_FILE, defaultBundledDir, listArchives, loadOne, resolveRoots } from './scan.js'
export { parseMeta, normalizeProfile, normalizeSource, resolveId, toIdCandidate } from './meta.js'
export { ZipError, detectWrapper, normalizeRelPath, openZip, readTextEntry } from './zip.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
} from './settings.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-persona-loader'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-persona-loader: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 人设包加载服务；未装载本插件时为 undefined。 */
    'ondra-persona-loader'?: PersonaLoaderService
  }
}

/**
 * Cordis 入口：解析配置、建注册表、扫一遍包、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-path-layout']` 后，
 * 路径服务缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「照常注册 + 分别降级」——随包根不依赖路径服务，缺了只少「用户导入」这一路。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: PersonaConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('persona-loader') : 'ondra.persona-loader') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      // 用户层用 kebab 键交给 O-005（§8.4 只认小写），回来再换成 camel 键。
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

  // 2. 路径服务是**软依赖**：只用来找「用户导入」的那一路，且用来拼用户可见路径。
  const pathLayout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  if (pathLayout === undefined) {
    log.info('没有路径服务（ondra-path-layout）：只扫随包根，用户导入的人设包扫不到')
  }

  const registry = new PersonaRegistry(pathLayout, log, settings, () => Date.now())

  // 3. 首扫放进 effect：扫描是本插件的一次性资源动作，登记成 effect
  //    能让 `getEffects()` 看见它，重载语义也确定。
  ctx.effect(() => {
    registry.refresh()
    return () => undefined
  }, 'ondra-persona-loader: 扫描人设包')

  ctx.effect(() => ctx.provide(PERSONA_LOADER_SERVICE_KEY, registry), 'ondra-persona-loader: 注册人设加载服务')

  // 4. 报一次现状。可用性、根、角色分布、当前人设，都要能被自检读到，不许黑箱（§12.2）。
  const stats = registry.stats()
  const counts = registry.lastCounts()
  if (!stats.available) {
    log.warn(
      '人设加载服务已注册但不可用（%s）：找到 %d 个包，注册 0 个',
      stats.reason ?? '未知原因',
      counts.found,
    )
    return
  }
  log.info(
    '人设就绪：%d 个（出厂 %d / 示例 %d / 用户 %d），扫到 %d 个包、跳过 %d 个，当前人设 %s',
    stats.total,
    stats.byRole.factory,
    stats.byRole.sample,
    stats.byRole.user,
    counts.found,
    counts.skipped,
    stats.activeId ?? '（未设置）',
  )
  for (const root of stats.roots) {
    log.debug?.('扫描根 %s：%s（%s，%d 个包）', root.kind, root.path, root.exists ? '存在' : '不存在', root.found)
  }
  // 出厂人设不在位是**必须说出来**的一件事：手册 §1.1 把它定成了「出厂人格」，
  // 缺了就意味着「装完打开，她不知道自己是谁」。而它缺席的典型原因是
  // 「有人把 ondra-persona-skills 目录删了/挪了」，界面上只会看到空列表。
  if (!stats.factoryPresent) {
    log.error(
      '出厂人设「%s」不在位：请检查随包目录 cordis/ondra-persona-skills 是否存在（手册 §1.1 定出厂为鲸鲸）',
      settings.factoryPersona,
    )
  }
  if (stats.samplePresent === false) {
    log.info('示例人设「%s」不在位：不影响使用，只是少一个可演示的包', settings.samplePersona)
  }
  if (stats.activeId === null) {
    log.warn(
      '配置的当前人设「%s」不存在，当前人设为空（**不自动退回第一个**）：可用的是 %s',
      settings.activePersona,
      registry
        .list()
        .map(item => item.id)
        .join(' / ') || '（一个都没有）',
    )
  }
  for (const issue of stats.issues.slice(0, 5)) {
    log.warn('[%s] %s：%s', issue.code, issue.file, issue.detail)
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
    ) => { readonly value: PersonaConfig } | { readonly issues: readonly { readonly message: string }[] }
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
