/**
 * 设置 · 权限（G1）。
 *
 * ## 应用级权限 vs AI 能力范围
 *
 * 对话页有一个「默认权限」，那是** AI 能碰什么**（对话内 / 工作区 / 整机）。
 * 这一页是另一个维度：**本应用能碰什么**——麦克风、文件、网络、通知。
 * 两者不是同一件事：前者是给她的授权，后者是给这个软件的授权。
 */

import { useEffect, useState } from 'react'
import { invokeShell } from '../lib/shell.ts'
import { Heading, Note } from './settingsUi.tsx'

/** 单条权限的展示模型。 */
interface PermissionRow {
  /** 权限名。 */
  name: string
  /** 用途说明。 */
  purpose: string
  /** 系统授权面板键。 */
  pane?: 'microphone' | 'camera' | 'files' | 'notifications'
  /** 当前状态文案。 */
  status: string
  /** 状态是否表示「需要用户去系统设置处理」。 */
  needsAction: boolean
}

/** 打开对应系统设置面板。 */
async function openPane(pane: string): Promise<void> {
  try {
    await invokeShell<void>('open_settings_pane', { pane })
  } catch (caught) {
    console.error('打开系统设置失败', caught)
  }
}

export function SettingsPermissions(): React.JSX.Element {
  const [notification, setNotification] = useState<string>('未知')

  // 通知权限可由 Web API 直接感知（壳注入了标准的 Notification 实现）。
  useEffect(() => {
    const permission = (globalThis as { Notification?: { permission?: string } }).Notification?.permission
    if (permission === 'granted') setNotification('已授权')
    else if (permission === 'denied') setNotification('已拒绝')
    else setNotification('尚未授权')
  }, [])

  const rows: PermissionRow[] = [
    {
      name: '麦克风',
      purpose: '用于语音输入，将您的语音转为文字。首次使用时由系统请求授权。',
      pane: 'microphone',
      status: '由系统授权',
      needsAction: true,
    },
    {
      name: '文件与文件夹',
      purpose: '用于读写会话、记忆、世界书、知识库与备份，均存于本机数据目录。',
      status: '本应用可管理自身数据目录',
      needsAction: false,
    },
    {
      name: '网络',
      purpose: '用于连接您所选的模型服务（在线或免费模型）。本地推理与离线模型不依赖网络。',
      status: '可访问所选模型服务',
      needsAction: false,
    },
    {
      name: '通知',
      purpose: '用于在您离开时提示主动发起的内容（默认关闭）。',
      pane: 'notifications',
      status: notification,
      needsAction: notification === '已拒绝' || notification === '尚未授权',
    },
  ]

  return (
    <section className="pref__section">
      <Heading>应用权限</Heading>
      <Note>
        下列权限由操作系统统一管理。本应用仅在对应功能需要时才会使用它们，
        您可随时在系统设置中收回。此处的「应用权限」与对话页的「默认权限」
        （AI 的能力范围）是两个不同的维度。
      </Note>

      <ul className="perm__list">
        {rows.map((row) => (
          <li className="perm__item" key={row.name}>
            <div className="perm__text">
              <span className="perm__name">{row.name}</span>
              <span className="perm__purpose">{row.purpose}</span>
            </div>
            <div className="perm__state">
              <span className={row.needsAction ? 'perm__status perm__status--warn' : 'perm__status'}>
                {row.status}
              </span>
              {row.pane === undefined ? null : (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => { void openPane(row.pane as string) }}
                >
                  在系统设置中管理
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <Note>
        以上状态来自本应用可感知的范围。若某项显示「由系统授权」，实际授权状态以系统设置为准；点击「在系统设置中管理」可直接跳转对应面板。
      </Note>
    </section>
  )
}
