/**
 * 手机顶栏（TopBar，§10.3）。
 *
 * ## 它与 TitleBar 的关系
 *
 * 两者语义相同——左入口 / 中标题 / 右状态，但**实现不同**：
 *
 * | | TitleBar | TopBar |
 * | --- | --- | --- |
 * | 适用 | 电脑三端（≥ 600 内容宽） | compact（< 600） |
 * | 左 | 红绿灯让位 / 菜单按钮 | 汉堡，点开全屏抽屉 |
 * | 中 | 44 高、14px | 48 + 安全区、14px、最大宽 180 |
 * | 右 | 窗口三键 | 8px 状态点，点开全屏检查器 |
 * | 拖拽 | 有（`data-tauri-drag-region`） | **无**（移动端没有窗口） |
 *
 * 高度 48 而不是 44：触屏需要更大的热区，且 48 + 安全区正好覆盖
 * iOS 的状态栏高度（44 会让顶栏压在灵动岛下面）。
 *
 * ## 为什么两个都渲染、由 CSS 决定谁可见
 *
 * 用 JS 读容器宽度会多一次测量、多一帧延迟，窗口从 700 拖到 560 时
 * 会先渲染错的顶栏再换。CSS 容器查询在同一个帧里完成切换。
 * 代价是两个组件都挂载——TitleBar 在手机上只是一个空 `<header>`，
 * 不跑任何逻辑；TopBar 在电脑上同理。
 *
 * ## 水位为什么变成 2px 横线
 *
 * §10.3 的答案：手机上右脊整个消失，水位没地方立着。改成贴在顶栏
 * 下沿的一条横线——高度=精力，颜色=心情，长度满宽。它绝对定位、
 * **不占布局高度**，覆盖在分隔线上，所以顶栏仍是 48。
 *
 * 这条横线是「信息不丢」的关键：手机上用户仍然随时看得见她的状态，
 * 而不必点开任何东西。颜色仍不单独承载信息——状态点的 `aria-label`
 * 与检查器里的文字读数说的是同一件事。
 */

import { Icon } from './Icon.tsx'
import { IconPanelLeft } from './icons.ts'
import { energyRatio, moodWord, waterColor } from '../lib/moodColor.ts'
import { useResolvedTheme } from '../lib/useResolvedTheme.ts'

export interface TopBarProps {
  /** 居中标题。空串表示不显示（首页）。 */
  title: string
  /** 心情，0–100。决定水位线与状态点的颜色。 */
  mood: number
  /** 精力，0–100。决定水位线与状态点的长度。 */
  energy: number
  /** 是否有真实读数。false 时水位线不画、状态点用中性色。 */
  hasData: boolean
  /** 是否休息态。压到 15%。 */
  resting: boolean
  /** 点汉堡：展开全屏抽屉。 */
  onOpenDrawer(): void
  /** 点状态点：展开全屏检查器。 */
  onOpenInspector(): void
}

/**
 * 渲染手机顶栏。
 *
 * 汉堡与状态点都是 `<button>` 而不是 `div` + 内部按钮：热区 44 由按钮
 * 自己撑开，读屏各念一句。两个按钮之间夹一个 `flex: 1` 的标题，
 * 这样标题的居中是「剩余空间的中点」而不是全宽中点——
 * 手机上两侧按钮等宽（44），两种算法结果相同，但用 flex 更少一处
 * 硬编码的 44。
 */
export function TopBar({
  title,
  mood,
  energy,
  hasData,
  resting,
  onOpenDrawer,
  onOpenInspector,
}: TopBarProps): React.JSX.Element {
  const dark = useResolvedTheme() === 'dark'
  const ratio = energyRatio(energy, hasData, resting)
  const color = waterColor(mood, dark)

  return (
    <header className="topbar">
      <button type="button" className="topbar__hit" aria-label="打开抽屉" onClick={onOpenDrawer}>
        <Icon icon={IconPanelLeft} size={20} />
      </button>

      {/*
        标题最大宽 180（§10.3）。超出省略：手机顶栏两侧已被按钮占掉 88，
        820 宽的 iPad 分屏里若标题不封顶，它会挤成一条细缝。
      */}
      {title === '' ? <span className="topbar__title" /> : (
        <h1 className="topbar__title">{title}</h1>
      )}

      <button
        type="button"
        className="topbar__hit"
        aria-label={`查看侧写：${hasData ? moodWord(mood) : '还没有读数'}`}
        onClick={onOpenInspector}
      >
        <span
          className="topbar__dot"
          aria-hidden="true"
          style={{ '--specific-water': color, opacity: hasData ? 1 : 0.3 } as React.CSSProperties}
        />
      </button>

      {/*
        水位横线。`--specific-water` 由上面那个 style 之外的地方写不合适
        （两个元素要同一个色），所以这里再算一次同一个值——算的是纯函数，
        两次结果必然相同，不构成第二处真源。
      */}
      <span
        className="topbar__water"
        aria-hidden="true"
        style={{
          '--specific-water': color,
          transform: `scaleX(${String(ratio)})`,
        } as React.CSSProperties}
      />
    </header>
  )
}
