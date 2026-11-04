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
  'tab.state.title': 'TA 的状态',
  'tab.state.description': '此刻的心情、TA 与你的关系、TA 记得的事',
  'state.stamp': '刚刚更新',
  'state.now.title': '此刻',
  'state.now.mood': '心情',
  'state.now.energy': '精力',
  'state.now.empty': '还没有心跳数据，聊两句 TA 就有了',
  'state.relation.title': 'TA 对你',
  'state.relation.empty': '还没有关系读数，先从一句话开始',
  'state.relation.note': '数值会随对话缓慢变化，可在设置里查看与调整',
  'state.memory.title': '记得的事',
  'state.memory.all': '全部',
  'state.memory.empty': '暂无记忆',
  'state.pet.title': '桌宠',
  'state.pet.idle': '未启动',
  'state.pet.hint': '让 TA 待在桌面，会跟着情绪活动',
  'state.pet.summon': '叫出 TA',
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
  'tab.state.title': 'Their state',
  'tab.state.description': 'Their mood now, your relationship, what they remember',
  'state.stamp': 'Updated just now',
  'state.now.title': 'Right now',
  'state.now.mood': 'Mood',
  'state.now.energy': 'Energy',
  'state.now.empty': 'No heartbeat reading yet — say a word and they have one',
  'state.relation.title': 'Them towards you',
  'state.relation.empty': 'No relationship reading yet — start with one sentence',
  'state.relation.note': 'Values drift slowly with conversation; review and adjust them in Settings',
  'state.memory.title': 'What she remembers',
  'state.memory.all': 'All',
  'state.memory.empty': 'Nothing remembered yet',
  'state.pet.title': 'Desktop pet',
  'state.pet.idle': 'Not running',
  'state.pet.hint': 'Keep them on your desktop; they move with their mood',
  'state.pet.summon': 'Call them out',
} satisfies Record<SidebarRightKey, string>
