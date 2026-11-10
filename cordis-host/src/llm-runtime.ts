/**
 * 把内核的模型能力挂成 `ctx.llm` —— 宿主侧的模型运行时。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-llm-gateway` 的 `available` 只有一个判据：`ctx.get('llm') !== undefined`。
 * 而 `llm` 这个服务键**整仓没有任何注册方**：`grep "provide('llm'"` 零命中。
 * 于是：
 *
 * ```
 * 用户说「我叫小玖，住在杭州」
 *   → intake 收到轮次，原文落 memory_raw（这一步通）
 *   → 提炼器 extract() 判可用性 → no-gateway → 直接返回 ok=false
 *   → memory_fact 从建库起一直 0 行
 * ```
 *
 * 更麻烦的是它**不报错**：`no-gateway` 是设计好的降级路径，日志里只有一行
 * warn，界面上一切正常。上一轮修好 `session/event` 之后 `memory_raw` 有数了，
 * 而 `memory_fact` 还是 0——差的就是这一环。
 *
 * ## 为什么不让宿主自己发 HTTP
 *
 * 提炼要模型，模型的**端点、密钥、模型名**只住在内核的 `ChatAdapter` 里
 * （由 `model.configure` 推过去的）。宿主自己发请求意味着把这三样再复制一份、
 * 把「请求体怎么拼、超时怎么算、供应商错误怎么翻」再实现一遍。
 * 两份实现迟早不一致，而症状是「对话正常、提炼静默失联」——正是现在这个形态。
 *
 * 所以这里只做**协议转接**：网关要 `AsyncIterable<GatewayChunk>`，
 * 而内核给 `model.complete` 的一次性文本。中间这层把一段文本拆成
 * `text-delta` + `finish` 两块，形状对上即可，**不做任何解码或重试**。
 *
 * ## 为什么不做流式
 *
 * 网关的 `complete()` 本来就是「把流拼成一段文本」。提炼与做梦都不需要
 * 逐字上屏，为它们在内核侧再开一条 SSE 转发链路，等于给一个没有观看者的
 * 流建基础设施。等真有「需要边生成边看的非对话调用」再谈。
 */

import type { Context } from '@ntars/cordis'

/** 服务键。与 `ondra-llm-gateway` 里 `ctx.get('llm')` 的字符串逐字一致。 */
export const LLM_RUNTIME_KEY = 'llm'

/** 内核 `model.complete` 返回的形状（只读我们用的那两个字段）。 */
interface CompleteResult {
  readonly text?: unknown
  readonly model?: unknown
}

/** 内核客户端的最小面。 */
interface KernelClientLike {
  call(method: string, params?: unknown): Promise<unknown>
  getState?(): { readonly running?: boolean }
}

/**
 * 网关认的 provider 路由键。
 *
 * 为什么只有这一个：网关的 `provider` 字段是「上游 `ctx.llm` 里注册的适配器
 * 路由名」，而对本仓来说**上游就是内核**——内核只有一个 `ChatAdapter`，
 * 它底下接的是任意 OpenAI 兼容端点。所以「路由」这一层在这里退化成
 * 一个固定名字，真正的供应商差异由 `model` 字段承担。
 *
 * 这个名字会出现在设置页的来源清单里（`sources[].provider`），
 * 所以必须稳定、小写、符合 `NAME_RE`。
 */
export const KERNEL_PROVIDER = 'kernel'

/** 运行时的模型清单条目（`LlmProviderInfoLike`）。 */
interface ProviderInfo {
  readonly id: string
  readonly name: string
}

/** 网关会读的调用参数。只声明本层真正用到的字段。 */
interface CallOptionsLike {
  readonly model?: unknown
  readonly messages?: unknown
  readonly system?: unknown
  readonly temperature?: unknown
  readonly maxTokens?: unknown
  readonly signal?: unknown
}

