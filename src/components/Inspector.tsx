/**
 * 侧写检查器（Inspector）。
 *
 * ## 内容顺序固定，不可重排
 *
 * §5.8 定死四段：此刻 → 她对你 → 记得的事 → 她此刻在做什么。
 * 这个顺序不是审美选择，是**从近到远**的认知顺序：先看现在什么样，
 * 再看关系，再看历史，最后看她正在干什么。
 *
 * ## 四段各自的空状态不一样
 *
 * §12.5 要求空状态用引导句。这里的四段有四句不同的话，不能共用一句
 * 「暂无数据」——那等于什么都没说。
 *
 * ## 坐标按 §5.8 的表落地
 *
 * 面板宽 300，内边距 16，于是：标签左对齐 480（= 464 + 16），
 * 轨道起点 576（距面板左 112），轨道宽 100，读数右对齐 748（距右 16）。
 * 这些数在 CSS 里用 `--inspector-*` 局部变量表达，避免在样式里散落魔术数。
 */

import { Icon } from './Icon.tsx'
import { IconClose } from './icons.ts'
import type { BondStats, MemoryItem, MoodState } from '../lib/types.ts'

/** 一条双极轨道的读数，`value` 落 −1..1。 */
interface Dial {
  key: string
  label: string
  /** −1..1。 */
  value: number
  /** 读数文案，如 `+0.30`。 */
  text: string
}

/**
 * 把 −1..1 的数写成带符号的两位小数。
 *
 * 统一两位小数而不是按需截断：一列读数的小数位不一致时，
 * 小数点对不齐，扫视会一顿一顿的（§5.8 要求 `tabular-nums` 也是同一原因）。
 */
function signed(value: number): string {
  const fixed = value.toFixed(2)
  return value > 0 ? `+${fixed}` : fixed
}

export interface InspectorProps {
  /** 此刻：心情、精力、张力。 */
  mood: MoodState
  /** 「她对你」的阶段与维度。 */
  bond: BondStats
  /** 记得的事，取最近 3 条。 */
  memories: MemoryItem[]
  /** 她此刻在做什么的一行状态。空串表示没有。 */
  activity: string
  /** 张力读数，−1..1。没有数据时 undefined。 */
  tension: number | undefined
  /** 是否有真实读数。false 时全部分组显示引导句。 */
  hasData: boolean
  /** 关闭。 */
  onClose(): void
}

/**
 * 渲染检查器。
 *
 * 面板本身是 `dialog` 语义（§10 的 aria 表：抽屉 `role="dialog"` +
 * `aria-modal="true"`）。但检查器**不是模态**——它覆盖主列右侧，
 * 主列仍可滚动、Rail 仍可点。所以用 `role="dialog"` 但**不给**
 * `aria-modal`：给了会让读屏把背后内容整个屏蔽，而用户其实还能操作它们。
 */
export function Inspector({
  mood,
  bond,
  memories,
  activity,
  tension,
  hasData,
  onClose,
}: InspectorProps): React.JSX.Element {
  /**
   * 双极轨道。心情与张力都是 −1..1 的对称量，精力是 0..1 的单极量。
   *
   * 心情从 0–100 映射到 −1..1：中点 50 是「平静」。
   */
  const dials: Dial[] = [
    { key: 'mood', label: '心情', value: (mood.mood - 50) / 50, text: signed((mood.mood - 50) / 50) },
    { key: 'tension', label: '张力', value: tension ?? 0, text: signed(tension ?? 0) },
  ]

  return (
    <aside className="inspector" role="dialog" aria-label="侧写">
      <header className="inspector__head">
        <h2 className="inspector__title">侧写</h2>
        <button type="button" className="inspector__close" aria-label="关闭侧写" onClick={onClose}>
          <Icon icon={IconClose} size={16} />
        </button>
      </header>

      <div className="inspector__body">
        {/* --- 此刻 ------------------------------------------------- */}
        <section className="inspector__group">
          <h3 className="inspector__caption">此刻</h3>
          {hasData ? (
            <>
              {dials.map((dial) => (
                <div className="inspector__row" key={dial.key}>
                  <span className="inspector__label">{dial.label}</span>
                  <span className="inspector__track" aria-hidden="true">
                    {/* 双极：负值从中点向左填，正值向右。 */}
                    <span
                      className="inspector__fill inspector__fill--bipolar"
                      style={{
                        transform: `scaleX(${String(Math.abs(dial.value))})`,
                        transformOrigin: dial.value < 0 ? 'right center' : 'left center',
                        left: dial.value < 0 ? 'auto' : '50%',
                        right: dial.value < 0 ? '50%' : 'auto',
                      }}
                    />
                  </span>
                  <span className="inspector__value">{dial.text}</span>
                </div>
              ))}
              {/* 精力是单极量，单独一行，避免与双极轨道共用同一套刻度。 */}
              <div className="inspector__row">
                <span className="inspector__label">精力</span>
                <span className="inspector__track" aria-hidden="true">
                  <span
                    className="inspector__fill"
                    style={{ transform: `scaleX(${String(Math.min(1, Math.max(0, mood.energy / 100)))})` }}
                  />
                </span>
                <span className="inspector__value">{mood.energy.toFixed(2)}</span>
              </div>
            </>
          ) : (
            <p className="inspector__empty">还没测到</p>
          )}
        </section>

        {/* --- 她对你 ----------------------------------------------- */}
        <section className="inspector__group">
          <h3 className="inspector__caption">她对你</h3>
          {bond.stage === undefined || bond.stage === '' ? (
            <p className="inspector__empty">聊两句就有了</p>
          ) : (
            <>
              <p className="inspector__stage">{bond.stage}</p>
              {(bond.dimensions ?? []).map((dimension) => (
                <div className="inspector__row" key={dimension.key}>
                  <span className="inspector__label">{dimension.label}</span>
                  <span className="inspector__track" aria-hidden="true">
                    <span
                      className="inspector__fill"
                      style={{ transform: `scaleX(${String(Math.min(1, Math.max(0, dimension.value)))})` }}
                    />
                  </span>
                  <span className="inspector__value">{Math.round(dimension.value * 100)}</span>
                </div>
              ))}
            </>
          )}
        </section>

        {/* --- 记得的事 --------------------------------------------- */}
        <section className="inspector__group">
          <h3 className="inspector__caption">记得的事</h3>
          {memories.length === 0 ? (
            <p className="inspector__empty">聊两句就有了</p>
          ) : (
            <ul className="inspector__memories">
              {memories.slice(0, 3).map((memory) => (
                <li className="inspector__memory" key={memory.id}>
                  <span className="inspector__memory-text">{memory.summary}</span>
                  <span className="inspector__memory-time">{memory.relative}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- 她此刻在做什么 --------------------------------------- */}
        <section className="inspector__group">
          <h3 className="inspector__caption">她此刻在做什么</h3>
          <p className="inspector__activity">{activity === '' ? '安静待着' : activity}</p>
        </section>
      </div>
    </aside>
  )
}
