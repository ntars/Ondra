/**
 * 设置 · 模型与 API。
 *
 * ## 它解决的是「她的大脑连在哪里」
 *
 * 模型来源分两类：**官方预设**（内置的在线 / 本地 / 免费三档，在顶栏的
 * 模型选择器里切换）与**自定义提供商**（本页管理）。本页让用户添加自己的
 * OpenAI 兼容端点——包括 Ollama、vLLM、magpie 等本地网关与自建服务：
 * 填基址、API Key、模型名，即可作为一个可选来源。API Key 以机密字段处理，
 * 不在界面明文回显。
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
import { useT } from '../lib/i18n.ts'
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
  const t = useT()
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
      setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('models.err.load') })
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = (): void => {
    if (draft === undefined || draft.name.trim() === '' || draft.baseUrl.trim() === '') {
      setReceipt({ tone: 'bad', text: t('models.err.required') })
      return
    }
    setBusy(true)
    void (async () => {
      try {
        await invokeShell<void>('providers_upsert', { entry: draft })
        setReceipt({ tone: 'ok', text: t('models.ok.saved') })
        setDraft(undefined)
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('models.err.save') })
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
        setReceipt({ tone: 'ok', text: t('models.ok.removed') })
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('models.err.remove') })
      } finally {
        setBusy(false)
      }
    })()
  }

  const setDefault = (id: string): void => {
    setPreferences({ provider: activeId === id ? '' : id })
    setReceipt({ tone: 'ok', text: activeId === id ? t('models.ok.defaultCleared') : t('models.ok.defaultSet') })
  }

  return (
    <section className="pref__section">
      <Heading>{t('models.title')}</Heading>
      <Note>{t('models.note')}</Note>

      <div className="pref__actions">
        <button
          type="button"
          className="button"
          aria-disabled={draft === undefined ? undefined : 'true'}
          onClick={() => { setDraft(blank()) }}
        >
          {t('models.add')}
        </button>
      </div>

      {items.length === 0 && draft === undefined ? (
        <Note>{t('models.empty')}</Note>
      ) : (
        <ul className="kb__list">
          {items.map((item) => (
            <li className="kb__item" key={item.id}>
              <div className="kb__text">
                <span className="kb__title">
                  {item.name}
                  {activeId === item.id ? <span className="kb__tag">{t('models.defaultTag')}</span> : null}
                </span>
                <span className="kb__body">{item.baseUrl}{item.model === '' ? '' : ` · ${item.model}`}</span>
              </div>
              <div className="kb__ops">
                <button type="button" className="button button--ghost" aria-disabled={busy ? 'true' : undefined} onClick={() => { setDefault(item.id) }}>
                  {t('models.setDefault')}
                </button>
                <button type="button" className="button button--ghost" onClick={() => { setDraft({ ...item }) }}>
                  {t('models.edit')}
                </button>
                <button type="button" className="button button--ghost" aria-disabled={busy ? 'true' : undefined} onClick={() => { remove(item.id) }}>
                  {t('models.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {draft === undefined ? null : (
        <div className="kb__editor">
          <Heading>{draft.id === '' ? t('models.editorNew') : t('models.editorEdit')}</Heading>
          <label className="kb__field">
            <span className="kb__label">{t('models.field.name')}</span>
            <input className="kb__input" value={draft.name} placeholder={t('models.field.namePh')} onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} />
          </label>
          <label className="kb__field">
            <span className="kb__label">{t('models.field.baseUrl')}</span>
            <input className="kb__input" value={draft.baseUrl} placeholder={t('models.field.baseUrlPh')} onChange={(event) => { setDraft({ ...draft, baseUrl: event.target.value }) }} />
          </label>
          <label className="kb__field">
            <span className="kb__label">{t('models.field.key')}</span>
            <input className="kb__input" type="password" autoComplete="off" value={draft.apiKey} placeholder={t('models.field.keyPh')} onChange={(event) => { setDraft({ ...draft, apiKey: event.target.value }) }} />
          </label>
          <label className="kb__field">
            <span className="kb__label">{t('models.field.model')}</span>
            <input className="kb__input" value={draft.model} placeholder={t('models.field.modelPh')} onChange={(event) => { setDraft({ ...draft, model: event.target.value }) }} />
          </label>
          <div className="pref__actions">
            <button type="button" className="button" aria-disabled={busy ? 'true' : undefined} onClick={save}>
              {busy ? t('models.saving') : t('models.save')}
            </button>
            <button type="button" className="button button--ghost" onClick={() => { setDraft(undefined) }}>
              {t('general.cancel')}
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
