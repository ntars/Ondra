/**
 * O-126 `ondra-vision`：图片理解 / OCR / 物体定位 / 视频抽帧（手册 §9.4，P1，〔复〕）。
 *
 * ## 一句话
 *
 * 用户发来一张图，本包把它变成**一段可以入库的中文描述**（或字、或方框），
 * 或者把一个视频抽成 4 帧。模型推理归 provider，本包只做接线、配置与降级。
 *
 * ## 装载期只做四件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. 建服务并 `provide`——**不在这里发请求**：装载期宿主正忙（配置合并、首屏），
 *    一个 30 秒的超时会把「启动慢」记到视觉头上；
 * 3. 向 O-076 登记一条出站能力（`vision`，payload=image）——只在开着的时候登记：
 *    关着的插件不该出现在合规告知的清单里；
 * 4. 把「为什么现在不能用」逐条打出来（关着 / 没配模型 / 地址写坏 / 没有 fetch）。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * 本插件消费 `ondra-privacy` / `ondra-config-schema` / `ondra-identity` /
 * `ondra-path-layout`，**四个全软**。声明 `inject` 会让缺一个就整包停 PENDING，
 * 而面板连「缺什么」都读不到；正确表现是服务照常注册、`available=false`、
 * 日志里明说原因。这也是手册 §8.3 那三条静默失败里最隐蔽的一条。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  credentialRefOf,
  egressHostsOf,
  isRecord,
  normalizeUserLayer,
  resolveEndpoint,
  valuesToConfigShape,
} from './settings.js'
import type { Config as VisionConfig } from './settings.js'
import { Vision } from './service.js'
import type { VisionDeps } from './service.js'
import { VISION_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  EgressSpecLike,
  FetchLike,
  IdentityLike,
  LogLike,
  PathLayoutLike,
  PrivacyLike,
  VisionService,
} from './types.js'
import { resolveFetch } from './transport.js'

export type * from './types.js'
export {
  VISION_SERVICE_KEY,
  NAME_RE,
  VISION_PROVIDERS,
  VISION_REASONS,
  MODALITIES,
  PROVIDER_ENDPOINTS,
} from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  CREDENTIAL_REF_RE,
  DEFAULT_CONFIG,
  DETAIL_LEVELS,
  FIELD_SPECS,
  SECTION_KEYS,
  TIMEOUT_MAX,
  TIMEOUT_MIN,
  IMAGE_BYTES_MAX,
  IMAGE_BYTES_MIN,
  OUTPUT_CHARS_MAX,
  OUTPUT_CHARS_MIN,
  FRAMES_MAX,
  FRAMES_MIN,
  completeConfig,
  configDriftOf,
  credentialRefOf,
  egressHostsOf,
  resolveEndpoint,
} from './settings.js'
export { loadImage, sniff, toBase64, toDataUrl } from './image.js'
export { charsOf, clip, firstJsonObject, fnv1a64, squeeze, titleOf } from './text.js'
export { buildRequest, describePrompt, locatePrompt, maxTokensOf, ocrPrompt, parseBoxes, textOfResponse } from './providers.js'
export { MAX_RESPONSE_CHARS, requestJson, resolveFetch } from './transport.js'
export { FrameGrabber, whichSync } from './frames.js'
export { EGRESS_ID, Vision, defaultBaseOf, draftOf } from './service.js'
export type { VisionDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-vision'

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
    /** 视觉；未装载本插件时为 undefined。 */
    'ondra-vision'?: VisionService
  }
}

/**
 * Cordis 入口：解析配置、装服务、登记出站能力。**永不抛错**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: VisionConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log: LogLike = ctx.logger(identity ? identity.loggerName('vision') : 'ondra.vision')

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

  const deps: VisionDeps = {
    settings: () => settings,
    log,
    now: () => {
      const clock = ctx.get('ondra-clock') as { now(): number } | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
    // 现取而不是快照：装载顺序由用户配置决定，不由本插件决定。
    fetch: () => resolveFetch() as FetchLike | undefined,
    privacy: () => ctx.get('ondra-privacy') as PrivacyLike | undefined,
    pathLayout: () => ctx.get('ondra-path-layout') as PathLayoutLike | undefined,
    credential: ref => resolveCredential(ctx, ref),
  }

  const service = new Vision(deps)

  ctx.effect(
    () => {
      const removeService = ctx.provide(VISION_SERVICE_KEY, service)
      return () => {
        // 先清临时帧再撤服务：卸载后没人再来收尾，留下的 jpg 会一直躺在临时目录里。
        service.dispose()
        removeService()
      }
    },
    'ondra-vision: 注册视觉服务',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('视觉关着（手册 §9.4 要求默认关闭）：服务仍注册（available=false），面板能读到「关着」')
    return
  }

  // 登记出站能力：主机列表只放「这次真的会发出去」的那一个。
  // `localOnly` 必须按**解析后的接入点**判，不能按 provider 名字判：
  // 有人会把 ollama 指到内网另一台机器（`base-url`），那时它就是出站。
  const endpoint = resolveEndpoint(settings)
  const privacy = ctx.get('ondra-privacy') as PrivacyLike | undefined
  if (privacy !== undefined) {
    const spec: EgressSpecLike = {
      id: 'vision',
      owner: name,
      title: '视觉：把图片发给模型服务',
      hosts: egressHostsOf(settings),
      payload: 'image',
      credentialRef: credentialRefOf(settings) === '' ? undefined : credentialRefOf(settings),
      localOnly: endpoint.ok ? endpoint.endpoint.local : false,
      reason: '图片理解与 OCR 必须由模型完成，本机没有可用的视觉模型时只能出站',
      source: '手册 §9.4「vision 默认关闭，出站前提示（与 privacy 联动）」',
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
    }, 'ondra-vision: 登记出站能力')
  }

  if (!service.available) {
    if (service.reason === 'no-model') {
      log.warn('视觉开着但没配模型：请填 vision.model（示例见字段说明，不是默认值）')
    } else if (!endpoint.ok) {
      log.warn('接入点地址不合法：%s', endpoint.detail)
    } else if (service.reason === 'no-transport') {
      log.warn('运行时没有 fetch：视觉不可用（这是宿主裁剪了运行时，不是配置问题）')
    }
    return
  }

  if (endpoint.ok) {
    log.info(
      '视觉就绪：%s，模型 %s，发往 %s（%s）',
      settings.provider,
      settings.model,
      endpoint.endpoint.host,
      endpoint.endpoint.local ? '本机，不出站' : '云端，每次出站前过 privacy',
    )
  }
  if (privacy === undefined && endpoint.ok && !endpoint.endpoint.local && !settings.cloudWithoutPrivacy) {
    log.warn('没有 ondra-privacy：云端出站一律不发（cloud-without-privacy=false）。这是默认的保守档')
  }
  log.info('本包不写记忆也不画界面：描述交给 O-128 入库，出站合规归 O-076，界面归应用外壳')
}

/**
 * 解析一个凭据引用。
 *
 * 顺序：上游 `credentials` 服务 → 环境变量。**只回值，不打印**。
 * 环境变量是兜底而不是主路径：上游 `credentials` 才是凭据域，它管着「值从哪来」；
 * 但最小安装里可能没有它，而引用名本来就是一个环境变量名（O-035 同口径），
 * 所以退回环境变量不算另开一条通路。
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
      // 凭据域出错：退回环境变量，而不是把整次视觉判死。
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
    readonly validate: (value: unknown) => { readonly value: VisionConfig } | { readonly issues: readonly { readonly message: string }[] }
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
