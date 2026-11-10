/**
 * O-005 `ondra-config-schema`：配置四层结构与默认值的单一真源。
 *
 * 四条必须写清楚的裁决：
 *
 * 1. **本插件不搬别人的默认值。**
 *    「默认值真源」最自然的做法是搞一份全仓 `DEFAULT_CONFIG` 大对象，但那是**双真源**：
 *    声明方自己还留着一份，两边一旦漂移，界面上显示的值与实际生效值就不一致。
 *    所以本插件只提供**注册表 + 合并算法 + 来源追溯**，默认值由**声明方**在注册段时
 *    一次性交出（`FieldSpec.default`），此后只经 `resolve()` 取值。
 *    **「默认值真源」落在「谁声明谁拥有、只有一份」上，而不是落在本插件手里。**
 *
 * 2. **层序照抄上游，不自创。**
 *    `factory → bundle → user → runtime`，与上游 `@ntars/ondra-settings` 的
 *    `schema 默认值 → 组合基座 → 用户层 → volatile` 一一对位。自创一套层名，
 *    会让设置面板与 Cordis 的 `config-editor` 对不上账。
 *
 * 3. **数组替换、对象深合并。`null` 显式置空、缺键表示未设置。**
 *    这两条各自对应一种「用户改了却没生效」的静默 bug，见 `layers.ts` 文件头。
 *
 * 4. **注册期抛错，运行期不抛。**
 *    声明写错要在装载时就炸（否则是「界面上没有这个字段」这种无声无息的错）；
 *    但 `resolve()` 取不到段就返回 `undefined`——配置读不出来不该让主对话跟着崩。
 */

import type { Context } from '@ntars/cordis'
import { CONFIG_SCHEMA_SERVICE_KEY, ConfigSchemaError, LAYER_ORDER, PRESET_ORDER } from './types.js'
import type {
  ConfigSchemaService,
  Disposer,
  LayerSet,
  PresetName,
  ResolvedSection,
  SectionDecl,
} from './types.js'
import { SectionRegistry } from './registry.js'
import { resolveSection } from './layers.js'

export type * from './types.js'
// 契约里既有纯类型也有运行时值，分开导出才不违背「类型导入不得混入运行时值」。
export { CONFIG_SCHEMA_SERVICE_KEY, LAYER_ORDER, PRESET_ORDER, ConfigSchemaError } from './types.js'
export { SectionRegistry } from './registry.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致（手册 §8.3-3）。 */
export const name = 'ondra-config-schema'

/**
 * O-001 身份服务的**结构对位**子集：只读日志命名空间根。
 *
 * 不 `import` O-001 源码：那会让两个插件编译期互相绑定（§15.5）。
 */
interface IdentityLike {
  loggerName(feature: string): string
}

/** 配置项：全部有默认值，不配置也能跑（手册 §3.3-2）。 */
export interface Config {
  /** 注册段时未给登记方名字时使用的名字，默认 `ondra-unknown`。 */
  readonly anonymousOwner: string
  /** 段数上限，默认 512。防「某个插件在循环里注册段」把内存吃光。 */
  readonly maxSections: number
  /** 是否把校验问题打进日志（默认 true）。关掉只影响日志，`issues` 照样给。 */
  readonly logIssues: boolean
}

/** 默认配置：只在这里出现一次。 */
const DEFAULT_CONFIG: Config = {
  anonymousOwner: 'ondra-unknown',
  maxSections: 512,
  logIssues: true,
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读字符串字段：缺省补默认值，类型不符抛错。 */
function readString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigSchemaError('bad-field-spec', 'ondra-config-schema', '配置项 ' + key + ' 必须是非空字符串')
  }
  return value
}

/** 读数字字段：缺省补默认值，越界或非整数抛错。 */
function readInteger(raw: Record<string, unknown>, key: string, fallback: number, min: number): number {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new ConfigSchemaError(
      'bad-field-spec',
      'ondra-config-schema',
      '配置项 ' + key + ' 必须是不小于 ' + String(min) + ' 的整数',
    )
  }
  return value
}

/** 读布尔字段：缺省补默认值。 */
function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new ConfigSchemaError('bad-field-spec', 'ondra-config-schema', '配置项 ' + key + ' 必须是布尔值')
  }
  return value
}

