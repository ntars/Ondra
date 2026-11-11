/**
 * 设置 · 对话。
 *
 * 两件与「她说一句、你回一句」直接相关的事：生成中按 Enter 的行为、
 * 新会话的默认权限。两者都是**行为**偏好，与外观、声音那些感官偏好分开。
 */

import { useEffect, useState } from 'react'
import { usePreferences, setPreferences } from '../lib/preferences.ts'
import type { SendMode } from '../lib/preferences.ts'
import { getConfig, savePermission } from '../lib/api.ts'
import type { PermissionLevel } from '../lib/api.ts'
import { Dialog } from './Dialog.tsx'
import { Choices, Heading, Note } from './settingsUi.tsx'
import { SettingsProviders } from './SettingsProviders.tsx'

export function SettingsTalk(): React.JSX.Element {
  const prefs = usePreferences()
  /** 权限档位来自宿主，不在本地存。读到之前是 undefined。 */
  const [permission, setPermission] = useState<PermissionLevel | undefined>(undefined)
  const [error, setError] = useState('')
  /** 选「不限制」前的二次确认。undefined 表示未弹窗。 */
  const [confirmFull, setConfirmFull] = useState(false)

  /*
   * 权限档位要在打开这一页时读一次。
   *
   * 走 `getConfig()` 就够：`host.ts` 的 `request` 已经带「连接没就绪就
   * 先拉一次 `get_host_state`」的逻辑。上一版设置是独立窗口，还要额外
   * 补一次 `ensureConnection`——它错过的那条 `host-ready` 事件在这里
   * 根本不存在。
   */
  useEffect(() => {
    let alive = true
    void getConfig().then(
      (config) => { if (alive) { setPermission(config.permission); setError('') } },
      (caught: unknown) => {
        if (!alive) return
        setError(caught instanceof Error ? caught.message : '读不到权限设置')
      },
    )
    return () => { alive = false }
  }, [])

  /**
   * 改权限。
   *
   * 先改本地（界面立刻跟手，§6.5），再写宿主。写失败时回滚并说明原因——
   * 不回滚的话界面会一直显示一个宿主持有的旧值，而用户以为已经改了。
   */
  const changePermission = (next: PermissionLevel): void => {
    // 选「不限制」是放大的授权：先弹确认，避免误点就把权限开到整机。
    if (next === 'full' && permission !== 'full') {
      setConfirmFull(true)
      return
    }
    const previous = permission
    setPermission(next)
    void savePermission(next).catch((caught: unknown) => {
      setPermission(previous)
      setError(caught instanceof Error ? caught.message : '写入失败')
    })
  }

  return (
    <section className="pref__section">
      <Heading>发送方式</Heading>
      <Choices<SendMode>
        name="发送方式"
        value={prefs.sendMode}
        onChange={(next) => { setPreferences({ sendMode: next }) }}
          options={[
            { value: 'interrupt', label: '打断', hint: '她正在生成时，按 Enter 可立即插入您的输入' },
            { value: 'queue', label: '排队', hint: '待她完成本轮生成后再接入您的输入' },
          ]}
      />
      <Note>
        这只影响「她正在生成时」按 Enter 的行为。空闲时 Enter 永远是发送，
        Shift + Enter 永远是换行。选「排队」时，生成中按 Cmd/Ctrl + Enter 可以越过队列立刻发。
      </Note>

      <Heading>默认权限</Heading>
      {permission === undefined ? (
        <p className="pref__note">
          {error === '' ? '正在读取…' : `读不到权限设置：${error}`}
        </p>
      ) : (
        <Choices<PermissionLevel>
          name="默认权限"
          value={permission}
          onChange={changePermission}
          options={[
            { value: 'chat', label: '只在对话内', hint: '不碰文件、不跑命令' },
            { value: 'workspace', label: '限于工作区', hint: '能在绑定的目录里读写' },
            { value: 'full', label: '不限制', hint: '可读取整台设备上的文件' },
          ]}
        />
      )}
      {error === '' ? null : <p className="pref__error" role="alert">{error}</p>}
      <Note>
        这是新会话的默认档位，不是当前会话的。已经开着的对话各自记住自己建立时的档位——
        否则改一次默认值，正在进行的对话会在中途悄悄扩大权限。
      </Note>
      {permission === 'full' ? (
        <p className="pref__warn" role="alert">
          当前默认档位为「不限制」：新会话将能够读取整台机器上的文件。若非必要，建议改回「限于工作区」或「只在对话内」。
        </p>
      ) : null}

      <SettingsProviders />

      {confirmFull ? (
        <Dialog
          title="放宽到「不限制」"
          confirmLabel="仍然放宽"
          cancelLabel="取消"
          onConfirm={() => {
            setConfirmFull(false)
            const previous = permission
            setPermission('full')
            void savePermission('full').catch((caught: unknown) => {
              setPermission(previous)
              setError(caught instanceof Error ? caught.message : '写入失败')
            })
          }}
          onCancel={() => { setConfirmFull(false) }}
          onDismiss={() => { setConfirmFull(false) }}
        >
          此档位允许新会话读取整台机器上的文件。除非确有需要，否则「限于工作区」更安全。确认放宽至不限制？
        </Dialog>
      ) : null}
    </section>
  )
}
