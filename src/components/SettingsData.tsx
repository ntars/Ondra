/**
 * 设置 · 数据（迁走与搬回）。
 *
 * ## 为什么单独一页
 *
 * 导出与导入是唯一两件**动到磁盘**的事：别的设置改了之后存在本机，
 * 这两件是把东西带出/带进这台机器。放在「对话」页里会与发送方式、权限
 * 混成一类，而它们的后果不是一个量级——一个改的是按 Enter 的行为，
 * 一个会把当前这段对话归档。
 *
 * ## 为什么导入前要解释「会归档」
 *
 * 单会话制：应用里同时只有一段对话。恢复一份旧对话必然要给它腾位置。
 * 做法是归档（不是删除），用户后悔时还能在数据目录里找到那一份。
 * 但这句话必须写在按钮上方——按下去才发现"原来不是追加"是糟糕的体验。
 */

import { useState } from 'react'
import { importSession, pickImportFile, saveAllJson, saveCurrentJson, saveCurrentMarkdown } from '../lib/transfer.ts'

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
      setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : '操作未完成' })
    } finally {
      setBusy('')
    }
  }

  const hasSession = sessionId !== undefined && sessionId !== ''

  return (
    /*
     * `data-section` 是给断言用的稳定锚点。
     *
     * 「导出与恢复」现在与「知识库」「备份」同处「记忆」一页，三个 section
     * 都用 `.pref__actions` 装按钮。断言若按全局选择器数按钮，会连隔壁两段
     * 的「新增条目」「创建备份」一起数进来——数字对不上，报的却是"数据页
     * 动作不全"。给这一段一个名字，量谁就限定谁。
     */
    <section className="pref__section" data-section="data">
      <h2 className="pref__heading">导出</h2>

      <p className="pref__note">
        对话本来就以明文 JSON 存在数据目录里，一个会话一个文件。
        「导出」做的是把当前这段（或全部，含已归档的段）写进下载目录，
        并存一份人能直接读的形式。文件不会上传到任何地方。
      </p>

      <div className="pref__actions">
        <button
          type="button"
          className="button"
          aria-disabled={hasSession && busy === '' ? undefined : 'true'}
          onClick={() => {
            if (!hasSession || sessionId === undefined) {
              setReceipt({ tone: 'bad', text: '暂无可导出的对话' })
              return
            }
            void run('current', async () => {
              const path = await saveCurrentJson(sessionId)
              return { tone: 'ok', text: `已存到 ${path}` }
            })
          }}
        >
          导出这一段的 JSON
        </button>

        <button
          type="button"
          className="button"
          aria-disabled={hasSession && busy === '' ? undefined : 'true'}
          onClick={() => {
            if (!hasSession || sessionId === undefined) {
              setReceipt({ tone: 'bad', text: '暂无可导出的对话' })
              return
            }
            void run('markdown', async () => {
              const path = await saveCurrentMarkdown(sessionId)
              return { tone: 'ok', text: `已存到 ${path}` }
            })
          }}
        >
          导出为 Markdown
        </button>

        <button
          type="button"
          className="button"
          aria-disabled={busy === '' ? undefined : 'true'}
          onClick={() => {
            void run('all', async () => {
              const { path, count } = await saveAllJson()
              return { tone: 'ok', text: `共 ${String(count)} 段，已存到 ${path}` }
            })
          }}
        >
          导出全部
        </button>
      </div>

      <h2 className="pref__heading">导入</h2>
      <p className="pref__note">
        导入的是上面那种 JSON 文件。恢复时
        <strong>当前这一段会被归档</strong>
        ，不会被删掉——单会话制下同时只有一段对话，旧的那段要让开位置。
        归档的段仍在数据目录里。
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
                    ? `已恢复 ${String(outcome.imported)} 条消息`
                    : `已恢复 ${String(outcome.imported)} 条消息，上一段已归档`,
                })
                onImported()
              } catch (caught) {
                setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : '导入失败' })
              } finally {
                setBusy('')
              }
            })()
          }}
        >
          {busy === 'import' ? '正在读取…' : '从文件恢复…'}
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
