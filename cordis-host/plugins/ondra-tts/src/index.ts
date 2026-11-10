/**
 * O-050 `ondra-tts`：三条合成通道，一个出口。
 *
 * ## 装载期只做四件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. 建三条通道并**同步**探一次「在不在」（只查文件与配置，不执行任何命令）；
 * 3. `provide` 服务；
 * 4. 把「为什么现在不能出声」逐条打出来。
 *
 * **不在装载期合成任何东西**：装载时宿主正忙（配置合并、界面首屏），
 * 一句试音会让启动曲线多出一段查不出原因的卡顿。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * 本插件消费 `ondra-path-layout` / `ondra-config-schema` / `ondra-clock` /
 * `ondra-identity`，五个依赖全软。声明 `inject` 会让缺一个就整包停 PENDING，
 * 面板连「缺什么」都读不到；正确表现是服务照常注册、`speak()` 返回原因码。
 *
 * ## 刻意不注册工具
 *
 * 注册 `speak` 工具后，模型可以自己「说一句」——那就成了工具箱里的喇叭，
 * 而不是「她开口说话」。要不要出声归 O-051 的闸门，本插件只被调用。
 */

import type { Context } from '@ntars/cordis'
import { Exec, fileExists, whichSync } from './exec.js'
import { resolveFetch } from './http.js'
import { ensureCacheDir } from './cache.js'
import { Player } from './player.js'
import { MacSayEngine } from './branches/macos-say.js'
import { EdgeTtsEngine } from './branches/edge-tts.js'
import { GptSovitsEngine } from './branches/gpt-sovits.js'
import { Tts } from './service.js'
import type { EngineSet } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as TtsConfig } from './settings.js'
import { NAME_RE, TTS_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PathLayoutLike,
  TtsService,
} from './types.js'

export type * from './types.js'
export {
  TTS_SERVICE_KEY,
  NAME_RE,
  ENGINE_NAMES,
  PRESET_IDS,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  RATE_MIN,
  RATE_MAX,
  MAX_CHARS_MIN,
  MAX_CHARS_MAX,
  TIMEOUT_MIN,
  TIMEOUT_MAX,
  CACHE_MIN,
  CACHE_MAX,
  PROVIDER_VALUES,
  GSV_LANG_VALUES,
  TEXT_MAX,
  isPresetId,
  completeConfig,
  configDriftOf,
} from './settings.js'
export { VOICES, PRESETS, isVoiceId, presetOf } from './voices.js'
export { speakable, charCount } from './speakable.js'
export { cacheKey, cachePath, CACHE_SUBDIR, HASH_LEN } from './cache.js'
export { Exec, whichSync, describeExec } from './exec.js'
export { postJsonForAudio, resolveFetch } from './http.js'
export { AFPLAY_PATH, PLAY_TIMEOUT_MS, Player } from './player.js'
export { MacSayEngine, SAY_PATH, wpmOf } from './branches/macos-say.js'
export { EdgeTtsEngine, rateArg, volumeArg } from './branches/edge-tts.js'
export { GptSovitsEngine, isLoopbackEndpoint, ttsUrl } from './branches/gpt-sovits.js'
export { Tts } from './service.js'
export type { EngineSet, TtsDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-tts'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-tts: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 语音合成服务；未装载本插件时为 undefined。 */
    'ondra-tts'?: TtsService
  }
}

/**
 * Cordis 入口：解析配置、建通道、注册服务、报一次现状。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: TtsConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('tts') : 'ondra.tts')

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

  // 3. 时间：有 O-003 就用它的 `now()`，没有才退回系统时钟（并在日志里说出来）。
  const clock = ctx.get('ondra-clock') as ClockLike | undefined
  const now = (): number => {
    const live = ctx.get('ondra-clock') as ClockLike | undefined
    return live === undefined ? Date.now() : live.now()
  }

  // 4. 进程出口：一个实例管一批子进程，卸载时一次收尾。
  const exec = new Exec()
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const cacheDir = ensureCacheDir(layout, log)
  const fetchImpl = resolveFetch()

  /** 重建通道集合。`probe()` 会再调一次（装完 CLI 后 PATH 结果会变）。 */
  const build = (): EngineSet => {
    const run = (command: string, args: readonly string[], options: { readonly timeoutMs: number }) =>
      exec.run(command, args, options)

    return {
      engines: [
        new GptSovitsEngine({
          endpoint: settings.gsvEndpoint,
          refAudio: settings.gsvRefAudio,
          promptText: settings.gsvPromptText,
          lang: settings.gsvTextLang,
          http: { fetch: fetchImpl, timeoutMs: settings.timeoutMs, log },
        }),
        new MacSayEngine({
          platform: process.platform,
          exists: fileExists,
          exec: run,
          timeoutMs: settings.timeoutMs,
          voice: settings.sayVoice,
          wpm: settings.sayWpm,
        }),
        new EdgeTtsEngine({
          bin: settings.edgeBin,
          resolved: whichSync(settings.edgeBin, process.env['PATH'], process.platform),
          exec: run,
          timeoutMs: settings.timeoutMs,
        }),
      ],
      player: new Player({ platform: process.platform, exists: fileExists, exec: run }),
    }
  }

  const tts = new Tts({ settings, log, cacheDir, build, now })

  ctx.effect(() => ctx.provide(TTS_SERVICE_KEY, tts), 'ondra-tts: 注册语音合成服务')
  // 卸载时杀干净在跑的子进程：只要有一个 `say` 还在念，插件就已经卸不掉了。
  ctx.effect(
    () => () => {
      exec.killAll()
    },
    'ondra-tts: 卸载收尾子进程',
  )

  // 5. 报一次现状：通道、缓存、播放、音色，都要能被自检读到（§12.2）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值越界已回退（%s）：音色与语速可能因此不是你设的数', drift.join(' / '))
  }

  if (!settings.enable) {
    log.warn('语音已关闭（enable=false）：服务照常注册，speak() 一律 disabled')
  } else if (!tts.available) {
    log.warn('语音暂无可用通道（%s）：三条都没就绪，speak() 一律返回原因码', tts.reason ?? 'no-engine')
  } else {
    log.info(
      '语音就绪：通道 %s · 预设 %s · 缓存 %s · 播放 %s',
      tts.engine,
      settings.preset,
      cacheDir,
      settings.playback === 'off' ? '关闭' : '系统播放器',
    )
  }

  if (settings.enable) {
    // 逐条打出三条通道各自的状态：全都不可用时，这一屏日志就是唯一的线索。
    // 只读同步事实（文件在不在、配置齐不齐），不发请求、不试音。
    void tts.probe().then(report => {
      for (const check of report.checks) {
        log.info('通道 %s：%s', check.engine, check.ready ? check.detail : '不可用 — ' + check.detail)
      }
      return undefined
    })
  }

  if (fetchImpl === undefined) {
    log.warn('运行时没有 fetch：gpt-sovits 通道不可用（替换 src/http.ts 即可接宿主 transport）')
  }
  if (clock === undefined) {
    log.info('时间服务未装载：时间戳退回本机时钟')
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
    ) => { readonly value: TtsConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法值回退默认、数值夹紧），因此永远不产 issue。
      // 音色 id 与参考音频路径**不在这里修**：清空会让面板显示「没配」，
      // 真正的原因（写错了）就丢了。
      return { value: completeConfig(value) }
    },
  },
}
