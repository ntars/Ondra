/**
 * 设置 · 模型提供商（G3）。
 *
 * ## 它解决的是「换一个模型后端」
 *
 * 内置只有「在线 / 本地 / 免费」三档预设来源。这一节让用户添加自己的
 * OpenAI 兼容端点（包括 Ollama、vLLM、自建网关）：填基址、API Key、模型名，
 * 即可作为一个可选来源出现在对话里。API Key 以机密字段处理，不在界面明文回显。
 *
 * ## 推理路由的边界
 *
 * 这里的增删改查与「默认选用」都是本地的、真实可用的。把选定提供商真正接到
 * 宿主的对话推理上，需要在宿主侧按 `preferences.provider` 切换 completion 端点——
 * 那一步属于内核，不在本页范围内；本页负责把选择与凭据稳定地存好、交出去。
 */

import { useCallback, useEffect, useState } from 'react'
import { invokeShell } from '../lib/shell.ts'
import { usePreferences, setPreferences } from '../lib/preferences.ts'
import { Heading, Note } from './settingsUi.tsx'

/** 一个自定义提供商。 */
interface Provider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
}

/** 空白草稿。 */
function blank(): Provider {
  return { id: '', name: '', baseUrl: '', apiKey: '', model: '' }
}

export function SettingsProviders(): React.JSX.Element {
  const { provider: activeId } = usePreferences()
  const [items, setItems] = useState<Provider[]>([])
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<{ tone: 'ok' | 'bad'; text: string } | undefined>(undefined)
  const [draft, setDraft] = useState<Provider | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      /* 壳返回 null（未知命令或空文件）时也当成空列表：直接 .length 会整页白屏。 */
      const rows = await invokeShell<Provider[] | null>('providers_list')
      setItems(Array.isArray(rows) ? rows : [])
    } catch (caught) {
      setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : '读不到提供商列表' })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = (): void => {
    if (draft === undefined || draft.name.trim() === '' || draft.baseUrl.trim() === '') {
      setReceipt({ tone: 'bad', text: '请填写名称与基址' })
      return
    }
    setBusy(true)
    void (async () => {
      try {
        await invokeShell<void>('providers_upsert', { entry: draft })
        setReceipt({ tone: 'ok', text: '已保存提供商' })
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
        await invokeShell<void>('providers_remove', { id })
        // 删掉的是当前默认时，一并取消默认选择。
        if (activeId === id) setPreferences({ provider: '' })
        setReceipt({ tone: 'ok', text: '已删除' })
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : '删除失败' })
      } finally {
        setBusy(false)
      }
    })()
  }

  const setDefault = (id: string): void => {
    setPreferences({ provider: activeId === id ? '' : id })
    setReceipt({ tone: 'ok', text: activeId === id ? '已取消默认提供商' : '已设为默认提供商' })
  }

  return (
    <section className="pref__section">
      <Heading>模型提供商</Heading>
      <Note>
        添加您自己的 OpenAI 兼容端点（如 Ollama、vLLM、自建网关）。基址与模型名决定请求发往何处；API Key 按机密字段处理，不在界面明文回显。设为默认后，对话将使用所选来源，实际推理切换由宿主按此选择生效。
      </Note>

      <div className="pref__actions">
        <button
          type="button"
          className="button"
          aria-disabled={draft === undefined ? undefined : 'true'}
          onClick={() => { setDraft(blank()) }}
        >
          添加提供商
        </button>
      </div>

      {items.length === 0 && draft === undefined ? (
        <Note>尚无自定义提供商。点击上方「添加提供商」可接入自建的模型后端。</Note>
      ) : (
        <ul className="kb__list">
          {items.map((item) => (
            <li className="kb__item" key={item.id}>
              <div className="kb__text">
                <span className="kb__title">
                  {item.name}
                  {activeId === item.id ? <span className="kb__tag">默认</span> : null}
                </span>
                <span className="kb__body">{item.baseUrl}{item.model === '' ? '' : ` · ${item.model}`}</span>
              </div>
              <div className="kb__ops">
                <button type="button" className="button button--ghost" aria-disabled={busy ? 'true' : undefined} onClick={() => { setDefault(item.id) }}>
                  设为默认
                </button>
                <button type="button" className="button button--ghost" onClick={() => { setDraft({ ...item }) }}>
                  编辑
                </button>
                <button type="button" className="button button--ghost" aria-disabled={busy ? 'true' : undefined} onClick={() => { remove(item.id) }}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {draft === undefined ? null : (
        <div className="kb__editor">
          <Heading>{draft.id === '' ? '添加提供商' : '编辑提供商'}</Heading>
          <label className="kb__field">
            <span className="kb__label">名称</span>
            <input className="kb__input" value={draft.name} placeholder="例如：本地 Ollama" onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} />
          </label>
          <label className="kb__field">
            <span className="kb__label">基址</span>
            <input className="kb__input" value={draft.baseUrl} placeholder="https://… 或 http://localhost:11434/v1" onChange={(event) => { setDraft({ ...draft, baseUrl: event.target.value }) }} />
          </label>
          <label className="kb__field">
            <span className="kb__label">API Key</span>
            <input className="kb__input" type="password" autoComplete="off" value={draft.apiKey} placeholder="留空表示无需密钥" onChange={(event) => { setDraft({ ...draft, apiKey: event.target.value }) }} />
          </label>
          <label className="kb__field">
            <span className="kb__label">模型名</span>
            <input className="kb__input" value={draft.model} placeholder="例如：llama3.1:8b" onChange={(event) => { setDraft({ ...draft, model: event.target.value }) }} />
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
