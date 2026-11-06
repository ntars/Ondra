/**
 * O-045 `ondra-diary`：每天一篇第一人称日记，一天一个 Markdown。
 *
 * ## 触发链（全部经 `ctx.effect`，卸载即撤销）
 *
 * ```
 * clock.dailyAt('02:00')  → tick()     到点写今天
 * clock.after(60s)        → tick()     启动后补一次（看门狗）
 * clock.after(retry)      → ensure()   窗口内退避重试（由服务自己排）
 * ```
 *
 * 为什么启动后要延迟 60 秒：装载期宿主正忙（配置合并、数据库迁移、界面首屏），
 * 这时候去读目录、调模型，会把「启动慢」记到日记头上。60 秒是**经验值**，
 * 不是手册参数，写在 README「待裁决」里。
 *
 * ## 明确不做
 *
 * - **不往会话发消息**：不调 `ondra-dialogue`、不调主动链路（O-042/O-043）。
 * - **不注册工具**：注册了模型就能自己触发「写日记」，那就不再是日记（见 types.ts）。
 * - **不写记忆**：日记是她的产物，不是记忆条目。要进记忆由 `ondra-memory-extract`
 *   自己决定，本插件不越界替它写。
 * - **不自己拼路径**：目录与权限归 `ondra-path-layout`（O-002）。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as DiaryConfig } from './settings.js'
import { DiaryFileStore } from './store.js'
import { Diary } from './service.js'
import { DIARY_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  DiaryService,
  GatewayLike,
  IdentityLike,
  LogLike,
  MemoryLike,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  DIARY_SERVICE_KEY,
  NAME_RE,
  DIARY_DIR,
  DIARY_EXT,
  DAY_KEY_RE,
  META_TAG,
  META_VERSION,
  DEFAULT_WINDOW_START,
  DEFAULT_WINDOW_END,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  HHMM_RE,
  MIN_CHARS,
  MAX_CHARS,
  BACKFILL_CEIL,
  completeConfig,
  configDriftOf,
  isDayKey,
} from './settings.js'
export {
  buildDoc,
  epochOfDayKey,
  isSafeDayKey,
  localDayKey,
  looksEmpty,
  parseDoc,
  sanitizeBody,
  shiftDayKey,
  stripMetrics,
  titleOf,
  weekdayNameOf,
} from './markdown.js'
export { composeBody, templateBody } from './compose.js'
export type { ComposeDeps, ComposeInput, ComposeResult } from './compose.js'
export { DiaryFileStore, LIST_LIMIT } from './store.js'
export type { DiaryStoreDeps, RawDoc } from './store.js'
export { Diary } from './service.js'
export type { DiaryOptions } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-diary'

/** 启动后多久补一次（毫秒）。理由见文件头，**不是手册参数**。 */
export const STARTUP_DELAY_MS = 60_000

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-diary: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 日记服务；未装载本插件时为 undefined。 */
    'ondra-diary'?: DiaryService
  }
}

/**
 * Cordis 入口：解析配置、注册服务、排两个定时。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`ondra-clock` / `ondra-path-layout` 缺席时，
 * 正确表现是「服务照常注册 + 一行告警 + 面板能说清缺什么」，
 * 而不是「整个插件停在 PENDING」——停在 PENDING 会让界面连缺什么都问不到。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DiaryConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('diary') : 'ondra.diary')

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

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  const store = new DiaryFileStore({
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    log,
  })

  // 重试链的 disposer 自己收着：`clock.after` 返回的撤销函数必须能被一次性全撤。
  const retryDisposers = new Set<() => void>()

  const diary = new Diary({
    settings,
    log,
    store,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    gateway: () => ctx.get('ondra-llm-gateway') as GatewayLike | undefined,
    memory: () => ctx.get('ondra-memory-core') as MemoryLike | undefined,
    now: () => Date.now(),
    after: (ms, fn) => {
      const clock = ctx.get('ondra-clock') as ClockLike | undefined
      if (clock === undefined) return () => {}
      let dispose: () => void = () => {}
      dispose = clock.after(ms, () => {
        retryDisposers.delete(dispose)
        fn()
      })
      retryDisposers.add(dispose)
      return () => {
        retryDisposers.delete(dispose)
        dispose()
      }
    },
  })

  ctx.effect(() => ctx.provide(DIARY_SERVICE_KEY, diary), 'ondra-diary: 注册日记服务')
  ctx.effect(
    () => () => {
      for (const dispose of retryDisposers) dispose()
      retryDisposers.clear()
    },
    'ondra-diary: 撤销重试链',
  )

  // 4. 两个定时入口。没有时钟就整条自动链不存在——只保留手动 `write()`。
  const clock = ctx.get('ondra-clock') as ClockLike | undefined
  if (clock !== undefined) {
    try {
      ctx.effect(
        () =>
          clock.dailyAt(settings.windowStart, () => {
            void diary.tick().catch((error: unknown) => {
              log.warn('到点写日记失败：%s', messageOf(error))
            })
          }),
        'ondra-diary: 每日窗口起点',
      )
      ctx.effect(
        () =>
          clock.after(STARTUP_DELAY_MS, () => {
            void diary.tick().catch((error: unknown) => {
              log.warn('启动补写失败：%s', messageOf(error))
            })
          }),
        'ondra-diary: 启动看门狗',
      )
    } catch (error) {
      log.warn('排定时失败（日记将不会自动写）：%s', messageOf(error))
    }
  }

  // 5. 报一次现状。窗口、目录、模型、落盘状态都要能被自检读到（§12.2）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('写入窗口配置非法，已回退默认（%s）：日记可能因此不在你以为的时候写', drift.join(' / '))
  }
  log.info(
    '日记就绪：窗口 %s–%s · 上限 %d 字 · 补写 %d 天 · 目录 %s · 模板兜底 %s',
    settings.windowStart,
    settings.windowEnd,
    settings.maxChars,
    settings.backfillDays,
    store.ready ? 'user/diary' : '不可用',
    settings.templateFallback ? '开' : '关',
  )
  if (!settings.enable) {
    log.warn('日记已关闭（enable=false）：服务照常注册，ensure() 一律 disabled')
  }
  if (!store.ready) {
    log.warn('路径服务未装载：日记无处可写（不自己拼路径，避免写到 cwd）')
  }
  if (clock === undefined) {
    log.warn('时间服务未装载：日记不会自动写，只能由面板手动触发；自然日退回本机时区')
  }
  if (ctx.get('ondra-llm-gateway') === undefined) {
    log.warn('模型网关未装载：每篇都会走模板兜底（内容仍然每天不空，但不是她写的）')
  }
  if (ctx.get('ondra-memory-core') === undefined) {
    log.info('记忆核心未装载：日记没有当天素材，读起来会比较空')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
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
    ) => { readonly value: DiaryConfig } | { readonly issues: readonly { readonly message: string }[] }
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
