/**
 * 设置 · 模型与 API。
 *
 * ## 它解决的是「她的大脑连在哪里」
 *
 * 本页管理的是**供应商**：一个 OpenAI 兼容端点 + 一个模型名 + 一把密钥。
 * 填完之后它同时出现在两处——顶栏的模型选择器里可以选它，设置里可以把它
 * 设为默认。API Key 以机密字段处理，读回时由宿主打码，不在界面明文回显。
 *
 * ## 为什么改成直接读写宿主
 *
 * 上一版本页走的是壳里的 `providers_list` / `providers_upsert`，写进
 * `providers.json`；而对话与模型选择器读的是宿主的 `config.json`。
 * **两个文件互不相识**，于是「在设置里加了 DeepSeek」与「选择器里还是
 * 原来那一条」可以同时成立，且没有任何一处报错。用户看到的是
 * 「填了、保存成功、但是不能用」。
 *
 * 现在只有一份真源：宿主 `config.json` 的 `profiles`。
 * `GET /api/config` 读，`POST /api/config/profiles` 写（整体替换语义）。
 * 壳里那三个 `providers_*` 命令随之删除——留着它就是留一条能悄悄
 * 把数据写进另一份文件的旁路。
 *
 * ## 为什么保存后要通知外面
 *
 * 模型选择器的列表是主界面状态（`useAppState.models`），它在宿主就绪时
 * 只拉一次。这里存完不通知，用户会看到「设置里明明有了、选择器里没有」，
 * 只能重启应用才认。`onChanged` 就是那一次重拉。
 */

import { useCallback, useEffect, useState } from 'react'
import { getConfig, saveProfiles, selectModel } from '../lib/api.ts'
import type { ProfileView } from '../lib/api.ts'
import { useT } from '../lib/i18n.ts'
import { Heading, Note } from './settingsUi.tsx'

/**
 * 编辑中的草稿。
 *
 * 与 {@link ProfileView} 的差别只在 `apiKey`：读回来的是打码值（`••••••••abcd`），
 * 宿主收到含圆点的密钥时知道「用户没改」并沿用原文，所以这里原样透传即可。
 */
interface Draft {
  id: string
  label: string
  baseUrl: string
  model: string
  apiKey: string
}

/** 空白草稿。id 留空表示新增，宿主会在保存时补一个。 */
function blank(): Draft {
  return { id: '', label: '', baseUrl: '', model: '', apiKey: '' }
}

/**
 * 把一条已存配置转成草稿。
 *
 * ## 为什么密钥回填的是打码值
 *
 * 宿主只给打码串（`••••••••abcd`），并且约定「回传值里含圆点 = 用户没改，
 * 沿用已存的原文」。所以这里必须把打码值原样放进草稿：
 *
 * - 留空 → 保存时回传空串 → 宿主认为用户主动清空了密钥 → **真密钥被抹掉**。
 *   这是编辑名字时最容易踩的坑：改个标签，密钥没了。
 * - 回填打码值 → 用户不动它就沿用原文，动了就按新值写。
 *
 * 输入框是 `type="password"`，打码串显示成圆点，不会泄漏真值。
 */
function toDraft(profile: ProfileView): Draft {
  return {
    id: profile.id,
    label: profile.label,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: profile.apiKey,
  }
}

export interface SettingsProvidersProps {
  /** 供应商列表变化后通知外面重拉模型列表与当前选中项。 */
  onChanged?(): void
}

/**
 * 判断基址是不是指向本机。
 *
 * 本机端点（Ollama、vLLM、LM Studio）通常不校验密钥，所以「Key 为空」
 * 在那里是正常配置而不是缺配置。判据只看主机名，不看端口——这些服务
 * 的端口可以随便改，写死 11434 会漏掉一半。
 */
function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host === '[::1]'
  } catch {
    // 基址还没填成合法 URL 时判不了，当作远端：最坏结果是多一句提醒，
    // 不会把「其实缺 Key」误放行。
    return false
  }
}

