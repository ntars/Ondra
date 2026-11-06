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

/** 列出会话。 */
export async function listSessions(): Promise<SessionMeta[]> {
  return await request<SessionMeta[]>('/api/sessions')
}

/** 创建会话。 */
export async function createSession(title: string): Promise<SessionMeta> {
  return await request<SessionMeta>('/api/sessions', { method: 'POST', body: { title } })
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

/** 归档会话。 */
export async function archiveSession(sessionId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: 'POST' })
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

/** 读取配置。 */
export async function getConfig(): Promise<ConfigView> {
  return await request<ConfigView>('/api/config')
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
  /** 中途出错。 */
  onError(message: string): void
}

/**
 * 发起一轮对话。
 *
 * 用流式而非等最终结果：模型逐字产出，界面若只能等最后一次性显示，
 * 用户面对的是几秒到几十秒的空白，无法判断是在思考还是卡死了。
 *
 * @param input 用户输入。
 * @param sessionId 会话 id。空串表示新建。
 * @param handlers 各阶段的回调。
 * @param signal 取消信号。
 */
export async function runInference(
  input: string,
  sessionId: string,
  handlers: InferenceHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await requestStream(
    '/api/inference',
    { input, sessionId },
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