/** 把宿主传入的配置补成完整配置（缺项补默认）。 */
function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return {
    anonymousOwner: readString(raw, 'anonymousOwner', DEFAULT_CONFIG.anonymousOwner),
    maxSections: readInteger(raw, 'maxSections', DEFAULT_CONFIG.maxSections, 1),
    logIssues: readBoolean(raw, 'logIssues', DEFAULT_CONFIG.logIssues),
  }
}

/** 极简日志出口：本插件只需要 info / warn / error 三档。 */
interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/**
 * 构造服务实例。
 * @param config 已补全的配置。
 * @param log 日志出口。
 */
function createService(config: Config, log: LogLike): ConfigSchemaService {
  const registry = new SectionRegistry()

  return {
    layers: LAYER_ORDER,
    presets: PRESET_ORDER,

    register(decl: SectionDecl, by?: string): Disposer {
      const owner = (by ?? decl.owner ?? config.anonymousOwner).trim() || config.anonymousOwner
      if (registry.list().length >= config.maxSections) {
        throw new ConfigSchemaError(
          'bad-field-spec',
          decl.id,
          '配置段数量已达上限 ' + String(config.maxSections) + '，拒绝继续登记「' + decl.id + '」',
        )
      }
      registry.register(decl, owner)
      log.info('配置段已登记：%s（%s，%d 个字段）', decl.id, owner, Object.keys(decl.fields).length)
      let done = false
      return () => {
        // 幂等：撤销两次不该把后来者登记的同名段也撤掉。
        if (done) return
        done = true
        registry.unregister(decl.id, owner)
      }
    },

    has(id: string): boolean {
      return registry.has(id)
    },

    list(): readonly string[] {
      return registry.list()
    },

    section(id: string): SectionDecl | undefined {
      return registry.section(id)
    },

    resolve(id: string, layers: LayerSet): ResolvedSection | undefined {
      const decl = registry.section(id)
      if (decl === undefined) {
        // 运行期不抛：取不到就交给调用方 `if (!r) return` 降级。
        log.warn('解析配置段「%s」失败：该段尚未登记（调用方应自行降级）', id)
        return undefined
      }
      const resolved = resolveSection(decl, layers)
      if (config.logIssues && resolved.issues.length > 0) {
        const fallbackNote = resolved.fallbackCount > 0
          ? '；其中 ' + String(resolved.fallbackCount) + ' 个字段已回退出厂默认值'
          : ''
        log.warn('配置段「%s」有 %d 条问题%s', id, resolved.issues.length, fallbackNote)
        for (const issue of resolved.issues) {
          log.warn(
            '  [%s] %s%s：%s',
            issue.code,
            issue.layer ?? 'default',
            issue.key === undefined ? '' : ' / ' + issue.key,
            issue.message,
          )
        }
      }
      return resolved
    },

    presetOf(id: string, preset: PresetName): Readonly<Record<string, unknown>> {
      return registry.presetOf(id, preset)
    },
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 配置真源服务；未装载 O-005 时为 undefined。 */
    'ondra-config-schema'?: ConfigSchemaService
  }
}

/**
 * Cordis 入口：注册配置真源服务。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Config): void {
  const complete = completeConfig(config)
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('config-schema') : 'ondra.config-schema')

  const service = createService(complete, log)

  ctx.effect(
    () => {
      const removeService = ctx.provide(CONFIG_SCHEMA_SERVICE_KEY, service)
      return () => {
        // 先撤服务再清注册表：撤服务后不会再有新登记进来。
        removeService()
      }
    },
    'ondra-config-schema: 注册配置真源服务',
  )

  log.info(
    '配置真源就绪：%d 层（%s），%d 档（%s），段数上限 %d',
    LAYER_ORDER.length,
    LAYER_ORDER.join(' → '),
    PRESET_ORDER.length,
    PRESET_ORDER.join(' / '),
    complete.maxSections,
  )
}

/**
 * 配置校验器（标准 schema 形状）。
 *
 * 刻意不引 `@ntars/schemastery`：本轮交付禁止安装依赖（§16.3），
 * 手写一个只做「补默认 + 类型校验」的 `~standard` 实现更可控，
 * 且与 O-001/O-003 的既有写法保持一致。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: Config } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      try {
        return { value: completeConfig(value) }
      } catch (error) {
        const message = error instanceof Error ? error.message : '配置不合法'
        return { issues: [{ message }] }
      }
    },
  },
}
