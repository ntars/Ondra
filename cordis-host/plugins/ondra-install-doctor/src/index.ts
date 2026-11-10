/**
 * O-133 `ondra-install-doctor`：**安装自检**（B6，P1，〔研〕）。
 *
 * ## 它回答的问题与 O-077 不同
 *
 * O-077 问「**我这个包**会不会被加载」（逐包十项）。本包问「**这份 profile
 * 装配出来长什么样**」（层 → 补丁 → 入口树）。两者的失败形态都是「日志干净、
 * 进程正常、功能不在」，但漏的地方不一样：包自己的补丁写对了，不代表它所在的
 * profile 装得上——profile 里没登记它、bundle 解析不到、`ondra.bundle` 缺声明、
 * 补丁路径相对包目录写错，这四种失败全发生在包外面。
 *
 * ## 只读是硬属性
 *
 * 台账写「O-133 只读，绝不执行器官」。所以本包**没有任何写路径**：
 * 不改 profile、不写 `disabled`、不装包、不跑器官。`PatchEntry.disabled`
 * 只被读出来印在报告里。
 *
 * ## 一个刻意的「不做」
 *
 * **不猜 profile 路径。** 宿主解析 profile 用 `resolveProfileDir(name, home)` +
 * `resolveBundleDir(…, installAnchor)`，依赖 `ondra` 的安装锚点与 `node_modules`
 * 提升规则。本包拿不到安装锚点，硬抄一份必然与宿主漂移——那时报告说「装得上」
 * 而宿主说「skipped」，比没有报告更坏。所以 `profile-path` 默认空，空就如实报
 * `no-profile`。
 *
 * ## 与手册摘要的一处差异（必须说）
 *
 * 手册 §8.3 的「安装自检」段落只写了「用移植的 `parsePatchYaml / applyEntryPatches /
 * composeEntries` 算出宿主会看到的入口树」。摘要没说**包间不许 import** 这件事
 * 会迫使这份移植**存在两份**（O-077 里一份、本包一份）。本包自带一份，代价写进
 * README「已知限制 1」。
 */

import type { Context } from '@ntars/cordis'
import { InstallDoctor } from './service.js'
import type { DoctorDeps } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Settings } from './settings.js'
import { DOCTOR_SERVICE_KEY } from './types.js'
import type { DoctorService, IdentityLike } from './types.js'

export type * from './types.js'
// 契约里既有纯类型也有运行时值，分开导出才不违背「类型导入不得混入运行时值」。
export {
  DOCTOR_SERVICE_KEY,
  NAME_RE,
  ENTRY_FIELDS,
  PATCH_ONLY_FIELDS,
  PROFILE_PATCH_FILENAME,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  DEFAULT_TTL_MS,
  FIELD_SPECS,
  MAX_FILE_BYTES,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export type { Settings } from './settings.js'
export { isRow, parsePatchYaml } from './yaml.js'
export type { YamlOutcome } from './yaml.js'
export { applyEntryPatches, composeEntries, inspectTree } from './compose.js'
export type { ComposeResult, LayeredPatches } from './compose.js'
export {
  isSafePackageName,
  isSafePatchPath,
  listSubdirs,
  readLayer,
  readProfileFacts,
  readUserLayer,
  resolvePackageDir,
} from './source.js'
export type { LayerFacts, ProfileFacts } from './source.js'
import { summarize } from './report.js'
export { buildFindings, decideVerdict, renderReport, summarize, verdictLabel } from './report.js'
export type { VerdictInput } from './report.js'
export { InstallDoctor } from './service.js'
export type { DoctorDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-install-doctor'

/** O-005 的结构对位子集。 */
interface ConfigSchemaLike {
  register(decl: unknown, by?: string): () => void
  resolve(id: string, layers: Record<string, unknown>): { readonly values: unknown; readonly fallbackCount: number } | undefined
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
    /** 安装自检；未装载本插件时为 undefined。 */
    'ondra-install-doctor'?: DoctorService
  }
}

/**
 * Cordis 入口：解析配置、注册服务、启动时体检一次。**永不抛错、永不拦启动**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('install-doctor') : 'ondra.install-doctor')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined) {
    try {
      schema.register(CONFIG_SECTION, name)
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('向 ondra-config-schema 注册/解析配置段失败（退回插件实例配置）：%s', textOf(error))
    }
  }
  const settings = completeConfig(effective)

  const deps: DoctorDeps = {
    settings: () => settings,
    log,
    now: () => {
      const clock = ctx.get('ondra-clock') as { now(): number } | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
  }

  const doctor = new InstallDoctor(deps)

  ctx.effect(
    () => {
      const removeService = ctx.provide(DOCTOR_SERVICE_KEY, doctor)
      return () => {
        doctor.invalidate()
        removeService()
      }
    },
    'ondra-install-doctor: 注册安装自检服务',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('安装自检关着：不查任何东西（它只判定，不影响加载）')
    return
  }
  if (settings.profilePath === '') {
    log.warn('`profile-path` 是空的：什么都不扫。把它配成 profile 目录的绝对路径')
    return
  }

  log.info('安装自检就绪：profile = %s（用户层 %s，缓存 %dms）', settings.profilePath, settings.userLayer ? '开' : '关', settings.ttlMs)

  // 启动时体检一次，**不 await**（只判定不拦启动）。
  // 用 try 包住同步调用，因为它要读磁盘；读盘异常绝不冒泡进启动路径。
  try {
    const report = doctor.inspect()
    if (report.verdict === 'fail') {
      log.error('安装自检不通过：%s', summarize(report))
      for (const finding of report.findings) {
        if (finding.level === 'error') log.error('  · %s', finding.detail)
      }
    } else if (report.verdict === 'unverifiable') {
      log.warn('安装自检未判定：%s', summarize(report))
    } else if (report.verdict === 'warn') {
      log.warn('安装自检通过但有告警：%s', summarize(report))
    } else {
      log.info('安装自检通过：%s', summarize(report))
    }
  } catch (error) {
    // 自检自己崩掉不该影响任何东西。
    log.warn('安装自检没能跑完：%s', textOf(error))
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: Settings } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏条目回退），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
