/**
 * 图标数据。
 *
 * ## 为什么从 `lucide` 引入数据而不是手写 path
 *
 * `docs/UI-DESIGN.md` §4.4 的图标数据源规则写得很死：
 *
 * | 项 | 规则 |
 * | --- | --- |
 * | 主集 | Iconoir outline |
 * | 补充集 | Lucide（ISC），仅当 Iconoir 缺该图形时使用 |
 * | 引入方式 | 从 `lucide` 包引入 `IconNode` 数据，**不从 `lucide-react` 引入组件** |
 * | 禁止 | 手绘 `<path>` |
 *
 * 上一版这一文件是手绘的九条路径，理由是「只用到九个，手写不到 60 行」。
 * 实际渲染后线条残缺、图形不可辨——手绘 24 网格的贝塞尔不是省事，
 * 是把设计工作伪装成「写几行坐标」。现在按规范走：只引数据，渲染仍由
 * 自己的 `Icon.tsx` 接管，线宽、端点、弹簧参数全项目唯一。
 *
 * `lucide` 的 `sideEffects: false` 且具名导出，Vite 摇树后只保留用到的图形。
 *
 * ## 命名约定
 *
 * 统一 `Icon` 前缀，让业务代码里一眼看出「这是个图标数据」。
 * 名字按**语义**取（`IconMemory`），不按 lucide 的原名取（`Brain`）——
 * 将来换主集时只改这一行映射，调用点不用动。
 *
 * ## 形变对
 *
 * §4.4 的八组形变对里有五组在本批范围内，数据都备好了：
 * 发送（`IconSend` ⇄ `IconStop`）、抽屉（`IconPanelLeft` ⇄ `IconClose`）、
 * 检查器（`IconPanelRight` ⇄ `IconClose`）、朗读（`IconPlay` ⇄ `IconPause`）、
 * 薄片（`IconChevronRight` ⇄ `IconChevronDown`）。
 * 主题（`IconSun` ⇄ `IconMoon`）与语音（`IconMic` ⇄ `IconWaveform`）
 * 归第 4、5 批接入，数据先放着——用到时不必再翻一遍库。
 */

/** 今天。日历页加日期点。 */
export { CalendarDays as IconToday } from 'lucide'

/** 本周。一周区间的日历。 */
export { CalendarRange as IconWeek } from 'lucide'

/** 记忆。用「脑」表达长期的、非即时的记住。 */
export { Brain as IconMemory } from 'lucide'

/** 剧场。两张面具。 */
export { Drama as IconTheater } from 'lucide'

/** 设置。齿轮。 */
export { Settings as IconSettings } from 'lucide'

/** 发送。向上箭头。形变对：与本图标 ⇄ `IconStop`。 */
export { ArrowUp as IconSend } from 'lucide'

/** 停止。方块。生成中替换发送键（形变对）。 */
export { Square as IconStop } from 'lucide'

/** 加号。附加文件。 */
export { Plus as IconPlus } from 'lucide'

/**
 * 关闭。叉。
 *
 * 三组形变对的公共终点：抽屉开关、检查器开关、以及所有浮层的关闭。
 * 共用同一个图形是有意的——「叉 = 结束这一切」在全界面只有一种说法。
 */
export { X as IconClose } from 'lucide'

/** 右箭头。薄片与列表项的指示。形变对：与本图标 ⇄ `IconChevronDown`。 */
export { ChevronRight as IconChevronRight } from 'lucide'

/** 下箭头。「有新消息」浮标与薄片展开态。 */
export { ChevronDown as IconChevronDown } from 'lucide'

/** 左侧抽屉开关。形变对：与本图标 ⇄ `IconClose`。 */
export { PanelLeft as IconPanelLeft } from 'lucide'

/** 右侧检查器开关。形变对：与本图标 ⇄ `IconClose`。 */
export { PanelRight as IconPanelRight } from 'lucide'

/** 朗读。形变对：与本图标 ⇄ `IconPause`。 */
export { Play as IconPlay } from 'lucide'

/** 暂停朗读。 */
export { Pause as IconPause } from 'lucide'

/** 语音输入。形变对：与本图标 ⇄ `IconWaveform`。 */
export { Mic as IconMic } from 'lucide'

/** 录音中。波形。 */
export { AudioLines as IconWaveform } from 'lucide'

/** 主题·浅色。形变对：与本图标 ⇄ `IconMoon`。 */
export { Sun as IconSun } from 'lucide'

/** 主题·深色。 */
export { Moon as IconMoon } from 'lucide'

/** 桌宠·在场。形变对：与本图标 ⇄ `IconMoon`。 */
export { Circle as IconCircle } from 'lucide'

/** 复制。消息悬停操作。 */
export { Copy as IconCopy } from 'lucide'

/** 引用。消息悬停操作。 */
export { Quote as IconQuote } from 'lucide'

/** 重试 / 重答。 */
export { RefreshCw as IconRetry } from 'lucide'

/** 删除。 */
export { Trash2 as IconTrash } from 'lucide'

/** 菜单。Windows 标题栏左上。 */
export { Menu as IconMenu } from 'lucide'

/**
 * 关闭 / 撤下。
 *
 * 与 `IconClose` 的区别在**语义**而不是形状：这个用于「这次不用」——
 * 撤下的是她的一句话，不是关掉一个面板。分开导出是因为两者将来可能
 * 演化成不同的图形（撤下更适合一个「收回去」的方向），而现在共用一个
 * 形状则是诚实的选择：语义差异靠 `aria-label` 传达，不靠猜图标。
 */
export { X as IconX } from 'lucide'
