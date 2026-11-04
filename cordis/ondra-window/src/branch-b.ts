/**
 * 方案 B：`hidden` + **自绘**红绿灯。
 *
 * ## 为什么它在，但不是默认
 *
 * B 存在的意义是「标题区要和品牌视觉完全融合」——`hiddenInset` 的位置只能微调，
 * 不能改配色、不能改间距、不能做「光球生命体」那套动效。设计上想要这些时，只能自绘。
 *
 * 代价是四套状态要自己实现：未聚焦变灰、hover 显示符号、按下高亮、全屏隐藏。
 * 少一套，用户第一眼就会觉得「这是假的」。所以它默认关闭，由 `branch: 'b'` 显式选择。
 *
 * ## 坐标为什么标 `grounded: false`
 *
 * 手册只写了「**方案 A/B**」四个字，两案的**内容与坐标一个都没给**；
 * master-plan §9.9 的 `x:20,y:19` 是**系统红绿灯的位置**（那是 A 案的值）。
 *
 * B 案自绘时要放在哪，没有任何出处。本包的做法是：
 *
 * - **沿用 A 的 20 / 19 / 12**，不自己发明一组「看起来更居中」的数；
 * - 在 `BranchDecl` 上标 `grounded: false`，并在 `plan()` 的 findinds 里说明。
 *
 * 自己发明坐标的坏处是：它会被后续所有截图、设计稿、验收单当成定案值引用，
 * 而它其实只是一次猜测。
 *
 * ## 只在 macOS 有意义
 *
 * 自绘红绿灯是 macOS 的概念。Windows / Linux 上这个分支**没有意义**，
 * 服务层会直接报 `unsupported-platform` 并退回 A——不是「降级运行」，是明确拒绝。
 */

import type { WindowBranch, WindowSpec } from './types.js'

/** 方案 B。 */
export const BRANCH_B: WindowBranch = Object.freeze({
  id: 'b',
  title: 'hidden + 自绘红绿灯',
  grounded: false,
  source: '手册 §7.1 只给「方案 A/B」四字；坐标沿用 A 的 20/19/12（**反推，非设计值**）',
  note: '仅 macOS；要自己实现四套按钮状态，坐标无出处，默认不选。',
  /**
   * 施加 B 案差异。
   * @param base 基线规格。
   */
  specOf(base: WindowSpec): WindowSpec {
    return Object.freeze({
      ...base,
      branch: 'b',
      titleBar: Object.freeze({
        ...base.titleBar,
        // `hidden` 把整个标题栏（含系统按钮）藏掉，由页面自己画。
        style: 'hidden',
        trafficLight: Object.freeze({ ...base.titleBar.trafficLight, mode: 'drawn' }),
      }),
    })
  },
})
