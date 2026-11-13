/**
 * 设置 · 通用。
 *
 * 2.3.0 起，「这个应用用起来什么样」的所有开关收进这一页：主题、字号、
 * 语言、发送方式、系统通知、默认权限、音效、语音输入。旧版它们散在
 * 外观 / 声音 / 对话三页里——用户为了关一条系统通知，得先猜它在哪页。
 *
 * 人物的声音（朗读、口吻、节奏、规矩）不在这里：那是「她是什么样的人」，
 * 属于人物设定页。
 */

import { useEffect, useState } from 'react'
import { usePreferences, setPreferences } from '../lib/preferences.ts'
import type { FontScale, Locale } from '../lib/preferences.ts'
import type { ThemeMode } from '../lib/api.ts'
import type { SendMode } from '../lib/preferences.ts'
import { getConfig, savePermission } from '../lib/api.ts'
import type { PermissionLevel } from '../lib/api.ts'
import { playCue, previewCue } from '../lib/sound.ts'
import type { SoundCue } from '../lib/sound.ts'
import { readPermission, requestPermission } from '../lib/notify.ts'
import type { NotifyPermission } from '../lib/notify.ts'
import { useT } from '../lib/i18n.ts'
import { getSettings, saveSetting } from '../lib/settings.ts'
import type { SettingsSection } from '../lib/settingTypes.ts'
import type { SceneValues } from '../lib/scenes.ts'
import { Dialog } from './Dialog.tsx'
import { SceneLayer } from './SceneLayer.tsx'
import { SectionFields } from './SectionFields.tsx'
import { Choices, Heading, Note, Row, Toggle } from './settingsUi.tsx'

/** 归这一页的场景段：主动发言三项 + 作息。 */
const GENERAL_SCENE_SECTIONS: ReadonlySet<string> = new Set([
  'proactive-quota',
  'proactive-gate',
  'proactive-reason',
  'life-rhythm',
])

/** 三种提示音的展示清单。顺序即用户在会话里听到它们的顺序。 */
const CUES: Array<{ key: SoundCue; labelKey: 'general.sound.cueSend' | 'general.sound.cueSpeak' | 'general.sound.cueError'; hintKey: 'general.sound.cueSendHint' | 'general.sound.cueSpeakHint' | 'general.sound.cueErrorHint' }> = [
  { key: 'send', labelKey: 'general.sound.cueSend', hintKey: 'general.sound.cueSendHint' },
  { key: 'speak', labelKey: 'general.sound.cueSpeak', hintKey: 'general.sound.cueSpeakHint' },
  { key: 'error', labelKey: 'general.sound.cueError', hintKey: 'general.sound.cueErrorHint' },
]

