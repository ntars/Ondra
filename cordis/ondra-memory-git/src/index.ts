/**
 * O-099 `ondra-memory-git`：记忆版本线（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 把一条记忆的**生命周期**投影成一套仓库语义，让人能回答三个问题：
 *
 * 1. 「它现在在哪一步」——`view(id).stage`（活跃 / 沉底 / 封存 / 已遗忘）+ 版本深度；
 * 2. 「它上次被改了什么」——`diff(id)`（最近一次订正的逐字差异）；
 * 3. 「那一刻的样子还在不在」——`tag()` 打检查点、`checkout()` 把快照登记为待恢复。
 *
 * ## 它刻意不做什么（五条，每条都是踩过的坑）
 *
 * - **不存第二份正文。** 见 `types.ts` 文件头：存正文就等于建了一个不受 O-010 寿命、
 *   不受 O-017 删除流程管的副本，「说忘了其实没忘」。所以能力上限是 `latest-only`。
 * - **不做完整历史。** `revisions` 只有计数、`oldText` 只有最近一份。
 *   要完整历史必须改 O-010 的表结构——那是「必须改上游」，按纪律应 `blocked`，不硬做。
 * - **不做自动回滚。** 连 `restore()` 都不镜像进契约。`checkout()` 最多把待恢复票递到
 *   人手上；换库必须人经 O-009 的二次确认执行。
 * - **不起子进程、不跑 git。** 禁装依赖，且插件形态只允许 `apply(ctx)`。
 * - **不画界面。** L8 已下线，时间轴、差异高亮、标签清单全部归应用外壳。
 *
 * ## 依赖纪律
 *
 * 三项依赖（记忆内核 / 快照 / 时钟）**全是软依赖**，故刻意不声明插件级 `inject`：
 * 缺了记忆内核 → `available=false` 且说清 `no-core`；
 * 缺了快照 → 视图与差异照常可用，只有 `tag()` 明确拒绝（不存空 id 假装成功）。
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
import type { Config as GitConfig } from './settings.js'
import { MemoryGit } from './service.js'
import { MEMORY_GIT_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  MemoryGitService,
  PathLike,
  SnapshotLike,
} from './types.js'

export type * from './types.js'
export {
  MEMORY_GIT_SERVICE_KEY,
  CAPABILITY,
  MEMORY_STAGES,
  STAGE_SPECS,
  TAG_RE,
  MAX_TAGS,
  GitError,
} from './types.js'
export { CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS, SECTION_KEYS, CONFIG_SECTION, completeConfig } from './settings.js'
export { stageOf, stageZhOf, isStage, previewOf, diffOf, depthOf } from './diff.js'
export { STATE_FILE, STATE_VERSION, emptyState, normalizeState, readState, writeState } from './store.js'
export { MemoryGit } from './service.js'
export type { MemoryGitDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-git'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-git: 注册配置段')
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
    /** 记忆版本线服务；未装载本插件时为 undefined。 */
    'ondra-memory-git'?: MemoryGitService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：三项依赖全软（见文件头）。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: GitConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('memory-git') : 'ondra.memory-git')

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
  const git = new MemoryGit({
    settings,
    log,
    core: () => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined,
    snapshot: () => ctx.get('ondra-snapshot') as SnapshotLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(MEMORY_GIT_SERVICE_KEY, git), 'ondra-memory-git: 注册记忆版本线服务')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱。
  const stats = git.stats()
  log.info(
    '记忆版本线就绪：%s（能力上限 %s）',
    git.available ? '可用' : `不可用（${git.reason ?? '未知'}）`,
    stats.capability,
  )
  if (git.available) {
    log.info('检查点 %d 个；O-009 持有的快照 %d 份', stats.checkpoints, stats.snapshots)
  }
  if (ctx.get('ondra-snapshot') === undefined) {
    log.info('快照服务未装载：视图与差异照常可用，但无法打检查点（tag 会明确拒绝，不存空 id）')
  }
  if (!settings.enable) {
    log.warn('记忆版本线已关闭（enable=false）：服务照常注册，view() 一律返回 undefined')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。四个字段都能安全补全，
 * 因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: GitConfig } | { readonly issues: readonly { readonly message: string }[] }
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
