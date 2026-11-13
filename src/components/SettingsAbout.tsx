/**
 * 设置 · 关于。
 *
 * 版本、许可证、仓库、更新方式。四件都在回答同一个问题：
 * 「这是什么东西、我能拿它做什么」。
 *
 * ## 为什么有「检查更新」但没有自动安装
 *
 * 自动下载安装需要代码签名与更新服务器，现在没有。检查更新只做**比对**：
 * 有新版本时指到下载页，覆盖安装不影响配置与对话。放一个点了没反应的
 * 「自动更新」按钮比不放更糟。
 */

import { useState } from 'react'
import { Mark } from './Mark.tsx'
import { openLink } from '../lib/openLink.ts'
import { invokeShell } from '../lib/shell.ts'
import { useT } from '../lib/i18n.ts'

/** 仓库与下载页。关于页两处都用，不各写一份。 */
const REPO = 'https://github.com/ntars/Ondra'
const RELEASES = 'https://github.com/ntars/Ondra/releases'

/** 一次更新检查的结果。 */
interface UpdateState {
  /** 检查中。 */
  checking: boolean
  /** 最新版本。 */
  latest: string
  /** 当前版本。 */
  current: string
  /** 是否有可用更新。 */
  available: boolean
  /** 版本说明。 */
  notes: string
  /** 发布页地址。 */
  url: string
  /** 错误信息（网络不可达等）。 */
  error: string
}

export function SettingsAbout(): React.JSX.Element {
  const t = useT()
  /** 打开链接失败时的原因。内置浏览器只认白名单，站外地址会被拒。 */
  const [error, setError] = useState('')
  const [update, setUpdate] = useState<UpdateState>({
    checking: false,
    latest: '',
    current: __APP_VERSION__,
    available: false,
    notes: '',
    url: RELEASES,
    error: '',
  })

  const open = (url: string): void => {
    setError('')
    void openLink(url).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : t('about.err.link'))
    })
  }

  /** 检查更新：查 GitHub Releases 的最新发布，不自动安装。 */
  const checkUpdate = (): void => {
    setUpdate((prev) => ({ ...prev, checking: true, error: '' }))
    void (async () => {
      try {
        const info = await invokeShell<{ current: string; latest: string; url: string; notes: string; available: boolean }>(
          'check_update',
        )
        setUpdate((prev) => ({ ...prev, checking: false, ...info }))
      } catch (caught) {
        setUpdate((prev) => ({
          ...prev,
          checking: false,
          error: caught instanceof Error ? caught.message : t('about.err.check'),
        }))
      }
    })()
  }

  return (
    <section className="pref__section">
      <div className="pref__brand">
        <Mark size={48} variant="tile" label="空谷 Ondra" />
        <div>
          <div className="pref__brand-name">空谷 Ondra</div>
          <div className="pref__brand-slogan">于无声处，听见共鸣。</div>
        </div>
      </div>

      <dl className="pref__facts">
        <dt>{t('about.version')}</dt>
        <dd>{__APP_VERSION__}</dd>
        <dt>{t('about.license')}</dt>
        <dd>AGPL-3.0</dd>
        <dt>{t('about.repo')}</dt>
        <dd>
          <button type="button" className="pref__link" onClick={() => { open(REPO) }}>
            github.com/ntars/Ondra
          </button>
        </dd>
      </dl>

      <p className="pref__heading">{t('about.update')}</p>
      <p className="pref__note">{t('about.updateNote')}</p>
      <div className="pref__actions">
        <button type="button" className="button" aria-disabled={update.checking ? 'true' : undefined} onClick={checkUpdate}>
          {update.checking ? t('about.checking') : t('about.check')}
        </button>
        <button type="button" className="button button--ghost" onClick={() => { open(RELEASES) }}>
          {t('about.openReleases')}
        </button>
      </div>

      {update.error === '' ? null : (
        <p className="pref__error" role="alert">{update.error}</p>
      )}
      {update.latest === '' ? null : update.available ? (
        <p className="pref__receipt" role="status">
          {t('about.ok.available', update.latest, update.current)}
        </p>
      ) : (
        <p className="pref__receipt" role="status">
          {t('about.ok.latest', update.current)}
        </p>
      )}

      {error === '' ? null : <p className="pref__error" role="alert">{error}</p>}
    </section>
  )
}
