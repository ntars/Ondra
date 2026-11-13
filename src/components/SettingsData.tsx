/**
 * 设置 · 备份与还原（导出与导入）。
 *
 * ## 为什么导出导入与整库备份同页
 *
 * 两者都是**动到磁盘**的事：导出/导入搬的是单文件（一段对话），
 * 备份/回滚搬的是整库快照。用户「想把数据带走或搬回来」时找的是同一页，
 * 不该让他先分辨两种机制的差别。
 *
 * ## 为什么导入前要解释「会归档」
 *
 * 单会话制：应用里同时只有一段对话。恢复一份旧对话必然要给它腾位置。
 * 做法是归档（不是删除），用户后悔时还能在数据目录里找到那一份。
 * 但这句话必须写在按钮上方——按下去才发现「原来不是追加」是糟糕的体验。
 */

import { useState } from 'react'
import { importSession, pickImportFile, saveAllJson, saveCurrentJson, saveCurrentMarkdown } from '../lib/transfer.ts'
import { useT } from '../lib/i18n.ts'

/** 一次动作的结果。成功与失败都落在这里，界面只有一条回执。 */
interface Receipt {
  tone: 'ok' | 'bad'
  text: string
}

export interface SettingsDataProps {
  /** 当前会话 id。空串或 undefined 表示还没有会话。 */
  sessionId?: string
  /** 导入成功后让主界面重新读一遍当前会话。 */
  onImported(): void
}

export function SettingsData({ sessionId, onImported }: SettingsDataProps): React.JSX.Element {
  const t = useT()
  /** 正在进行的动作。同一时刻只允许一个，避免并发写同名文件。 */
  const [busy, setBusy] = useState<'' | 'current' | 'markdown' | 'all' | 'import'>('')
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined)

  /**
   * 跑一个动作并把结果说清楚。
   *
   * 三个动作的失败长相完全不同（没有会话、文件写不进去、JSON 不合法），
   * 但界面只需要一个位置显示它们——所以统一收成一个 `receipt`。
   * 用 `busy` 挡住重入：连点两下「导出」会写两个同名文件，第二个覆盖第一个。
   */
  const run = async (kind: 'current' | 'markdown' | 'all', action: () => Promise<Receipt>): Promise<void> => {
    if (busy !== '') return
    setBusy(kind)
    setReceipt(undefined)
    try {
      setReceipt(await action())
    } catch (caught) {
      setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('data.err.generic') })
    } finally {
      setBusy('')
    }
  }

  const hasSession = sessionId !== undefined && sessionId !== ''

  return (
    /*
     * `data-section` 是给断言用的稳定锚点。
     *
     * 「导出与恢复」与「备份」同处一页，两段都用 `.pref__actions` 装按钮。
     * 断言若按全局选择器数按钮，会把隔壁段的「创建备份」一起数进来——
     * 给这一段一个名字，量谁就限定谁。
     */
    <section className="pref__section" data-section="data">
      <h2 className="pref__heading">{t('data.export')}</h2>

      <p className="pref__note">{t('data.exportNote')}</p>

      <div className="pref__actions">
        <button
          type="button"
          className="button"
          aria-disabled={hasSession && busy === '' ? undefined : 'true'}
          onClick={() => {
            if (!hasSession || sessionId === undefined) {
              setReceipt({ tone: 'bad', text: t('data.none') })
              return
            }
            void run('current', async () => {
              const path = await saveCurrentJson(sessionId)
              return { tone: 'ok', text: t('data.savedTo', path) }
            })
          }}
        >
          {t('data.exportCurrent')}
        </button>

        <button
          type="button"
          className="button"
          aria-disabled={hasSession && busy === '' ? undefined : 'true'}
          onClick={() => {
            if (!hasSession || sessionId === undefined) {
              setReceipt({ tone: 'bad', text: t('data.none') })
              return
            }
            void run('markdown', async () => {
              const path = await saveCurrentMarkdown(sessionId)
              return { tone: 'ok', text: t('data.savedTo', path) }
            })
          }}
        >
          {t('data.exportMarkdown')}
        </button>

        <button
          type="button"
          className="button"
          aria-disabled={busy === '' ? undefined : 'true'}
          onClick={() => {
            void run('all', async () => {
              const { path, count } = await saveAllJson()
              return { tone: 'ok', text: t('data.savedAll', count, path) }
            })
          }}
        >
          {t('data.exportAll')}
        </button>
      </div>

      <h2 className="pref__heading">{t('data.import')}</h2>
      <p className="pref__note">
        {t('data.importNoteA')}
        <strong>{t('data.importNoteStrong')}</strong>
        {t('data.importNoteB')}
      </p>

      <div className="pref__actions">
        <button
          type="button"
          className="button"
          aria-disabled={busy === '' ? undefined : 'true'}
          onClick={() => {
            if (busy !== '') return
            setBusy('import')
            setReceipt(undefined)
            void (async () => {
              try {
                const picked = await pickImportFile()
                if (picked === undefined) {
                  // 用户取消了。不留回执：他刚刚按的是「取消」。
                  return
                }
                const outcome = await importSession(picked.content)
                setReceipt({
                  tone: 'ok',
                  text: outcome.archivedId === ''
                    ? t('data.ok.restored', outcome.imported)
                    : t('data.ok.restoredArchived', outcome.imported),
                })
                onImported()
              } catch (caught) {
                setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('data.err.import') })
              } finally {
                setBusy('')
              }
            })()
          }}
        >
          {busy === 'import' ? t('data.restoring') : t('data.restore')}
        </button>
      </div>

      {receipt === undefined ? null : (
        <p
          className={receipt.tone === 'ok' ? 'pref__receipt' : 'pref__error'}
          role={receipt.tone === 'ok' ? 'status' : 'alert'}
        >
          {receipt.text}
        </p>
      )}
    </section>
  )
}
