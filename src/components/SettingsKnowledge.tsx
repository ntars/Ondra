/**
 * 设置 · 知识库（G5）。
 *
 * ## 它和「世界书」的关系
 *
 * 内核自带的「世界书」是背景知识插件，用户看不到、也改不了。这一页把
 * 「知识库」做成一个**用户可管理**的清单：自己加、自己删、自己分类，
 * 对标参考应用里用户侧的知识管理。两者并存——这里是入口，内核那份是底层。
 */

import { useCallback, useEffect, useState } from 'react'
import { invokeShell } from '../lib/shell.ts'
import { Heading, Note } from './settingsUi.tsx'

/** 一条知识库条目。 */
interface Entry {
  id: string
  title: string
  category: string
  body: string
  created_at?: number
  updated_at?: number
}

/** 空白草稿。 */
function blank(): Entry {
  return { id: '', title: '', category: '', body: '' }
}

export function SettingsKnowledge(): React.JSX.Element {
  const [items, setItems] = useState<Entry[]>([])
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<{ tone: 'ok' | 'bad'; text: string } | undefined>(undefined)
  /** 正在编辑的草稿。undefined 表示没有打开编辑器。 */
  const [draft, setDraft] = useState<Entry | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      /* 壳返回 null 时按空列表处理，避免整页在渲染期抛错。 */
      const rows = await invokeShell<Entry[] | null>('kb_list')
      setItems(Array.isArray(rows) ? rows : [])
    } catch (caught) {
      setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : '读不到知识库' })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = (): void => {
    if (draft === undefined || draft.title.trim() === '') {
      setReceipt({ tone: 'bad', text: '请先填写标题' })
      return
    }
    setBusy(true)
    void (async () => {
      try {
        await invokeShell<void>('kb_upsert', { entry: draft })
        setReceipt({ tone: 'ok', text: '已保存' })
        setDraft(undefined)
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : '保存失败' })
      } finally {
        setBusy(false)
      }
    })()
  }

  const remove = (id: string): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        await invokeShell<void>('kb_delete', { id })
        setReceipt({ tone: 'ok', text: '已删除' })
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : '删除失败' })
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <section className="pref__section">
      <Heading>知识库</Heading>
      <Note>
        这里是您可自己维护的知识清单：把常用背景、人物设定、项目资料录进来，
        她会在对话时参考。支持分类，便于管理与检索。数据保存在本机，不上传。
      </Note>

      <div className="pref__actions">
        <button
          type="button"
          className="button"
          aria-disabled={draft === undefined ? undefined : 'true'}
          onClick={() => { setDraft(blank()) }}
        >
          新增条目
        </button>
      </div>

      {items.length === 0 && draft === undefined ? (
        <Note>知识库还是空的。点上面的「新增条目」写第一条。</Note>
      ) : (
        <ul className="kb__list">
          {items.map((item) => (
            <li className="kb__item" key={item.id}>
              <div className="kb__text">
                <span className="kb__title">{item.title}</span>
                {item.category === '' ? null : <span className="kb__tag">{item.category}</span>}
                <span className="kb__body">{item.body}</span>
              </div>
              <div className="kb__ops">
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => { setDraft({ ...item }) }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  aria-disabled={busy ? 'true' : undefined}
                  onClick={() => { remove(item.id) }}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {draft === undefined ? null : (
        <div className="kb__editor">
          <Heading>{draft.id === '' ? '新增条目' : '编辑条目'}</Heading>
          <label className="kb__field">
            <span className="kb__label">标题</span>
            <input
              className="kb__input"
              value={draft.title}
              placeholder="例如：项目代号、人物关系"
              onChange={(event) => { setDraft({ ...draft, title: event.target.value }) }}
            />
          </label>
          <label className="kb__field">
            <span className="kb__label">分类</span>
            <input
              className="kb__input"
              value={draft.category}
              placeholder="可选，例如：工作 / 人物 / 资料"
              onChange={(event) => { setDraft({ ...draft, category: event.target.value }) }}
            />
          </label>
          <label className="kb__field">
            <span className="kb__label">内容</span>
            <textarea
              className="kb__textarea"
              value={draft.body}
              rows={5}
              placeholder="录入这条知识的正文"
              onChange={(event) => { setDraft({ ...draft, body: event.target.value }) }}
            />
          </label>
          <div className="pref__actions">
            <button type="button" className="button" aria-disabled={busy ? 'true' : undefined} onClick={save}>
              {busy ? '保存中…' : '保存'}
            </button>
            <button type="button" className="button button--ghost" onClick={() => { setDraft(undefined) }}>
              取消
            </button>
          </div>
        </div>
      )}

      {receipt === undefined ? null : (
        <p className={receipt.tone === 'ok' ? 'pref__receipt' : 'pref__error'} role={receipt.tone === 'ok' ? 'status' : 'alert'}>
          {receipt.text}
        </p>
      )}
    </section>
  )
}
