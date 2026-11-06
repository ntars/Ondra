/**
 * 五个只读工具的描述与参数校验。**模型看到的就是这里的字。**
 *
 * ## 描述为什么反复写「只读」
 *
 * 模型会读描述来决定要不要调。描述里若只写「读取通知」，它与「清空通知」在
 * 字面上差别不大；写上「不会修改设备上的任何内容」之后，它至少不会指望这个工具
 * 能替用户点掉通知。这是**给模型的护栏**，不是给人看的装饰。
 *
 * ## 参数校验为什么不用「夹紧」而用「拒绝」
 *
 * `limit: 500` 若被悄悄夹成 50，调用方（模型或界面）会以为拿到了 500 条，
 * 于是在「只有 50 条」的事实上继续推理。宁可返回 `bad-arg` 并写清范围，
 * 让调用方自己改成 50——错要错在明处。
 *
 * ## 联系人的关键词为什么必填
 *
 * 通讯录是五个能力里唯一「一次能拿走一群人」的那一个。
 * 关键词必填 + 上限 20 条，等于把「整本通讯录」这件事从接口层面取消掉。
 * 这不是可以靠文档劝阻的事——接口不给，就没得商量。
 */

import type { ParamSpec, ToolDescriptor, ToolKey } from './types.js'
import {
  CONTACT_LIMIT_CEIL,
  DEFAULT_LIMIT,
  LIMIT_CEIL,
  QUERY_MAX,
  QUERY_MIN,
  TOOL_KEYS,
  TOOL_NAMES,
} from './types.js'

/** `limit` 参数规格（各工具共用同一段文案）。 */
const LIMIT_PARAM: ParamSpec = Object.freeze({
  type: 'number',
  description: '最多返回几条（1–50，默认 10）。越界会被拒绝，不会悄悄截断。',
  min: 1,
  max: LIMIT_CEIL,
})

/**
 * 生成五个工具描述。
 * @param timeoutMs 单次超时（写进描述，让模型知道等多久）。
 */
export function buildDescriptors(timeoutMs: number): readonly ToolDescriptor[] {
  const descriptors: readonly ToolDescriptor[] = [
    {
      name: TOOL_NAMES.notifications,
      title: '手机通知',
      description:
        '读取手机当前的通知列表（应用名 + 标题，默认不含正文）。**只读**：不会清空、点击或折叠任何通知。',
      readOnly: true,
      timeoutMs,
      parameters: { limit: LIMIT_PARAM },
    },
    {
      name: TOOL_NAMES.sms,
      title: '手机短信',
      description:
        '读取手机收件箱里的短信（默认只读未读）。**只读**：不会标记已读、不会发送、不会删除。正文可能被截断，看 truncated 字段。',
      readOnly: true,
      timeoutMs,
      parameters: {
        limit: LIMIT_PARAM,
        unreadOnly: {
          type: 'boolean',
          description: '只看未读（默认 true）。传 false 才读全部。',
        },
      },
    },
    {
      name: TOOL_NAMES.contacts,
      title: '手机联系人',
      description:
        '按关键词搜索联系人（姓名或号码包含关键词）。**只读**，且**必须给关键词**——不支持「把通讯录列出来」。号码默认打码。',
      readOnly: true,
      timeoutMs,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '搜索关键词（1–64 字）。必填：接口不提供「全量导出通讯录」。',
        },
        limit: {
          type: 'number',
          description: '最多返回几条（1–20，默认 10）。联系人条数上限比其它能力更低。',
          min: 1,
          max: CONTACT_LIMIT_CEIL,
        },
      },
    },
    {
      name: TOOL_NAMES.battery,
      title: '手机电量',
      description: '读取电量百分比、是否在充电、电池温度。**只读**。',
      readOnly: true,
      timeoutMs,
      parameters: {},
    },
    {
      name: TOOL_NAMES.foreground,
      title: '前台应用',
      description: '读取当前前台应用的包名与界面名。**只读**：不截屏、不取界面内容、不模拟点击。',
      readOnly: true,
      timeoutMs,
      parameters: {},
    },
  ]
  return Object.freeze(descriptors)
}

