/**
 * 「她说话的口吻」这一格（偏好设置 → 朗读 → 说话口吻）。
 *
 * ## 为什么它必须和「朗读」分开成一块
 *
 * 两件事问的是不同的问题：
 *
 * | 格 | 问题 | 坏了的表现 |
 * | --- | --- | --- |
 * | 朗读 | 她出声了吗 | 安静 |
 * | 说话口吻 | 她嘴里像人还是像文档 | 每个句号都在、书面语、像个客服 |
 *
 * 合成坏了口吻照改；口吻关掉了声音照出。合成一格会把这两件事说成一件，
 * 而修法完全不同——合成去查引擎，口吻去查情绪档与设置开关。
 *
 * ## 为什么要显示 `turns` 与 `puncts` 两个数
 *
 * `turns` 是「宿主真的调过塑形」的唯一证据。插件装载正常、
 * `available=true`、`expressReady=true`，却 `turns=0`——这是
 * 「一切正常却没效果」里最难查的一种，本仓在语音、弥散、做梦三处
 * 各踩过一次。把这两个数摆出来，读者不必去翻日志就能判。
 *
 * `pools=0` 单独说一句：口头禅池是空的意味着她**不会插口癖**。
 * 那是设计（池子要 12–20 条才够用，台词库还没迁过来），不是故障，
 * 所以文案要把它与「坏了」分开，否则读者会去修一个不存在的问题。
 */

import { useCallback, useEffect, useState } from 'react'
import { getOralState } from '../lib/api.ts'
import type { OralState } from '../lib/api.ts'
import { getSettings, saveSetting } from '../lib/settings.ts'

/** 渲染口语化状态与开关。 */
export function OralCard(): React.JSX.Element {
  const [state, setState] = useState<OralState | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  /** 用户层里 `oral.enable` 的覆盖值；`undefined` 表示没改过、用插件默认。 */
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  /** 插件默认值，来自设置段的字段声明。 */
  const [fallback, setFallback] = useState(true)

  const load = useCallback((): void => {
    void getOralState()
      .then((next) => { setState(next); setFailed(false) })
      .catch(() => { setFailed(true) })
    void getSettings()
      .then((snapshot) => {
        const section = snapshot.sections.find((item) => item.id === 'oral')
        const field = section?.fields.find((item) => item.key === 'enable')
        if (typeof field?.default === 'boolean') setFallback(field.default)
        const value = snapshot.user['oral']?.['enable']
        setOverride(typeof value === 'boolean' ? value : undefined)
      })
      .catch(() => { /* 读不到设置就按插件默认值渲染开关 */ })
  }, [])

  useEffect(() => { load() }, [load])

  const enabled = override ?? fallback

  const change = useCallback((next: boolean): void => {
    /*
     * 与插件默认值相同时删键而不是写同值：写同值会让「恢复默认」
     * 再也回不到「没改过」的状态。与朗读那一格同一口径。
     */
    const value = next === fallback ? undefined : next
    setOverride(value)
    void saveSetting('oral', 'enable', value).catch(() => { setOverride(override) })
  }, [fallback, override])

  if (failed) {
    return (
      <div className="pref__row">
        <div className="pref__row-text">
          <span className="pref__row-label">说话口吻</span>
          <span className="pref__row-hint">读不到口语化状态，宿主可能没在跑</span>
        </div>
      </div>
    )
  }

  const stats = state?.stats
  /*
   * `state.note` 也要设防。类型写的是 `string`，但它跨了一次 JSON——
   * 宿主漏字段时 `note === ''` 不成立，界面会渲染出一个**空的带边框说明块**
   * （`.pref__note` 有底色有描边，空的时候是一块谁也说不出用途的灰片）。
   */
  const note = state === undefined ? '正在读状态…' : (typeof state.note === 'string' ? state.note : '')

  return (
    <>
      <div className="pref__row">
        <div className="pref__row-text">
          <span className="pref__row-label">说话口吻</span>
          <span className="pref__row-hint">
            {state === undefined
              ? '正在读取状态'
              : state.expressReady
                ? '按情绪调整标点、省略主语、精简语气词'
                : '情绪档未就绪：仅调整标点，不改动语气词'}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="说话口吻"
          className="pref__switch pref__switch--voice control-switch"
          onClick={() => { change(!enabled) }}
        >
          <span className="pref__switch-knob control-switch-knob" />
        </button>
      </div>

      {note === '' ? null : <p className="pref__note">{note}</p>}

      {/*
       * 两个数分开报。`turns` 掉在 0 与 `puncts` 掉在 0 是两种不同的断裂：
       * 前者是宿主没调它，后者是调了但一个动作都没做（情绪档太平）。
       */}
      {state !== undefined && stats !== undefined ? (
        stats.turns === 0 ? (
          <p className="pref__note">
            还没有一句话经过口语化。说一句话就会开始记账。
          </p>
        ) : (
          <p className="pref__note">
            {`塑形 ${String(stats.turns)} 轮，改了标点 ${String(stats.puncts)} 次`
              + `，减了语气词 ${String(stats.particles)} 次`
              + `，省成不完整句 ${String(stats.incompletes)} 次`}
          </p>
        )
      ) : null}

      {/*
       * 池子为空是设计，不是故障。它与「口语化坏了」长得一样（都不插口癖），
       * 所以必须单独说一句，否则读者会去修一个不存在的问题。
       */}
      {state !== undefined && stats !== undefined && stats.pools === 0 ? (
        <p className="pref__note">
          口头禅池还是空的：她不会插「诶」「对吧」这类口癖。池子要 12–20 条才够用，
          台词库迁过来之前不插——三条的池子会让同一句话每轮都出现，那才真的僵。
        </p>
      ) : null}

      <p className="pref__note">
        只加不删，也不改内容：去掉的是句末句号和多余的「呀」「啦」，不砍句子。
        带代码块的回答一个字都不动——那是你要复制的东西，不是语感。
      </p>
    </>
  )
}
