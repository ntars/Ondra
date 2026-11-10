/**
 * 「说话节奏」这一格（偏好设置 → 声音 → 说话节奏）。
 *
 * ## 为什么它必须与「说话口吻」分开
 *
 * 两件事问的是不同的问题，坏了的表现也不一样：
 *
 * | 格 | 问题 | 坏了的表现 |
 * | --- | --- | --- |
 * | 说话口吻 | 句子有没有主语、句号多不多 | 像个客服 |
 * | 说话节奏 | 开口前有没有那半拍、深夜会不会更慢 | 一瞬间吐完整段 |
 *
 * ## 为什么要摆 `turns` / `runs` 两个数
 *
 * 三个包各自装载正常、`available` 全 true、配置段也读得到，却一次都没被调过——
 * 这正是接入前的状态，而在任何面板上都看不出来。`turns` 是「宿主问过分条」
 * 的唯一证据，`runs` 是「时间线真的排过」的唯一证据。两者分开：
 * 前者为 0 是宿主没接线，后者为 0 是计时器没被调用。
 *
 * ## 为什么把「只做了首字延迟」写进正文
 *
 * 计划里算了四条（首字延迟、长停顿、深夜放大、自我修正），而实际只用第一条。
 * 不写清楚的话，读者看到「长停顿 0 次」会去查一个不存在的问题。
 * 这不是缺陷，是单窗单气泡这个形态给出的边界。
 */

import { useCallback, useEffect, useState } from 'react'
import { getRhythmState } from '../lib/api.ts'
import type { RhythmState } from '../lib/api.ts'
import { getSettings, saveSetting } from '../lib/settings.ts'

