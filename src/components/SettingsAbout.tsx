/**
 * 设置 · 关于。
 *
 * 版本、许可证、仓库、更新方式。四件都在回答同一个问题：
 * 「这是什么东西、我能拿它做什么」。
 *
 * ## 为什么没有「检查更新」按钮
 *
 * 做成那个按钮要先有一个能签名的更新源，现在没有。放一个点了没反应的
 * 按钮比不放更糟——用户会以为是自己网断了。这里给的是它实际的样子：
 * 手动替换，说清配置与对话不会被覆盖。
 */

import { useState } from 'react'
import { Mark } from './Mark.tsx'
import { openLink } from '../lib/openLink.ts'
import { invokeShell } from '../lib/shell.ts'

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
      setError(caught instanceof Error ? caught.message : '打不开这个地址')
    })
  }

  /** 检查更新（G7）。查 GitHub Releases 的最新发布，不自动安装。 */
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
          error: caught instanceof Error ? caught.message : '检查更新失败',
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
        <dt>版本</dt>
        <dd>{__APP_VERSION__}</dd>
        <dt>许可证</dt>
        <dd>AGPL-3.0</dd>
        <dt>仓库</dt>
        <dd>
          <button type="button" className="pref__link" onClick={() => { open(REPO) }}>
            github.com/ntars/Ondra
          </button>
        </dd>
      </dl>

      <p className="pref__heading">更新</p>
      <p className="pref__note">
        本应用不内置自动下载安装（需代码签名与更新服务器）。点击「检查更新」将比对 GitHub 上的最新发布；若有新版本，可前往下载页获取安装包覆盖安装，配置与对话均不受影响。
      </p>
      <div className="pref__actions">
        <button type="button" className="button" aria-disabled={update.checking ? 'true' : undefined} onClick={checkUpdate}>
          {update.checking ? '正在检查…' : '检查更新'}
        </button>
        <button type="button" className="button button--ghost" onClick={() => { open(RELEASES) }}>
          打开下载页
        </button>
      </div>

      {update.error === '' ? null : (
        <p className="pref__error" role="alert">{update.error}</p>
      )}
      {update.latest === '' ? null : update.available ? (
        <p className="pref__receipt" role="status">
          发现新版本 v{update.latest}（当前 v{update.current}）。前往下载页获取更新。
        </p>
      ) : (
        <p className="pref__receipt" role="status">
          已是最新（v{update.current}）。
        </p>
      )}

      {error === '' ? null : <p className="pref__error" role="alert">{error}</p>}
    </section>
  )
}
