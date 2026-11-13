/**
 * 业务接口封装。
 *
 * 这一层把宿主提供的 HTTP 路径翻译成具名函数。界面只调这些函数，
 * 不知道路径长什么样——路径改动时只需改这一个文件。
 */

import { request, requestStream } from './host.ts'

/** 会话元信息，与内核 `SessionMeta` 对应。 */
export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  /**
   * 绑定的工作区绝对路径。
   *
   * 空串表示没有绑定（老会话文件没有这个字段，或建立目录失败）。
   * 界面据此决定显示路径还是"未绑定"，不猜。
   */
  workspace: string
}

/** 会话中的一条消息。 */
export interface SessionMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  createdAt: number
  toolName?: string
}

/** 模型描述，与内核 `ModelDescriptor` 对应。 */
export interface ModelDescriptor {
  id: string
  label: string
  contextWindow: number
  supportsTools: boolean
  supportsStreaming: boolean
}

/** 工具描述。 */
export interface ToolDescriptor {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 健康检查结果。 */
export interface HealthResult {
  ok: boolean
  at: number
}

/** 权限档位。与宿主 `PermissionLevel` 对应。 */
export type PermissionLevel = 'full' | 'workspace' | 'chat'

/** 主题模式。只保留浅色与深色两种主题，默认跟随系统。 */
export type ThemeMode = 'system' | 'light' | 'dark'

/** 供应商配置（读回时密钥已打码）。 */
export interface ProfileView {
  id: string
  label: string
  baseUrl: string
  model: string
  apiKey: string
  hasKey: boolean
}

/** 宿主配置视图。 */
export interface ConfigView {
  currentModel: string
  permission: PermissionLevel
  profiles: ProfileView[]
}

/** 读健康状态。 */
export async function fetchHealth(): Promise<HealthResult> {
  return await request<HealthResult>('/api/health')
}

/**
 * 读当前会话。
 *
 * 单会话制：全应用只有一段对话。返回 `null` 表示还没有开始过（新装应用）。
 *
 * ## 为什么不是一个数组
 *
 * 界面没有任何地方需要「第二条会话」。返回数组会诱导调用方写 `[0]`，
 * 而那个下标在归档段混进来时就会取错——单会话是产品口径，类型上就该是单数。
 */
export async function getCurrentSession(): Promise<SessionMeta | null> {
  return await request<SessionMeta | null>('/api/sessions')
}

/** 取单个会话。 */
export async function getSession(id: string): Promise<SessionMeta> {
  // id 必须编码：会话 id 虽为 UUID，但编码后能防止将来换成含特殊字符的
  // 标识时把路径拼坏。
  return await request<SessionMeta>(`/api/sessions/${encodeURIComponent(id)}`)
}

/** 取会话消息。 */
export async function getMessages(sessionId: string): Promise<SessionMessage[]> {
  return await request<SessionMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
}

/**
 * 删除一条消息。
 *
 * 传消息 id 而不是下标：界面手里只有 id。换算成下标是宿主的事——那里
 * 刚读过消息数组，比界面维护一份会随删除整体错位的映射可靠。
 *
 * @returns 是否真的删掉了。`false` 表示这条已经不在了（另一个窗口删过、
 *   或这是一条还没落盘的本地消息）。
 */
export async function deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
  const result = await request<{ removed: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/delete`,
    { method: 'POST', body: { messageId } },
  )
  return result.removed === true
}

/** 清空结果。 */
export interface ClearResult {
  /** 是否归档成段（保留旧数据）。 */
  archived: boolean
  /** 直接删除时删掉的条数；归档时为 0。 */
  cleared: number
  /** 清空之后的会话 id。归档时是新建的那一段。 */
  sessionId: string
  /** 归档时新段的元信息。 */
  session?: SessionMeta
}

/**
 * 清空全部。
 *
 * `archive` 默认 `true`：把当前段归档（数据留在磁盘上，只是不出现在界面上），
 * 再开一段空的。单会话意味着用户没有第二个容器放旧内容，直接抹掉会让一次
 * 误点变成永久损失。
 */
export async function clearSession(sessionId: string, archive = true): Promise<ClearResult> {
  return await request<ClearResult>(`/api/sessions/${encodeURIComponent(sessionId)}/clear`, {
    method: 'POST',
    body: { archive },
  })
}

/** 会话统计。会话抽屉的四项读数。 */
export interface SessionStats {
  sessionId: string
  /** 轮数：用户消息条数。与日志里「第 N 轮」同口径。 */
  rounds: number
  /** 会话创建时间，Unix 毫秒。 */
  startedAt: number
  /** 用户与助手正文的字符总数。 */
  totalChars: number
  /** 已归档的段数（清空过几次）。 */
  archivedSegments: number
  /** 消息总条数（含工具与系统消息）。 */
  messages: number
  title: string
  workspace: string
}

/** 读会话统计。 */
export async function getSessionStats(sessionId: string): Promise<SessionStats> {
  return await request<SessionStats>(`/api/sessions/${encodeURIComponent(sessionId)}/stats`)
}

/**
 * 会话日志的一行。
 *
 * 形状与 `lib/types.ts` 的 `LogEntry` 相同，但**单独声明**：那个文件已经
 * 从 `api.ts` 借走 `PermissionLevel`，这里再反向引用会形成类型层的环。
 * 映射放在 `useAppState` 一处，不做第二份真源。
 */
export interface SessionLogRow {
  id: string
  round: number
  at: number
  channel: 'rhythm' | 'channel' | 'model'
  actor: 'system' | 'user' | 'assistant'
  summary: string
  detail?: string
  chars?: number
  ms?: number
}

/** 读会话日志（从落盘消息派生）。 */
export async function getSessionLogs(sessionId: string): Promise<SessionLogRow[]> {
  const result = await request<{ sessionId: string; items: SessionLogRow[] }>(
    `/api/logs/session?sessionId=${encodeURIComponent(sessionId)}`,
  )
  return Array.isArray(result.items) ? result.items : []
}

/** 一条系统日志。 */
export interface SystemLogRow {
  /** 进程内自增序号，同时用作界面 key。 */
  id: number
  at: number
  level: 'info' | 'warn' | 'error'
  text: string
}

/** 读系统日志。 */
export async function getSystemLogs(limit = 200): Promise<SystemLogRow[]> {
  const result = await request<{ items: SystemLogRow[]; size: number }>(`/api/logs/system?limit=${String(limit)}`)
  return Array.isArray(result.items) ? result.items : []
}

/**
 * 读通道日志。
 *
 * 恒为空，`note` 说明原因。**不是空数组**：空数组会被读成「通道在，
 * 只是最近没消息」，而本版本八个适配器已随插件精简一并删除。
 */
export async function getChannelLogs(): Promise<{ items: unknown[]; note: string }> {
  return await request<{ items: unknown[]; note: string }>('/api/logs/channel')
}

/** 扩展清单里的一行。与宿主 `src/plugins.ts` 的 `PluginRow` 对应。 */
export interface PluginRow {
  id: string
  name: string
  version: string
  description: string
  /** 当前进程是否装载。 */
  loaded: boolean
  /** 按开关算出的下次启动状态。 */
  enabled: boolean
  /** 开关结果与当前装载不一致 → 需要重启才生效。 */
  pendingRestart: boolean
  /** 核心链成员，不允许停用。 */
  core: boolean
  /** 对应设置段 id；没有设置段时为 null。 */
  sectionId: string | null
  sectionTitle: string | null
  fields: number
}

/** 扩展清单与合计。 */
export interface PluginList {
  items: PluginRow[]
  totals: { all: number; loaded: number; pending: number }
}

/** 列出全部扩展包。 */
export async function listPlugins(): Promise<PluginList> {
  return await request<PluginList>('/api/plugins')
}

/**
 * 启用或停用一个扩展。
 *
 * 返回 `restartRequired`：本次进程不会卸载插件（撤走已 `provide` 的服务键
 * 会留下悬空引用），开关只影响下次启动。界面必须如实提示，不能假装已生效。
 */
export async function togglePlugin(id: string, enabled: boolean): Promise<{ ok: boolean; restartRequired: boolean }> {
  return await request<{ ok: boolean; restartRequired: boolean }>(
    `/api/plugins/${encodeURIComponent(id)}/toggle`,
    { method: 'POST', body: { enabled } },
  )
}

/*
 * 人设清单。
 *
 * 与 `/api/plugins` 不是一回事：插件清单回答「装了哪些能力」，人设清单
 * 回答「她现在是谁」。两者都由宿主扫目录得到，但一个是扩展抽屉的数据源，
 * 一个是标题栏与人物设定页的数据源，混在一起会出现「切人设时刷出一堆插件」。
 */
export interface PersonaSummary {
  /** 人设 id（`meta.slug`），切换时用它。 */
  id: string
  /** 包名。 */
  name: string
  /** 展示名（`display_name`），标题栏用这个。 */
  displayName: string
  version: string
  /** 出厂 / 示例 / 用户。切换浮层里按这个排序并标出角色。 */
  role: 'factory' | 'sample' | 'user'
  /** 人设卡标签。 */
  tags: string[]
  /** 包文件名，例如「哦鲸鲸.skill.zip」。 */
  archiveName: string
}

/** 人设清单。 */
export interface PersonaList {
  /** 加载器是否可用。false 时 `items` 为空、`reason` 说明原因。 */
  available: boolean
  /** 不可用原因码；可用时为 null。 */
  reason: string | null
  /** 当前人设 id。没有可用的当前人设时为 null（配的 id 不在位）。 */
  activeId: string | null
  items: PersonaSummary[]
}

/** 读人设清单。 */
export async function listPersonas(): Promise<PersonaList> {
  return await request<PersonaList>('/api/personas')
}

/**
 * 热切换当前人设。
 *
 * `persisted` 为 false 表示「这一轮已经换过去了，但没写进配置文件」，
 * 重启会退回旧人设——界面据此提示，不能假装保存成功。
 */
export async function activatePersona(id: string): Promise<{ ok: boolean; activeId: string; persisted: boolean }> {
  return await request<{ ok: boolean; activeId: string; persisted: boolean }>(
    '/api/persona/activate',
    { method: 'POST', body: { id } },
  )
}

/*
 * 她的此刻（右栏侧写的数值来源）。
 *
 * 六维一律 0–1：`mood` / `tension` / `pleasure` 的中性点是 0.5，`energy`
 * 的 0 是「提不起劲」。界面自己做 −1..1 的双极映射，宿主不替它决定刻度。
 */
export interface CompanionState {
  /** 情绪六维是否真的测到了。false 时 `axes` 是基线值，界面应显示「尚未测量」。 */
  measured: boolean
  /** 不可用原因（`no-emotion-core` 等）。 */
  reason: string | null
  /** 快照时刻。 */
  at: number
  axes: {
    pleasure: number
    arousal: number
    dominance: number
    mood: number
    energy: number
    tension: number
  }
  /** 当前最强标签；没有时为 null。 */
  dominant: string | null
  bond: {
    /** 七阶的中文名。空串表示关系服务没给。 */
    stage: string
    stageId: string
    days: number
    /** 四维，0–1。 */
    affection: number
    trust: number
    intimacy: number
    familiarity: number
  }
  /** 两个服务各自是否在位。诊断用。 */
  sources: { emotion: boolean; stage: boolean }
}

/** 读她的此刻。 */
export async function getCompanionState(): Promise<CompanionState> {
  return await request<CompanionState>('/api/companion/state')
}

/** 列出可用模型。 */
export async function listModels(): Promise<ModelDescriptor[]> {
  return await request<ModelDescriptor[]>('/api/models')
}

/** 切换到指定模型。 */
export async function selectModel(id: string): Promise<{ model: string }> {
  return await request<{ model: string }>('/api/models/select', { method: 'POST', body: { id } })
}

/** 列出可用工具。 */
export async function listTools(): Promise<ToolDescriptor[]> {
  return await request<ToolDescriptor[]>('/api/tools')
}

/** 一条记忆（宿主 `/api/memory` 的行）。 */
export interface MemoryRow {
  id: string
  /** 正文；有摘要时优先给摘要。 */
  text: string
  /** 五类标签：fact / preference / event / relation / … */
  kind: string
  /** 11 类寿命类别。 */
  category: string
  /** 显著度 0–100，列表按它降序。 */
  salience: number
  createdAt: number
  lastSeenAt: number
  important: boolean
}

/** 记忆清单。`reason` 非空时表示**读不到**，与「确实为空」不是一回事。 */
export interface MemoryList {
  items: MemoryRow[]
  total: number
  reason?: string
}

/**
 * 列出她记住的事。
 *
 * `reason` 是这条接口最要紧的字段：内核没装时返回 `no-memory-core`，
 * 读库抛错时返回 `list-failed`。界面必须把这两种与「确实一条都没有」
 * 分开——否则「记忆引擎坏了」会以「她还没记住什么」的样子出现。
 */
export async function listMemory(limit = 60): Promise<MemoryList> {
  return await request<MemoryList>(`/api/memory?limit=${String(limit)}`)
}

/**
 * 体检报告里的一条问题。
 *
 * `tier` 是修复档位：`auto` 无损可修、`confirm` 必须人点名、`advise` 归别的插件。
 * 界面按它分组显示，**不合并成一堆**——三档混排会让人以为都能一键清掉。
 */
export interface MemoryFinding {
  /** 问题种类：dangling-pin / tombstone-leak / … ，共七种。 */
  code: string
  /** 修复档位。 */
  tier: 'auto' | 'confirm' | 'advise'
  /** 涉及的记忆 id（或钉子 id）。 */
  id: string
  /** 一句话说明。 */
  detail: string
  /** 修复动作名；`advise` 档为 null。 */
  action: string | null
}

/**
 * 体检结果。
 *
 * `loaded: false` 表示自愈插件没装载；`ran: false` 表示只问了统计、
 * 没有真的扫库。两者与「查过、零问题」是同形不同义，界面必须分开说。
 */
export interface MemoryHealth {
  loaded: boolean
  available?: boolean
  /** 不可用原因：`not-loaded` / `no-core` / `disabled`。 */
  reason?: string
  /** 本次是否真的巡检过。 */
  ran?: boolean
  /** 巡检时刻。 */
  at?: number
  /** 扫了多少条记忆。 */
  scanned?: number
  /** 是否扫完整。false 时清单只是部分结果。 */
  complete?: boolean
  /** 缺席的上游服务键。 */
  missing?: string[]
  /** 三档计数。 */
  counts?: { auto: number; confirm: number; advise: number }
  findings?: MemoryFinding[]
  /** 可执行项数。 */
  actionable?: number
  /** 只能建议的项数。 */
  advisory?: number
  /** 插件累计统计。 */
  stats?: Record<string, unknown> | null
  error?: string
}

/**
 * 记忆库体检。
 *
 * `run=false` 只读统计（面板轮询用，不扫库）；`run=true` 才真的巡检一遍——
 * 巡检要翻几百条记忆并逐条算强度，不能跟着每次渲染跑。
 */
export async function getMemoryHealth(run = false): Promise<MemoryHealth> {
  return await request<MemoryHealth>(`/api/memory/health${run ? '?run=1' : ''}`)
}

/** 修复结果。 */
export interface MemoryRepairOutcome {
  key: string
  ok: boolean
  refusal?: string
  detail: string
}

/**
 * 按清单修记忆。**必须逐个点名**，没有「全修」。
 *
 * 只放行 `auto` / `confirm` 两档；`advise` 档传进来会被插件拒（`not-actionable`）。
 */
export async function repairMemory(keys: string[]): Promise<{ outcomes: MemoryRepairOutcome[]; ok: number }> {
  return await request<{ outcomes: MemoryRepairOutcome[]; ok: number }>('/api/memory/health/repair', {
    method: 'POST',
    body: { keys },
  })
}

/**
 * 做梦的状态（只读探针）。
 *
 * 三个状态必须分开说：`loaded: false`（没装）/ `available: false`（装了但不可用，
 * 比如记忆内核缺席）/ 都 true（能做梦）。合成一句「做梦不可用」会把
 * 「还没接上」与「内核坏了」说成同一件事。
 */
export interface DreamState {
  loaded: boolean
  available: boolean
  /** 不可用原因码：`not-loaded` / `no-core` / `no-model` / `disabled`。 */
  reason?: string
  /** 当前分支：`gate` / `lightweight` / `surreal`。 */
  mode?: string
  /** 插件累计统计。 */
  stats?: Record<string, unknown> | null
  /** 最近几场梦（新→旧）。 */
  history?: DreamLogEntry[]
  /** 卡片（按权重降序，含已归档）。 */
  cards?: DreamCardEntry[]
  /** 待注入的梦话条数。 */
  pendingTalk?: number
}

/** 一条做梦记账。 */
export interface DreamLogEntry {
  id: string
  /** 哪一晚（`YYYY-MM-DD`）。 */
  date: string
  mode: string
  at: number
  facts: number
  cards: number
  talk: number
  edges: number
  note: string
}

/** 一张卡片（纯规则挖出的五类之一）。 */
export interface DreamCardEntry {
  id: string
  kind: string
  title: string
  body: string
  /** 当前权重 0–1。 */
  weight: number
  archived: boolean
  uses: number
}

/** 做一场梦的结果。 */
export interface DreamRunResult {
  ran: boolean
  /** 没跑的原因：`already-today` / `not-loaded` / `unavailable` / `no-material`。 */
  skipped?: string
  ok?: boolean
  reason?: string
  mode?: string
  date?: string
  at?: number
  candidates?: number
  written?: number
  rejected?: number
  cards?: number
  talk?: number
  edges?: number
  /** 开工前备份：`created` / `skipped` / `failed`。 */
  backup?: string
  logged?: boolean
  note: string
}

/** 读做梦状态。**只读**，不扫库、不调模型。 */
export async function getDreamState(): Promise<DreamState> {
  return await request<DreamState>('/api/memory/dream')
}

/**
 * 做一场梦。
 *
 * `force` 是界面上「再来一场」那颗按钮：它只绕开宿主那道「一天一场」的闸，
 * 插件里的四道闸绕不过去。
 */
export async function runDreamNow(force = false): Promise<DreamRunResult> {
  return await request<DreamRunResult>('/api/memory/dream', {
    method: 'POST',
    body: force ? { force: true } : {},
  })
}

/**
 * 快照的探针（只读）。
 *
 * 三个状态分开：`loaded: false`（没装）/ `available: false`（装了但不可用，
 * 插件会给出人话原因）/ 都 true（能读到清单）。
 */
export interface SnapshotState {
  loaded: boolean
  available: boolean
  /** 不可用原因。**是人话**，不是原因码——插件侧给的就是这句话。 */
  reason?: string
  /** 快照目录的用户可见写法。 */
  dir?: string | null
  /** 保留份数。 */
  keep?: number
  /** 快照清单（新→旧）。 */
  items?: SnapshotItem[]
  /** 总字节数。 */
  totalBytes?: number
  /** 待执行的恢复登记（只提醒，不执行）。 */
  pendingRestore?: boolean
  /** 恢复入口接上了没有。恒 false——宿主持有着库，恢复的第二道闸不会成立。 */
  restoreWired?: boolean
}

/** 一份快照。 */
export interface SnapshotItem {
  id: string
  fileName: string
  /** 用户可见写法；绝对路径不进界面。 */
  displayPath: string
  createdAtMs: number
  sizeBytes: number
  schemaVersion: number | null
}

/** 读快照清单。只读，不建快照。 */
export async function getSnapshots(): Promise<SnapshotState> {
  return await request<SnapshotState>('/api/memory/snapshots')
}

/** 校验一份快照能不能读。会读几百 MB，故必须是显式动作。 */
export async function verifySnapshot(id: string): Promise<{ ok: boolean; check?: string; reason?: string }> {
  return await request<{ ok: boolean; check?: string; reason?: string }>('/api/memory/snapshots/verify', {
    method: 'POST',
    body: { id },
  })
}

/** 读取配置。 */
export async function getConfig(): Promise<ConfigView> {  return await request<ConfigView>('/api/config')
}

/** 写入供应商配置。整体替换语义。 */
export async function saveProfiles(profiles: ProfileView[]): Promise<void> {
  await request<{ ok: boolean }>('/api/config/profiles', { method: 'POST', body: { profiles } })
}

/** 写入权限档位。 */
export async function savePermission(permission: PermissionLevel): Promise<void> {
  await request<{ permission: PermissionLevel }>('/api/config/permission', {
    method: 'POST',
    body: { permission },
  })
}

/** 一轮对话的回调。 */
export interface InferenceHandlers {
  /** 宿主创建或确认了会话 id。首页直接打字时用它拿到新会话。 */
  onSession(sessionId: string): void
  /** 一个新到的正文片段。 */
  onDelta(text: string): void
  /**
   * 一个新到的思考片段。
   *
   * 推理模型会先吐思维链再吐正文。不把它单独给出来，界面在思考的
   * 十几秒里就是全空白——用户分不清在思考还是卡死。
   */
  onReasoning?(text: string): void
  /** 本轮结束。 */
  onDone(result: { text: string; aborted: boolean }): void
  /**
   * 她的阶段变了（思考 / 打字 / 走神 / 空闲）。
   *
   * ## 时序（宿主侧 `cordis-host/index.ts`）
   *
   * 1. 首帧正文到达时，宿主先压住它，发一帧 `presence('thinking')`；
   * 2. 停 0.8–2 秒（`firstDelay` 的区间，夹到 2 秒上限）；
   * 3. 放行首帧 `delta`，紧接着 `presence('typing')`；
   * 4. `done` 之前补一帧 `presence('idle')`。
   *
   * 也就是说：**这一帧比第一个字早**。它的全部用处就是让那段等待
   * 有内容可看——用户按了发送，气泡立刻显示她在打字，一两秒后才出字。
   *
   * 没有这个回调时界面照旧显示三点（占位消息的 `pending`），不缺信息；
   * 呼吸感插件或节奏插件缺席时宿主不报这一帧。
   */
  onPresence?(view: { show: boolean; phase: string; reason: string }): void
  /** 中途出错。 */
  onError(message: string): void
}

/**
 * 发起一轮对话。
 *
 * 用流式而非等最终结果：模型逐字产出，界面若只能等最后一次性显示，
 * 用户面对的是几秒到几十秒的空白，无法判断是在思考还是卡死了。
 *
 * @param input 用户输入。主动开口时传空串。
 * @param sessionId 会话 id。空串表示新建。
 * @param handlers 各阶段的回调。
 * @param signal 取消信号。
 * @param proactive 是否是她主动开口（§6.4 E）。为 true 时不追加用户消息，
 *   宿主会带一句本次运行临时的提示让她真的开口。
 */
export async function runInference(
  input: string,
  sessionId: string,
  handlers: InferenceHandlers,
  signal?: AbortSignal,
  proactive = false,
  /**
   * 主动开口的由头（`proactive: true` 时才用得上）。
   *
   * 传进内核后它会成为本次运行的临时提示的一部分，让模型知道「这次要说的
   * 是这件事」，而不是泛泛地接一句。缺省时只有那句通用的「主动开口」提示——
   * 那种情况下模型容易说「在忙吗」这类空话。
   */
  nudge?: string,
): Promise<void> {
  await requestStream(
    '/api/inference',
    {
      input,
      sessionId,
      ...(proactive ? { proactive: true } : {}),
      ...(nudge === undefined || nudge === '' ? {} : { nudge }),
    },
    {
      ...(signal === undefined ? {} : { signal }),
      onFrame(frame): void {
        switch (frame.event) {
          case 'session': {
            const id = (frame.data as { sessionId?: unknown }).sessionId
            if (typeof id === 'string') handlers.onSession(id)
            break
          }
          case 'delta': {
            const text = (frame.data as { text?: unknown }).text
            if (typeof text === 'string') handlers.onDelta(text)
            break
          }
          case 'reasoning': {
            const text = (frame.data as { text?: unknown }).text
            if (typeof text === 'string') handlers.onReasoning?.(text)
            break
          }
          case 'presence': {
            const data = frame.data as { show?: unknown; phase?: unknown; reason?: unknown }
            handlers.onPresence?.({
              show: data.show === true,
              phase: typeof data.phase === 'string' ? data.phase : 'idle',
              reason: typeof data.reason === 'string' ? data.reason : '',
            })
            break
          }
          case 'done': {
            const data = frame.data as { text?: unknown; aborted?: unknown }
            handlers.onDone({
              text: typeof data.text === 'string' ? data.text : '',
              aborted: data.aborted === true,
            })
            break
          }
          case 'error': {
            const message = (frame.data as { message?: unknown }).message
            handlers.onError(typeof message === 'string' ? message : '生成失败')
            break
          }
          default:
            // 未知事件类型忽略而不是报错：宿主的次版本升级可能新增事件，
            // 旧界面不该因此整轮失败。
            break
        }
      },
    },
  )
}

/** 中断正在进行的推理。 */
export async function abortInference(sessionId: string): Promise<void> {
  await request<{ aborted: boolean }>('/api/inference/abort', { method: 'POST', body: { sessionId } })
}

/**
 * 一次主动开口判定（§6.4 E、§7.4）。
 *
 * ## 为什么带上 `text`
 *
 * 门控的内容闸与 60 分钟去重要看「准备说什么」。不给正文，去重闸只能拿到
 * 一个恒定占位串，于是第一条之后永远判重复——症状是「她只主动说过一次」。
 * 这里传的是**意图描述**（由头摘要），不是最终发出去的那句话：判据需要
 * 「说的是哪件事」，正文由模型生成时还不知道。
 */
export interface ProactiveVerdict {
  /** 能不能说。 */
  allow: boolean
  /** 稳定原因码。`pass` 表示放行。 */
  code: string
  /** 一句人话，直接进「她主动开口 · {这句}」。 */
  reason: string
  /**
   * 她这次要说的事（由头摘要）。
   *
   * 有由头时宿主会填这一项：`reason` 是给用户看的**种类名**（「你交代过的事」），
   * `text` 是要带进模型上下文的**具体那件事**。两者分开是因为用户不需要读
   * 「（待办）记得明天打印合同 · 强度 0.71」这种内部记账。
   *
   * 没有由头时这一项缺席——此时不要编一句替补，那会让模型说一句空话。
   */
  text?: string
  /** 今日还剩几条。 */
  remaining: number
  /** 今日额度。 */
  quota: number
  /** 今日已用。 */
  used: number
  /** 需要等多久再说（毫秒）。 */
  deferMs: number
  /** 门控本身缺席（没装或关掉了）。与 `allow:false` 不是一回事。 */
  gateMissing: boolean
}

/** 主动开口的请求参数。 */
export interface ProactiveAsk {
  sessionId: string
  /** 会话已闲置多少分钟。 */
  idleMinutes?: number
  /** 准备说的事（由头）。缺省时宿主给一句通用描述。 */
  text?: string
}

/**
 * 判一次「此刻能不能主动开口」。
 *
 * 判据全部在宿主的 `ondra-proactive-gate` 里，界面只消费结论。
 */
export async function checkProactive(ask: ProactiveAsk): Promise<ProactiveVerdict> {
  return await request<ProactiveVerdict>('/api/proactive/check', {
    method: 'POST',
    body: {
      sessionId: ask.sessionId,
      ...(ask.idleMinutes === undefined ? {} : { idleMinutes: ask.idleMinutes }),
      ...(ask.text === undefined ? {} : { text: ask.text }),
    },
  })
}

/** 告诉宿主「这一次她主动说的话，用户点了这次不用」。 */
export async function declineProactive(sessionId: string): Promise<void> {
  await request<{ ok: boolean }>('/api/proactive/decline', {
    method: 'POST',
    body: { sessionId },
  })
}

/**
 * 声音链的探针（只读）。
 *
 * ## 为什么界面要读它，而不是只读 `tts.enable`
 *
 * `enable` 只回答「用户想不想让她说话」。真正出不出声还取决于通道在不在、
 * 闸门有没有拦、插件装没装。只看开关会得到最坏的一种界面：开关是开的、
 * 一片安静、没有任何线索。
 *
 * 三个数各有分工：
 * - `note` 非空 → 直接显示那句话，它就是答案；
 * - `gateStats.decisions` 长期 0 → 宿主那条线断了（`admit()` 没被调）；
 * - `gateStats.spoken` > 0 → 真的放行过，链子是通的。
 */
export interface VoiceState {
  ttsLoaded: boolean
  gateLoaded: boolean
  /** 用户在设置里关没关朗读。 */
  enabled: boolean
  ttsAvailable: boolean
  /** 当前通道：`macos-say` / `edge-tts` / `gpt-sovits` / `none`。 */
  engine: string
  gateAvailable: boolean
  /** 一句话说清「为什么现在不出声」。能出声时为空串。 */
  note: string
  gateStats?: {
    decisions: number
    spoken: number
    blocked: Record<string, number>
    streak: number
    lastReason?: string
    lastSpokenAt: number
  } | undefined
  ttsStats?: {
    calls: number
    ok: number
    failures: number
    played: number
    lastError?: string
    cacheFiles: number
  } | undefined
}

/** 读声音链状态。只读，不触发合成。 */
export async function getVoiceState(): Promise<VoiceState> {
  return await request<VoiceState>('/api/diagnostics/voice')
}

/** 口语化（说话口吻）状态。 */
export interface OralState {
  /** `ondra-oral` 在不在。 */
  loaded: boolean
  /** 用户在设置里关没关（`oral.enable`）。 */
  enabled: boolean
  /** 插件自报可用。 */
  available: boolean
  /** 六态语域此刻在不在位。为 false 时只改标点、语气词不动。 */
  expressReady: boolean
  /** 一句话说清「为什么现在不改字」。能改时为空串。 */
  note: string
  /**
   * 插件账本。
   *
   * `turns` 与 `puncts` 必须分开看：前者说「宿主调过它」，
   * 后者说「真的改了字」。只报一个会把「没接线」和「接了但没处可改」说成同一件事。
   */
  stats?: {
    turns: number
    messages: number
    habits: number
    incompletes: number
    particles: number
    puncts: number
    skipped: number
    pools: number
    sessions: number
    expressErrors: number
  } | undefined
}

/** 读口语化状态。只读，不塑形。 */
export async function getOralState(): Promise<OralState> {
  return await request<OralState>('/api/diagnostics/oral')
}

/** 节奏（分条 / 计时 / 呼吸）状态。 */
export interface RhythmState {
  /** 三个包各自在不在。 */
  loaded: { rhythm: boolean; typing: boolean; breath: boolean }
  /** 三个包各自自报可用。 */
  available: { rhythm: boolean; typing: boolean; breath: boolean }
  /** 被用户在设置里关掉的（`reason='disabled'`）。 */
  disabled: string[]
  /** 一句话说清「现在为什么不像人在打字」。全都正常时为空串。 */
  note: string
  /** 分条账本。`turns` 为 0 说明还没有一轮问过它。 */
  rhythm?: {
    turns: number
    messages: number
    cappedTurns: number
    overflowTurns: number
    longPauses: number
    selfCorrections: number
    avgMessages: number
    avgChars: number
  } | undefined
  /** 时间线账本。`runs` 涨说明真的排过时间线。 */
  typing?: {
    runs: number
    sent: number
    aborted: number
    superseded: number
    degraded: number
    failed: number
    active: number
    avgElapsedMs: number
  } | undefined
  /** 呼吸感账本 + 今日额度。 */
  breath?: {
    stats: { takes: number; deniedQuota: number; deniedDuplicate: number; presences: number }
    quota: {
      used: number
      cap: number
      remaining: number
      /**
       * 池子里每条动作今天的用量。
       *
       * 必须一起读：`remaining` 同时受 `cap` 与「可用动作条数」压着，
       * 出厂池只有一条动作 + 同一动作每日一次 → 永远只有 1 次可给。
       * 只报 `remaining` 会让「池子只有一条」读成「额度丢了」。
       */
      actions: { id: string; text: string; used: number }[]
    }
  } | undefined
  /**
   * 宿主视角的调用计数。
   *
   * 与插件的 `typing.runs` 口径不同：`runs` 只统计真正逐条发送的 `run()`，
   * 而单窗形态下宿主走 `schedule()`（纯预览）。`holds` 才是
   * 「宿主问过分条」的证据。
   */
  host: {
    holds: number
    lastHoldMs: number
    lastPieces: number
    skipped: number
  }
}

/** 读节奏状态。只读，不排时间线、不消耗额度。 */
export async function getRhythmState(): Promise<RhythmState> {
  return await request<RhythmState>('/api/diagnostics/rhythm')
}

/** 输出过滤（九步链）状态。 */
export interface FilterState {
  /** `ondra-filter-chain` 在不在。 */
  loaded: boolean
  /** 用户在设置里关没关（`filter-chain.enable`）。 */
  enabled: boolean
  /** 插件自报可用。 */
  available: boolean
  /** 一句话说清「现在为什么不过滤」。正常时为空串。 */
  note: string
  /** 本轮**没做**的两件事。面板要如实显示，不能只报好消息。 */
  pending: string[]
  /**
   * 插件账本。
   *
   * `runs` 与 `lastRemoved` 必须分开看：前者说「宿主调过它」，
   * 后者说「上一次真删掉了几句」。只报一个会把「没接线」和
   * 「接了但一步都没命中」说成同一件事。
   */
  stats?: {
    runs: number
    lastRemoved: number
    lastNeedsRegenerate: boolean
    reviews: number
    steers: number
    roundLimited: number
    /** 四个上游各在不在位。任一个 false，对应的那几步不会命中。 */
    sources: { persona: boolean; stage: boolean; express: boolean; gateway: boolean }
  } | undefined
}

/** 读输出过滤状态。只读，不跑过滤、不动计数。 */
export async function getFilterState(): Promise<FilterState> {
  return await request<FilterState>('/api/diagnostics/filter')
}
