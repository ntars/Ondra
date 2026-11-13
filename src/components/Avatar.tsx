/**
 * 头像：她的脸，也是应用的脸。
 *
 * ## 默认为什么是「应用图标」而不是鱼的线稿
 *
 * 标题栏原来画的是 `Mark variant="line"`——只有图形的玄青鲸鱼，底是沉色圆。
 * 那更像一枚图标，不像一张脸：图标回答「这是什么应用」，头像回答「这是谁」。
 *
 * 出厂人设包没有自带立绘（`meta.json` 里没有头像字段，`哦鲸鲸.skill.zip`
 * 里也没有图片），所以默认只能退回应用图标。退回时要**保持应用图标的比例**：
 * 白底、黑主体、图形在 24 视窗里的相对大小与 `icon.svg` 完全一致——
 * 用户放大到 200% 时，头像与 Dock 里那枚图标应当是同一个形状，
 * 而不是「一个像它的东西」。
 *
 * ## 为什么白底黑主体不跟着主题反色
 *
 * 这是应用图标的配色，不是界面的配色。图标在 Dock、About 页、安装包里
 * 全是白底黑鱼，头像跟着主题翻成黑底白鱼，就成了第二个标志。
 * 24px 的白圆放在深色标题栏上确实是最亮的一点，但它是**身份**，
 * 亮度本来就是它该有的重量。
 *
 * ## 自定义头像为什么走 `<img>` 而不走背景图
 *
 * `alt` 要能读、`onError` 要能退回图标。背景图两者都做不到：图裂了
 * 只剩一个空圆，读屏也念不出这是谁。
 */

import { useState } from 'react'
import {
  MARK_PATH_D,
  MARK_PATH_EVEN_ODD,
  MARK_PATH_TRANSFORM,
  MARK_VIEW_BOX,
} from '../brand/mark.ts'

export interface AvatarProps {
  /** 边长，px。标题栏 24、设置页 40。 */
  size: number
  /** 自定义头像（data URL）。空串表示用应用图标。 */
  src?: string
  /** 无障碍标签。传空串表示纯装饰（旁边已有名字时）。 */
  label?: string
}

/**
 * 渲染头像。
 *
 * 载入失败要退回图标：用户删掉了相册里那张图、同步工具改了 data URL，
 * 都可能让 `<img>` 裂开。裂开时留一个空圆，比显示默认图标更让人困惑
 * ——「她是不是坏了」。
 */
export function Avatar({ size, src, label }: AvatarProps): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const showImage = src !== undefined && src !== '' && !broken
  const decorative = label === undefined || label === ''

  return (
    <span
      className="avatar"
      style={{ width: `${String(size)}px`, height: `${String(size)}px` }}
      role={decorative ? undefined : 'img'}
      {...(decorative ? { 'aria-hidden': true } : { 'aria-label': label })}
    >
      {showImage ? (
        <img
          className="avatar__img"
          src={src}
          alt=""
          draggable={false}
          onError={() => { setBroken(true) }}
        />
      ) : (
        /*
         * 图形与 `icon.svg` 共用同一份几何（`brand/mark.ts`），只有配色
         * 写死在这里：白底 `#ffffff`、黑主体 `#111111`，与图标文件逐字相同。
         */
        <svg className="avatar__glyph" viewBox={MARK_VIEW_BOX} aria-hidden="true">
          <path
            d={MARK_PATH_D}
            {...(MARK_PATH_TRANSFORM === null ? {} : { transform: MARK_PATH_TRANSFORM })}
            {...(MARK_PATH_EVEN_ODD ? { fillRule: 'evenodd' as const } : {})}
            fill="#111111"
          />
        </svg>
      )}
    </span>
  )
}
