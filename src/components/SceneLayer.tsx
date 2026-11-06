/**
 * 设置·场景层。
 *
 * ## 这一层只做一件事：把 13 个真实旋钮讲成人话
 *
 * 1168 个字段里，普通用户真正会调的是这 13 个。每项一行：左边名字、
 * 右边控件、下面一行元数据（当前值 · 默认值 · 来源插件 · 是否已改）。
 *
 * ## 控件语言由底层 `kind` 决定，不由"看起来像几档"决定
 *
 * §5.13 反复强调的一条：
 *
 * | 底层 kind | 控件 | 为什么 |
 * | --- | --- | --- |
 * | `number` | 滑杆（可带锚点） | 连续值必须能拉到任意数，只给 4 档等于把它阉成枚举 |
 * | `enum` | 纯分段 | 值本身离散，界面不能凭空多造一档 |
 * | `boolean` | 开关 | — |
 * | `string` + `HH:MM` | 24h 横轴 + 两个点 | 「作息」是一个区间，拆成两个滑杆就不叫作息 |
 *
 * 所以「她记得多深」是滑杆 + 4 个锚点（字段 min:1 max:3650），
 * 而「她多主动」是纯三段（字段只有 slow/standard/fast 三个取值）。
 *
 * ## 预演只给 6 项
 *
 * §5.13 点名能演的是 1/2/4/5/6/7 六项，其余七项是开关、时间、审批策略，
 * 演不出有意义的文本。硬给一个"预演"只会显示一句废话——比不给更差。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SceneItem, SceneState, SceneValues } from '../lib/scenes.ts'
import { SCENE_ITEMS, resolveScene, writesFor } from '../lib/scenes.ts'
import type { SettingsSection } from '../lib/settingTypes.ts'

/** 场景层要用的宿主数据。 */
export interface SceneLayerProps {
  sections: SettingsSection[]
  user: SceneValues
  /** 写一个字段。`undefined` 表示恢复默认。 */
  onWrite(section: string, key: string, value: unknown): Promise<void>
}

/** 把一个值写成用户看得懂的一小段文字。 */
function formatValue(value: unknown, kind: string | undefined): string {
  if (value === undefined) return '未设置'
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value === '' ? '空' : value
  // json / 数组：不在这里展开，交给模块层。展开成一行只会是一串括号。
  return kind === 'json' ? '（见模块层）' : '—'
}

/**
 * 元数据行的文案：当前值 · 默认值 · 来源段 · 是否已改。
 *
 * **显示段 id 而不是段名**：122 个段里有 12 个段 id 与目录名不同，
 * 而配置文件里存的就是段 id。用户报问题时说目录名、配置里存段 id，
 * 两句话必须能在这一行对上，否则排查时会互相听不懂。
 */
function metaLine(item: SceneItem, state: SceneState): string {
  const current = formatValue(state.value, state.field?.kind)
  const fallback = formatValue(state.fallback, state.field?.kind)
  return `${current} · 默认 ${fallback} · ${item.section}${state.changed ? ' · 已改' : ''}`
}

