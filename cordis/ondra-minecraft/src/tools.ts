/**
 * 工具描述与参数解析。
 *
 * ## 三个工具为什么只有这三个
 *
 * `minecraft-status`（只读）/ `minecraft-chat`（会被人看见）/ `minecraft-command`（管理员接口）。
 * 没有「移动」「挖掘」「打怪」——那些要么归驱动，要么属另一个量级的风险面。
 * 台账只写了「Mineflayer 接入（占位）」，没有能力清单，
 * 所以本包只开放「能对别人产生影响」这一层最小的三个入口，其余登记待裁决（README 限制 6）。
 *
 * ## 描述里反复出现的一句话
 *
 * 「未接入时**不会假装在线**」。这不是文案，是本包唯一能证明自己的地方：
 * 一个空壳插件最坏的行为不是「什么都不做」，而是「让模型以为她在游戏里」。
 */

import type { Config } from './settings.js'
import type { ParamSpec, ToolDescriptor, ToolKey } from './types.js'
import { TOOL_NAMES } from './types.js'

/**
 * 判空对象。
 * @param value 待判值。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 工具名 → 能力键。
 * @param tool 工具名。
 */
export function toolKeyOf(tool: string): ToolKey | undefined {
  const entry = (Object.entries(TOOL_NAMES) as readonly (readonly [ToolKey, string])[]).find(
    pair => pair[1] === tool,
  )
  return entry === undefined ? undefined : entry[0]
}

/**
 * 造一份工具描述。
 * @param key 能力键。
 * @param settings 配置（超时从这里取，不写第二份）。
 */
export function descriptorOf(key: ToolKey, settings: Config): ToolDescriptor {
  const name = TOOL_NAMES[key]
  if (key === 'status') {
    const params: Readonly<Record<string, ParamSpec>> = Object.freeze({})
    return {
      name,
      title: '看游戏状态',
      description:
        '读一眼当前在哪个服务器、生命与饥饿、坐标、在线人数与最近几条聊天。**只读**。' +
        '若本插件没有接上 Minecraft 驱动，会明确告诉你「没有驱动」——它不会假装在线。',
      mutates: false,
      timeoutMs: settings.connectTimeoutMs,
      parameters: params,
    }
  }
  if (key === 'chat') {
    const params: Readonly<Record<string, ParamSpec>> = Object.freeze({
      text: { type: 'string', required: true, description: `要说的内容（不超过 ${settings.chatMax} 字符）` },
    })
    return {
      name,
      title: '在游戏里说一句',
      description:
        `以她的名字在服务器公屏说一句（上限 ${settings.chatMax} 字符，协议上限 256，超过会直接掉线）。` +
        '一句话一条，不分条、不加前后缀。频率受限：两次之间至少 ' +
        `${settings.minSendIntervalMs} 毫秒，每分钟最多 ${settings.maxPerMinute} 条。`,
      mutates: true,
      timeoutMs: settings.connectTimeoutMs,
      parameters: params,
    }
  }
  const params: Readonly<Record<string, ParamSpec>> = Object.freeze({
    command: { type: 'string', required: true, description: '指令，例如 /list（指令名必须在允许列表里）' },
  })
  return {
    name,
    title: '发一条指令',
    description:
      '发一条 `/` 开头的服务器指令。**默认一个都不许**：`/` 是管理员接口，' +
      '`/kill`、`/op` 这类可能毁掉别人的存档。指令名必须在 command-allow-list 里，' +
      '且不允许选择器与串联字符（`@a`、`{}`、`;`、`|` 一律拒）。',
    mutates: true,
    timeoutMs: settings.connectTimeoutMs,
    parameters: params,
  }
}

/**
 * 从参数里取文本。
 * @param args 原始参数。
 * @param field 字段名。
 */
export function textOfArgs(args: unknown, field: string): string | undefined {
  if (!isRecord(args)) return undefined
  const value = args[field]
  return typeof value === 'string' ? value : undefined
}
