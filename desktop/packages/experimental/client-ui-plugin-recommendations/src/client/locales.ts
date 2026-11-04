/** Typed product copy for recommendation cards. */
export const zh = {
  heading: '推荐插件',
  official: '官方',
  detailsFor: '查看详情：{title}',
  'version-error': '插件与当前 Ondra 版本不兼容，请更新 Ondra 后重试。',
  'management-error': '无法启用插件，请打开详情检查错误后重试。',
  enable: '启用',
  dismiss: '暂不需要',
  working: '正在处理…',
  scope: '启用后可在所有会话中使用',
  enabled: '已启用',
  'already-enabled': '已在插件页开启，可查看详情了解运行状态',
  dismissed: '已忽略',
  replaced: '已替换',
  'restart-required': '已保存，重启 Ondra 后生效',
  failed: '启用失败。可重试或在插件页检查。',
  retry: '重试启用',
  unconfirmed: '无法确认插件是否已启用，可重试确认。',
  'lookup-failed': '无法读取插件信息，请重试。',
  retryLookup: '重试',
  unavailable: '这个插件当前无法启用，请在插件页检查。',
  unknown: '找不到这条推荐，请重新打开会话。',
  'access-denied': '没有修改此配置的权限。',
  'not-live-root': '请在原会话中操作这条推荐。',
  closing: '服务正在重载，请稍后重试。',
  transport: '无法确认操作结果，请刷新后重试。',
} satisfies Record<string, string>

/** Keys shared by every card dictionary. */
export type RecommendationKey = keyof typeof zh

/** English card copy. */
export const en = {
  heading: 'Recommended plugin',
  official: 'Official',
  detailsFor: 'View details: {title}',
  'version-error': 'This plugin is incompatible with this Ondra version. Update Ondra and retry.',
  'management-error': 'Could not enable the plugin. Open its details to check the error and retry.',
  enable: 'Enable',
  dismiss: 'Not now',
  working: 'Working…',
  scope: 'Available in all conversations when enabled',
  enabled: 'Enabled',
  'already-enabled': 'Already selected in Plugins. Open details to check its runtime status.',
  dismissed: 'Dismissed',
  replaced: 'Replaced',
  'restart-required': 'Saved. Restart Ondra to apply.',
  failed: 'Could not enable. Retry or check Plugins.',
  retry: 'Retry enabling',
  unconfirmed: 'Could not confirm whether the plugin was enabled. Retry to check.',
  'lookup-failed': 'Could not load this plugin’s details. Try again.',
  retryLookup: 'Try again',
  unavailable: 'This plugin cannot be enabled now. Check Plugins.',
  unknown: 'This recommendation is unavailable. Reopen the conversation.',
  'access-denied': 'You do not have permission to change this profile.',
  'not-live-root': 'Use this recommendation in its original conversation.',
  closing: 'The service is reloading. Try again shortly.',
  transport: 'Could not confirm the result. Refresh and try again.',
} satisfies Record<RecommendationKey, string>






