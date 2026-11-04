/** Locale-owned sandbox approval text; audit inputs remain verbatim. */

/** English escalation messages. */
export const en = {
  escalation: (mode: string, justification: string): string => `Allow this operation with ${mode} permissions: ${justification}`,
}

/** Chinese escalation messages. */
export const zh = {
  escalation: (mode: string, justification: string): string => `允许本次操作使用 ${mode} 权限：${justification}`,
} satisfies typeof en

/**
 * Build translations for the existing Client localized-text resolver.
 * @param mode - requested sandbox mode.
 * @param justification - raw model justification, preserved in every translation.
 * @returns localized approval text.
 */
export function escalationDisplayReason(mode: string, justification: string): Record<'en' | 'zh', string> {
  return {
    en: en.escalation(mode, justification),
    zh: zh.escalation(mode, justification),
  }
}
