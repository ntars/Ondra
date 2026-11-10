/**
 * 图标唯一入口。
 *
 * ## 为什么必须有这一层
 *
 * 图标纪律：业务代码只允许 `import { Icon } from
 * './Icon.tsx'`，禁止直接引用 `morphicons/react` 或任何图标包。
 *
 * 理由不是「封装好看」，而是**参数必须只有一个真源**。图标有 5 个参数
 * （size / strokeWidth / absoluteStrokeWidth / spring / reducedMotion），
 * 散落在 40 处调用点上，必然出现「这个 1.5、那个 1.6」的漂移——
 * 而线宽差 0.1 在 16px 图标上肉眼可见，会让人说不出哪里不对劲但就是
 * 觉得脏。
 *
 * ## 锁定的五个参数
 *
 * | 参数 | 值 | 原因 |
 * | --- | --- | --- |
 * | `size` | 16 | 与 11px 标签、14px 正文的比例协调（§4.4） |
 * | `strokeWidth` | 1.5 | 16px 下 1.5 是唯一不糊不细的值 |
 * | `absoluteStrokeWidth` | true | 不加这项，`size` 变化时线宽跟着缩放，20px 图标会比 16px 粗 |
 * | `spring` | 临界阻尼 | 图标形变是「切换状态」，不该回弹（§8.2） |
 * | `reducedMotion` | `'user'` | 尊重系统「减少动态效果」（§8.7） |
 *
 * ## 为什么用 `smooth` 预设而不是自定义 {320, 34}
 *
 * 规范写的是 `{ stiffness: 320, damping: 34 }`，算出的阻尼比
 * ζ = 34 / (2 × √320) ≈ 0.95，接近临界阻尼但略欠。库的 `smooth` 是
 * ζ = 1.00，即**严格不回弹**。
 *
 * 取 `smooth` 而不是照抄 320/34：图标形变是状态切换的反馈，任何回弹
 * 都会让「选中」这个动作显得轻浮。规范里 320/34 的意图是「临界阻尼」，
 * `smooth` 正是那个意图的精确实现。
 */

import { MorphIcon } from 'morphicons/react'
import type { IconInput } from 'morphicons/react'

/** 图标尺寸。只允许两档：常规 16、触屏放大 20（§5.0.7）。 */
export type IconSize = 16 | 20

export interface IconProps {
  /** 图标数据，来自 `icons.ts`。 */
  icon: IconInput
  /** 尺寸。默认 16；触屏环境的发送键与关闭叉用 20。 */
  size?: IconSize
  /**
   * 无障碍标签。
   *
   * 有标签 → `role="img"` + `<title>`，读屏会念出来。
   * 无标签 → `aria-hidden`，纯装饰。
   *
   * **凡是独立承载语义的图标必须给**（如 Rail 的五个图标）；
   * 图标旁已有文字时必须不给，否则读屏会念两遍。
   */
  label?: string
  /** 追加的类名。布局用，不要用它改写颜色或线宽。 */
  className?: string
}

/**
 * 渲染一个图标。
 *
 * 颜色继承 `currentColor`：图标不自己定色，由父元素决定。
 * 这样「选中转 teal」只需给父元素换 `color`，不必穿透到图标内部。
 */
export function Icon({ icon, size = 16, label, className }: IconProps): React.JSX.Element {
  return (
    <MorphIcon
      icon={icon}
      size={size}
      strokeWidth={1.5}
      absoluteStrokeWidth
      spring="smooth"
      reducedMotion="user"
      color="currentColor"
      {...(label === undefined ? {} : { label })}
      {...(className === undefined ? {} : { className })}
    />
  )
}