export function SettingsGeneral(): React.JSX.Element {
  const t = useT()
  const prefs = usePreferences()

  /*
   * 主动发言的三个段（门控 / 节律 / 话由）。
   *
   * ## 为什么在通用页而不是人物设定
   *
   * 这三段回答的是「她什么时候开口」——那是**这个应用用起来什么样**，
   * 不是「她是谁」。原先它们只在扩展功能的模块层里，用户想让她少说两句，
   * 得先知道有个叫「主动门控」的插件段。
   *
   * 场景层有「主动发言频率」与「静默阈值」两个旋钮，但那只是两档显示名；
   * 完整的 21 + 9 + 4 个字段在这里原地展开。
   */
  const [sections, setSections] = useState<SettingsSection[]>([])
  const [settingsUser, setSettingsUser] = useState<SceneValues>({})

  useEffect(() => {
    let alive = true
    void getSettings()
      .then((snapshot) => {
        if (!alive) return
        setSections(snapshot.sections)
        setSettingsUser(snapshot.user)
      })
      .catch(() => { /* 读不到就不展开：这一节本身不是必答项 */ })
    return () => { alive = false }
  }, [])

  const writeSetting = async (section: string, key: string, value: unknown): Promise<void> => {
    const previous = settingsUser[section]?.[key]
    const had = previous !== undefined
    setSettingsUser((current) => {
      const bucket = { ...current[section] }
      if (value === undefined) delete bucket[key]
      else bucket[key] = value
      const next = { ...current }
      if (Object.keys(bucket).length === 0) delete next[section]
      else next[section] = bucket
      return next
    })
    try {
      await saveSetting(section, key, value)
    } catch (caught) {
      setSettingsUser((current) => {
        const bucket = { ...current[section] }
        if (had) bucket[key] = previous
        else delete bucket[key]
        const next = { ...current }
        if (Object.keys(bucket).length === 0) delete next[section]
        else next[section] = bucket
        return next
      })
      setPermissionError(caught instanceof Error ? caught.message : t('general.permissionWriteFail'))
    }
  }

  const sectionOf = (id: string): SettingsSection | undefined => sections.find((item) => item.id === id)

  /* ---- 系统通知 ---- */
  /** 通知权限。默认 `default`（还没问过）。 */
  const [notifyPermission, setNotifyPermission] = useState<NotifyPermission>('default')

  /*
   * 读一次权限（只读，不请求）。请求必须由**点开关**触发，不能在页面
   * 打开时顺手请求——被拒过的人不该再被系统弹一次窗。
   */
  useEffect(() => {
    let alive = true
    void readPermission().then((next) => { if (alive) setNotifyPermission(next) })
    return () => { alive = false }
  }, [])

  /**
   * 打开或关闭系统通知。
   *
   * 先落开关再请求：请求会弹系统框，等它返回才写偏好，那几百毫秒里开关
   * 是不动的——点了没反应。落完再请求，被拒则弹回去，否则用户会一直等
   * 一条永远不会来的通知。
   */
  const changeNotify = async (next: boolean): Promise<void> => {
    if (!next) {
      setPreferences({ notify: false })
      return
    }
    setPreferences({ notify: true })
    const result = await requestPermission()
    setNotifyPermission(result)
    if (result !== 'granted') setPreferences({ notify: false })
  }

  /* ---- 默认权限 ---- */
  /** 权限档位来自宿主，不在本地存。读到之前是 undefined。 */
  const [permission, setPermission] = useState<PermissionLevel | undefined>(undefined)
  const [permissionError, setPermissionError] = useState('')
  /** 选「不限制」前的二次确认。false 表示未弹窗。 */
  const [confirmFull, setConfirmFull] = useState(false)

  useEffect(() => {
    let alive = true
    void getConfig().then(
      (config) => { if (alive) { setPermission(config.permission); setPermissionError('') } },
      (caught: unknown) => {
        if (!alive) return
        setPermissionError(caught instanceof Error ? caught.message : t('general.permissionWriteFail'))
      },
    )
    return () => { alive = false }
  }, [t])

  /**
   * 改权限：先改本地（界面立刻跟手），再写宿主。写失败时回滚并说明原因。
   * 选「不限制」是放大的授权：先弹确认，避免误点就把权限开到整机。
   */
  const changePermission = (next: PermissionLevel): void => {
    if (next === 'full' && permission !== 'full') {
      setConfirmFull(true)
      return
    }
    const previous = permission
    setPermission(next)
    void savePermission(next).catch((caught: unknown) => {
      setPermission(previous)
      setPermissionError(caught instanceof Error ? caught.message : t('general.permissionWriteFail'))
    })
  }

  /* ---- 提示音 ---- */
  /**
   * 打开提示音的同时播一声：用户不知道它到底开没开时，只能等下一次真实
   * 发消息。这一声用 `previewCue`——它绕开开关本身，此刻开关已设为开。
   */
  const changeSound = (next: boolean): void => {
    setPreferences({ sound: next })
    if (next) previewCue('send')
  }

  return (
    <section className="pref__section">
      <Heading>{t('general.theme')}</Heading>
      <Choices<ThemeMode>
        name={t('general.theme')}
        value={prefs.theme}
        onChange={(next) => { setPreferences({ theme: next }) }}
        options={[
          { value: 'system', label: t('general.theme.system'), hint: t('general.theme.systemHint') },
          { value: 'light', label: t('general.theme.light'), hint: t('general.theme.lightHint') },
          { value: 'dark', label: t('general.theme.dark'), hint: t('general.theme.darkHint') },
        ]}
      />
      <Note>{t('general.themeNote')}</Note>

      <Heading>{t('general.font')}</Heading>
      <Choices<FontScale>
        name={t('general.font')}
        value={prefs.fontScale}
        onChange={(next) => { setPreferences({ fontScale: next }) }}
        options={[
          { value: 'small', label: t('general.font.small'), hint: '15px' },
          { value: 'standard', label: t('general.font.standard'), hint: '16px' },
          { value: 'large', label: t('general.font.large'), hint: '18px' },
        ]}
      />
      {/*
        预演：拖动后下方示例句按新字号重排。
        它用的是真实的正文字号令牌，所以不是「画一个大概」。
      */}
      <div className="pref__sample">
        <p className="pref__sample-text">{t('general.fontSample')}</p>
        <span className="pref__sample-meta">{t('general.fontSampleMeta')}</span>
      </div>
      <Note>{t('general.fontNote')}</Note>

      <Heading>{t('general.locale')}</Heading>
      <Choices<Locale>
        name={t('general.locale')}
        value={prefs.locale}
        onChange={(next) => { setPreferences({ locale: next }) }}
        options={[
          { value: 'zh-CN', label: t('general.locale.zh'), hint: t('general.locale.zhHint') },
          { value: 'en', label: t('general.locale.en'), hint: t('general.locale.enHint') },
        ]}
      />
      <Note>{t('general.localeNote')}</Note>

      <Heading>{t('general.proactive')}</Heading>
      <Note>{t('general.proactiveNote')}</Note>
      {/*
        四个日常旋钮在前（频率、静默阈值、作息、可解释），
        完整字段在后面的折叠区里。前者是「她多久说一次」，后者是「闸门
        具体怎么算」——两种问题分开回答，不必让用户先读懂阈值再动手。
      */}
      <SceneLayer
        sections={sections}
        user={settingsUser}
        onWrite={writeSetting}
        only={GENERAL_SCENE_SECTIONS}
      />
      <SectionFields
        section={sectionOf('proactive-gate')}
        user={settingsUser}
        onWrite={writeSetting}
        developerMode={prefs.developerMode}
        label={t('general.proactive.gate')}
      />
      <SectionFields
        section={sectionOf('proactive-quota')}
        user={settingsUser}
        onWrite={writeSetting}
        developerMode={prefs.developerMode}
        label={t('general.proactive.quota')}
      />
      <SectionFields
        section={sectionOf('proactive-reason')}
        user={settingsUser}
        onWrite={writeSetting}
        developerMode={prefs.developerMode}
        label={t('general.proactive.reason')}
      />

      <Heading>{t('general.send')}</Heading>
      <Choices<SendMode>
        name={t('general.send')}
        value={prefs.sendMode}
        onChange={(next) => { setPreferences({ sendMode: next }) }}
        options={[
          { value: 'interrupt', label: t('general.send.interrupt'), hint: t('general.send.interruptHint') },
          { value: 'queue', label: t('general.send.queue'), hint: t('general.send.queueHint') },
        ]}
      />
      <Note>{t('general.sendNote')}</Note>

      <Heading>{t('general.notify')}</Heading>
      <Row label={t('general.notify.row')} hint={t('general.notify.rowHint')}>
        <Toggle label={t('general.notify.row')} checked={prefs.notify} onChange={(next) => { void changeNotify(next) }} />
      </Row>
      {notifyPermission === 'denied' ? (
        <p className="pref__note pref__note--warn">{t('general.notify.denied')}</p>
      ) : null}
      {notifyPermission === 'unsupported' ? (
        <p className="pref__note">{t('general.notify.unsupported')}</p>
      ) : null}
      <Note>{t('general.notify.note1')}</Note>
      <Note>{t('general.notify.note2')}</Note>

      <Heading>{t('general.permission')}</Heading>
      {permission === undefined ? (
        <p className="pref__note">{permissionError === '' ? t('general.permission.pending') : t('general.permission.loadError', permissionError)}</p>
      ) : (
        <Choices<PermissionLevel>
          name={t('general.permission')}
          value={permission}
          onChange={changePermission}
          options={[
            { value: 'chat', label: t('general.permission.chat'), hint: t('general.permission.chatHint') },
            { value: 'workspace', label: t('general.permission.workspace'), hint: t('general.permission.workspaceHint') },
            { value: 'full', label: t('general.permission.full'), hint: t('general.permission.fullHint') },
          ]}
        />
      )}
      {permissionError === '' ? null : <p className="pref__error" role="alert">{permissionError}</p>}
      <Note>{t('general.permissionNote')}</Note>
      {permission === 'full' ? (
        <p className="pref__warn" role="alert">{t('general.permissionWarn')}</p>
      ) : null}

      <Heading>{t('general.sound')}</Heading>
      <Row label={t('general.sound.row')} hint={t('general.sound.rowHint')}>
        <Toggle label={t('general.sound.row')} checked={prefs.sound} onChange={changeSound} />
      </Row>

      <div className="pref__slider" data-off={prefs.sound ? undefined : ''}>
        <div className="pref__slider-head">
          <span className="pref__row-label">{t('general.sound.volume')}</span>
          <span className="pref__slider-readout" aria-hidden="true">{prefs.soundVolume}</span>
        </div>
        <input
          type="range"
          className="pref__range control-range"
          min={0}
          max={100}
          step={1}
          value={prefs.soundVolume}
          aria-label={t('general.sound.volumeAria')}
          aria-valuetext={String(prefs.soundVolume)}
          disabled={!prefs.sound}
          /* 已填充比例。0–100 的连续档，直接用值当百分比。 */
          style={{ '--fill': `${String(prefs.soundVolume)}%` } as React.CSSProperties}
          onChange={(event) => {
            setPreferences({ soundVolume: Number(event.target.value) })
          }}
          /*
            松手才试听：拖动过程中每帧都响会变成一串机关枪，那不是预演是噪音。
            `onChange` 在 WebKit 上随拖动连续触发，所以预演挂在 pointerup 上。
          */
          onPointerUp={() => { playCue('send') }}
          onKeyUp={() => { playCue('send') }}
        />
      </div>

      {/* 三种音逐个可听。没有这三个入口，「只有三种音」就只是一句话。 */}
      <div className="pref__cues">
        {CUES.map((cue) => (
          <button
            key={cue.key}
            type="button"
            className="pref__cue"
            aria-disabled={prefs.sound ? undefined : 'true'}
            title={prefs.sound ? undefined : t('general.sound.cueLocked')}
            onClick={() => {
              if (!prefs.sound) return
              playCue(cue.key)
            }}
          >
            <span className="pref__cue-name">{t(cue.labelKey)}</span>
            <span className="pref__cue-hint">{t(cue.hintKey)}</span>
          </button>
        ))}
      </div>

      <Note>{t('general.sound.note')}</Note>

      <Heading>{t('general.voiceInput')}</Heading>
      <Row label={t('general.voiceInput.row')} hint={t('general.voiceInput.rowHint')}>
        <Toggle label={t('general.voiceInput.row')} checked={prefs.voiceInput} onChange={(next) => { setPreferences({ voiceInput: next }) }} />
      </Row>
      <Note>{t('general.voiceInputNote')}</Note>

      {confirmFull ? (
        <Dialog
          title={t('general.fullConfirmTitle')}
          confirmLabel={t('general.fullConfirmConfirm')}
          cancelLabel={t('general.cancel')}
          onConfirm={() => {
            setConfirmFull(false)
            const previous = permission
            setPermission('full')
            void savePermission('full').catch((caught: unknown) => {
              setPermission(previous)
              setPermissionError(caught instanceof Error ? caught.message : t('general.permissionWriteFail'))
            })
          }}
          onCancel={() => { setConfirmFull(false) }}
          onDismiss={() => { setConfirmFull(false) }}
        >
          {t('general.fullConfirmBody')}
        </Dialog>
      ) : null}
    </section>
  )
}
