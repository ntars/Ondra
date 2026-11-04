/**
 * 内置浏览器面板的界面半身：注册右侧栏的一个 tab 类型。
 *
 * ## 为什么挂在右侧栏，而不是新开一个 Electron 窗口
 *
 * 主人要的是「像设置一样的窗口」。设置本身就是**侧栏面板**（`sidebar.settings`
 * 由 `ui-settings-general` 占据），不是独立进程窗口。跟随同一个载体有三个好处：
 *
 * 1. 宽度可拖、随主窗口缩放，不需要自己处理窗口生命周期与多显示器；
 * 2. 与文件预览、终端共用同一套 dock 机制，切会话时行为一致；
 * 3. 不新增 `BrowserWindow`，也就没有新的 preload 面与 IPC 面要审。
 *
 * ## 与宿主的分工
 *
 * 本包**不做白名单判定**、**不做页面登记**。它只做两件事：向后端要
 * `/pane/state`（有哪些页、该开哪一页），把选中的页塞进 iframe。
 * 判定与登记都在 `cordis/ondra-browser-pane` —— 安全边界只有一处，好审。
 */

import type { Context as ClientContext } from '@ntars/cordis'
// Type-only：拉进 ctx.locale 的类型合并。
import type {} from '@ntars/ondra-client-locale/client'
import type {} from '@ntars/ondra-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@ntars/ondra-client-ui-sidebar-right/client'
import type {} from '@ntars/ondra-client-ui-sidebar-right/client'
import { PaneBody } from './PaneBody.tsx'
import { PaneTitle } from './PaneTitle.tsx'
import { en, zh, type BrowserPaneKey } from './locales.ts'

export type { PaneBodyProps } from './PaneBody.tsx'
export type { BrowserPaneKey } from './locales.ts'

declare module '@ntars/ondra-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 内置浏览器面板的文案。 */
    browserPane: BrowserPaneKey
  }
}

/** 本实现的身份（同时是 `sidebar.right.pane.tab*` 两个 seat 的 key）。 */
export const PANE_ID = '@ntars/ondra-client-ui-browser-pane'

/** tab 类型判别值，也是 `openTab` 时传的 kind。 */
export const PANE_KIND = 'browser-pane'

/** 文案命名空间。 */
const NS = 'browserPane'

/** 必需服务。`slots` 与 `sidebarRightTabs` 缺席时本包不该被装载。 */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/**
 * 构造 tab 类型定义。
 * @param t 绑定了本包命名空间的翻译函数。
 * @returns 侧栏 tab 定义。
 */
function paneDefinition(t: (key: BrowserPaneKey) => string): SidebarRightTabDefinition {
  return {
    id: PANE_ID,
    kind: PANE_KIND,
    // 一个面板就够：多开只会让用户困惑「哪个是哪个」，它们显示的是同一份状态。
    multiple: false,
    // 切会话时不重建 iframe：注册页填了一半表单被销毁，是最恼人的体验。
    keepMounted: true,
    priority: 'builtin',
    title: () => t('type.label'),
    // 不给 guide 条目绑快捷键：本包没有注册任何 command，绑一个不存在的
    // commandId 只会让引导页显示一个按了没反应的键位。
    guide: [{
      id: 'open',
      order: 40,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
    }],
  }
}

/**
 * 客户端入口：注册字典、tab 类型、body 与 title。
 * @param ctx 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-browser-pane: 字典')
  ctx.effect(() => ctx.sidebarRightTabs.register(paneDefinition(t)), 'ui-browser-pane: tab 类型')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PANE_ID,
    locale: NS,
  }, PaneBody)), 'ui-browser-pane: body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: PANE_ID,
  }, PaneTitle)), 'ui-browser-pane: title')
}
