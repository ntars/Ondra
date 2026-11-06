/**
 * 图标数据。
 *
 * ## 为什么手写 path 而不是引入 lucide-react
 *
 * 本应用只用到 9 个图标。引入 `lucide-react` 会把 1500 个图标打进产物
 * （即使 tree-shaking 后仍有数百个），而手写这 9 个的坐标总共不到
 * 60 行。更重要的是**线宽的绝对一致**：lucide 各图标的 path 是按
 * 视觉平衡调过的，混用会让某几个看起来粗一点。这里统一在 24 × 24
 * 视窗、1.5 线宽下画，全部落在 0.5 的整数倍上。
 *
 * ## 数据格式
 *
 * 与 lucide 相同：`[标签名, 属性表]` 的数组。`morphicons` 的
 * `IconInput` 直接接受这个形状，因此不需要任何转换。
 *
 * ## 绘制约定
 *
 * - 视窗 24 × 24，所有图形居中于 (12, 12)。
 * - 线宽不写在数据里，由 `Icon.tsx` 统一下发 `strokeWidth`。
 * - 圆角端点与圆角连接由包装组件下发，数据只写几何。
 * - **不填充**。全部图标是描边风格，与「一条 0.5px 线」的整体调性一致。
 */

import type { IconNode } from 'morphicons/react'

/**
 * 今天。一个日历页加一个点。
 *
 * 用圆点而不是数字：数字要渲染字体，11px 下「31」会糊。
 */
export const IconToday: IconNode = [
  ['path', { d: 'M6 5h12a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 18 20H6a1.5 1.5 0 0 1-1.5-1.5v-12A1.5 1.5 0 0 1 6 5Z' }],
  ['path', { d: 'M4.5 9.5h15' }],
  ['circle', { cx: '12', cy: '14.5', r: '1.6' }],
]

/** 周。三根等长横线 + 左侧三个点，像一周的刻度。 */
export const IconWeek: IconNode = [
  ['path', { d: 'M7 8h12' }],
  ['path', { d: 'M7 12h12' }],
  ['path', { d: 'M7 16h12' }],
  ['circle', { cx: '4.5', cy: '8', r: '0.9' }],
  ['circle', { cx: '4.5', cy: '12', r: '0.9' }],
  ['circle', { cx: '4.5', cy: '16', r: '0.9' }],
]

/**
 * 记忆。三个同心圆弧，开口朝右上。
 *
 * 不用「脑子」的常见画法：那个形状在 16px 下会糊成一团。
 */
export const IconMemory: IconNode = [
  ['path', { d: 'M12 20a8 8 0 1 1 8-8' }],
  ['path', { d: 'M12 16.5a4.5 4.5 0 1 1 4.5-4.5' }],
  ['circle', { cx: '12', cy: '12', r: '1' }],
]

/** 剧场。两撇幕布 + 底部一条台沿。 */
export const IconTheater: IconNode = [
  ['path', { d: 'M4 5c2.5 2 2.5 12 0 14' }],
  ['path', { d: 'M20 5c-2.5 2-2.5 12 0 14' }],
  ['path', { d: 'M8.5 19h7' }],
]

/**
 * 设置。齿轮用六根短齿 + 中心圆。
 *
 * 六齿而不是八齿：16px 下八齿的齿宽不足 1px，会连成一片。
 */
export const IconSettings: IconNode = [
  ['circle', { cx: '12', cy: '12', r: '3.2' }],
  ['path', { d: 'M12 2.8v2.4' }],
  ['path', { d: 'M12 18.8v2.4' }],
  ['path', { d: 'M4.5 7.4l2 1.2' }],
  ['path', { d: 'M17.5 15.4l2 1.2' }],
  ['path', { d: 'M4.5 16.6l2-1.2' }],
  ['path', { d: 'M17.5 8.6l2-1.2' }],
]

/** 发送。向上的三角，实心由填充规则表达，这里用描边三角。 */
export const IconSend: IconNode = [
  ['path', { d: 'M12 19V6' }],
  ['path', { d: 'M6.5 11.5 12 6l5.5 5.5' }],
]

/** 加号。用来附加文件。 */
export const IconPlus: IconNode = [
  ['path', { d: 'M12 5.5v13' }],
  ['path', { d: 'M5.5 12h13' }],
]

/** 关闭。一个叉。 */
export const IconClose: IconNode = [
  ['path', { d: 'M6.5 6.5l11 11' }],
  ['path', { d: 'M17.5 6.5l-11 11' }],
]

/** 停止。一个方块，表示「先别说」。 */
export const IconStop: IconNode = [
  ['rect', { x: '7.5', y: '7.5', width: '9', height: '9', rx: '1.5' }],
]

/** 右箭头。抽屉与薄片的指示。 */
export const IconChevronRight: IconNode = [
  ['path', { d: 'M9.5 6l6 6-6 6' }],
]

/** 下箭头。用于「有新消息」浮标。 */
export const IconChevronDown: IconNode = [
  ['path', { d: 'M6 9.5l6 6 6-6' }],
]
