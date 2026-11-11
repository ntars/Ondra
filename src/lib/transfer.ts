/**
 * 会话的导出与导入（迁移 / 恢复）。
 *
 * ## 会话本来就是明文
 *
 * 落盘是 `sessions/<uuid>.json`，一个会话一个文件、内容是未压缩的 JSON。
 * 所以这个文件不负责"加密"或"打包"——它只是把宿主已经算好的东西
 * 搬到磁盘上，以及把磁盘上的东西交回宿主。界面缺的从来不是明文，
 * 而是**两个可执行的出口**。
 *
 * ## 为什么格式化在宿主
 *
 * 界面手里只有当前这一段的消息，归档段它根本没见过。「导出全部」要成立，
 * 格式化就必须发生在能列出全部会话的地方。这里只做两件本地事：
 * 拼一个用户看得懂的文件名、把文本写进下载目录。
 *
 * ## 为什么写下载目录而不是弹「另存为」
 *
 * 弹对话框要引 `tauri-plugin-dialog`，而这个项目一直避免为单一功能加插件。
 * 更要紧的是：导出的用途是「带走一份」，落到最容易找到的位置再当场打开
 * 它所在的文件夹，比让用户在树形目录里选路径少两步，也不容易存丢。
 */

import { request } from './host.ts'
import { invokeShell } from './shell.ts'

/** 导出接口返回的一段会话。字段与宿主 `SessionPayload` 一一对应。 */
interface SessionPayload {
  format: number
  exportedAt: number
  id: string
  title: string
  createdAt: number
  updatedAt: number
  workspace: string
  messages: Array<{ role: string; content: string; createdAt?: number; toolName?: string }>
}

/** `GET /api/export/session/:id` 的响应。 */
interface SingleExport {
  session: SessionPayload
  markdown: string
}

/** `GET /api/export/all` 的响应。 */
interface AllExport {
  format: number
  exportedAt: number
  sessions: SessionPayload[]
}

/** `POST /api/import` 的响应。 */
export interface ImportOutcome {
  /** 真正写进去的消息条数。 */
  imported: number
  /** 新会话的标题（取自文件，可能为空串）。 */
  title: string
  /** 被归档的上一段。空串表示导入前没有会话。 */
  archivedId: string
}

/**
 * 把时间戳排成 `2026-02-14` 这样的日期。
 *
 * 不用 `toLocaleDateString`：它按系统地区设置排版，同一份文件在不同机器上
 * 会得到 `2/14/2026` 或 `14.02.2026`，而文件名应该是可排序、可比较的。
 */
function stamp(at: number | undefined): string {
  const date = new Date(at ?? Date.now())
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 把标题洗成能进文件名的样子。
 *
 * 与壳里的 `sanitize_filename` 是同一条规则的两半：壳负责**必须**洗掉的
 * 字符（路径分隔符），这里负责**读起来**该短一些。两边都做不是重复——
 * 壳那一层是安全边界（前端可以被替换），这一层是可读性。
 */
function slug(title: string): string {
  const trimmed = title.trim().replace(/[\\/:*?"<>|]/g, '-')
  if (trimmed === '') return '未命名'
  // 20 字够认出是哪一段，再长会把文件名撑到列表里显示不全。
  return trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed
}

/** 写进下载目录，返回落盘路径。 */
async function save(filename: string, content: string): Promise<string> {
  return invokeShell<string>('save_export', { filename, content })
}

/**
 * 导出当前这一段。
 *
 * 同时拿到 JSON 与 Markdown 两种形态：前者能原样倒回来，后者是给人读的。
 * 一次请求拿两份，用户点两个按钮时不必再跑一次网络。
 */
export async function exportCurrent(sessionId: string): Promise<{ json: string; markdown: string; title: string }> {
  const data = await request<SingleExport>(`/api/export/session/${encodeURIComponent(sessionId)}`)
  return {
    json: JSON.stringify(data.session, null, 2),
    markdown: data.markdown,
    title: typeof data.session.title === 'string' ? data.session.title : '',
  }
}

/** 把当前这一段的 JSON 写进下载目录。 */
export async function saveCurrentJson(sessionId: string): Promise<string> {
  const data = await exportCurrent(sessionId)
  return save(`空谷对话-${slug(data.title)}-${stamp(Date.now())}.json`, data.json)
}

/** 把当前这一段的 Markdown 写进下载目录。 */
export async function saveCurrentMarkdown(sessionId: string): Promise<string> {
  const data = await exportCurrent(sessionId)
  return save(`空谷对话-${slug(data.title)}-${stamp(Date.now())}.md`, data.markdown)
}

/**
 * 导出全部（含归档段），写成一个文件。
 *
 * ## 为什么全部是一个文件而不是一个压缩包
 *
 * 一个 JSON 数组用文本编辑器就能看、能搜、能只挑一段贴出来。压缩包要先
 * 解压才看得见内容，而"能直接看懂"正是这一版要解决的事。会话数量级是
 * 几十到几百，纯文本不会大到不可用。
 */
export async function saveAllJson(): Promise<{ path: string; count: number }> {
  const data = await request<AllExport>('/api/export/all')
  const count = Array.isArray(data.sessions) ? data.sessions.length : 0
  const path = await save(`空谷对话-全部-${stamp(data.exportedAt)}.json`, JSON.stringify(data, null, 2))
  return { path, count }
}

/** 选一个文件并读回它的文本。用户取消时返回 `undefined`。 */
export async function pickImportFile(): Promise<{ path: string; content: string } | undefined> {
  const picked = await invokeShell<{ path: string; content: string } | null>('open_import')
  return picked ?? undefined
}

/**
 * 把一份导出的 JSON 倒回成一段会话。
 *
 * 宿主会先归档当前段再建新段——单会话制下恢复旧对话必然要腾位置，
 * 而直接清空等于销毁。`archivedId` 就是为此回传的：界面可以告诉用户
 * 「上一段已归档，没有丢」。
 */
export async function importSession(content: string): Promise<ImportOutcome> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('这个文件不是有效的 JSON，可能不是空谷导出的对话文件')
  }
  const result = await request<{ session: { title?: unknown } | null; imported?: unknown; archivedId?: unknown }>(
    '/api/import',
    { method: 'POST', body: parsed },
  )
  const title = result.session !== null && typeof result.session?.title === 'string' ? result.session.title : ''
  return {
    imported: typeof result.imported === 'number' ? result.imported : 0,
    title,
    archivedId: typeof result.archivedId === 'string' ? result.archivedId : '',
  }
}
