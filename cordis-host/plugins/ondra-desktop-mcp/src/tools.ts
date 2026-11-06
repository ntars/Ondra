/**
 * 工具描述表与参数校验。
 *
 * 两条纪律：
 *
 * 1. **越界一律拒绝，不夹紧**（与 O-069 同口径）。`limit: 500` 若被悄悄改成 50，
 *    调用方会在「只有 50 条」的假事实上继续推理，而没有任何地方报错。
 * 2. **参数表里没有的东西，就是做不到的事**。`processes` 没有 `includeCommandLine`、
 *    `clipboard` 没有 `includeText`——不是没实现，是**不提供这个参数**。
 *    少一个参数比多一行「出于隐私我们不返回」的说明可靠得多。
 */

import type { Config } from './settings.js'
import { LIMIT_FLOOR } from './settings.js'
import type { ParamSpec, SortKey, ToolDescriptor, ToolKey } from './types.js'
import {
  FILE_DEPTH_CEIL,
  FILE_LIMIT_CEIL,
  KEYWORD_MAX,
  KEYWORD_MIN,
  LIMIT_CEIL,
  TOOL_NAMES,
} from './types.js'

/** 参数表（每个工具固定，与配置无关）。 */
const PARAMS: Readonly<Record<ToolKey, Readonly<Record<string, ParamSpec>>>> = Object.freeze({
  processes: Object.freeze({
    limit: { type: 'number', description: '条数（1–50）', min: LIMIT_FLOOR, max: LIMIT_CEIL },
    sort: { type: 'string', description: '排序：cpu / mem / name', values: Object.freeze(['cpu', 'mem', 'name']) },
  }),
  foreground: Object.freeze({}),
  clipboard: Object.freeze({}),
  findFiles: Object.freeze({
    keyword: {
      type: 'string',
      required: true,
      description: '文件名关键词（2–64 字，必填）',
    },
    depth: { type: 'number', description: '深度（1–2 层）', min: 1, max: FILE_DEPTH_CEIL },
    limit: { type: 'number', description: '条数（1–30）', min: LIMIT_FLOOR, max: FILE_LIMIT_CEIL },
  }),
  sysinfo: Object.freeze({}),
} satisfies Readonly<Record<ToolKey, Readonly<Record<string, ParamSpec>>>>)

/** 中文短标题。 */
const TITLES: Readonly<Record<ToolKey, string>> = Object.freeze({
  processes: '进程列表',
  foreground: '前台应用',
  clipboard: '剪贴板元信息',
  findFiles: '文件检索',
  sysinfo: '系统状态',
})

/**
 * 给模型看的能力说明。
 *
 * 每一条都显式写「只读」与「不返回什么」——**说明里省掉的那半句，模型会自己编**。
 * 例如不写「不含命令行」，模型很可能在回答里补一个「它运行的命令是 …」。
 */
const DESCRIPTIONS: Readonly<Record<ToolKey, string>> = Object.freeze({
  processes:
    '只读：列出正在运行的进程（名字 / 进程号 / CPU / 内存）。**不返回命令行参数**——命令行里常有 token 与路径。',
  foreground: '只读：当前前台应用的名称与（可关闭的）窗口标题。',
  clipboard: '只读：剪贴板的形态与长度（类型 / 字符数 / 行数）。**不返回剪贴板内容**。',
  findFiles:
    '只读：在指定的几个目录下按文件名关键词检索（最多 2 层、最多 30 条）。**不读文件内容**，只给名字与大小。',
  sysinfo: '只读：系统状态（平台 / 核数 / 内存 / 负载 / 开机时长 / 电量）。',
})

/**
 * 构造模型侧可见的工具描述。
 * @param settings 已补全的配置。
 */
export function buildDescriptors(settings: Config): readonly ToolDescriptor[] {
  const out: ToolDescriptor[] = []
  for (const key of settings.enabledTools) {
    out.push(
      Object.freeze({
        name: TOOL_NAMES[key],
        title: TITLES[key],
        description: DESCRIPTIONS[key],
        readOnly: true as const,
        timeoutMs: settings.callTimeoutMs,
        parameters: PARAMS[key],
      }),
    )
  }
  return Object.freeze(out)
}

