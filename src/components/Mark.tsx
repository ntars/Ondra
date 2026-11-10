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
 * | `tile` | 玄青实心 | 纸白 | 首页中央（大尺寸，需要一个实体感） |
 * | `line` | 透明 | 玄青描边 | Rail 顶部（小尺寸，与图标同语言） |
 *
 * `line` 变体把底板矩形当描边画，图形保持填充——两条路径共用同一个
 * 视窗与坐标，因此两个尺寸下的轮廓完全一致，不会出现「小图标与大图标
 * 不是同一个东西」的漂移。
 */

import { MARK_PATH_D, MARK_PATH_EVEN_ODD, MARK_PATH_TRANSFORM, MARK_PLATE_RX, MARK_VIEW_BOX } from '../brand/mark.ts'

export type MarkVariant = 'tile' | 'line'

export interface MarkProps {
  /** 边长，单位 px。首页 64、Rail 24。 */
  size: number
  /** 外观。见文件头表格。 */
  variant?: MarkVariant
  /** 无障碍标签。纯装饰时传空串，会输出 `aria-hidden`。 */
  label?: string
}

/**
 * 渲染品牌标志。
 *
 * ## 为什么底板也画出来
 *
 * `icon.svg` 的底板是一个白色圆角矩形（应用图标需要它才能在 Dock 里有形）。
 * 在界面里直接把白底贴上去，深色模式下会变成一个刺眼的白方块。所以：
 *
 * - `tile` 变体把底板填成玄青，图形用纸白——是一枚「印章」。
 * - `line` 变体把底板画成描边，图形保持填充——是一枚「线稿」。
 *
 * 两种都不是简单地把原图贴上去，这是「派生物」而非「复制品」的界线。
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
      {/* 底板。tile 填实，line 只描边。 */}
      <rect
        x="0"
        y="0"
        width="24"
        height="24"
        rx={MARK_PLATE_RX}
        fill={tile ? 'var(--ui-action)' : 'none'}
        stroke={tile ? 'none' : 'var(--ui-action)'}
        /*
         * `non-scaling-stroke`：描边宽度不随 SVG 缩放。
         *
         * 不写它时，24 视窗里的 1.5 会在首页 72px 尺寸下放大成 **4.5px**——
         * 那圈板框变成整枚标志里最重的东西，图形（鲸）退成框里的填充物，
         * 观感是一枚「复选框」而不是一个标志。同一段代码在 Rail 的 24px
         * 下又是细的，于是大小两处的语言不一致。
         *
         * 加上之后两处都是 1px 的 hairline，与全界面「只有一种线」的规则
         * 对齐；标识的分量交回给图形本身。
         */
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
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