/** 归一化后的参数（按能力分派用）。 */
export type NormalizedArgs =
  | { readonly kind: 'notifications'; readonly limit: number }
  | { readonly kind: 'sms'; readonly limit: number; readonly unreadOnly: boolean }
  | { readonly kind: 'contacts'; readonly query: string; readonly limit: number }
  | { readonly kind: 'battery' }
  | { readonly kind: 'foreground' }

/** 参数校验结论。 */
export type ArgsVerdict =
  | { readonly ok: true; readonly value: NormalizedArgs }
  | { readonly ok: false; readonly detail: string }

/**
 * 从能力键找工具名。
 * @param tool 工具名（连字符）。
 */
export function keyOf(tool: string): ToolKey | undefined {
  for (const key of TOOL_KEYS) {
    if (TOOL_NAMES[key] === tool) return key
  }
  return undefined
}

/**
 * 读一个正整数参数。越界 / 类型错一律拒绝。
 * @param args 原始参数。
 * @param name 参数名。
 * @param fallback 缺省值。
 * @param ceil 该参数自己的上界。
 */
function readLimit(args: Record<string, unknown>, name: string, fallback: number, ceil: number): number | string {
  const given = args[name]
  if (given === undefined) return fallback
  if (typeof given !== 'number' || !Number.isFinite(given)) return name + ' 必须是数字'
  const value = Math.trunc(given)
  if (value !== given) return name + ' 必须是整数'
  if (value < 1 || value > ceil) return name + ' 必须在 1–' + String(ceil) + ' 之间'
  return value
}

/**
 * 校验并归一化参数。
 * @param tool 工具名。
 * @param args 模型给的参数（可空）。
 * @param defaultLimit 默认条数。
 */
export function normalizeArgs(tool: string, args: unknown, defaultLimit: number = DEFAULT_LIMIT): ArgsVerdict {
  const key = keyOf(tool)
  if (key === undefined) return { ok: false, detail: '没有这个工具：' + tool }

  let record: Record<string, unknown> = {}
  if (args !== undefined && args !== null) {
    if (typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, detail: '参数必须是一个对象' }
    }
    record = args as Record<string, unknown>
  }

  if (key === 'battery') return { ok: true, value: { kind: 'battery' } }
  if (key === 'foreground') return { ok: true, value: { kind: 'foreground' } }

  if (key === 'notifications') {
    const limit = readLimit(record, 'limit', defaultLimit, LIMIT_CEIL)
    if (typeof limit === 'string') return { ok: false, detail: limit }
    return { ok: true, value: { kind: 'notifications', limit } }
  }

  if (key === 'sms') {
    const limit = readLimit(record, 'limit', defaultLimit, LIMIT_CEIL)
    if (typeof limit === 'string') return { ok: false, detail: limit }
    const unread = record['unreadOnly']
    if (unread !== undefined && typeof unread !== 'boolean') {
      return { ok: false, detail: 'unreadOnly 必须是布尔值' }
    }
    return { ok: true, value: { kind: 'sms', limit, unreadOnly: unread === undefined ? true : unread } }
  }

  // contacts：关键词必填（见文件头）。
  const query = record['query']
  if (typeof query !== 'string') return { ok: false, detail: '联系人必须给 query 关键词（不提供全量导出）' }
  const text = query.trim()
  if (text.length < QUERY_MIN || text.length > QUERY_MAX) {
    return { ok: false, detail: 'query 长度必须在 ' + String(QUERY_MIN) + '–' + String(QUERY_MAX) + ' 之间' }
  }
  const limit = readLimit(record, 'limit', defaultLimit, CONTACT_LIMIT_CEIL)
  if (typeof limit === 'string') return { ok: false, detail: limit }
  return { ok: true, value: { kind: 'contacts', query: text, limit } }
}
