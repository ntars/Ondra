/**
 * 设置 · 人物设定。
 *
 * 「她是什么样的人、记得什么」收在这一页：朗读声音、说话口吻、说话节奏、
 * 说话的规矩、知识库（记忆）。它们回答的是同一个问题——她的性格与
 * 记忆由什么构成。音效、语音输入这类**应用行为**在通用页，不在这里。
 *
 * 四张卡（Voice / Oral / Rhythm / Filter）的内部文案来自宿主插件的状态
 * 与数据，暂随宿主语言，不在界面双语的覆盖范围内。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { invokeShell } from '../lib/shell.ts'
import { useT } from '../lib/i18n.ts'
import { setPreferences, usePreferences } from '../lib/preferences.ts'
import { reloadPersonas, usePersona } from '../lib/usePersona.ts'
import { Avatar } from './Avatar.tsx'
import { FilterCard } from './FilterCard.tsx'
import { OralCard } from './OralCard.tsx'
import { RhythmCard } from './RhythmCard.tsx'
import { VoiceCard } from './VoiceCard.tsx'
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

/** 头像边长。24 是显示尺寸，96 是存储尺寸——四倍像素密度足够 Retina。 */
const AVATAR_PIXELS = 96

/**
 * 角色 → 文案键。
 *
 * 不写成 `` t(`persona.pack.role.${role}`) ``：`t()` 的入参是字面量联合，
 * 模板串会被类型系统拒掉，而改成 `as` 断言就等于把「键写错了」这件事
 * 从编译期挪到运行期（运行期它只会显示一个空串）。
 */
const ROLE_KEY = {
  factory: 'persona.pack.role.factory',
  sample: 'persona.pack.role.sample',
  user: 'persona.pack.role.user',
} as const

/**
 * 把选中的图片裁成正方形并缩到 96×96，返回 data URL。
 *
 * ## 为什么在界面里缩，不直接存原图
 *
 * `localStorage` 只有 5MB 量级，一张手机照片的 base64 就能吃掉一半；
 * 而这一格最大只显示 24px。存原图等于用一张 4000×3000 的图去填一个
 * 24 像素的圆，代价是每次启动都要解一次大图。
 *
 * ## 为什么先裁中心正方形
 *
 * 头像容器是正圆。不裁的话 `object-fit: cover` 只是**看起来**裁了，
 * 存进去的仍是整张图；换一个更宽的容器（比如设置页的 40px）就会露出
 * 裁切之外的部分。裁在存之前，读的地方就不必再猜。
 */
function shrinkToAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(new Error('read-failed')) }
    reader.onload = () => {
      const image = new Image()
      image.onerror = () => { reject(new Error('decode-failed')) }
      image.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = AVATAR_PIXELS
        canvas.height = AVATAR_PIXELS
        const context = canvas.getContext('2d')
        if (context === null) {
          reject(new Error('canvas-unavailable'))
          return
        }
        const side = Math.min(image.width, image.height)
        context.drawImage(
          image,
          (image.width - side) / 2,
          (image.height - side) / 2,
          side,
          side,
          0,
          0,
          AVATAR_PIXELS,
          AVATAR_PIXELS,
        )
        resolve(canvas.toDataURL('image/png'))
      }
      image.src = typeof reader.result === 'string' ? reader.result : ''
    }
    reader.readAsDataURL(file)
  })
}