/**
 * 造一个 `LlmRuntimeLike`。
 *
 * @param getClient 取内核客户端。用取值函数而不是装载时取一次：
 *   内核客户端由 `dsh-client` 插件提供，装载顺序不保证，晚到时要能自愈。
 * @param getModels 取**当前**已配置的模型 id 清单。同样用取值函数，
 *   理由见 `stream()` 里那段「为什么不能信 `options.model`」。
 */
export function createKernelLlmRuntime(
  getClient: () => KernelClientLike | undefined,
  getModels: () => readonly string[],
): {
  readonly listProviders: () => readonly ProviderInfo[]
  readonly stream: (options: unknown) => AsyncIterable<unknown>
} {
  return {
    /*
     * 恒返回这一个 provider，**即使内核还没起来**。
     *
     * 网关的 `probe()` 用这份清单判「路由注册了没有」。若内核未就绪时返回
     * 空数组，网关会把来源标成 `provider-missing` 并缓存下来——而它的重算
     * 条件只看 `available === false`，等内核起来后要等下一次调用才可能纠正，
     * 中间那几轮提炼全是 `no-source`。恒返回反而更准确：
     * 「路由存在，但现在发不出去」由 `stream()` 抛错表达，那是可重试的。
     */
    listProviders(): readonly ProviderInfo[] {
      return Object.freeze([{ id: KERNEL_PROVIDER, name: '内核模型' }])
    },

    async *stream(options: unknown): AsyncIterable<unknown> {
      const client = getClient()
      if (client === undefined) {
        throw new Error('内核客户端未装载，无法发起模型调用')
      }
      const call = (options ?? {}) as CallOptionsLike

      // 取消：内核的 `model.complete` 没有中断入口（它短、无人观看、也不会被
      // 用户按停止）。所以这里只做「调用前已取消就不发」这一层，
      // 调用途中被取消则由网关那侧的 AbortSignal 超时兜底。
      const signal = call.signal as AbortSignal | undefined
      if (signal?.aborted === true) {
        throw Object.assign(new Error('调用方已取消'), { name: 'AbortError' })
      }

      const params: Record<string, unknown> = {
        messages: normalizeMessages(call.messages),
      }
      const model = resolveModel(call.model, getModels())
      if (model !== undefined) params['model'] = model
      if (typeof call.system === 'string' && call.system !== '') params['system'] = call.system
      if (typeof call.temperature === 'number') params['temperature'] = call.temperature
      if (typeof call.maxTokens === 'number') params['maxTokens'] = call.maxTokens

      const raw = await client.call('model.complete', params)
      const result = (raw ?? {}) as CompleteResult
      const text = typeof result.text === 'string' ? result.text : ''

      /*
       * 分两块发。
       *
       * 网关的 `complete()` 只认 `text-delta` 与 `finish`，但它的 `stream()`
       * 里有一条更硬的要求：**首块之后不再重试**，判据是 `finish.reason.kind`。
       * 所以必须发 `finish{kind:'stop'}`——不发的话网关会一直等到块间隔超时，
       * 把一次成功的调用判成 `idle-timeout`。
       *
       * 空文本也照发 finish：`ok=true + 空` 是合法结果（「这段没什么值得记的」），
       * 与「调用失败」必须能被下游区分开。
       */
      if (text !== '') {
        yield { type: 'text-delta', index: 0, text }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/**
 * 决定这次调用用哪个模型。
 *
 * ## 为什么不能直接信 `options.model`
 *
 * 网关的来源清单（`sources`）是**启动时的一份配置快照**：它把「当时配好的
 * 供应商」抄成了 `{ provider, model }`。而供应商清单本身是**运行时可变**的
 * ——用户在设置里换一个模型，快照不会跟着变。
 *
 * 症状很具体：实测里 `sources[0].model = 'auto/deepseek-v4.1-flash'`（内置预设），
 * 而用户实际配的是 `fake-model`。于是内核收到一个不存在的模型 id，
 * 回「模型不存在：…」，提炼 `calls=1 / failed=1`，`memory_fact` 仍是 0 行。
 *
 * 这与本轮修的其他几处同族：**同一件事存了两份，一份会漂**。
 * 所以这里以**当前配置**为准：网关说的名字还在清单里就用它，
 * 不在了就退到清单第一条；清单为空则完全不传，让内核用它的 `currentModel`。
 *
 * @param requested 网关要求用的模型名。
 * @param current 当前已配置的模型 id。
 * @returns 实际要传给内核的模型名；`undefined` 表示不传。
 */
function resolveModel(requested: unknown, current: readonly string[]): string | undefined {
  const wanted = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : undefined
  if (wanted !== undefined && current.includes(wanted)) return wanted
  // 第一条即「用户排在最前的那个」，与来源清单的 priority 顺序一致。
  if (current.length > 0) return current[0]
  // 一个都没配：交给内核的 `currentModel`（它自己会退回本地演示模型）。
  return undefined
}


/**
 * 把网关转来的消息压成内核认的形状。
 *
 * 网关会把 `content` 从字符串补成 `[{type:'text',text}]`（见它的
 * `toModelMessages`），而内核的 `model.complete` 只收纯字符串。
 * 这里做反向展开——**只认纯文本块**，遇到别的块（图片、工具调用）
 * 就跳过当前消息而不是整条丢弃：宁可少一段，也不要让一次提炼因为
 * 一个没见过的块类型直接失败。
 * @param raw 网关给的消息数组。
 */
function normalizeMessages(raw: unknown): { readonly role: string; readonly content: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { role: string; content: string }[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { readonly role?: unknown; readonly content?: unknown }
    const role = record.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue
    const text = flattenContent(record.content)
    if (text === '') continue
    out.push({ role, content: text })
  }
  return out
}

/**
 * 把内容块数组拼回一段纯文本。
 * @param content 字符串或内容块数组。
 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const pieces: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      pieces.push(block)
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    const record = block as { readonly type?: unknown; readonly text?: unknown }
    if (record.type !== 'text') continue
    if (typeof record.text === 'string') pieces.push(record.text)
  }
  return pieces.join('')
}

/**
 * 把运行时挂成上下文服务。
 *
 * 用 `ctx.provide` 而不是给 `ctx` 赋属性：Cordis 4 拒绝未经 provide 的属性写入，
 * 且 provide 会把撤销动作挂到当前 fiber 上（宿主退出时自动实现清理）。
 *
 * @param ctx 宿主根上下文。
 * @param getClient 取内核客户端。
 * @param getModels 取**当前**已配置的模型 id 清单（每次调用时读，不缓存快照）。
 */
export function provideKernelLlm(
  ctx: Context,
  getClient: () => KernelClientLike | undefined,
  getModels: () => readonly string[],
): void {
  const runtime = createKernelLlmRuntime(getClient, getModels)
  // 仅注册服务，不建插件：这一层的生命周期与宿主进程完全一致，
  // 单独建一个包只会多一层 `apply` 的间接。
  ctx.provide(LLM_RUNTIME_KEY, runtime as unknown as never)
}

/** 一条用户配好的供应商（宿主 `StoredProfile` 的子集）。 */
interface ProfileLike {
  readonly id?: unknown
  readonly label?: unknown
  readonly model?: unknown
}

/** 网关要的来源条目（`SourceSpec` 的子集，只写本层真正决定的字段）。 */
export interface DerivedSource {
  readonly id: string
  readonly kind: string
  readonly provider: string
  readonly model: string
  readonly priority: number
}

/**
 * 把用户配好的供应商清单翻成网关的来源清单。
 *
 * ## 为什么要有这一步
 *
 * `ondra-llm-gateway` 的 `sources` 默认是空数组，而且它**刻意不猜**：
 * `provider` 是「上游适配器注册的路由键」，编一个出来就是假开关（插件注释
 * 原话：「不做假开关」）。对旧项目那套多适配器架构，这个决定是对的——
 * 用户装了什么适配器，网关无从得知。
 *
 * 但本仓只有一个上游：内核的 `ChatAdapter`。它能接任何 OpenAI 兼容端点，
 * 供应商差异全部表达在**模型配置**里（`baseUrl` + `model` + `apiKey`）。
 * 所以「用户配了几个供应商」与「网关该有几条来源」是同一件事，
 * 让用户在两个界面各填一遍才是真正的第二份真源。
 *
 * ## `model` 字段填的是**供应商 id**，不是模型名
 *
 * 这一处极易搞错，实测踩过：网关的 `model` 语义是「透传给上游
 * `GenerateOptions.model`」，而对内核来说那个位置要的是**供应商 id**
 * （`ChatAdapter.run()` 用 `request.model` 去 `profiles.find(p => p.id === …)`）。
 * 填成模型名（`fake-model`）会得到「模型不存在：fake-model」，
 * 提炼 `calls=1 / failed=1`，`memory_fact` 依旧 0 行。
 *
 * 两个名字同时存在是必要的：`id` 是「选哪条配置」，`model` 是「用哪个模型」。
 * 语义不同，不能互换。
 *
 * ## 为什么要改 id
 *
 * 来源 id 受 `NAME_RE` 约束（`^[a-z][a-z0-9_-]{1,63}$`），而用户配的
 * 供应商 id 可以是任意串（`fake/e2e`、`DeepSeek 官方`）。直接透传会被
 * 网关逐条丢弃，症状是「配了模型，提炼还是 no-source」。
 * 所以这里做一次**确定性清洗**：非法字符换成 `-`、转小写、保证字母开头、
 * 截到 64 字符；重名追加序号，保证全清单唯一。
 *
 * ## 为什么固定 `kind='remote'`
 *
 * `kind` 只影响默认参数（超时、重试次数）与展示，不影响协议。而这一层
 * 看不到 `baseUrl` 是不是 localhost——猜「跑在本机就是 local」会在用户
 * 把 Ollama 挂到另一台机器时猜错。`remote` 是唯一不会错的那个值：
 * 它对所有来源都成立（请求都走网络栈）。
 *
 * @param profiles 用户配好的供应商。
 * @returns 可直接塞进网关配置的来源清单。
 */
export function sourcesFromProfiles(profiles: readonly ProfileLike[]): readonly DerivedSource[] {
  const used = new Set<string>()
  const out: DerivedSource[] = []
  for (const [index, profile] of profiles.entries()) {
    const profileId = typeof profile.id === 'string' ? profile.id.trim() : ''
    // 没有 id 的供应商内核认不出来，塞进清单只会让网关多一次注定失败的尝试。
    if (profileId === '') continue
    const base = sanitizeSourceId(profileId)
    let id = base
    let suffix = 2
    while (used.has(id)) {
      // 截断到 61 再拼序号，保证总长不超过 64。
      id = `${base.slice(0, 61)}-${String(suffix)}`
      suffix += 1
    }
    used.add(id)
    out.push(
      Object.freeze({
        id,
        kind: 'remote',
        provider: KERNEL_PROVIDER,
        // 供应商 id：内核据此在 `profiles` 里查「用哪条配置」。见上方注释。
        model: profileId,
        // 顺序即优先级：用户把哪条排在前，哪条先试。
        priority: index * 10,
      }),
    )
  }
  return Object.freeze(out)
}

/**
 * 把一个任意串清洗成合法来源 id。
 *
 * 口径与网关的 `NAME_RE` 逐字对齐：`^[a-z][a-z0-9_-]{1,63}$`。
 * 起首必须是小写字母，所以先补一个 `s` 前缀再截断——比「丢掉开头的数字」
 * 更可预测（用户能看出 `9router` 变成了 `s9router`，而不是变成了 `router`）。
 * @param raw 原始 id。
 */
function sanitizeSourceId(raw: string): string {
  const cleaned = raw
    .normalize('NFKC')
    .toLowerCase()
    // 非 [a-z0-9_-] 一律折成连字符：保留「有几个词」这个信息，比删掉更好认。
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // 空串或纯符号：给一个能站住的默认名，不留空 id。
  if (cleaned === '') return 'profile'
  const prefixed = /^[a-z]/.test(cleaned) ? cleaned : `s${cleaned}`
  return prefixed.slice(0, 64)
}
