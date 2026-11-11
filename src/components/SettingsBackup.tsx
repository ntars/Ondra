/**
 * 设置 · 备份与恢复（G4）。
 *
 * ## 为什么这一页存在
 *
 * 数据页只能「导出/导入会话」，是单文件、手动、无历史。这一页做的是
 * **整库快照**：会话、记忆、世界书、知识库、模型配置、偏好，一次拍下全部，
 * 保留多份，随时回滚。对应参考应用里的「备份与恢复 / 数据迁移」。
 */

import { useCallback, useEffect, useState } from 'react'
import { invokeShell } from '../lib/shell.ts'
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
  const [items, setItems] = useState<Backup[]>([])
  const [busy, setBusy] = useState<'' | 'create' | 'restore'>('')
  const [receipt, setReceipt] = useState<{ tone: 'ok' | 'bad'; text: string } | undefined>(undefined)
  /** 待确认回滚的备份 id。undefined 表示没有弹窗。 */
  const [pending, setPending] = useState<string | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      /* 同上：壳可能返回 null，按空列表处理。 */
      const rows = await invokeShell<Backup[] | null>('backup_list')
      setItems(Array.isArray(rows) ? rows : [])
    } catch (caught) {
      setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : '读不到备份列表' })
    }
  }, [])

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
        setReceipt({ tone: 'ok', text: `已创建备份（${formatTime(info.created_at)}）` })
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : '创建备份失败' })
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
        setReceipt({ tone: 'ok', text: '已回滚到所选备份，应用将重新读取数据' })
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : '回滚失败' })
      } finally {
        setBusy('')
      }
    })()
  }

  return (
    <section className="pref__section">
      <Heading>备份与恢复</Heading>
      <Note>
        备份会复制本应用的全部本地数据（会话、记忆、世界书、知识库、模型配置与偏好）到数据目录下的
        「backups」文件夹，互不覆盖，可保留多份。恢复会把整库回到所选备份的时刻——
        此操作会覆盖当前全部数据，请先确认。
      </Note>

      <div className="pref__actions">
        <button
          type="button"
          className="button"
          aria-disabled={busy === '' ? undefined : 'true'}
          onClick={create}
        >
          {busy === 'create' ? '正在创建…' : '创建备份'}
        </button>
      </div>

      <Heading>已有备份</Heading>
      {items.length === 0 ? (
        <Note>还没有任何备份。上面那个按钮会拍下当前全部数据的第一份快照。</Note>
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
                回滚到此份
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
          title="回滚到此备份"
          confirmLabel="回滚"
          cancelLabel="取消"
          onConfirm={() => { restore(pending) }}
          onCancel={() => { setPending(undefined) }}
          onDismiss={() => { setPending(undefined) }}
        >
          此操作会用这份备份覆盖当前全部本地数据，且不可撤销。确定要回滚到该时刻吗？
        </Dialog>
      )}
    </section>
  )
}
