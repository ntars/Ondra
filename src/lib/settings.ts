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

/**
 * 读设置全景。段与字段的声明、用户层改动一次全给。
 *
 * ## 为什么要在边界上验一次形状
 *
 * 宿主版本不一致时，这个接口可能返回 `{ ok: true }` 或某个字段缺失。
 * 界面拿到之后会直接 `Object.keys(snapshot.user)`，遇到 `undefined`
 * 抛 `TypeError`——而 React 在渲染期抛错会**卸载整棵树**，用户看到的是
 * 白屏，不是「读不到设置」。
 *
 * 所以把畸形响应当成失败抛出：`Settings.tsx` 已有 `failed` 分支，
 * 会显示原因加重试。错误在边界上变成一句人话，比在渲染里炸成白屏好。
 *
 * @returns 结构可信的设置快照。
 * @throws 响应结构不符合预期时抛错。
 */
export async function getSettings(): Promise<SettingsSnapshot> {
  const raw = await request<Partial<SettingsSnapshot>>('/api/settings')
  if (raw === null || typeof raw !== 'object') throw new Error('设置接口返回了空响应')
  if (!Array.isArray(raw.sections)) throw new Error('设置接口缺少 sections')
  if (raw.user === null || typeof raw.user !== 'object' || Array.isArray(raw.user)) {
    throw new Error('设置接口缺少 user')
  }
  const totals = raw.totals
  return {
    sections: raw.sections,
    user: raw.user,
    totals: {
      sections: typeof totals?.sections === 'number' ? totals.sections : raw.sections.length,
      fields: typeof totals?.fields === 'number' ? totals.fields : 0,
      unregistered: typeof totals?.unregistered === 'number' ? totals.unregistered : 0,
    },
  }
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
