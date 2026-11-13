/**
 * 设置 · 应用权限。
 *
 * ## 应用级权限 vs AI 能力范围
 *
 * 通用页有一个「默认权限」，那是** AI 能碰什么**（对话内 / 工作区 / 整机）。
 * 这一节是另一个维度：**本应用能碰什么**——麦克风、文件、网络、通知。
 * 两者不是同一件事：前者是给她的授权，后者是给这个软件的授权。
 */

import { useEffect, useState } from 'react'
import { invokeShell } from '../lib/shell.ts'
import { useT } from '../lib/i18n.ts'
import type { MessageKey } from '../lib/i18n.ts'
import { Heading, Note } from './settingsUi.tsx'

/** 单条权限的展示模型。 */
interface PermissionRow {
  /** 权限名（文案键）。 */
  nameKey: MessageKey
  /** 用途说明（文案键）。 */
  purposeKey: MessageKey
  /** 系统授权面板键。 */
  pane?: 'microphone' | 'camera' | 'files' | 'notifications'
  /** 当前状态文案（文案键；通知一项在运行时决定）。 */
  statusKey: MessageKey
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
  const t = useT()
  const [notification, setNotification] = useState<'unknown' | 'granted' | 'denied'>('unknown')

  // 通知权限可由 Web API 直接感知（壳注入了标准的 Notification 实现）。
  useEffect(() => {
    const permission = (globalThis as { Notification?: { permission?: string } }).Notification?.permission
    if (permission === 'granted') setNotification('granted')
    else if (permission === 'denied') setNotification('denied')
    else setNotification('unknown')
  }, [])

  const notificationStatusKey: MessageKey = notification === 'granted'
    ? 'perm.status.granted'
    : notification === 'denied'
      ? 'perm.status.denied'
      : 'perm.status.notYet'

  const rows: PermissionRow[] = [
    {
      nameKey: 'perm.mic',
      purposeKey: 'perm.micPurpose',
      pane: 'microphone',
      statusKey: 'perm.status.bySystem',
      needsAction: true,
    },
    {
      nameKey: 'perm.files',
      purposeKey: 'perm.filesPurpose',
      statusKey: 'perm.filesStatus',
      needsAction: false,
    },
    {
      nameKey: 'perm.network',
      purposeKey: 'perm.networkPurpose',
      statusKey: 'perm.networkStatus',
      needsAction: false,
    },
    {
      nameKey: 'perm.notifications',
      purposeKey: 'perm.notificationsPurpose',
      pane: 'notifications',
      statusKey: notificationStatusKey,
      needsAction: notification === 'denied' || notification === 'unknown',
    },
  ]

  return (
    <section className="pref__section">
      <Heading>{t('perm.title')}</Heading>
      <Note>{t('perm.note')}</Note>

      <ul className="perm__list">
        {rows.map((row) => (
          <li className="perm__item" key={row.nameKey}>
            <div className="perm__text">
              <span className="perm__name">{t(row.nameKey)}</span>
              <span className="perm__purpose">{t(row.purposeKey)}</span>
            </div>
            <div className="perm__state">
              <span className={row.needsAction ? 'perm__status perm__status--warn' : 'perm__status'}>
                {t(row.statusKey)}
              </span>
              {row.pane === undefined ? null : (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => { void openPane(row.pane as string) }}
                >
                  {t('perm.manage')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <Note>{t('perm.footNote')}</Note>
    </section>
  )
}