/** 归一化后的参数（按工具区分，字段名与端口入参逐字一致）。 */
export type NormalizedArgs =
  | { readonly tool: 'processes'; readonly limit: number; readonly sort: SortKey }
  | { readonly tool: 'foreground' }
  | { readonly tool: 'clipboard' }
  | { readonly tool: 'findFiles'; readonly keyword: string; readonly depth: number; readonly limit: number }
  | { readonly tool: 'sysinfo' }

/** 参数校验结论。 */
export type ArgsVerdict =
  | { readonly ok: true; readonly args: NormalizedArgs }
  | { readonly ok: false; readonly detail: string }

/**
 * 取一个整数参数。
 *
 * 缺省回退、越界拒绝、类型不对拒绝——三件事分开判，不合并成一次 `Number()`。
 * `Number('')` 是 0、`Number('12abc')` 是 NaN，合并判会把「没填」与「填错」混成一类。
 * @param node 参数对象。
 * @param key 键。
 * @param fallback 缺省值。
 * @param min 下界。
 * @param max 上界。
 */
function intOf(
  node: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly detail: string } {
  const raw = node[key]
  if (raw === undefined || raw === null) return { ok: true, value: fallback }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, detail: `${key} 必须是数字（收到 ${typeof raw}）` }
  }
  const value = Math.trunc(raw)
  if (value < min || value > max) return { ok: false, detail: `${key} 必须在 ${min}–${max} 之间（收到 ${value}）` }
  return { ok: true, value }
}

/**
 * 校验并归一化一次调用的参数。
 * @param tool 工具名（连字符形式）。
 * @param value 模型给的参数。
 * @param settings 已补全的配置。
 */
export function normalizeArgs(tool: string, value: unknown, settings: Config): ArgsVerdict {
  const node: Readonly<Record<string, unknown>> =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}

  if (tool === TOOL_NAMES.processes) {
    const limit = intOf(node, 'limit', settings.defaultLimit, LIMIT_FLOOR, LIMIT_CEIL)
    if (!limit.ok) return { ok: false, detail: limit.detail }
    const rawSort = node['sort']
    let sort: SortKey = settings.sort
    if (rawSort !== undefined && rawSort !== null) {
      if (rawSort !== 'cpu' && rawSort !== 'mem' && rawSort !== 'name') {
        return { ok: false, detail: 'sort 只能是 cpu / mem / name' }
      }
      sort = rawSort
    }
    return { ok: true, args: { tool: 'processes', limit: limit.value, sort } }
  }

  if (tool === TOOL_NAMES.foreground) return { ok: true, args: { tool: 'foreground' } }
  if (tool === TOOL_NAMES.clipboard) return { ok: true, args: { tool: 'clipboard' } }
  if (tool === TOOL_NAMES.sysinfo) return { ok: true, args: { tool: 'sysinfo' } }

  if (tool === TOOL_NAMES.findFiles) {
    const rawKeyword = node['keyword']
    if (typeof rawKeyword !== 'string') return { ok: false, detail: 'keyword 必填，且必须是字符串' }
    const keyword = rawKeyword.trim()
    if (keyword.length < KEYWORD_MIN) {
      return { ok: false, detail: `keyword 至少 ${KEYWORD_MIN} 个字（一个字会把几乎所有文件都算命中）` }
    }
    if (keyword.length > KEYWORD_MAX) return { ok: false, detail: `keyword 最多 ${KEYWORD_MAX} 个字` }
    const depth = intOf(node, 'depth', settings.findDepth, 1, FILE_DEPTH_CEIL)
    if (!depth.ok) return { ok: false, detail: depth.detail }
    const limit = intOf(node, 'limit', settings.findLimit, LIMIT_FLOOR, FILE_LIMIT_CEIL)
    if (!limit.ok) return { ok: false, detail: limit.detail }
    return { ok: true, args: { tool: 'findFiles', keyword, depth: depth.value, limit: limit.value } }
  }

  return { ok: false, detail: `没有这个工具：${tool}` }
}
