/**
 * 手机端的「本地宿主」。
 *
 * ## 它模拟的是什么
 *
 * 桌面版的前端通过 HTTP 跟宿主说话：`/api/sessions`、`/api/inference`、
 * `/api/memory/*`……一共有二十几个端点。手机端没有宿主进程，但**前端不该
 * 因此改写**——那等于维护两套界面逻辑，而两套迟早会走散（改一处忘一处，
 * 用户遇到的是「手机上少了个按钮」这类说不清的问题）。
 *
 * 所以这里实现一个同形状的分发层：`request()` 检测到「没有真实宿主」时，
 * 把请求交给这张表处理。界面代码一行不改。
 *
 * ## 覆盖范围：核心全给，外围给空值
 *
 * | 类别 | 处理 |
 * | --- | --- |
 * | 会话 / 消息 | 真实实现（IndexedDB） |
 * | 推理 | 真实实现（直连模型服务） |
 * | 记忆 | 真实实现（写入、召回、寿命） |
 * | 情绪 | 真实实现（六维 + 标签 + 结算） |
 * | 配置 | 真实实现（模型端点、密钥） |
 * | 插件 / 诊断 / 日志 / 备份 | **返回合理的空值**，不抛错 |
 *
 * 最后一行是刻意设计：桌面版的「扩展功能」页会拉 `/api/plugins`。手机端
 * 没有插件系统，若让这个请求 404，那一页会显示「读不到插件」——看起来
 * 像坏了。返回一个空清单，页面显示「0 个包」，那是**准确的**。
 */

import * as store from './store.ts'
import { addFact, clearFacts, extractFacts, listFacts, removeFact, strengthOf } from './memory.ts'
import { applyEvent, loadState, readout, saveState } from './emotion.ts'
import { assembleSystem, DEFAULT_PERSONA } from './prompt.ts'
import type { Persona } from './prompt.ts'
import { streamChat } from './inference.ts'
import type { ModelConfig } from './inference.ts'

/** 模型配置的存档形状。 */
interface StoredConfig {
  currentModel: string
  profiles: Array<{ id: string; label: string; baseUrl: string; model: string; apiKey: string }>
  permission: 'full' | 'workspace' | 'chat'
}

/** 出厂配置：本地演示模型。 */
const DEFAULT_CONFIG: StoredConfig = {
  currentModel: 'local-demo',
  profiles: [],
  permission: 'chat',
}

/** 读配置。 */
export async function readConfig(): Promise<StoredConfig> {
  const stored = await store.dbGet<StoredConfig>('config', 'current')
  if (stored === undefined) return DEFAULT_CONFIG
  return {
    currentModel: typeof stored.currentModel === 'string' ? stored.currentModel : DEFAULT_CONFIG.currentModel,
    profiles: Array.isArray(stored.profiles) ? stored.profiles : [],
    permission: stored.permission ?? 'chat',
  }
}

/** 写配置。 */
export async function writeConfig(next: StoredConfig): Promise<void> {
  await store.dbPut('config', 'current', next)
}

/** 读人设。 */
export async function readPersona(): Promise<Persona> {
  const stored = await store.dbGet<Persona>('persona', 'current')
  if (stored === undefined) return DEFAULT_PERSONA
  return {
    name: typeof stored.name === 'string' && stored.name !== '' ? stored.name : DEFAULT_PERSONA.name,
    userAddress: typeof stored.userAddress === 'string' ? stored.userAddress : '',
  }
}

/** 写人设。 */
export async function writePersona(next: Persona): Promise<void> {
  await store.dbPut('persona', 'current', next)
}

/** 当前生效的模型配置。没有可用供应商时返回 undefined。 */
export async function activeModel(): Promise<ModelConfig | undefined> {
  const config = await readConfig()
  const profile = config.profiles.find((item) => item.id === config.currentModel)
  if (profile === undefined) return undefined
  return { baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey }
}

/**
 * 一轮对话的完整流程。
 *
 * 顺序：结算情绪 → 召回记忆 → 装配提示词 → 流式推理 → 落盘 → 更新情绪。
 *
 * ## 为什么情绪在推理**之后**才更新
 *
 * 用户这句话会推动情绪（「今天好累」让 energy 掉），但若在推理前就更新，
 * 模型会看到「用户刚说完累、她的状态已经变了」——而实际上她应该先以
 * 当前状态回应，回应之后这件事才沉淀下来。这与人的感受顺序一致。
 */
