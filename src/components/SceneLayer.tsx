/**
 * 设置·场景层。
 *
 * ## 这一层只做一件事：把 13 个真实旋钮讲成人话
 *
 * 1116 个字段里，普通用户真正会调的是这 13 个。每项一行：左边名字、
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
import { stepOf } from '../lib/numberStep.ts'
import type { SceneItem, SceneState, SceneValues } from '../lib/scenes.ts'
import { SCENE_ITEMS, resolveScene, writesFor } from '../lib/scenes.ts'
import type { SettingsSection } from '../lib/settingTypes.ts'

/** 场景层要用的宿主数据。 */
export interface SceneLayerProps {
  sections: SettingsSection[]
  user: SceneValues
  /** 写一个字段。`undefined` 表示恢复默认。 */
  onWrite(section: string, key: string, value: unknown): Promise<void>
  /**
   * 只渲染这些段下的场景项。
   *
   * ## 为什么需要按段过滤
   *
   * 12 个场景项原先全在「扩展功能」的场景层里，而其中 10 项对应的段已经
   * 上移到「人物设定」与「通用」。用户在新页面看到「记忆保留与容量」的
   * 十几个原始字段，却在扩展功能里另有一个叫「记忆保留深度」的滑杆——
   * 两者改的是同一个键，出现在两个页面。
   *
   * 过滤之后每个场景项只在自己的归属页出现：日常旋钮（带预演）在专门页
   * 的顶部，完整字段在它下面的「更多设置」里，扩展功能只剩真正底层的段。
   *
   * 不传表示全部渲染（向后兼容，测试里也用它一次渲染全部）。
   */
  only?: ReadonlySet<string>
}

/**
 * 「已改」标记 + 恢复默认。
 *
 * ## 为什么不再显示「当前值 · 默认值」
 *
 * 上一版这行是 `metaLine()`，写成 `5 · 默认 3 · 已改`。它把三个数字
 * 并排摆出来，而这一层的控制件（滑杆、开关、分段）**已经显示了当前值**
 * ——滑杆的填充比例、开关的开合、分段的选中项，都是当前值的视觉表达。
 * 再写一遍数字是重复；再补一个默认值，则是把「用户不需要知道、但会
 * 拿来比较」的内部状态摊在眼前。
 *
 * 用户的反馈很直接：**原始数值无需展示，给一个恢复默认就行**。
 *
 * 所以这里只保留两件事：
 * - 改过 → 显示一个「恢复默认」按钮（没改过时不显示，避免一排灰按钮）；
 * - 没改过 → 什么都不显示（空 `<p>` 会占一行高度，所以整行条件渲染）。
 *
 * 「改过」这个状态本身仍要说出来——它是用户唯一需要知道的事，且
 * 按钮的存在本身就承载了这个信息（有按钮 = 改过）。
 */
