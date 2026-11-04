/**
 * 方案 A（**默认**）：`hiddenInset` + 系统红绿灯 + 微调位置。
 *
 * ## 为什么它是默认
 *
 * 三个理由，按权重排：
 *
 * 1. **不重绘系统控件** = 不会和系统主题、全屏、辅助功能、红绿灯 hover 态打架。
 *    自绘红绿灯要做「未聚焦变灰、hover 出符号、按下高亮，全屏时隐藏」四套状态，
 *    少一套就是「看起来像假的」。
 * 2. **`hiddenInset` 是 Electron 为这个场景准备的**：保留系统按钮、把标题栏藏起来。
 * 3. 手册 §7.1 把 A/B 并列，但没说哪个默认；master-plan §12 的优先级是
 *    「正确 > 稳定 > 可维护 > 省资源」——A 在稳定这一项上明显更高。
 *
 * ## 非 macOS 怎么办
 *
 * `hiddenInset` 只在 macOS 生效。Windows / Linux 上本分支把 `style` 退回 `'default'`：
 * 保留系统标题栏与按钮，**不假装能隐藏**。假装的结果是「标题栏没了、也拖不动」，
 * 比默认标题栏难查得多。
 */

import type { WindowBranch, WindowSpec } from './types.js'

/** 方案 A。 */
export const BRANCH_A: WindowBranch = Object.freeze({
  id: 'a',
  title: 'hiddenInset + 系统红绿灯',
  grounded: true,
  source: '手册 §7.1「macOS 标题栏红绿灯方案 A/B」+ master-plan §9.9（48 / x:20,y:19 / 圆心 25）',
  note: '保留系统控件，只藏标题栏；非 macOS 退回 default。',
  /**
   * 施加 A 案差异。
   * @param base 基线规格。
   */
  specOf(base: WindowSpec): WindowSpec {
    const macos = base.platform === 'macos'
    return Object.freeze({
      ...base,
      branch: 'a',
      titleBar: Object.freeze({
        ...base.titleBar,
        style: macos ? 'hiddenInset' : 'default',
        trafficLight: Object.freeze({ ...base.titleBar.trafficLight, mode: 'system' }),
      }),
    })
  },
})
