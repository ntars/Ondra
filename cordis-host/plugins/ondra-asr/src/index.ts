/**
 * O-127 `ondra-asr`：语音转写（手册 §1.5，P1，〔复〕）。
 *
 * ## 一句话
 *
 * 用户发来一段语音，本包在本机用 whisper 转成带时间戳的中文，转不出来才走云端；
 * 无论哪条路，拿不到就**安静地**返回原因码，不弹错、不编内容。
 *
 * ## 装载期只做四件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. 建服务并 `provide`——**不在这里起 whisper、不在这里探 ffmpeg**：
 *    装载期宿主正忙，一次 `which` 扫描加一次进程启动会把「启动慢」记到转写头上；
 * 3. 向 O-076 登记一条出站能力（`asr`，payload=audio）——只在开着的时候登记；
 * 4. 把「为什么现在不能用」逐条打出来（关着 / 没二进制 / 没模型 / 没有 fetch）。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * 四个消费方（`ondra-privacy` / `ondra-config-schema` / `ondra-identity` /
 * `ondra-path-layout`）全是软依赖。声明 `inject` 会让缺一个就整包停 PENDING，
 * 而本包的整个设计前提是「失败静默**但可查**」——静默加载失败会连
 * 「为什么没转写」都查不到。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  egressHostsOf,
  isRecord,
  normalizeUserLayer,
  resolveCloudEndpoint,
  valuesToConfigShape,
} from './settings.js'
import type { Config as AsrConfig } from './settings.js'
import { Asr } from './service.js'
import type { AsrDeps } from './service.js'
import { ASR_SERVICE_KEY } from './types.js'
import type {
  AsrService,
  ConfigSchemaLike,
  EgressSpecLike,
  FetchLike,
  IdentityLike,
  LogLike,
  PathLayoutLike,
  PrivacyLike,
} from './types.js'
import { resolveFetch } from './transport.js'

export type * from './types.js'
export {
  ASR_SERVICE_KEY,
  NAME_RE,
  ASR_PROVIDERS,
  ASR_REASONS,
  MODALITIES,
} from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  CREDENTIAL_REF_RE,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  LANGUAGE_RE,
  SECTION_KEYS,
  AUDIO_BYTES_MAX,
  AUDIO_BYTES_MIN,
  CHARS_MAX,
  CHARS_MIN,
  THREADS_MAX,
  THREADS_MIN,
  TIMEOUT_MAX,
  TIMEOUT_MIN,
  completeConfig,
  configDriftOf,
  egressHostsOf,
  isLanguage,
  resolveCloudEndpoint,
} from './settings.js'
export { loadAudio, sniffAudio, wavInfo, isWhisperWav } from './audio.js'
export { charsOf, clip, fnv1a64, squeeze, titleOf } from './text.js'
export { MAX_RESPONSE_CHARS, hasFormData, resolveFetch, sendForm } from './transport.js'
export { LocalWhisper, parseWhisperJson, whichSync } from './local.js'
export { CloudAsr, parseCloudBody, uploadNameOf } from './cloud.js'
export { Asr, EGRESS_ID, draftOf } from './service.js'
export type { AsrDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-asr'

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
    /** 语音转写；未装载本插件时为 undefined。 */
    'ondra-asr'?: AsrService
  }
}

