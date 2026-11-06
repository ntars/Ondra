/**
 * 右栏：TA 的状态。
 *
 * ## 四张卡片
 *
 * 1. **此刻** —— 心情、精力两条指标条
 * 2. **TA 对你** —— 关系读数，没有数据时给一句引导
 * 3. **记得的事** —— 最近记下的要点
 * 4. **桌宠** —— 一个动作入口
 *
 * ## 结构以原版为准
 *
 * 这一栏的每个类名、每档字号、每处间距都对着原版的运行时 CSS 抄：
 * `R_gE1G_*` 共 29 个类，容器 `padding: 12px` / `gap: 10px`，
 * 卡片 `padding: 12px 14px` / `gap: 8px` / `radius: 16px`。
 *
 * 我此前在这里自创了「称谓 + 相处 N 天 · 说过 N 轮话」两行，
 * 原版 CSS 里根本没有对应的类——那是我按"这一栏该有这些信息"的
 * 想象补的，不是复刻。原版有数据时也只是把 `empty` 换成 `summary`
 * 与若干条 `meter`，不加任何新元素。
 *
 * ## 为什么指标是横条不是环
 *
 * 这一栏在最小窗口下只有约 203px 宽。环形要看出差异需要足够直径，
 * 在这里会小到看不出 30% 与 60% 的区别；横条靠长度表达比例，
 * 同样的宽度下差异清楚得多。
 *
 * ## 数据为空时说什么
 *
 * 每张卡都有自己的空文案，而且都是"下一步该做什么"式的引导
 * （"聊两句 TA 就有了"），不是干巴巴的"暂无数据"。
 * 这一栏在会话刚开始时必然是空的，此时它仍然要显得有用。
 *
 * ## 数值与空文案不能同时出现
 *
 * 心情、精力读数为 0 表示"还没有心跳数据"，此时只出空文案，
 * 不出两条 0% 的横条——那是把"没有数据"画成"数据是零"。
 */

import { useEffect, useState } from 'react'
import { CatIcon } from './icons.tsx'

/** 「此刻」的情绪读数。全 0 表示还没有测到。 */
export interface MoodState {
  /** 心情，0–100。 */
  mood: number
  /** 精力，0–100。 */
  energy: number
  /** 情绪的六个字标签。空字符串表示还没有数据。 */
  label?: string
  /** 一句概括。空字符串表示还没有数据。 */
  summary?: string
}

/**
 * 「TA 对你」的读数。
 *
 * 只有五个关系维度与一个阶段标签，**没有称谓、没有相处天数**。
 * 原版的 `EMPTY` 形状就是 `{ stage, relation }` 两项；
 * 我此前自己加了 `nickname` / `days` / `turns` 并渲染成两行文字，
 * 原版 CSS 里连对应的类都不存在——那是按"这一栏该有什么"的想象补的。
 */
export interface BondStats {
  /** 关系阶段。空字符串表示还没有数据。 */
  stage?: string
  /** 五个关系维度。空数组表示还没有读数。 */
  dimensions?: Array<{ key: string; label: string; value: number }>
}

/** 一条记忆。 */
export interface MemoryItem {
  id: string
  /** 记忆正文。 */
  summary: string
  /** 相对时间，如「3 小时前」。 */
  relative: string
}

/** 组件属性。 */
export interface CompanionProps {
  mood: MoodState
  bond: BondStats
  /** 记得的事。可能为空。 */
  memories: MemoryItem[]
  /** 状态块的更新时间戳。 */
  updatedAt: number
  /** 桌宠是否已启动。 */
  petRunning?: boolean
  /** 叫出桌宠。 */
  onSummonPet(): void
}

/** 把时间戳转成「刚刚更新 / N 分钟前更新」。 */
function updatedLabel(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minute = 60_000
  if (diff < minute) return '刚刚更新'
  if (diff < 60 * minute) return `${String(Math.floor(diff / minute))} 分钟前更新`
  return `${String(Math.floor(diff / (60 * minute)))} 小时前更新`
}

/**
 * 一条横条指标。
 *
 * 三列 grid：标签 28px、轨道自适应、读数 20px。
 * 标签列固定宽度让所有轨道起点对齐，扫视时才能横向比较长度。
 */
function Meter(props: { label: string; value: number }): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, props.value))
  return (
    <div className="meter">
      <span className="meter__label">{props.label}</span>
      <span
        className="meter__track"
        role="meter"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={props.label}
      >
        <span className="meter__fill" style={{ inlineSize: `${String(clamped)}%` }} />
      </span>
      <span className="meter__value">{Math.round(clamped)}</span>
    </div>
  )
}