export async function runTurn(
  input: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; error?: string }> {
  const now = Date.now()
  const config = await readConfig()
  const model = await activeModel()
  if (model === undefined) {
    return { text: '', error: '还没有配置模型服务。到「设置 · 模型与 API」填一个端点即可。' }
  }

  /* 1. 结算情绪（锁屏三小时再打开时，这一步让状态回到当下） */
  let emotion = await loadState(now)

  /* 2. 召回记忆 */
  const facts = await listFacts()

  /* 3. 装配提示词 */
  const persona = await readPersona()
  const system = assembleSystem(persona, facts, emotion, now)

  /* 4. 取历史（最近 20 条，够一轮上下文） */
  const history = (await store.listMessages()).slice(-20)

  const messages = [
    { role: 'system' as const, content: system },
    ...history.map((item) => ({ role: item.role, content: item.content })),
    { role: 'user' as const, content: input },
  ]

  /* 5. 落用户消息（先落：中断时这句话也不该丢） */
  await store.appendMessage({
    id: store.localId('msg'),
    role: 'user',
    content: input,
    at: now,
  })

  /* 6. 推理 */
  let full = ''
  let failure = ''
  await streamChat(
    model,
    messages,
    {
      onDelta(text) { full += text; onDelta(text) },
      onDone() { /* 收尾在下面统一做 */ },
      onError(message) { failure = message },
    },
    signal,
  )

  if (failure !== '') return { text: full, error: failure }

  /* 7. 落她的回复。空回复不落——那会在时间线上留一个空气泡。 */
  if (full.trim() !== '') {
    await store.appendMessage({
      id: store.localId('msg'),
      role: 'assistant',
      content: full,
      at: Date.now(),
    })
  }

  /* 8. 更新情绪：这句话会推动状态 */
  emotion = applyEvent(emotion, eventFor(input, full))
  await saveState(emotion)

  /* 9. 提炼记忆 */
  for (const fact of extractFacts(input)) {
    await addFact(fact, now)
  }

  void config
  return { text: full }
}

/**
 * 一句话应该怎么推动情绪。
 *
 * ## 为什么用关键词而不是再调一次模型
 *
 * 再调一次模型意味着每轮对话两次往返、两倍延迟，而情绪是**慢变量**——
 * 一句话判得粗一点，长期看会被后续几十句修正。桌面版用模型做细粒度
 * 判定，手机端用规则，差别在精度而不在方向。
 *
 * 规则只认最明确的信号，判不出来就不动（`{}`）——乱推比不推更糟：
 * 用户说「今天加班」被推成「开心」，她会笑着回应，那比没有情绪更怪。
 */
export function eventFor(userText: string, replyText: string): Parameters<typeof applyEvent>[1] {
  const text = `${userText} ${replyText}`

  /*
   * ## 强度为什么给到接近满档
   *
   * `axisDelta()` 把意图乘以 `MAX_STEP = 0.12`（手册 §3.2 的「单条消息
   * 影响上限」）。那个上限是**防止一句话翻天覆地**，不是「一句话只该
   * 有这么点影响」——传 0.35 时实际位移只有 0.042，在 0–100 的 energy 上
   * 等于 4.2 点，用户说完「今天累死了」看她还是活蹦乱跳。
   *
   * 所以判到明确信号就给 0.9–1.0：让这一条消息**用满它被允许的那 12 点**。
   * 连续说三句累，才会累到明显；说一句，只是"有点"。这与人的感受一致，
   * 也没有突破手册的上限。
   */
  if (/(累|疲惫|加班|难受|不开心|烦|压力|难过|哭|困)/.test(text)) {
    return { axes: { energy: -1, mood: -0.8, pleasure: -0.5 }, labels: { sadness: 0.6 } }
  }
  if (/(生气|讨厌|滚|别烦我|气死|火大)/.test(text)) {
    return { axes: { pleasure: -1, arousal: 0.9, tension: 1 }, labels: { anger: 0.7 } }
  }
  if (/(焦虑|紧张|担心|害怕|睡不着|慌)/.test(text)) {
    return { axes: { arousal: 0.9, mood: -0.6 }, labels: { anxiety: 0.6 } }
  }

  /* 正面信号 */
  if (/(开心|高兴|太好了|哈哈|笑死|喜欢|爱你|棒)/.test(text)) {
    return { axes: { pleasure: 1, mood: 0.8, energy: 0.6 }, labels: { joy: 0.7 } }
  }
  if (/(谢谢|感谢|辛苦)/.test(text)) {
    return { axes: { pleasure: 0.6, mood: 0.4 }, labels: { moved: 0.5 } }
  }

  /* 判不出来就不动 */
  return {}
}

