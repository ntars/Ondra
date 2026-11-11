/**
 * 品牌标志。
 *
 * ## 图形来源
 *
 * 几何全部来自 `src/brand/mark.ts`，而那是 `tools/gen-brand.mjs` 从仓库根
 * `icon.svg` 派生的（§4.5 的唯一真源规则）。这里**一个坐标都不手写**——
 * 手写一份就等于有了第二真源，改图标时必然漏。
 *
 * ## 为什么不走 `Icon.tsx`
 *
 * §4.5 明确：「品牌标志不走 morphicons。」它是图形，不是图标：视窗是
 * 24 × 24 但里面有填充路径与变换，跟 1.5px 描边的图标体系不是一套语言。
 * 塞进图标引擎会让「换图标库」变成不可能。
 *
 * ## 颜色
 *
 * 四个色都由 `variant` 决定，不用 `currentColor` 兜底：
 *
 * | variant | 底板 | 图形 | 用在哪 |
 * | --- | --- | --- | --- |
 * | `tile` | 玄青实心 | 纸白 | 关于页等需要实体感处 |
 * | `line` | 不画底板 | 玄青填充 | 空状态等小尺寸，与图标同语言 |
 *
 * `line` 变体不画底板，只留图形——两处共用同一条路径与同一视窗，
 * 因此轮廓完全一致，不会出现「小图标与大图标不是同一个东西」的漂移。
 */

import { MARK_PATH_D, MARK_PATH_EVEN_ODD, MARK_PATH_TRANSFORM, MARK_PLATE_RX, MARK_VIEW_BOX } from '../brand/mark.ts'

export type MarkVariant = 'tile' | 'line'

export interface MarkProps {
  /** 边长，单位 px。空状态 32、关于页 48。 */
  size: number
  /** 外观。见文件头表格。 */
  variant?: MarkVariant
  /** 无障碍标签。纯装饰时传空串，会输出 `aria-hidden`。 */
  label?: string
}

/**
 * 渲染品牌标志。
 *
 * ## 为什么 line 变体不画底板
 *
 * `icon.svg` 的底板是一个白色圆角矩形（应用图标需要它才能在 Dock 里有形）。
 * 在界面里直接把白底贴上去，深色模式下会变成一个刺眼的白方块。所以：
 *
 * - `tile` 变体把底板填成玄青，图形用纸白——是一枚「印章」。
 * - `line` 变体**只画图形**，不画底板，也不画一圈描边。
 *
 * 早先 line 变体把底板矩形当 1px hairline 描边画，浅色下 `--ui-action`
 * 是 `#203a85`（近黑），于是 logo 四周多了一圈深色方框，图形退成框里的
 * 填充物——观感是一枚「复选框」而不是一个标志；深底上又翻成亮框，明暗
 * 两处语言不一致。描边宽度可以靠 `non-scaling-stroke` 压住，但「有框」
 * 这件事本身就是多余的：品牌标志该由图形承担，不该由一个容器承担。
 *
 * 两种变体都不是简单地把原图贴上去，这是「派生物」而非「复制品」的界线。
 */
export function Mark({ size, variant = 'line', label }: MarkProps): React.JSX.Element {
  const tile = variant === 'tile'
  return (
    <svg
      width={size}
      height={size}
      viewBox={MARK_VIEW_BOX}
      role={label === undefined || label === '' ? undefined : 'img'}
      {...(label === undefined || label === '' ? { 'aria-hidden': true } : { 'aria-label': label })}
    >
      {/* 底板只在 tile 变体出现；line 变体不画框，理由见文件头。 */}
      {tile ? (
        <rect x="0" y="0" width="24" height="24" rx={MARK_PLATE_RX} fill="var(--ui-action)" />
      ) : null}
      {/* 鲸鱼。坐标与变换全部来自真源。 */}
      <path
        d={MARK_PATH_D}
        {...(MARK_PATH_TRANSFORM === null ? {} : { transform: MARK_PATH_TRANSFORM })}
        {...(MARK_PATH_EVEN_ODD ? { fillRule: 'evenodd' as const } : {})}
        fill={tile ? 'var(--ui-action-ink)' : 'var(--ui-action)'}
      />
    </svg>
  )
}