/** 数字滑杆 + 可选锚点。 */
function NumberControl({
  item,
  state,
  onCommit,
}: {
  item: SceneItem
  state: SceneState
  onCommit(value: number): void
}): React.JSX.Element {
  const field = state.field
  // 范围取字段声明，不做界面收窄（§5.13 硬规矩 2）。
  const min = field?.min ?? 0
  const max = field?.max ?? 100
  const current = typeof state.value === 'number' ? state.value : min

  /*
   * 拖动中的值是本地态，松手才提交。
   *
   * 每移动一像素就写一次盘，会在 300ms 里产生几十次 HTTP 请求与几十次
   * 文件 rename。界面看着流畅，磁盘却在被打；用户拖到一半反悔时，
   * 配置里还会留下一串中间值。
   */
  const [draft, setDraft] = useState<number>(current)
  const dragging = useRef(false)

  // 外部值变化（撤销、恢复默认）时同步进来，但拖动中不打断。
  useEffect(() => {
    if (!dragging.current) setDraft(current)
  }, [current])

  const commit = (): void => {
    dragging.current = false
    if (draft !== current) onCommit(draft)
  }

  return (
    <div className="scene__control">
      {item.options === undefined || item.options.length === 0 ? null : (
        <div className="scene__anchors" role="group" aria-label={`${item.name}的快捷档位`}>
          {item.options.map((option) => {
            const optionValue = Number(option.value)
            return (
              <button
                key={option.value}
                type="button"
                className="scene__anchor"
                aria-pressed={draft === optionValue}
                onClick={() => {
                  dragging.current = false
                  setDraft(optionValue)
                  onCommit(optionValue)
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      )}

      <input
        className="scene__range"
        type="range"
        min={min}
        max={max}
        // 步长 1：字段没有声明 step（§12.16），整数参数不该出现 30.5 天。
        step={1}
        value={draft}
        aria-label={item.name}
        aria-valuetext={String(draft)}
        onChange={(event) => {
          dragging.current = true
          setDraft(Number(event.target.value))
        }}
        onPointerUp={commit}
        // 键盘调节没有 pointerup；失焦与方向键松手都要能提交。
        onKeyUp={commit}
        onBlur={commit}
      />

      <div className="scene__readout">
        {item.scale === undefined ? null : <span className="scene__scale">{item.scale.join(' —— ')}</span>}
        <span className="scene__number">{draft}</span>
      </div>
    </div>
  )
}

/** 纯分段：一档对一个真实取值。 */
function EnumControl({
  item,
  state,
  onCommit,
}: {
  item: SceneItem
  state: SceneState
  onCommit(value: string): void
}): React.JSX.Element {
  const current = typeof state.value === 'string' ? state.value : ''
  /*
   * 候选值优先取字段声明。
   *
   * 插件改了枚举值而界面没跟着改时，按插件走才不会让用户选到一个字段里
   * 不存在的值——那种值写进配置文件后会被插件判非法并回退默认值，
   * 而界面上却显示"已改为 X"。
   */
  const values = state.field?.values ?? item.options?.map((option) => option.value) ?? []

  return (
    <div className="scene__segments" role="group" aria-label={item.name}>
      {values.map((value) => {
        const label = item.options?.find((option) => option.value === value)?.label ?? value
        return (
          <button
            key={value}
            type="button"
            className="scene__segment"
            aria-pressed={current === value}
            onClick={() => { onCommit(value) }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

/** 开关。 */
function SwitchControl({
  item,
  state,
  onCommit,
}: {
  item: SceneItem
  state: SceneState
  onCommit(value: boolean): void
}): React.JSX.Element {
  const on = state.value === true
  return (
    <button
      type="button"
      className="scene__switch"
      role="switch"
      aria-checked={on}
      aria-label={item.name}
      onClick={() => { onCommit(!on) }}
    >
      <span className="scene__switch-knob" />
    </button>
  )
}

/** 把 `HH:MM` 换成当天的分钟数。 */
function toMinutes(text: string): number {
  const [hour, minute] = text.split(':')
  return Number(hour) * 60 + Number(minute)
}

/** 把分钟数写回 `HH:MM`，夹在 0–1439。 */
function toLabel(minutes: number): string {
  const clamped = Math.min(1439, Math.max(0, Math.round(minutes)))
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

/** `HH:MM` 的合法性。与 `life-rhythm` 的 `pattern` 同一形状。 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 时间区间：一条 24 小时横轴 + 两个点。
 *
 * ## 存的是两个字符串，不是时间戳
 *
 * `life-rhythm` 的 `pattern` 是 `^([01]\d|2[0-3]):[0-5]\d$`，界面必须产出
 * 符合它的值。所以内部一直用 `HH:MM`，只在画横轴时换成 0–1440 的分钟数。
 *
 * ## 跨零点要画成两段
 *
 * 23:30–07:00 是常见设置。若当成一条从 23:30 到 07:00 的线段，
 * 起点在终点右边，线段会反向铺满整天。正确画法是两段：
 * 23:30–24:00 与 00:00–07:00。
 */
function TimeRangeControl({
  item,
  state,
  onCommit,
}: {
  item: SceneItem
  state: SceneState
  onCommit(start: string, end: string): void
}): React.JSX.Element {
  const start = typeof state.value === 'string' ? state.value : '23:30'
  const end = typeof state.endValue === 'string' ? state.endValue : '07:00'

  const startMin = toMinutes(start)
  const endMin = toMinutes(end)
  const pct = (minutes: number): number => (minutes / 1440) * 100

  /** 跨零点时画两段，否则一段。 */
  const segments: ReadonlyArray<readonly [number, number]> = startMin <= endMin
    ? [[startMin, endMin]]
    : [[startMin, 1440], [0, endMin]]

  return (
    <div className="scene__control">
      <div className="scene__clock" aria-hidden="true">
        {segments.map(([from, to]) => (
          <span
            key={`${String(from)}-${String(to)}`}
            className="scene__clock-rest"
            style={{ left: `${String(pct(from))}%`, width: `${String(pct(to) - pct(from))}%` }}
          />
        ))}
        {[0, 6, 12, 18, 24].map((hour) => (
          <span key={hour} className="scene__clock-tick" style={{ left: `${String((hour / 24) * 100)}%` }} />
        ))}
      </div>

      <div className="scene__times">
        <label className="scene__time">
          <span className="scene__time-label">起点</span>
          <input
            type="time"
            className="scene__time-input"
            value={start}
            aria-label={`${item.name}起点`}
            onChange={(event) => {
              const next = event.target.value
              // 只接受符合字段正则的值。`<input type="time">` 在部分平台上
              // 允许空串与越界值，这道判断是必要的第二道闸。
              if (!HHMM.test(next)) return
              onCommit(next, end)
            }}
          />
        </label>
        <span className="scene__time-dash" aria-hidden="true">—</span>
        <label className="scene__time">
          <span className="scene__time-label">终点</span>
          <input
            type="time"
            className="scene__time-input"
            value={end}
            aria-label={`${item.name}终点`}
            onChange={(event) => {
              const next = event.target.value
              if (!HHMM.test(next)) return
              onCommit(start, next)
            }}
          />
        </label>
      </div>

      {/* 跨零点这件事必须写出来：横轴上是两段，不说明会让人以为设错了。 */}
      {startMin > endMin ? (
        <p className="scene__note">跨零点：{toLabel(startMin)} 到次日 {toLabel(endMin)}</p>
      ) : null}
    </div>
  )
}

/**
 * 预演区块。
 *
 * ## 四条交互细则（不做就等于没做）
 *
 * 1. 首次不展开，用户动过控件后才展开；
 * 2. 300ms 内不给加载态——这里的预演是同步的本地计算，根本不会有
 *    300ms 以上的等待，所以「重算中」这个状态在实现上**不可能出现**。
 *    保留一个永远不显示的加载态是死代码，故不写；
 * 3. 算不出来要说原因，不留空白（由各 `preview` 函数自己返回那句话）；
 * 4. 底部固定一句免责声明——预演用的是本地规则，不是她会说的话。
 */
function PreviewBlock({
  item,
  values,
  revealed,
}: {
  item: SceneItem
  values: SceneValues
  revealed: boolean
}): React.JSX.Element | null {
  const text = useMemo(() => (item.preview === undefined ? undefined : item.preview(values)), [item, values])
  if (!revealed || text === undefined) return null

  return (
    <div className="scene__preview">
      <p className="scene__preview-text">{text}</p>
      <p className="scene__preview-note">示例只演参数的影响，不是她会说的话</p>
    </div>
  )
}

/** 渲染场景层。 */
export function SceneLayer({
  sections,
  user,
  onWrite,
}: SceneLayerProps): React.JSX.Element {
  /** 本次打开以来动过的项 id。用来决定预演区块是否展开。 */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())

  const markTouched = useCallback((id: string): void => {
    setTouched((previous) => {
      if (previous.has(id)) return previous
      const next = new Set(previous)
      next.add(id)
      return next
    })
  }, [])

  /** 供预演读取的完整取值表：用户层覆盖默认值，与界面显示同一套规则。 */
  const values = useMemo<SceneValues>(() => {
    const merged: SceneValues = {}
    for (const item of SCENE_ITEMS) {
      const state = resolveScene(item, sections, user)
      merged[item.section] = {
        ...merged[item.section],
        [item.key]: state.value,
        ...(item.keyEnd === undefined ? {} : { [item.keyEnd]: state.endValue }),
      }
    }
    return merged
  }, [sections, user])

  return (
    <div className="settings__scene">
      <ul className="scene__list">
        {SCENE_ITEMS.map((item) => {
          const state = resolveScene(item, sections, user)
          const missing = state.field === undefined

          const commit = (value: unknown, endValue?: unknown): void => {
            markTouched(item.id)
            for (const write of writesFor(item, value, endValue)) {
              void onWrite(write.section, write.key, write.value)
            }
          }

          return (
            <li className="scene__item" key={item.id} data-missing={missing ? '' : undefined}>
              <div className="scene__head">
                <span className="scene__name">{item.name}</span>
                {item.control === 'boolean' ? (
                  <SwitchControl item={item} state={state} onCommit={(value) => { commit(value) }} />
                ) : null}
              </div>

              {item.control === 'number' || item.control === 'number-anchored' ? (
                <NumberControl item={item} state={state} onCommit={(value) => { commit(value) }} />
              ) : null}

              {item.control === 'enum' ? (
                <EnumControl item={item} state={state} onCommit={(value) => { commit(value) }} />
              ) : null}

              {item.control === 'range-time' ? (
                <TimeRangeControl item={item} state={state} onCommit={(start, end) => { commit(start, end) }} />
              ) : null}

              {item.hint === undefined ? null : <p className="scene__hint">{item.hint}</p>}
              {missing
                ? <p className="scene__hint scene__hint--warn">这个插件没有装载，改不了它的参数</p>
                : <p className="scene__meta">{metaLine(item, state)}</p>}

              <PreviewBlock item={item} values={values} revealed={touched.has(item.id)} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
