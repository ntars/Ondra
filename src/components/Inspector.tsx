/**
 * 侧写检查器（Inspector）。
 *
 * ## 内容顺序固定，不可重排
 *
 * §5.8 定死四段：此刻 → 关系阶段 → 记得的事 → 当前活动。
 * 这个顺序不是审美选择，是**从近到远**的认知顺序：先看现在什么样，
 * 再看关系，再看历史，最后看她正在干什么。
 *
 * ## 四段各自的空状态不一样
 *
 * §12.5 要求空状态用引导句。这里的四段有四句不同的话，不能共用一句
 * 「暂无数据」——那等于什么都没说。
 *
 * ## 坐标以 CSS 变量为真源
 *
 * 面板宽由 `tokens.css` 的 `--w-inspector`（300）定值；标签、轨道、读数
 * 的位置在样式里用 `--inspector-*` 局部变量表达，避免在样式里散落魔术数。
 * 注释里不写死像素坐标——窗口宽度一改，写死的数就会悄悄过期。
 */

import { Icon } from './Icon.tsx'
import { IconClose } from './icons.ts'
import { MemoryHealthBlock } from './MemoryHealth.tsx'
import { DreamBlock } from './DreamBlock.tsx'
import { SnapshotBlock } from './SnapshotBlock.tsx'
import { useRestoreFocus } from '../lib/useRestoreFocus.ts'
import type { BondStats, MemoryItem, MoodState } from '../lib/types.ts'

/**
 * 把 −1..1 的数写成带符号的两位小数。
 * 统一两位小数而不是按需截断：一列读数的小数位不一致时，
 * 小数点对不齐，扫视会一顿一顿的（§5.8 要求 `tabular-nums` 也是同一原因）。
 */
function signed(value: number): string {
  const fixed = value.toFixed(2)
  return value > 0 ? `+${fixed}` : fixed
}

/**
 * 一条双极轨道的三种状态。
 *
 * ## 为什么不能只留「有值 / 没值」两种
 *
 * 张力这一路现在**恒为 `undefined`**（`App.tsx` 传 `tension={undefined}`，
 * 后端还没给这个数）。原来的写法是 `tension ?? 0` + `signed(...)`，
 * 于是空态渲染成 **`+0.00`**——一个看起来精确、实际是编的读数。
 *
 * 「张力刚好在正中间」和「张力根本没测到」是两件完全不同的事，
 * 画成一样就是撒谎。心情那一档同理：`mood.mood` 在无数据时是占位值，
 * 映射出的 `−1.00` 也不是真的。
 *
 * 所以三个状态必须分开：
 *
 * - `value` 有数 → 画轨道、给读数；
 * - `value` 是 `undefined` → **整行不出现**（不是画成 0）；
 * - 整体 `hasData` 为 false → 整组显示引导句。
 */
interface Dial {
  key: string
  label: string
  /** −1..1。undefined 表示这一路没有数据。 */
  value: number | undefined
}

