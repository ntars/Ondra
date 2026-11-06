/**
 * 窗口规格的**单一真源**：所有 px 数字只在这里出现一次。
 *
 * ## 数字从哪来（逐个数标出处）
 *
 * | 值 | 出处 |
 * |---|---|
 * | 标题区 48 | master-plan §9.9「48px 标题区横跨整窗」 |
 * | 拖动区 44 | **台账那一行**（手册 0 命中；`Ondra-标题栏方案-macOS.md` 的 44px 见 master-plan §1 素材地图） |
 * | `trafficLightPosition{x:20,y:19}` | master-plan §9.9（Electron 该参数是**容器左上角**，不是圆心） |
 * | 红绿灯直径 12 | 反推：圆心 25 − 顶边 19 = 6，半径 6 → 直径 12 |
 * | 圆心 y=25 | master-plan §9.9「三列共用圆心 y=25」 |
 * | 三栏 272 / ≥520 / 300 | master-plan §9.9「栏宽 272 / 1fr（最小 520）/ 300」 |
 * | 断点 1440/1240/1080/900/860 | master-plan §9.9「断点 1440 / 1240 / 1080 / 900 / 860 / <860」 |
 *
 * ## 三个「看起来矛盾」的地方，逐条给结论
 *
 * 1. **48 与 44。** 不是矛盾：48 是标题区总高，44 是可拖热区高。余下 4px 是
 *    热区下方留白（拖动区不该贴到内容区第一行，否则拖动时容易误触）。
 *    **手册没写这两者的关系**，本包的读法是「44 在 48 之内、下沿留 4px」，并标为
 *    `source: '反推'`。
 * 2. **25 与 24。** 48 / 2 = 24，但圆心给的是 25。差 1px。这不是笔误：
 *    19（顶边）+ 12 / 2 = 25，两个数**自洽**；而 24 只是「标题区的几何中线」。
 *    结论：25 是**红绿灯的视觉重心**，刻意比几何中线低 1px。本包不「纠正」它，
 *    而是把这个事实变成一条 `warn` 级 issue，让后来的人看见原因。
 * 3. **1092 与 1080。** 三栏全展开最小 272 + 520 + 300 = **1092**，但断点里右栏
 *    到 **900** 才折叠。也就是说 1080 这个断点上三栏硬装不下（差 12px）。
 *    两条都是 master-plan §9.9 的原话，**本包不擅自改任何一个数**，只报 issue。
 *    真正要裁决的是主人：要么右栏折叠点提到 1092 以上，要么中间栏 `min 520` 放宽。
 */

import type { SpecIssue, WindowBranchId, WindowPlatform, WindowSpec } from './types.js'

/** 标题区总高（px）。master-plan §9.9。 */
export const TITLE_BAR_HEIGHT = 48

/** 可拖热区高（px）。台账。 */
export const DRAG_HEIGHT = 44

/** 红绿灯容器左边（px）。master-plan §9.9。 */
export const TRAFFIC_LIGHT_X = 20

/** 红绿灯容器上边（px）。master-plan §9.9。 */
export const TRAFFIC_LIGHT_Y = 19

/** 红绿灯直径（px）。反推：圆心 25 − 顶边 19 = 半径 6。 */
export const TRAFFIC_LIGHT_SIZE = 12

/** 红绿灯圆心 y（px）。master-plan §9.9。 */
export const TRAFFIC_LIGHT_CENTER_Y = 25

/** 三栏宽度（px）。master-plan §9.9。 */
export const COLUMNS = Object.freeze({ left: 272, centerMin: 520, right: 300 })

/** 断点（大 → 小）。master-plan §9.9。 */
export const BREAKPOINTS: readonly number[] = Object.freeze([1440, 1240, 1080, 900, 860])

/** 右栏折叠的断点（master-plan：900 折叠为抽屉）。 */
export const RIGHT_COLLAPSE_AT = 900

/**
 * 基线的三栏最小宽度：`left + centerMin + right`。
 *
 * 由三个分量算出来，**不写第二个常数**——写死 1092 之后，谁改了栏宽就一定会漏改它。
 */
export const MIN_WIDTH = COLUMNS.left + COLUMNS.centerMin + COLUMNS.right

/**
 * 把配置里的平台字符串收成枚举。
 *
 * `auto` 交给 `process.platform`；认不出的给 `unknown`——**不默认成 macos**。
 * 默认成 macos 的后果：Windows 上也会去设 `hiddenInset`，而那在 Windows 上无效，
 * 表现为「标题栏没了、也拖不动」，比不设更难查。
 * @param configured 配置值。
 * @param actual `process.platform` 的值。
 */
export function platformOf(configured: 'auto' | WindowPlatform, actual: string): WindowPlatform {
  if (configured !== 'auto') return configured
  if (actual === 'darwin') return 'macos'
  if (actual === 'win32') return 'windows'
  if (actual === 'linux') return 'linux'
  return 'unknown'
}