/** 卡片外壳。卡片头是它唯一的装饰。 */
function Card(
  { title, aside, children }: {
    title: string
    aside?: React.ReactNode
    children: React.ReactNode
  },
): React.JSX.Element {
  return (
    <section className="card">
      <header className="card__head">
        <h2 className="card__title">{title}</h2>
        {aside === undefined ? null : <div className="card__aside">{aside}</div>}
      </header>
      {children}
    </section>
  )
}

/** 渲染右栏。 */
export function Companion(props: CompanionProps): React.JSX.Element {
  // 「刚刚更新」需要随时间推移变化。每 60 秒刷一次就够了——
  // 更密的定时器只会产生无意义的重渲染。
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => { setTick((value) => value + 1) }, 60_000)
    return () => { window.clearInterval(timer) }
  }, [])
  // tick 只用于触发重渲染，读取时间戳时要用最新值。
  void tick

  const moodKnown = props.mood.summary !== undefined && props.mood.summary !== ''
  const relation = props.bond.dimensions ?? []

  return (
    <aside className="companion scroller">
      {/* --- 页头 ------------------------------------------------- */}
      {/*
        右栏页头也是拖拽区。

        三栏的顶部都在同一条水平线上，用户不会先判断"这是哪一栏"
        再决定能不能拖。只要他在窗口顶部那片区域按下，就应该能拖。
        原版右栏这块同样挂着 `data-window-drag`。
      */}
      <header className="companion__head" data-tauri-drag-region="deep">
        <h1 className="companion__title">TA 的状态</h1>
        <span className="companion__stamp">{updatedLabel(props.updatedAt)}</span>
      </header>

      {/* --- 此刻 ------------------------------------------------- */}
      <Card
        title="此刻"
        {...(props.mood.label === undefined || props.mood.label === ''
          ? {}
          : { aside: <span className="card__chip">{props.mood.label}</span> })}
      >
        {/* 有数据出概括、没数据出引导语，二者互斥；但两条指标条**始终**都在。
            原版就是这样：没有心跳时它们渲染成 0%。
            我先前以为"没数据还画 0% 的条"是矛盾，把条删了——
            但原版留着它，因为它表达的是"这两项会被测量，只是还没测到"，
            删掉会让人不知道这一栏将来看什么。 */}
        {moodKnown ? (
          <p className="card__summary">{props.mood.summary}</p>
        ) : (
          <p className="card__empty">还没有心跳数据，聊两句 TA 就有了</p>
        )}
        <Meter label="心情" value={props.mood.mood} />
        <Meter label="精力" value={props.mood.energy} />
      </Card>

      {/* --- TA 对你 ---------------------------------------------- */}
      <Card
        title="TA 对你"
        {...(props.bond.stage === undefined || props.bond.stage === ''
          ? {}
          : { aside: <span className="card__chipQuiet">{props.bond.stage}</span> })}
      >
        {/* 没有读数时出一条引导语，有读数时换成五个维度的横条。
            这里没有称谓、没有相处天数——原版没有这两样。 */}
        {relation.length === 0 ? (
          <p className="card__empty">还没有关系读数，先从一句话开始</p>
        ) : (
          relation.map((dimension) => (
            <Meter key={dimension.key} label={dimension.label} value={dimension.value} />
          ))
        )}
        <p className="card__note">数值会随对话缓慢变化，可在设置里查看与调整</p>
      </Card>

      {/* --- 记得的事 --------------------------------------------- */}
      <Card
        title="记得的事"
        aside={<button type="button" className="link">全部</button>}
      >
        {props.memories.length === 0 ? (
          <p className="card__empty">暂无记忆</p>
        ) : (
          <ul className="memory-list">
            {props.memories.map((memory) => (
              <li key={memory.id} className="memory-list__item">
                <span className="memory-list__text">{memory.summary}</span>
                <span className="memory-list__time">{memory.relative}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* --- 桌宠 ------------------------------------------------- */}
      <Card
        title="桌宠"
        aside={
          <span className="card__chipQuiet">
            {props.petRunning === true ? '运行中' : '未启动'}
          </span>
        }
      >
        <div className="pet">
          <span className="pet__mark" aria-hidden>
            <CatIcon size={26} />
          </span>
          <p className="pet__hint">让 TA 待在桌面，会跟着情绪活动</p>
          <button type="button" className="pet__button" onClick={props.onSummonPet}>
            叫出 TA
          </button>
        </div>
      </Card>
    </aside>
  )
}