export interface InspectorProps {
  /** 此刻：心情、精力、张力。 */
  mood: MoodState
  /** 「关系阶段」的阶段与维度。 */
  bond: BondStats
  /** 记得的事，取最近 3 条。 */
  memories: MemoryItem[]
  /**
   * 记忆读不到的原因码。undefined 表示读取正常。
   *
   * 检查器与抽屉共用同一个数据源，所以也要能区分「读不到」与「确实为空」：
   * 两处对同一件事给出不同说法，是最容易被当成 bug 的那种不一致。
   */
  memoryFault: string | undefined
  /** 「当前活动」的一行状态。空串表示没有。 */
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
  memoryFault,
  activity,
  tension,
  hasData,
  onClose,
}: InspectorProps): React.JSX.Element {
  /*
   * 关闭时把焦点还给触发它的 Spine 按钮（§9.5「关闭浮层 → 回到触发元素」）。
   *
   * 检查器是条件渲染的（`App` 里 `inspector ? <Inspector/> : null`），
   * 所以这里恒传 `true`：挂载即打开，卸载即关闭，钩子的清理函数
   * 正好在卸载时跑。
   */
  useRestoreFocus(true)

  /**
   * 双极轨道。心情与张力都是 −1..1 的对称量，精力是 0..1 的单极量。
   *
   * 心情从 0–100 映射到 −1..1：中点 50 是「平静」。
   *
   * ## `hasData` 与 `tension` 各自管各自的
   *
   * `hasData` 为 false 时整组走引导句，此时不该构造出任何数——所以整个
   * `dials` 数组只在有数据时才建。而 `tension` 是另一层：即便有数据，
   * 它也**可能这一路没有感知值**（现在恒为 `undefined`）。那就不渲染这一行，
   * 而不是拿 0 顶上。
   */
  const dials: Dial[] = hasData
    ? [
        { key: 'mood', label: '心情', value: (mood.mood - 50) / 50 },
        { key: 'tension', label: '张力', value: tension },
      ]
    : []

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
              {dials.map((dial) =>
                dial.value === undefined ? null : (
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
                    <span className="inspector__value">{signed(dial.value)}</span>
                  </div>
                ),
              )}
              {/* 精力是单极量，单独一行，避免与双极轨道共用同一套刻度。 */}
              <div className="inspector__row">
                <span className="inspector__label">精力</span>
                <span className="inspector__track" aria-hidden="true">
                  <span
                    className="inspector__fill"
                    style={{ transform: `scaleX(${String(Math.min(1, Math.max(0, mood.energy / 100)))})` }}
                  />
                </span>
                <span className="inspector__value">{(mood.energy / 100).toFixed(2)}</span>
              </div>
            </>
          ) : (
            <p className="inspector__empty">尚未测量</p>
          )}
        </section>

        {/* --- 关系阶段 --------------------------------------------- */}
        <section className="inspector__group">
          <h3 className="inspector__caption">关系阶段</h3>
          {bond.stage === undefined || bond.stage === '' ? (
            <p className="inspector__empty">暂无记录，对话后生成</p>
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
            <p className="inspector__empty">
              {memoryFault === undefined
                ? '暂无记录，对话后生成'
                : memoryFault === 'list-failed' ? '暂时无法读取' : '尚未连接'}
            </p>
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

        {/* --- 当前活动 --------------------------------------------- */}
        <section className="inspector__group">
          <h3 className="inspector__caption">当前活动</h3>
          <p className="inspector__activity">{activity === '' ? '空闲' : activity}</p>
        </section>

        {/*
          --- 记忆维护 ------------------------------------------------

          ## 为什么这些块搬到了检查器里

          左栏改成「会话 / 日志 / 扩展」之后，原来的记忆抽屉不存在了，而
          记忆体检、做梦、快照这三块是**唯一能修她的记忆的入口**，不能跟着
          抽屉一起丢掉。它们属于「她的记忆」，而检查器正是看记忆详情的地方
          （上面那段「记得的事」）。

          ## 为什么默认收起

          §5.8 的四段顺序（此刻 → 关系阶段 → 记得的事 → 当前活动）是
          固定的，这三块不属于那四段。折叠起来，它们不打断阅读；需要时点开
          就能用。三块内部顺序按可逆性排：体检（无损）→ 做梦（写事实，
          不可逆）→ 快照（只读）。
        */}
        <section className="inspector__group">
          <details className="inspector__fold">
            <summary className="inspector__fold-head">记忆维护</summary>
            <div className="inspector__fold-body">
              <MemoryHealthBlock />
              <DreamBlock />
              <SnapshotBlock />
            </div>
          </details>
        </section>
      </div>

      {/*
       * 这里曾经有一个底栏，装一个「全部设置」按钮。
       *
       * 删掉的理由不是它不好看，是它**已经重复**：设置合并成一个面板之后，
       * 那个按钮和 Rail 底部的齿轮打开的是同一个 `.settings`，只差落在哪一页
       * （外观 / 插件参数）。一站之内两个「设置」入口，用户看到的是两次同样的
       * 动作，却要猜它们是不是同一处——这正是合并设置要消掉的那种猜疑。
       *
       * 插件参数仍然可达：Rail 齿轮 → 左侧导航「插件参数」，或扩展抽屉里
       * 某个包的「配置」直接定位到那一段。后者是**上下文入口**，不是第二个
       * 总入口，所以留着。
       */}
    </aside>
  )
}
