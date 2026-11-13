/**
 * 设置 · 备份与还原（整库快照）。
 *
 * ## 为什么这一页存在
 *
 * 导出/导入只能搬单文件，是手动、无历史的。这一页做的是**整库快照**
 * （时间机器同款思路）：会话、记忆、世界书、知识库、模型配置、偏好，
 * 一次拍下全部，保留多份，随时回滚。
 */

import { useCallback, useEffect, useState } from 'react'
import { invokeShell } from '../lib/shell.ts'
import { useT } from '../lib/i18n.ts'
import { Dialog } from './Dialog.tsx'
import { Heading, Note } from './settingsUi.tsx'

/** 备份元信息（与壳侧 `BackupInfo` 对应）。 */
interface Backup {
  id: string
  created_at: number
  path: string
}

/** 把 Unix 秒排成 `2026-02-14 15:04`。 */
function formatTime(seconds: number): string {
  const date = new Date(seconds * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function SettingsBackup(): React.JSX.Element {
  const t = useT()
  const [items, setItems] = useState<Backup[]>([])
  const [busy, setBusy] = useState<'' | 'create' | 'restore'>('')
  const [receipt, setReceipt] = useState<{ tone: 'ok' | 'bad'; text: string } | undefined>(undefined)
  /** 待确认回滚的备份 id。undefined 表示没有弹窗。 */
  const [pending, setPending] = useState<string | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      /* 壳可能返回 null，按空列表处理。 */
      const rows = await invokeShell<Backup[] | null>('backup_list')
      setItems(Array.isArray(rows) ? rows : [])
    } catch (caught) {
      setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('backup.err.list') })
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = (): void => {
    if (busy !== '') return
    setBusy('create')
    setReceipt(undefined)
    void (async () => {
      try {
        const info = await invokeShell<Backup>('backup_create')
        setReceipt({ tone: 'ok', text: t('backup.ok.created', formatTime(info.created_at)) })
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('backup.err.create') })
      } finally {
        setBusy('')
      }
    })()
  }

  const restore = (id: string): void => {
    if (busy !== '') return
    setBusy('restore')
    setPending(undefined)
    void (async () => {
      try {
        await invokeShell<void>('backup_restore', { id })
        setReceipt({ tone: 'ok', text: t('backup.ok.restored') })
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('backup.err.restore') })
      } finally {
        setBusy('')
      }
    })()
  }

  return (
    <section className="pref__section">
      <Heading>{t('backup.title')}</Heading>
      <Note>{t('backup.note')}</Note>

      <div className="pref__actions">
        <button
          type="button"
          className="button"
          aria-disabled={busy === '' ? undefined : 'true'}
          onClick={create}
        >
          {busy === 'create' ? t('backup.creating') : t('backup.create')}
        </button>
      </div>

      <Heading>{t('backup.existing')}</Heading>
      {items.length === 0 ? (
        <Note>{t('backup.empty')}</Note>
      ) : (
        <ul className="backup__list">
          {items.map((item) => (
            <li className="backup__item" key={item.id}>
              <div className="backup__text">
                <span className="backup__time">{formatTime(item.created_at)}</span>
                <span className="backup__path">{item.path}</span>
              </div>
              <button
                type="button"
                className="button button--ghost"
                aria-disabled={busy === '' ? undefined : 'true'}
                onClick={() => { setPending(item.id) }}
              >
                {t('backup.rollback')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {receipt === undefined ? null : (
        <p className={receipt.tone === 'ok' ? 'pref__receipt' : 'pref__error'} role={receipt.tone === 'ok' ? 'status' : 'alert'}>
          {receipt.text}
        </p>
      )}

      {pending === undefined ? null : (
        <Dialog
          title={t('backup.confirmTitle')}
          confirmLabel={t('backup.confirmConfirm')}
          cancelLabel={t('general.cancel')}
          onConfirm={() => { restore(pending) }}
          onCancel={() => { setPending(undefined) }}
          onDismiss={() => { setPending(undefined) }}
        >
          {t('backup.confirmBody')}
        </Dialog>
      )}
    </section>
  )
}