/* ------------------------------------------------------------------ *
 * API 分发表
 * ------------------------------------------------------------------ */

/** 一个端点的处理结果。`body` 会被 JSON 序列化。 */
export interface LocalResponse {
  status: number
  body: unknown
}

/** 会话形状，与桌面版 `/api/sessions` 对齐。 */
async function sessionView(): Promise<unknown> {
  const session = await store.currentSession()
  const messages = await store.listMessages()
  return {
    id: session.id,
    title: session.title,
    createdAt: session.startedAt,
    updatedAt: messages.length === 0 ? session.startedAt : (messages.at(-1)?.at ?? session.startedAt),
    archived: false,
    workspace: '',
  }
}

/** 情绪状态的对外形状，与桌面版 `/api/companion/state` 对齐。 */
async function companionView(): Promise<unknown> {
  const now = Date.now()
  const state = await loadState(now)
  const view = readout(state)
  return {
    present: true,
    available: true,
    measured: true,
    axes: {
      pleasure: state.axes.pleasure,
      arousal: state.axes.arousal,
      dominance: state.axes.dominance,
      mood: view.mood / 100,
      energy: view.energy / 100,
      tension: view.tension,
    },
    labels: state.labels,
    label: view.label ?? '',
  }
}

/**
 * 处理一个请求。
 *
 * 未覆盖的端点统一返回 200 + 空结构，不返回 404——理由见文件头。
 */
