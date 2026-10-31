/** Locale-owned application-access approval messages. */

/** English application-access messages. */
export const en = {
  question: 'Allow computer use to launch, read, capture and control this application?',
  detail: 'Allowing or denying applies to every version and copy sharing the same application identity. Session access and denial apply only to this conversation.',
  approve: 'Allow for this session',
}

/** Chinese application-access messages. */
export const zh = {
  question: '允许 Computer Use 启动、读取、截图和控制此应用吗？',
  detail: '允许或拒绝会应用于同一应用标识的所有版本和副本。会话许可和拒绝仅在当前对话中生效。',
  approve: '本会话允许',
} satisfies Record<keyof typeof en, string>

/** Display translations resolved by the Client; wire choices stay unchanged. */
export const applicationAccessDisplay = {
  question: { en: en.question, zh: zh.question },
  detail: { en: en.detail, zh: zh.detail },
  approve: { en: en.approve, zh: zh.approve },
}