/**
 * 基线规格（**未施加分支差异**）。
 *
 * 基线的 `trafficLight.mode` 给 `'system'`、`style` 给 `'hiddenInset'`：
 * 这是 A 案的形状，也是「最稳」的那一支——不重绘系统控件，就不会和系统主题、
 * 全屏行为、辅助功能打架。
 * @param platform 平台。
 */
export function baseSpecOf(platform: WindowPlatform): WindowSpec {
  const macos = platform === 'macos'
  return Object.freeze({
    platform,
    branch: 'a',
    titleBar: Object.freeze({
      height: TITLE_BAR_HEIGHT,
      dragHeight: DRAG_HEIGHT,
      // 非 macOS 上 `hiddenInset` 不生效，退回 `default`；`hidden` 在 Windows 上会
      // 连窗口按钮一起藏掉，那两个分支见 `branch-b.ts` 的说明。
      style: macos ? 'hiddenInset' : 'default',
      trafficLight: Object.freeze({
        mode: 'system',
        x: TRAFFIC_LIGHT_X,
        y: TRAFFIC_LIGHT_Y,
        size: TRAFFIC_LIGHT_SIZE,
        centerY: TRAFFIC_LIGHT_CENTER_Y,
      }),
    }),
    columns: COLUMNS,
    breakpoints: BREAKPOINTS,
    minWidth: MIN_WIDTH,
  })
}

/**
 * 规格自洽检查（纯函数）。
 *
 * 分两级：
 * - `error`：**算错了**（拖动区比标题区还高、minWidth 与三项之和对不上）。会挡住 `spec()`。
 * - `warn`：**文档级口径冲突**（25 与 24、1092 与 1080）。不挡，但必须报——
 *   悄悄「修正」别人的定案值，比留一条 warning 危险得多。
 * @param spec 待检规格。
 */
export function specIssues(spec: WindowSpec): readonly SpecIssue[] {
  const issues: SpecIssue[] = []
  const bar = spec.titleBar
  const light = bar.trafficLight

  if (bar.dragHeight > bar.height) {
    issues.push({
      code: 'drag-over-title',
      severity: 'error',
      message: `拖动区 ${bar.dragHeight} 比标题区 ${bar.height} 还高，热区会盖到内容区第一行`,
      source: 'master-plan §9.9（48）+ 台账（44）',
    })
  }

  const expectedCenter = light.y + light.size / 2
  if (light.centerY !== expectedCenter) {
    issues.push({
      code: 'center-mismatch',
      severity: 'error',
      message: `圆心 ${light.centerY} 不等于顶边 ${light.y} + 半径 ${light.size / 2} = ${expectedCenter}`,
      source: 'master-plan §9.9（x:20,y:19 与圆心 y=25）',
    })
  }

  if (light.centerY !== bar.height / 2) {
    issues.push({
      code: 'center-off-geometric',
      severity: 'warn',
      message: `圆心 ${light.centerY} 比标题区几何中线 ${bar.height / 2} 低 ${light.centerY - bar.height / 2}px；两个数各自自洽（19+6=25），故意不纠正`,
      source: 'master-plan §9.9（48 与 y=25 同段）',
    })
  }

  const sum = spec.columns.left + spec.columns.centerMin + spec.columns.right
  if (spec.minWidth !== sum) {
    issues.push({
      code: 'min-width-sum',
      severity: 'error',
      message: `最小宽度 ${spec.minWidth} 不等于三栏之和 ${sum}`,
      source: 'master-plan §9.9（272 / ≥520 / 300）',
    })
  }

  if (spec.minWidth > RIGHT_COLLAPSE_AT) {
    issues.push({
      code: 'min-width-over-breakpoint',
      severity: 'warn',
      message: `三栏要 ${spec.minWidth} 才装得下，但右栏到 ${RIGHT_COLLAPSE_AT} 才折叠——${RIGHT_COLLAPSE_AT}~${spec.minWidth} 之间会硬挤出横向滚动`,
      source: 'master-plan §9.9（断点 900 折叠 与 272+520+300 同段）',
    })
  }

  for (let index = 1; index < spec.breakpoints.length; index += 1) {
    const prev = spec.breakpoints[index - 1]
    const next = spec.breakpoints[index]
    if (prev === undefined || next === undefined) continue
    if (prev <= next) {
      issues.push({
        code: 'breakpoint-order',
        severity: 'error',
        message: `断点必须从大到小，但 ${prev} 排在 ${next} 前面`,
        source: 'master-plan §9.9',
      })
    }
  }

  return Object.freeze(issues)
}

/**
 * 有没有 `error` 级问题（有就不该把规格交出去）。
 * @param issues 问题表。
 */
export function hasBlockingIssue(issues: readonly SpecIssue[]): boolean {
  return issues.some(issue => issue.severity === 'error')
}

/**
 * 分支 id 收窄。
 * @param value 原始值。
 */
export function branchOf(value: string): WindowBranchId {
  return value === 'b' ? 'b' : 'a'
}
