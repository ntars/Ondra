/**
 * 设置 · 通知（§12.10、§7.5）。
 *
 * ## 请求权限的时机只能在这里
 *
 * §7.5：「系统通知权限只在用户开启"主动消息"时才请求，不在首启请求」。
 * 这一条决定了整个组件的形状——请求必须由**点开关**触发，不能在页面
 * 打开时顺手请求。所以下面那个 effect 只读不请求。
 */

import { useEffect, useState } from 'react'
import { usePreferences, setPreferences } from '../lib/preferences.ts'
import { readPermission, requestPermission } from '../lib/notify.ts'
import type { NotifyPermission } from '../lib/notify.ts'
import { Heading, Note, Row, Toggle } from './settingsUi.tsx'

export function SettingsNotify(): React.JSX.Element {
  const prefs = usePreferences()
  /** 通知权限。默认 `default`（还没问过）。 */
  const [permission, setPermission] = useState<NotifyPermission>('default')

  /*
   * 读一次权限（只读，不请求）。
   *
   * 多做一件事：用户可能已经授权过、开关却因为别的原因关着（比如上次
   * 被拒后回滚）。读到已授权就不显示那句「去系统设置」的提示，免得他
   * 自己都授权了还被告知去开。
   */
  useEffect(() => {
    let alive = true
    void readPermission().then((next) => { if (alive) setPermission(next) })
    return () => { alive = false }
  }, [])

  /**
   * 打开或关闭系统通知。
   *
   * ## 先落开关再请求
   *
   * 请求会弹系统框，用户点完才返回。若等他点完才写偏好，那几百毫秒里
   * 界面上的开关是不动的——点了没反应。落完再请求，被拒则回滚。
   *
   * ## 被拒绝时开关要弹回去
   *
   * 用户点了「不允许」，如果开关还停在「开」，他会以为设置成功了，
   * 然后一直等一条永远不会来的通知。
   */
  const change = async (next: boolean): Promise<void> => {
    if (!next) {
      setPreferences({ notify: false })
      return
    }
    setPreferences({ notify: true })
    const result = await requestPermission()
    setPermission(result)
    if (result !== 'granted') setPreferences({ notify: false })
  }

  return (
    <section className="pref__section">
      <Heading>系统通知</Heading>

      <Row label="系统通知" hint="窗口不在桌面时，她说的话会弹到通知栏">
        <Toggle label="系统通知" checked={prefs.notify} onChange={(next) => { void change(next) }} />
      </Row>

      {/*
        权限被拒时给一条可执行的出路，而不是只说「不可用」。
        §7.6 的三段式在这里同样适用：发生了什么 · 为什么 · 下一步。
      */}
      {permission === 'denied' ? (
        <p className="pref__note pref__note--warn">
          系统里拒绝了通知权限。去「系统设置 → 通知 → 空谷 Ondra」打开，
          再回来打开这个开关。
        </p>
      ) : null}
      {permission === 'unsupported' ? (
        <p className="pref__note">
          这台机器上读不到通知权限（浏览器里预览时也会这样）。桌面端才能发系统通知。
        </p>
      ) : null}

      <Note>
        仅在窗口不可见时发送。窗口在屏幕上、只是焦点落在其他应用时不发送：返回应用即可直接看到，此时推送反而是干扰。
      </Note>
      <Note>
        主动消息仍受每日上限与作息约束；通知只把已出现在时间轴上的内容呈现在通知中心。静音期间不发送任何通知。
      </Note>
    </section>
  )
}
