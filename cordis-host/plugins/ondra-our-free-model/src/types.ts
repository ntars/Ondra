/**
 * `ondra-our-free-model` 的对外契约。
 *
 * 定位：**渠道目录与策略层**。回答三个问题——
 * 「有哪些渠道」「这个渠道长什么样（endpoint / 协议 / 凭据引用 / 模型）」
 * 「它现在能不能用」。**不回答第四个问题**：怎么把 token 流解出来。
 * 那是传输层的事，归 `@ntars/ondra-llm-pi-ai`。
 *
 * ## 为什么不在本插件里写协议
 *
 * 手册 §1.8：能复用却自研 = 违规。仓库里已经有 `llm-pi-ai`，
 * 它支持 `openai-completions` / `openai-responses` / `anthropic-messages`
 * 三种线协议，也支持「手写声明的网关」（`api` + `baseURL` + `models` 三件套）。
 * 免费车道与聚合渠道**全部**落在这套能力里，再写一遍 SSE 解码就是自我复制。
 *
 * 本插件的产出因此是一份 **profile 字典**——恰好就是 pi-ai 的 `providers`
 * 配置形状。应用把这些 profile 写进 pi-ai 的配置，请求就能发出去。
 *
 * ## 与上游项目的关系
 *
 * 渠道注册表取自 `Ebony-Vinyl/dsh-our-free-model`（MIT）的 `registry.json`，
 * 76 家、502 个模型，逐条保留技术字段，去掉官网链接与公告位（那部分属于推广，
 * 与产品无关）。上游的省 token 管线、降级链、用量看板、应用内自升级**不搬**：
 * 前两者与本插件的职责边界冲突，后两者与 Ondra 的统一升级器与界面口径冲突。
 */

/** 本插件注册的服务键。 */
export const OFM_SERVICE_KEY = 'ondra-our-free-model'

/** 渠道类别（与上游注册表同口径）。 */
export type ChannelCategory = 'apikey' | 'free-tier' | 'local' | 'oauth'

/** 线协议。与 pi-ai 的 `api` 取值逐一对应。 */
export type WireProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/** 上游注册表里的原始协议名。 */
export type RegistryProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

/** 认证方式。 */
export type AuthKind = 'apiKey' | 'oauth' | 'adc' | 'none'

/** 一个模型的技术字段。 */
export interface ChannelModel {
  /** 模型 id（请求时原样下发的那个串）。 */
  readonly id: string
  /** 展示名。 */
  readonly name: string
  /** 上下文窗口（tokens）；上游未公布时为 `null`。**不做估算**。 */
  readonly contextWindow: number | null
}

/** 一家渠道。 */
export interface Channel {
  /** 渠道键（小写连字符，同时是 pi-ai 的 provider 路由名）。 */
  readonly id: string
  /** 展示名。 */
  readonly name: string
  /** 类别。 */
  readonly category: ChannelCategory
  /** 接口根地址（不含尾部斜杠）。 */
  readonly baseUrl: string
  /** 线协议。 */
  readonly api: WireProtocol
  /** 认证方式。 */
  readonly authKind: AuthKind
  /** 凭据引用名（环境变量名）；无需凭据时为空。 */
  readonly authEnv: string | null
  /** 是否本机服务（llama.cpp / LM Studio / Ollama）。 */
  readonly local: boolean
  /** 该渠道公布的模型。 */
  readonly models: readonly ChannelModel[]
}

/**
 * 免费车道。
 *
 * 与聚合渠道分开列的理由：车道的**认证方式与风险形态都不同**。
 * 聚合渠道要用户自备 Key，出站去向由用户自己选；免费车道用的是第三方
 * 公开免密额度，**默认关闭**，且必须在隐私告知里点名。
 */