export async function dispatch(rawPath: string, method: string, body: unknown): Promise<LocalResponse> {
  /*
   * 剥掉查询串再匹配。
   *
   * 前端会拼 `/api/memory?limit=60` 这类带参数的路径。若拿完整路径去比
   * `path === '/api/memory'`，永远不成立——症状是那一页显示「拉取失败」，
   * 而本地实现明明在。
   */
  const path = rawPath.split('?')[0] ?? rawPath
  const now = Date.now()

  /* ---- 健康 ---- */
  if (path === '/api/health') {
    return { status: 200, body: { ok: true, version: 'local', uptime: 0 } }
  }

  /* ---- 会话 ---- */
  if (path === '/api/sessions' && method === 'GET') {
    return { status: 200, body: await sessionView() }
  }
  if (path.startsWith('/api/sessions/') && path.endsWith('/messages') && method === 'GET') {
    const messages = await store.listMessages()
    return {
      status: 200,
      body: messages.map((item) => ({
        id: item.id,
        role: item.role,
        content: item.content,
        text: item.content,
        /*
         * `createdAt` 与 `at` 两个字段都给。
         *
         * 界面读 `createdAt`（桌面版宿主的字段名），而本地存储用的是 `at`。
         * 只给 `at` 时日期会渲染成 `NaN 年 NaN 月 NaN 日`——`new Date(undefined)`
         * 不报错，只产出 Invalid Date，而 `getFullYear()` 返回 NaN。
         *
         * 两个都给而不是改名：改本地字段名会让存储层与桌面版的导出格式
         * 对不上，而多给一个字段没有任何代价。
         */
        createdAt: item.at,
        at: item.at,
      })),
    }
  }

  /* ---- 消息删除 ---- */
  if (path.startsWith('/api/messages/') && method === 'DELETE') {
    const id = path.slice('/api/messages/'.length)
    await store.deleteMessage(decodeURIComponent(id))
    return { status: 200, body: { ok: true } }
  }

  /* ---- 清空 ---- */
  if (path === '/api/sessions/clear' || (path.startsWith('/api/sessions/') && path.endsWith('/clear'))) {
    await store.clearMessages()
    return { status: 200, body: { cleared: 0, archived: 0 } }
  }

  /* ---- 配置 ---- */
  if (path === '/api/config' && method === 'GET') {
    const config = await readConfig()
    return { status: 200, body: config }
  }
  if (path === '/api/config/profiles' && method === 'POST') {
    const payload = body as { profiles?: StoredConfig['profiles'] } | undefined
    const config = await readConfig()
    const next: StoredConfig = {
      ...config,
      profiles: Array.isArray(payload?.profiles) ? payload.profiles : [],
    }
    await writeConfig(next)
    return { status: 200, body: next }
  }
  if (path === '/api/models/select' && method === 'POST') {
    const payload = body as { id?: unknown } | undefined
    const config = await readConfig()
    const id = typeof payload?.id === 'string' ? payload.id : ''
    const next: StoredConfig = { ...config, currentModel: id }
    await writeConfig(next)
    return { status: 200, body: next }
  }
  if (path === '/api/config/permission' && method === 'POST') {
    const payload = body as { permission?: unknown } | undefined
    const config = await readConfig()
    const level = payload?.permission
    const next: StoredConfig = {
      ...config,
      permission: level === 'full' || level === 'workspace' || level === 'chat' ? level : config.permission,
    }
    await writeConfig(next)
    return { status: 200, body: next }
  }

  /* ---- 模型清单 ---- */
  if (path === '/api/models' && method === 'GET') {
    /*
     * 返回**数组**，不是 `{ items }`。
     *
     * `listModels()` 的返回类型是 `ModelDescriptor[]`，界面直接
     * `models.find(...)`。包一层会让它变成 `undefined.find`——
     * 而那是一个整页白屏的错误。
     */
    const config = await readConfig()
    return {
      status: 200,
      body: config.profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        model: profile.model,
        current: profile.id === config.currentModel,
        local: /^https?:\/\/(127\.0\.0\.1|localhost)/.test(profile.baseUrl),
      })),
    }
  }

  /* ---- 情绪 ---- */
  if (path === '/api/companion/state') {
    return { status: 200, body: await companionView() }
  }

  /* ---- 记忆 ---- */
  if (path === '/api/memory' && method === 'GET') {
    const facts = await listFacts()
    const rows = facts
      .map((fact) => ({ ...fact, strength: strengthOf(fact, now) }))
      .sort((left, right) => right.strength - left.strength)
    return { status: 200, body: { items: rows, total: rows.length } }
  }
  if (path.startsWith('/api/memory/') && method === 'DELETE') {
    const id = path.slice('/api/memory/'.length)
    await removeFact(decodeURIComponent(id))
    return { status: 200, body: { ok: true } }
  }
  if (path === '/api/memory/clear' && method === 'POST') {
    await clearFacts()
    return { status: 200, body: { ok: true } }
  }

  /* ---- 人设 ---- */
  if (path === '/api/persona' && method === 'GET') {
    return { status: 200, body: await readPersona() }
  }
  if (path === '/api/persona' && method === 'POST') {
    const payload = body as Partial<Persona> | undefined
    const current = await readPersona()
    const next: Persona = {
      name: typeof payload?.name === 'string' ? payload.name : current.name,
      userAddress: typeof payload?.userAddress === 'string' ? payload.userAddress : current.userAddress,
    }
    await writePersona(next)
    return { status: 200, body: next }
  }

  /* ---- 设置：手机端没有插件系统，返回空清单而不是 404 ---- */
  if (path === '/api/settings') {
    return { status: 200, body: { sections: [], user: {}, totals: { sections: 0, fields: 0, unregistered: 0 } } }
  }
  if (path === '/api/plugins') {
    return { status: 200, body: { items: [], totals: { total: 0, loaded: 0, enabled: 0 } } }
  }
  if (path === '/api/personas') {
    return { status: 200, body: { items: [], activeId: '' } }
  }
  if (path === '/api/tools') {
    return { status: 200, body: { items: [] } }
  }
  if (path === '/api/logs/channel') {
    return { status: 200, body: { items: [] } }
  }
  if (path.startsWith('/api/diagnostics/')) {
    return { status: 200, body: { present: false, available: false, reason: '手机端没有这一层' } }
  }

  /* ---- 兜底：不 404，返回空对象 ---- */
  return { status: 200, body: {} }
}

/** 把一次推理包装成分发层能用的形式（供 `host.ts` 的流式分支调用）。 */
export async function dispatchStream(
  body: unknown,
  onFrame: (event: string, data: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const payload = body as { input?: unknown } | undefined
  const input = typeof payload?.input === 'string' ? payload.input : ''
  const session = await store.currentSession()
  onFrame('session', { sessionId: session.id })
  onFrame('presence', { show: true, phase: 'thinking', reason: '' })

  const result = await runTurn(
    input,
    (text) => { onFrame('delta', { text }) },
    signal,
  )

  if (result.error !== undefined) {
    onFrame('error', { message: result.error })
  }
  onFrame('done', { text: result.text, aborted: signal?.aborted === true })
  onFrame('presence', { show: false, phase: 'idle', reason: '' })
}

/** 供界面读取的「当前是否本地模式」。 */
export const LOCAL_MODE = true