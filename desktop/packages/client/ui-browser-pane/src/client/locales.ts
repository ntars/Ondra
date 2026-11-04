/**
 * 面板的文案。中英各一份，键集合必须一致（自检按集合比对）。
 *
 * 文案里**不出现任何网址**：连"打开 127.0.0.1:xxxx"这种说明都不写，
 * 否则「不显示链接」就在文案层破功了。
 */

/** 中文文案（键的唯一真源，英文按此集合校对）。 */
export const zh = {
  'type.label': '内置浏览器',
  'guide.title': '内置浏览器',
  'guide.description': '查看内置插件的页面，比如开通引导与调试界面。',
  'empty.title': '这里还没有可显示的页面',
  'empty.body': '内置插件登记页面之后，它会出现在这里。',
  'error.title': '页面没能加载',
  'error.body': '可能是宿主服务还没就绪。稍等一下再试，或者在设置里确认插件已启用。',
  'error.retry': '重试',
  'unsupported.title': '这个环境暂时打不开内置页面',
  'unsupported.body': '内置浏览器需要本地页面服务。当前运行方式没有提供它，页面无法在这里显示。',
  'reload': '刷新',
} as const

/** 中文文案的键集合。 */
export type BrowserPaneKey = keyof typeof zh

/** 英文文案。 */
export const en: Record<BrowserPaneKey, string> = {
  'type.label': 'Built-in Browser',
  'guide.title': 'Built-in Browser',
  'guide.description': 'View built-in plugin pages such as onboarding guides and debug surfaces.',
  'empty.title': 'No page to show yet',
  'empty.body': 'Once a built-in plugin registers a page, it appears here.',
  'error.title': 'The page did not load',
  'error.body': 'The host service may not be ready yet. Wait a moment and retry, or check that the plugin is enabled.',
  'error.retry': 'Retry',
  'unsupported.title': 'Built-in pages cannot open in this environment',
  'unsupported.body': 'The built-in browser needs a local page service. The current runtime does not provide one, so the page cannot be shown here.',
  'reload': 'Reload',
}