function RestoreRow({
  state,
  onRestore,
}: {
  state: SceneState
  onRestore(): void
}): React.JSX.Element | null {
  if (!state.changed) return null
  return (
    <p className="scene__meta">
      <button type="button" className="scene__restore" onClick={onRestore}>
        恢复默认
      </button>
    </p>
  )
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

  /*
   * 已填充比例（§12.16「左起至滑块」）。
   *
   * 轨道本身只有一条背景，无法分段着色，所以填充画在元素自己的
   * `linear-gradient` 上，由这个百分比切成两段。`max === min` 时除零，
   * 退到 0——那种字段在界面上不该出现滑杆，但真出现了也不该崩。
   */
  const fill = max > min ? `${String(((draft - min) / (max - min)) * 100)}%` : '0%'

  /*
   * 单位。空串表示这个数字没有量纲（极少数），此时不渲染也不拼进
   * `aria-valuetext`——拼一个空的会让读屏多念一次停顿。
   */
  const unit = item.unit ?? ''

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
        className="scene__range control-range"
        type="range"
        min={min}
        max={max}
        /*
         * 步长按字段自己的取值范围推导，不写死 1。
         *
         * 场景层这 13 项目前全是整数（天 / 分钟 / 字 / 轮），写 1 看着没问题
         * ——但它是**按当前数据碰巧成立**，不是判据。一旦某项改成概率或
         * 温度（0–1 区间），`step="1"` 会把 0.8 静默吸附成 1。同一份
         * 推导写在 `numberStep.ts`，模块层与场景层共用一处，两处不会分叉。
         */
        step={stepOf(min, max, field?.default)}
        value={draft}
        aria-label={item.name}
        /*
         * 单位必须进 `aria-valuetext`。
         *
         * 读屏读滑杆时只会念这个字段，不会去念旁边的视觉读数。裸数字
         * 「30」在听觉上完全没有量纲，用户无从判断是 30 天还是 30 条。
         * 视觉读数与这里共用同一个 `unit`（`scenes.ts`），两处不会漂。
         *
         * 百分号不空格：「50 %」在中文排版里是错的，它紧贴数字读作
         * 「百分之五十」。其余单位（天、分钟、字）按词处理，要空格。
         */
        aria-valuetext={
          unit === ''
            ? String(draft)
            : unit === '%'
              ? `${String(draft)}%`
              : `${String(draft)} ${unit}`
        }
        /* 已填充比例交给 CSS 画（见 `controls.css` 的 `.control-range`）。 */
        style={{ '--fill': fill } as React.CSSProperties}
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
        <span className="scene__number">
          {draft}
          {unit === '' ? null : <span className="scene__unit">{unit}</span>}
        </span>
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
    <div className="scene__segments control-segments" role="group" aria-label={item.name}>
      {values.map((value) => {
        const label = item.options?.find((option) => option.value === value)?.label ?? value
        return (
          <button
            key={value}
            type="button"
            className="scene__segment control-segment"
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
      className="scene__switch control-switch"
      role="switch"
      aria-checked={on}
      aria-label={item.name}
      onClick={() => { onCommit(!on) }}
    >
      <span className="scene__switch-knob control-switch-knob" />
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
      <p className="scene__preview-note">示例仅演示参数影响，不代表实际回复</p>
    </div>
  )
}

/** 渲染场景层。 */
export function SceneLayer({
  sections,
  user,
  onWrite,
  only,
}: SceneLayerProps): React.JSX.Element {
  /** 实际要渲染的场景项。`only` 缺省时是全部。 */
  const items = useMemo(
    () => (only === undefined ? SCENE_ITEMS : SCENE_ITEMS.filter((item) => only.has(item.section))),
    [only],
  )
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
    for (const item of items) {
      const state = resolveScene(item, sections, user)
      merged[item.section] = {
        ...merged[item.section],
        [item.key]: state.value,
        ...(item.keyEnd === undefined ? {} : { [item.keyEnd]: state.endValue }),
      }
    }
    return merged
  }, [sections, user, items])

  /* 这一页没有属于它的场景项时整块不渲染，不留一个空列表。 */
  if (items.length === 0) return <></>

  return (
    <div className="settings__scene">
      <ul className="scene__list">
        {items.map((item) => {
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
                : (
                  <RestoreRow
                    state={state}
                    onRestore={() => {
                      /*
                       * 恢复默认 = 把值写回插件声明的 `default`。
                       *
                       * 不删用户层那条覆盖记录，而是**写一个等于默认值的新值**：
                       * 写入接口只有「设成某个值」这一个动作，没有「删掉覆盖」
                       * ——后者要让宿主与内核都理解「这个键不存在」，牵扯到
                       * 四层合并的语义。写回默认值在观感上等价（界面显示的就是
                       * 默认值），代价只是配置里多一条与默认相同的记录。
                       *
                       * 区间项（作息）要连终点一起恢复，否则只恢复了起点，
                       * 区间会变成「默认起点 + 用户终点」这种半恢复状态。
                       */
                      commit(state.fallback, state.endField?.default)
                    }}
                  />
                )}

              <PreviewBlock item={item} values={values} revealed={touched.has(item.id)} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
