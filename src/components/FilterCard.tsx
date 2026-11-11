/**
 * 「说话的规矩」这一格（偏好设置 → 声音 → 说话的规矩）。
 *
 * ## 为什么它跟口吻、节奏排在同一页
 *
 * 这一页名字叫「声音」，但真正的主题是**她怎么把话说出来**，
 * 下面四格各管一段，顺序就是话走过的顺序：
 *
 * | 格 | 管的是 | 坏了的表现 |
 * | --- | --- | --- |
 * | 朗读 | 出不出声 | 安静 |
 * | 说话口吻 | 句子里像不像人 | 像个客服 |
 * | 说话节奏 | 说得多快、开口前停不停 | 一瞬间吐完整段 |
 * | 说话的规矩 | 说出来的话对不对 | 冒出「作为一个 AI」、重复上一轮那句 |
 *
 * 前三条是风格，这一条是**内容**。删掉一句越线的话之后，正文读起来
 * 仍然通顺——所以「过滤没跑」与「她本来就很干净」在界面上完全一样，
 * 只能靠把账本摆出来分辨。
 *
 * ## 为什么 `pending` 必须显示
 *
 * 锚点纠偏与事后评审这两件本轮没接。只报好消息会让读的人以为
 * 九步链整条都通了，而后发现「她说了越线的话也没人拦」时，
 * 会去查一个已经被判过「不在本轮范围」的地方。把没做的写在脸上，
 * 比事后解释便宜得多。
 *
 * ## 为什么先验形状再 `setState`
 *
 * 与节奏那一格同一条教训：探针返回错误体时 `state.loaded` 是
 * `undefined`，渲染里一读就抛，React 卸掉**整棵偏好设置树**——
 * 左侧导航一起消失、整页白屏。一个诊断卡片读不到数据，
 * 不该把整页带走。
 */

import { useCallback, useEffect, useState } from 'react'
import { getFilterState } from '../lib/api.ts'
import type { FilterState } from '../lib/api.ts'
import { getSettings, saveSetting } from '../lib/settings.ts'

/** 四个上游的中文名，用于「哪几步不生效」那句话。 */
const SOURCE_LABELS: ReadonlyArray<{ key: keyof NonNullable<FilterState['stats']>['sources']; label: string }> = [
  { key: 'persona', label: '人格' },
  { key: 'stage', label: '阶段' },
  { key: 'express', label: '表达' },
  { key: 'gateway', label: '网关' },
]

/** 渲染输出过滤状态与总开关。 */
export function FilterCard(): React.JSX.Element {
  const [state, setState] = useState<FilterState | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  /** 用户层里 `filter-chain.enable` 的覆盖值；`undefined` 表示没改过。 */
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  /** 插件默认值，来自设置段的字段声明。 */
  const [fallback, setFallback] = useState(true)
  /**
   * 改过开关但还没重启。
   *
   * `filter-chain` 在 `apply()` 里一次性读配置（`completeConfig()` 之后定死），
   * 改开关要重启宿主才生效。而这一格的 `note` 来自探针，重启前一个字都不会变——
   * 用户拨了开关看不到变化，会以为开关坏了。沿用「下次启动生效」这句已有语言。
   */
  const [restartNeeded, setRestartNeeded] = useState(false)

  const load = useCallback((): void => {
    void getFilterState()
      .then((next) => {
        const ok = next !== null && typeof next === 'object'
          && typeof next.loaded === 'boolean'
          && typeof next.note === 'string'
        if (!ok) { setFailed(true); return }
        setState(next)
        setFailed(false)
      })
      .catch(() => { setFailed(true) })
    void getSettings()
      .then((snapshot) => {
        const section = snapshot.sections.find((item) => item.id === 'filter-chain')
        const field = section?.fields.find((item) => item.key === 'enable')
        if (typeof field?.default === 'boolean') setFallback(field.default)
        const value = snapshot.user['filter-chain']?.['enable']
        setOverride(typeof value === 'boolean' ? value : undefined)
      })
      .catch(() => { /* 读不到设置就按插件默认值渲染开关 */ })
  }, [])

  useEffect(() => { load() }, [load])

  const enabled = override ?? fallback

  const change = useCallback((next: boolean): void => {
    // 与插件默认值相同时删键而不是写同值：写同值会让「恢复默认」
    // 再也回不到「没改过」的状态。与朗读、口吻、节奏三格同一口径。
    const value = next === fallback ? undefined : next
    setOverride(value)
    setRestartNeeded(true)
    void saveSetting('filter-chain', 'enable', value).catch(() => { setOverride(override) })
  }, [fallback, override])

  if (failed) {
    return (
      <div className="pref__row">
        <div className="pref__row-text">
          <span className="pref__row-label">说话的规矩</span>
          <span className="pref__row-hint">读不到过滤状态，宿主可能没在跑</span>
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
  /** 缺席的上游。任一个缺席，对应的那几步就不会命中。 */
  const missing = stats === undefined
    ? []
    : SOURCE_LABELS.filter((item) => stats.sources[item.key] !== true).map((item) => item.label)

  return (
    <>
      <div className="pref__row">
        <div className="pref__row-text">
          <span className="pref__row-label">说话的规矩</span>
          <span className="pref__row-hint">
            {state === undefined
              ? '读状态中'
              : state.loaded
                ? '发出去之前过九道手：草稿腔、客服腔、旁白、复读都删掉'
                : '九步过滤没装载，她说什么都会原样发出来'}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="说话的规矩"
          className="pref__switch pref__switch--voice control-switch"
          onClick={() => { change(!enabled) }}
        >
          <span className="pref__switch-knob control-switch-knob" />
        </button>
      </div>

      {note === '' ? null : <p className="pref__note">{note}</p>}

      {restartNeeded ? <p className="pref__note">下次启动生效</p> : null}

      {stats === undefined ? null : (
        <p className="pref__note">
          {/*
           * `runs` 与 `lastRemoved` 必须分开报：
           * 前者说「宿主调过它」，后者说「上一次真删掉了几句」。
           * 只报一个，会把「没接线」和「接了但一步都没命中」说成同一件事。
           */}
          {stats.runs === 0
            ? '还没有一句话过过这道闸。说一句话就会开始记账。'
            : `已过 ${String(stats.runs)} 句，上次删掉 ${String(stats.lastRemoved)} 句`
              + `（评审 ${String(stats.reviews)} 次，其中打回重写 ${String(stats.steers)} 次）`}
        </p>
      )}

      {missing.length === 0 ? null : (
        <p className="pref__note">
          {`${missing.join('、')}不在位：这几步不会命中，其余照跑。`}
        </p>
      )}

      {state === undefined || state.pending.length === 0 ? null : (
        <p className="pref__note">
          {`还没接的两件：${state.pending.join('；')}。`}
        </p>
      )}

      <p className="pref__note">
        只删整句，绝不切在句中——半句话读起来仍然通顺，只是意思变了，
        那种错没人会归因到过滤。删空时这一轮放行原文，因为重新生成只有对话链能做。
      </p>
    </>
  )
}
