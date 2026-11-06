/**
 * 设置接口的客户端封装。
 *
 * 与 `api.ts` 分开而不是加进去：`api.ts` 里都是"对话"这条主链路，
 * 设置是另一条独立的读写路径，两者没有共享的中间状态。放一起会让
 * 那个文件从 230 行涨到 300 行，而它已经够长了。
 */

import { request } from './host.ts'
import type { SettingsSection } from './settingTypes.ts'

export type { FieldKind, SettingsField, SettingsSection } from './settingTypes.ts'

/** 一次设置全景。 */
export interface SettingsSnapshot {
  sections: SettingsSection[]
  user: Record<string, Record<string, unknown>>
  totals: { sections: number; fields: number; unregistered: number }
}

/** 读设置全景。段与字段的声明、用户层改动一次全给。 */
export async function getSettings(): Promise<SettingsSnapshot> {
  return await request<SettingsSnapshot>('/api/settings')
}

/**
 * 写一个字段。
 *
 * @param section 段 id（配置里的 kebab 写法）。
 * @param key 字段键（同样是 kebab）。
 * @param value 新值。`undefined` 表示删除这一层的设置、回落到默认值。
 */
export async function saveSetting(section: string, key: string, value: unknown): Promise<void> {
  // 显式区分「删键」与「写 undefined」：宿主按 `value` 字段是否存在判断，
  // 所以删键时整个字段都不能出现，不能写成 `value: undefined`
  // （JSON.stringify 会把它丢掉，但语义上要靠这里的 shape 表达清楚）。
  const body: Record<string, unknown> = { section, key }
  if (value !== undefined) body['value'] = value
  await request<{ ok: boolean }>('/api/settings', { method: 'POST', body })
}