/**
 * Cordis 入口：解析配置、装服务、登记出站能力。**永不抛错**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: AsrConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log: LogLike = ctx.logger(identity ? identity.loggerName('asr') : 'ondra.asr')

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
      log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    }
  }
  const settings = completeConfig(effective)

  const deps: AsrDeps = {
    settings: () => settings,
    log,
    now: () => {
      const clock = ctx.get('ondra-clock') as { now(): number } | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
    fetch: () => resolveFetch() as FetchLike | undefined,
    privacy: () => ctx.get('ondra-privacy') as PrivacyLike | undefined,
    pathLayout: () => ctx.get('ondra-path-layout') as PathLayoutLike | undefined,
    credential: ref => resolveCredential(ctx, ref),
  }

  const service = new Asr(deps)

  ctx.effect(
    () => {
      const removeService = ctx.provide(ASR_SERVICE_KEY, service)
      return () => {
        // 先杀子进程再撤服务：卸载后没人再收尾，whisper 会一直跑到自己结束。
        service.dispose()
        removeService()
      }
    },
    'ondra-asr: 注册语音转写服务',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('转写关着：服务仍注册（available=false），面板能读到「关着」')
    return
  }

  const privacy = ctx.get('ondra-privacy') as PrivacyLike | undefined
  if (privacy !== undefined) {
    const spec: EgressSpecLike = {
      id: 'asr',
      owner: name,
      title: '语音转写：把音频发给模型服务',
      hosts: egressHostsOf(settings),
      payload: 'audio',
      credentialRef: settings.credentialRef === '' ? undefined : settings.credentialRef,
      localOnly: settings.provider === 'local' && service.localReady,
      reason: '本机没有可用的 whisper 时，转写只能交给云端模型',
      source: '手册 §1.5 O-127「本地 whisper 优先云端兜底」+ §9.4 隐私红线',
    }
    ctx.effect(() => {
      try {
        const result = privacy.declare(spec)
        if (!result.ok) {
          log.warn('出站能力登记被拒（%s）：%s', result.code, result.detail)
        }
      } catch (error) {
        log.warn('出站能力登记出错：%s', textOf(error))
      }
      return () => {
        try {
          privacy.undeclare(spec.id)
        } catch {
          // 卸载期不抛：宿主正在拆树，抛了只会多一条没人看的错误。
        }
      }
    }, 'ondra-asr: 登记出站能力')
  }

  log.info(
    '语音转写：首选 %s，本地%s，云端%s',
    settings.provider,
    service.localReady ? '就绪' : '不可用',
    service.cloudReady ? '就绪' : '不可用',
  )

  if (!service.available) {
    if (service.reason === 'no-binary') {
      log.warn(
        '本地找不到 whisper（%s）：装好 whisper.cpp 后把 binary 指过去（新版叫 whisper-cli，旧版叫 main）',
        settings.binary,
      )
    } else if (service.reason === 'no-model') {
      log.warn('本地没有可用的 whisper 模型文件：请填 asr.model-path（whisper 的 -m 没有默认值）')
    } else if (service.reason === 'no-transport') {
      log.warn('运行时缺 fetch / FormData / Blob：云端兜底不可用')
    } else if (service.reason === 'no-credential') {
      log.warn('云端缺凭据（%s）：本地也不可用，所以现在转不了', settings.credentialRef)
    }
    const endpoint = resolveCloudEndpoint(settings)
    if (!endpoint.ok) log.warn('云端接入点地址不合法：%s', endpoint.detail)
    return
  }

  const endpoint = resolveCloudEndpoint(settings)
  if (privacy === undefined && endpoint.ok && !settings.cloudWithoutPrivacy) {
    log.warn('没有 ondra-privacy：云端出站一律不发（cloud-without-privacy=false）。这是默认的保守档')
  }
  if (settings.quiet) {
    log.info('失败静默开着（手册要求）：转不出来只记 debug 与计数，不弹错')
  }
  log.info('本包不写记忆：转写文本交给 O-128 入库；界面归应用外壳')
}

/**
 * 解析一个凭据引用。
 *
 * 顺序：上游 `credentials` 服务 → 环境变量。**只回值，不打印**。
 * 环境变量是兜底而不是主路径：引用名本来就是一个环境变量名（O-035 同口径）。
 * @param ctx 宿主上下文。
 * @param ref 环境变量名。
 */
async function resolveCredential(ctx: Context, ref: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials') as
    | { resolve(name: string): Promise<{ readonly value: string } | undefined> }
    | undefined
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && resolved.value !== '') return resolved.value
    } catch {
      // 凭据域出错：退回环境变量，而不是把整次转写判死。
    }
  }
  const env = process.env[ref]
  return env === undefined || env === '' ? undefined : env
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: AsrConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏枚举回退），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