export interface FreeLane {
  /** 车道键，也是 pi-ai 的 provider 路由名。 */
  readonly id: string
  /** 展示名。 */
  readonly name: string
  /** 接口根地址。 */
  readonly baseUrl: string
  /** 线协议。 */
  readonly api: WireProtocol
  /** 认证头里的值；`null` 表示不带认证头。 */
  readonly bearer: string | null
  /** 模型清单地址（相对 baseUrl 的路径）。 */
  readonly modelsPath: string
  /**
   * 风险说明（会进隐私告知）。
   *
   * 上游模型卡逐字写着 prompt 可能被记录用于改进服务，
   * 这句话必须原样带给用户，不能总结成「请注意隐私」。
   */
  readonly risk: string
}

/** 一条可写入 pi-ai `providers` 的配置。 */
export interface ProviderProfile {
  /** 展示名。 */
  readonly displayName: string
  /** 线协议。 */
  readonly api: WireProtocol
  /** 接口根地址。 */
  readonly baseURL: string
  /** 凭据引用名；`undefined` 表示该路由不需要 Key。 */
  readonly apiKeyEnv?: string
  /** 额外请求头（免费车道用它带 `Authorization: Bearer public`）。 */
  readonly headers?: Readonly<Record<string, string>>
  /** 模型清单。 */
  readonly models: readonly { readonly id: string; readonly name: string; readonly contextWindow?: number }[]
}

/** 探测结果。 */
export interface ProbeOutcome {
  /** 渠道键。 */
  readonly channel: string
  /** 是否可达。 */
  readonly reachable: boolean
  /** 上游公布的模型数。 */
  readonly modelCount: number
  /** 失败原因（可达时为空）。 */
  readonly failure?: 'timeout' | 'network' | 'http' | 'parse'
}

/** 地区判定结果。 */
export interface RegionOutcome {
  /** 是否判定成功。 */
  readonly known: boolean
  /** 出口 IP 的国家码（大写两位）；未知时为空串。 */
  readonly country: string
  /** 判定来源。 */
  readonly source: 'ipinfo' | 'ipwho' | 'none'
}

/**
 * 本插件提供的服务。
 *
 * 刻意**不提供** `complete()` / `stream()`：本插件不发模型请求。
 * 提供这类方法会让调用方绕过网关，直接打上游，用量记账与降级策略全部失效。
 */
export interface OurFreeModelService {
  /** 聚合渠道清单（76 家）。 */
  channels(): readonly Channel[]
  /** 免费车道清单（默认全部关闭，`enabled` 由配置决定）。 */
  lanes(): readonly { readonly lane: FreeLane; readonly enabled: boolean }[]
  /** 按渠道键查一家。 */
  channel(id: string): Channel | undefined
  /**
   * 把一家渠道翻成 pi-ai 的 profile。
   * @param id 渠道键。
   * @param selectedModels 只保留这些模型 id；省略则全量。
   * @returns profile；渠道不存在时 `undefined`。
   */
  profileOf(id: string, selectedModels?: readonly string[]): ProviderProfile | undefined
  /** 把已启用的免费车道翻成 profile 字典。 */
  laneProfiles(): Readonly<Record<string, ProviderProfile>>
  /**
   * 探测一家渠道的模型清单是否可达。
   *
   * 免费车道不带凭据，直接探；聚合渠道多数要 Key，而**本插件不持有凭据**
   * （凭据归 `credentials` 域），所以调用方必须把认证头传进来。
   * 不传时对需要 Key 的渠道会得到一次 401，结果里体现为 `http` 失败——
   * 这不是 bug，是「没有钥匙就别去开门」。
   * @param id 渠道键或车道键。
   * @param signal 取消信号。
   * @param headers 调用方持有的认证头（聚合渠道必需）。
   */
  probe(
    id: string,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ): Promise<ProbeOutcome>
  /** 判定出口地区；只有启用免费车道时才有意义。 */
  region(): Promise<RegionOutcome>
}

/** 本插件自己产生的错误。 */
export class OurFreeModelError extends Error {
  /**
   * @param message 人话描述。
   * @param code 机器可读原因。
   */
  constructor(message: string, readonly code: 'unknown-channel' | 'disabled' | 'lanes-off') {
    super(message)
    this.name = 'OurFreeModelError'
  }
}
