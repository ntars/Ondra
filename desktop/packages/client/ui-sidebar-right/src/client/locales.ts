/**
 * `sidebarRight` namespace dictionaries.
 *
 * Everything a user reads in this column is here, including the strings handed
 * to the docking kit — the kit renders no copy of its own, so its whole
 * vocabulary is this package's to own and translate.
 *
 * There is no copy for opening, closing or resizing the presentation: the third
 * column is permanent, so no control and no command offers those.
 */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'command.close': '关闭当前页面／窗口',
  'command.refresh': '刷新当前页面',
  'command.noRefresh': '当前页面不支持刷新',
  'command.noFocus': '请先聚焦右侧面板',
  'command.stale': '页面已切换，请重新聚焦',
  'command.float': '浮动面板不支持此操作',
  'command.empty': '请先打开页面',
  'command.budget': '已达两格上限',
  'command.width': '栏宽不足，拖宽侧边栏后再分栏',
  'dock.emptyPane': '空面板',
  'dock.splitPane': '分栏',
  'dock.splitPaneDisabled': '已达两格上限',
  'dock.splitPaneNarrow': '栏宽不足，拖宽侧边栏后再分栏',
  'dock.closeTab': '关闭',
  'dock.addTab': '新标签页',
  'dock.dockFloat': '收回到侧边栏',
  'dock.closeFloat': '关闭',
  'dock.drop.center': '移到这里',
  'dock.drop.left': '左分栏',
  'dock.drop.right': '右分栏',
  'dock.drop.top': '上分栏',
  'dock.drop.bottom': '下分栏',
  'tab.guide.title': '开始',
  'tab.guide.more': '更多工具',
  'tab.unavailable': '这类内容还没有可用的查看方式。',
} satisfies Record<string, string>

/** Right-Sidebar dictionary key union. */
export type SidebarRightKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'command.close': 'Close current page or window',
  'command.refresh': 'Refresh current page',
  'command.noRefresh': 'This page cannot be refreshed',
  'command.noFocus': 'Focus a right sidebar pane first',
  'command.stale': 'The page changed; focus it again',
  'command.float': 'This action is unavailable in a floating panel',
  'command.empty': 'Open a page first',
  'command.budget': 'Two panes is the limit',
  'command.width': 'Not enough width to split, widen the sidebar',
  'dock.emptyPane': 'Empty pane',
  'dock.splitPane': 'Split',
  'dock.splitPaneDisabled': 'Two panes is the limit',
  'dock.splitPaneNarrow': 'Not enough width to split, widen the sidebar',
  'dock.closeTab': 'Close',
  'dock.addTab': 'New tab',
  'dock.dockFloat': 'Send back to the sidebar',
  'dock.closeFloat': 'Close',
  'dock.drop.center': 'Move here',
  'dock.drop.left': 'Add left split',
  'dock.drop.right': 'Add right split',
  'dock.drop.top': 'Add top split',
  'dock.drop.bottom': 'Add bottom split',
  'tab.guide.title': 'Start',
  'tab.guide.more': 'More tools',
  'tab.unavailable': 'Nothing here can view this kind of content yet.',
} satisfies Record<SidebarRightKey, string>