export function SettingsProviders({ onChanged }: SettingsProvidersProps): React.JSX.Element {
  const t = useT()
  const [items, setItems] = useState<ProfileView[]>([])
  const [currentId, setCurrentId] = useState('')
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const config = await getConfig()
      setItems(config.profiles)
      setCurrentId(config.currentModel)
    } catch (caught) {
      setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('models.err.load') })
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * 落盘一份完整的供应商清单。
   *
   * 接口是**整体替换**语义，所以每次都把整张表送上去。这也意味着「删除」
   * 不需要单独接口：从数组里去掉再送一遍就是删除。
   *
   * @param next 期望的最终清单。
   * @returns 是否写入成功。失败时调用方不该更新本地列表。
   */
  const write = useCallback(async (next: ProfileView[]): Promise<boolean> => {
    setBusy(true)
    try {
      await saveProfiles(next)
      await refresh()
      onChanged?.()
      return true
    } catch (caught) {
      setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('models.err.save') })
      return false
    } finally {
      setBusy(false)
    }
  }, [refresh, onChanged, t])

  const save = (): void => {
    if (draft === undefined) return
    if (draft.label.trim() === '' || draft.baseUrl.trim() === '' || draft.model.trim() === '') {
      setReceipt({ tone: 'bad', text: t('models.err.required') })
      return
    }
    void (async () => {
      /*
       * 新增时补一个稳定的 id。用「时间戳 + 随机尾巴」而不是自增序号：
       * 序号会在删除中间一条后与历史 id 撞车，而 id 是会话与内核
       * `currentModel` 认人的依据，撞了就会出现「选的是这条、用的是那条」。
       */
      const id = draft.id !== '' ? draft.id : `prov-${String(Date.now())}-${Math.random().toString(36).slice(2, 7)}`
      const entry: ProfileView = {
        id,
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        apiKey: draft.apiKey,
        // 这个字段只用于「填过了没有」的界面判断，宿主会自己算。
        hasKey: draft.apiKey !== '',
      }
      const existing = items.findIndex((item) => item.id === id)
      const next = existing === -1
        ? [...items, entry]
        : items.map((item) => (item.id === id ? { ...entry, hasKey: item.hasKey || entry.hasKey } : item))
      if (await write(next)) {
        /*
         * 存住了，但「能不能用」是另一件事。
         *
         * ## 为什么不在保存前拦下来
         *
         * 因为**空 Key 是合法的**：Ollama、vLLM、LM Studio 这些本机端点
         * 根本不校验密钥，硬拦会让它们一条都存不进去。填了必填三项就
         * 放行，是这一页唯一说得通的规则。
         *
         * ## 为什么也不装作一切正常
         *
         * 上一版回一句「已保存提供商」就结束了，用户以为配好了，切过去
         * 发第一句话才收到 401——那时他已经在对话里，回不到这个表单，
         * 也不知道该改哪一项。所以这里如实说两件事：**已经存下**、
         * **还差密钥**，并把补救路径（编辑、补 Key）指出来。
         *
         * 远端端点才提醒：`baseUrl` 指向本机（localhost / 127.0.0.1 /
         * 0.0.0.0）时，空 Key 是正常配置，不该被当成待办事项。
         */
        const missingKey = draft.apiKey === '' && !isLocalEndpoint(draft.baseUrl)
        setReceipt(
          missingKey
            ? { tone: 'warn', text: t('models.warn.noKey') }
            : { tone: 'ok', text: t('models.ok.saved') },
        )
        setDraft(undefined)
      }
    })()
  }

  const remove = (id: string): void => {
    if (busy) return
    void (async () => {
      const next = items.filter((item) => item.id !== id)
      if (!await write(next)) return
      /*
       * 删掉的正好是当前选中的那条：宿主那边 `currentModel` 会指向一个
       * 不存在的 id，下一次说话就报「模型不存在」。这里顺手改选第一条，
       * 一条都不剩时选本地演示——它一定会回应。
       */
      if (currentId === id) {
        const fallback = next[0]?.id ?? 'local/echo'
        try {
          await selectModel(fallback)
          await refresh()
          onChanged?.()
        } catch (caught) {
          setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('models.err.save') })
          return
        }
      }
      setReceipt({ tone: 'ok', text: t('models.ok.removed') })
    })()
  }

  const setDefault = (id: string): void => {
    if (busy) return
    void (async () => {
      setBusy(true)
      try {
        await selectModel(id)
        await refresh()
        onChanged?.()
        setReceipt({ tone: 'ok', text: t('models.ok.defaultSet') })
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('models.err.save') })
      } finally {
        setBusy(false)
      }
    })()
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
                  {item.label}
                  {currentId === item.id ? <span className="kb__tag">{t('models.defaultTag')}</span> : null}
                </span>
                <span className="kb__body">{item.baseUrl}{item.model === '' ? '' : ` · ${item.model}`}</span>
              </div>
              <div className="kb__ops">
                <button type="button" className="button button--ghost" aria-disabled={busy ? 'true' : undefined} onClick={() => { setDefault(item.id) }}>
                  {t('models.setDefault')}
                </button>
                <button type="button" className="button button--ghost" onClick={() => { setDraft(toDraft(item)) }}>
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
            <input className="kb__input" value={draft.label} placeholder={t('models.field.namePh')} onChange={(event) => { setDraft({ ...draft, label: event.target.value }) }} />
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
        <p
          /*
           * 三档：成功用中性回执、缺密钥用警示、失败用错误。
           *
           * 缺密钥不能复用 `pref__error`：那会把「已保存」这件事也读成失败，
           * 用户会去重复点保存。也不能复用 `pref__receipt`：中性色会让
           * 「还差一步」这条提醒被眼睛滑过去，而它恰恰是必须被看见的。
           */
          className={
            receipt.tone === 'ok'
              ? 'pref__receipt'
              : receipt.tone === 'warn'
                ? 'pref__receipt pref__receipt--warn'
                : 'pref__error'
          }
          role={receipt.tone === 'ok' ? 'status' : 'alert'}
        >
          {receipt.text}
        </p>
      )}
    </section>
  )
}