/** 渲染节奏状态与总开关。 */
export function RhythmCard(): React.JSX.Element {
  const [state, setState] = useState<RhythmState | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  /** 用户层里 `rhythm.enable` 的覆盖值；`undefined` 表示没改过、用插件默认。 */
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  /** 插件默认值，来自设置段的字段声明。 */
  const [fallback, setFallback] = useState(true)
  /**
   * 用户改过开关、但还没重启。
   *
   * ## 为什么必须说出来
   *
   * `rhythm` 与 `rhythm-typing` 都在 `apply()` 里**一次性**读配置
   * （`completeConfig()` 之后定死），所以改开关要重启宿主才生效。
   * 而这一格的 `note` 来自探针，重启前**一个字都不会变**——
   * 用户拨了开关、看到状态没变，会以为「这个开关坏了」。
   *
   * 已有「下次启动生效」的语言（`ModuleLayer.tsx` 的 `field__restart`），
   * 这里沿用同一句，不另起说法。
   */
  const [restartNeeded, setRestartNeeded] = useState(false)

  const load = useCallback((): void => {
    void getRhythmState()
      .then((next) => {
        /*
         * 只认**形状对**的响应。
         *
         * ## 为什么不能直接 `setState(next)`
         *
         * `request()` 只保证「HTTP 通了」，不保证 body 是节奏探针：
         * 宿主还没起来、路由还没注册、版本比界面旧时，中间层可能返回
         * `{ error: '...' }` 或一个 404 的纯文本包装。那些响应同样是
         * 「请求成功」，直接塞进 `state` 会让渲染里 `state.loaded.rhythm`
         * 读到 `undefined.rhythm` —— **整页白屏**。
         *
         * 这不是假想：本轮接入时 `check:ui` 就是在这一步崩的，
         * 症状是偏好设置页整块消失、连左侧导航都不剩（React 整树卸载）。
         * 一个诊断卡片读不到数据，不该把整页带走。
         */
        const ok = next !== null && typeof next === 'object'
          && typeof next.loaded === 'object' && next.loaded !== null
          && typeof next.host === 'object' && next.host !== null
        if (!ok) { setFailed(true); return }
        setState(next)
        setFailed(false)
      })
      .catch(() => { setFailed(true) })
    void getSettings()
      .then((snapshot) => {
        const section = snapshot.sections.find((item) => item.id === 'rhythm')
        const field = section?.fields.find((item) => item.key === 'enable')
        if (typeof field?.default === 'boolean') setFallback(field.default)
        const value = snapshot.user['rhythm']?.['enable']
        setOverride(typeof value === 'boolean' ? value : undefined)
      })
      .catch(() => { /* 读不到设置就按插件默认值渲染开关 */ })
  }, [])

  useEffect(() => { load() }, [load])

  const enabled = override ?? fallback

  const change = useCallback((next: boolean): void => {
    // 与插件默认值相同时删键而不是写同值：写同值会让「恢复默认」再也回不到
    // 「没改过」的状态。与朗读、口吻两格同一口径。
    const value = next === fallback ? undefined : next
    setOverride(value)
    setRestartNeeded(true)
    void saveSetting('rhythm', 'enable', value).catch(() => { setOverride(override) })
  }, [fallback, override])

  if (failed) {
    return (
      <div className="pref__row">
        <div className="pref__row-text">
          <span className="pref__row-label">说话节奏</span>
          <span className="pref__row-hint">读不到节奏状态，宿主可能没在跑</span>
        </div>
      </div>
    )
  }

  const rhythm = state?.rhythm
  const note = state === undefined ? '正在读状态…' : state.note

  return (
    <>
      <div className="pref__row">
        <div className="pref__row-text">
          <span className="pref__row-label">说话节奏</span>
          <span className="pref__row-hint">
            {state === undefined
              ? '读状态中'
              : state.loaded.rhythm && state.loaded.typing
                ? '开口前留半拍，不一口气吐完整段'
                : '分条或计时没装载，她会一次性说完'}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="说话节奏"
          className="pref__switch pref__switch--voice control-switch"
          onClick={() => { change(!enabled) }}
        >
          <span className="pref__switch-knob control-switch-knob" />
        </button>
      </div>

      {note === '' ? null : <p className="pref__note">{note}</p>}

      {restartNeeded ? <p className="pref__note">下次启动生效</p> : null}

      {/*
       * 两个数分开报。`turns` 掉在 0 与 `holds` 掉在 0 是两种不同的断裂：
       * 前者是插件没被问过，后者是宿主没接线。而 `typing.runs` 在这个形态下
       * 恒 0（宿主走的是 `schedule()` 预览路径，不记账），所以不拿它当判据。
       */}
      {state !== undefined && rhythm !== undefined ? (
        rhythm.turns === 0 && state.host.holds === 0 ? (
          <p className="pref__note">还没有一句话经过分条。说一句话就会开始记账。</p>
        ) : (
          <p className="pref__note">
            {`分条 ${String(rhythm.turns)} 轮，平均切成 ${String(rhythm.avgMessages)} 条`
              + `× ${String(rhythm.avgChars)} 字`
              + `；宿主问过 ${String(state.host.holds)} 次，`
              + `上次停了 ${String(state.host.lastHoldMs)} 毫秒`}
          </p>
        )
      ) : null}

      {state?.breath !== undefined ? (
        <p className="pref__note">
          {/*
           * 三个数必须一起说。
           *
           * `remaining` 是「今天还能给几个」，它同时受两个数压着：
           * 单日上限（2）与**池子里可给的动作条数**（出厂只有「伸懒腰」一条，
           * 且同一动作每日一次 → 可给 1 条）。所以会出现
           * 「用了 0 次、上限 2、却只剩 1 次」——那不是额度丢了，是池子只有一条。
           * 只报 `remaining` 的话，读的人必然去查一个不存在的 bug。
           */}
          {`今天呼吸感动作还能用 ${String(state.breath.quota.remaining)} 次`
            + `（上限 ${String(state.breath.quota.cap)} 次，已用 ${String(state.breath.quota.used)} 次；`
            + `池里可用的动作只有 ${String(state.breath.quota.actions.filter((item) => item.used === 0).length)} 条，`
            + `同一动作一天一次，所以实际能到手的少于上限）`}
        </p>
      ) : null}

      <p className="pref__note">
        只做一件事：一个字都不来时，先亮「她在打字」，过一两秒再落定。
        分条把话拆成四条、长停顿、深夜放慢都算出来了，但这里是单窗单气泡、
        正文早就逐字显示完了——把显示过的字收回去再重打一遍，只会让人多等。
        所以只用第一项，其余如实记在上面的账里。
      </p>
    </>
  )
}