export function SettingsPersona(): React.JSX.Element {
  const t = useT()
  const preferences = usePreferences()
  const persona = usePersona()
  /** 隐藏的文件选择器：按钮点它，避免做第二个自绘控件。 */
  const fileRef = useRef<HTMLInputElement | null>(null)
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
      setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('kb.err.load') })
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = (): void => {
    if (draft === undefined || draft.title.trim() === '') {
      setReceipt({ tone: 'bad', text: t('kb.err.title') })
      return
    }
    setBusy(true)
    void (async () => {
      try {
        await invokeShell<void>('kb_upsert', { entry: draft })
        setReceipt({ tone: 'ok', text: t('kb.ok.saved') })
        setDraft(undefined)
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('kb.err.save') })
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
        setReceipt({ tone: 'ok', text: t('kb.ok.deleted') })
        await refresh()
      } catch (caught) {
        setReceipt({ tone: 'bad', text: caught instanceof Error ? caught.message : t('kb.err.delete') })
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <section className="pref__section">
      {/*
        人设包与头像排在第一位：这一页的其余四段（声音 / 口吻 / 节奏 / 规矩）
        都是**她怎么说话**，而人设包决定**她是谁**。先是谁，再是怎么说。
      */}
      <Heading>{t('persona.pack')}</Heading>
      <Note>{t('persona.pack.note')}</Note>

      <div className="pref__identity">
        <Avatar size={40} src={preferences.avatar} label={t('persona.avatar')} />
        <div className="pref__identity-main">
          <div className="pref__identity-actions">
            <button type="button" className="button" onClick={() => { fileRef.current?.click() }}>
              {t('persona.avatar.pick')}
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={preferences.avatar === ''}
              onClick={() => { setPreferences({ avatar: '' }) }}
            >
              {t('persona.avatar.reset')}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => { reloadPersonas() }}
            >
              {t('persona.pack.rescan')}
            </button>
          </div>
          <p className="pref__hint">{t('persona.avatar.note')}</p>
        </div>
        {/*
          文件输入必须留在 DOM 里但不可见：`display:none` 的 input 在部分
          WebView 里点不动，用视觉隐藏（0 尺寸 + 不可聚焦）最稳。
        */}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="pref__file"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0]
            /* 清空 value：同一张图连选两次也要能触发 change。 */
            event.target.value = ''
            if (file === undefined) return
            void shrinkToAvatar(file).then(
              (url) => { setPreferences({ avatar: url }) },
              () => { setReceipt({ tone: 'bad', text: t('persona.avatar.err') }) },
            )
          }}
        />
      </div>

      {persona.personas.length === 0 ? (
        <Note>{t('persona.pack.empty')}</Note>
      ) : (
        <ul className="pref__packs">
          {persona.personas.map((pack) => {
            const current = pack.id === persona.activeId
            return (
              <li className="pref__pack-row" key={pack.id} data-current={current ? '' : undefined}>
                <span className="pref__pack-name" title={pack.displayName}>{pack.name}</span>
                <span className="pref__pack-role">{t(ROLE_KEY[pack.role])}</span>
                {current ? (
                  <span className="pref__pack-state">{t('persona.pack.current')}</span>
                ) : (
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={persona.switching !== undefined}
                    onClick={() => {
                      void persona.switchTo(pack.id).then((result) => {
                        setReceipt({
                          tone: result.ok ? 'ok' : 'bad',
                          text: result.ok ? t('persona.pack.switched') : (result.message ?? ''),
                        })
                      })
                    }}
                  >
                    {t('persona.pack.switch')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <Heading>{t('persona.voice')}</Heading>
      <VoiceCard />

      <Heading>{t('persona.tone')}</Heading>
      <OralCard />

      <Heading>{t('persona.pace')}</Heading>
      <RhythmCard />

      <Heading>{t('persona.rules')}</Heading>
      <FilterCard />

      <Heading>{t('persona.memory')}</Heading>
      <Note>{t('kb.note')}</Note>

      <div className="pref__actions">
        <button
          type="button"
          className="button"
          aria-disabled={draft === undefined ? undefined : 'true'}
          onClick={() => { setDraft(blank()) }}
        >
          {t('kb.add')}
        </button>
      </div>

      {items.length === 0 && draft === undefined ? (
        <Note>{t('kb.empty')}</Note>
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
                  {t('kb.edit')}
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  aria-disabled={busy ? 'true' : undefined}
                  onClick={() => { remove(item.id) }}
                >
                  {t('kb.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {draft === undefined ? null : (
        <div className="kb__editor">
          <Heading>{draft.id === '' ? t('kb.editorNew') : t('kb.editorEdit')}</Heading>
          <label className="kb__field">
            <span className="kb__label">{t('kb.field.title')}</span>
            <input
              className="kb__input"
              value={draft.title}
              placeholder={t('kb.field.titlePh')}
              onChange={(event) => { setDraft({ ...draft, title: event.target.value }) }}
            />
          </label>
          <label className="kb__field">
            <span className="kb__label">{t('kb.field.category')}</span>
            <input
              className="kb__input"
              value={draft.category}
              placeholder={t('kb.field.categoryPh')}
              onChange={(event) => { setDraft({ ...draft, category: event.target.value }) }}
            />
          </label>
          <label className="kb__field">
            <span className="kb__label">{t('kb.field.body')}</span>
            <textarea
              className="kb__textarea"
              value={draft.body}
              rows={5}
              placeholder={t('kb.field.bodyPh')}
              onChange={(event) => { setDraft({ ...draft, body: event.target.value }) }}
            />
          </label>
          <div className="pref__actions">
            <button type="button" className="button" aria-disabled={busy ? 'true' : undefined} onClick={save}>
              {busy ? t('kb.saving') : t('kb.save')}
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
