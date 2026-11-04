/**
 * 工具描述与参数解析。
 *
 * ## 四个工具为什么是「一次一个动作」
 *
 * 描述里逐字写了「一次只做一步」，因为模型最容易犯的错是「一次把整段流程点完」。
 * 提示词挡不住它，但**接口形状**能：`gui-click` 只收一个坐标，
 * 没有 `steps`、没有 `repeat`、没有 `then`。想点两下就得调两次，
 * 而第二次要重新观察、重新判定、重新过预算与限频。
 *
 * ## 参数解析为什么要「拒绝」而不是「夹紧」
 *
 * `x: "300"` 这种字符串坐标，夹紧会变成 `NaN` 或 `0`，然后**点到屏幕左上角**——
 * 那里正好是苹果菜单。宁可回 `bad-arg` 让它重写一次。
 */

import type { Config } from './settings.js'
import type { ParamSpec, Point, ToolDescriptor, ToolKey } from './types.js'
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
 * @param settings 配置（超时与上限从这里取，不写第二份）。
 */
export function descriptorOf(key: ToolKey, settings: Config): ToolDescriptor {
  const name = TOOL_NAMES[key]
  if (key === 'observe') {
    const params: Readonly<Record<string, ParamSpec>> = Object.freeze({})
    return {
      name,
      title: '看屏幕',
      description:
        '看一眼当前屏幕与前台应用，返回屏幕尺寸、前台应用名、表单状态。**只读**，不改任何东西。' +
        '每次决定点哪里之前都先调它一次：旧观察会在 30 秒后失效。',
      mutates: false,
      timeoutMs: settings.observeTimeoutMs,
      parameters: params,
    }
  }
  if (key === 'click') {
    const params: Readonly<Record<string, ParamSpec>> = Object.freeze({
      x: { type: 'number', required: true, description: '横坐标（像素，左上原点）' },
      y: { type: 'number', required: true, description: '纵坐标（像素，左上原点）' },
    })
    return {
      name,
      title: '点一下',
      description:
        '在指定坐标点一下鼠标。**一次只点一下**：没有双击、没有拖拽、没有「点完接着打字」。' +
        '坐标必须来自刚才那次观察；落在危险区（菜单栏/窗口按钮/Dock）会被直接拒绝。' +
        '可能返回「需要用户确认」——那不是失败，是等你把票号交给界面。',
      mutates: true,
      timeoutMs: settings.actTimeoutMs,
      parameters: params,
    }
  }
  if (key === 'type') {
    const params: Readonly<Record<string, ParamSpec>> = Object.freeze({
      text: { type: 'string', required: true, description: `要输入的文本（不超过 ${settings.textMax} 字）` },
    })
    return {
      name,
      title: '输入文本',
      description:
        '往当前焦点里输入一段文本。**不会先点击**：输入框得已经被选中（可以先 gui-click 一次）。' +
        '风险等级 high，默认需要用户确认；表单状态未知时也会被拦——别在别人填了一半的表单上打字。',
      mutates: true,
      timeoutMs: settings.actTimeoutMs,
      parameters: params,
    }
  }
  const params: Readonly<Record<string, ParamSpec>> = Object.freeze({
    key: { type: 'string', required: true, description: '键名，例如 enter / escape / tab / cmd-s' },
  })
  return {
    name,
    title: '按一个键',
    description:
      '按一个组合键。键名只允许小写字母开头、由小写字母/数字/连字符组成（`cmd-s`、`escape`）。' +
      '风险等级 high：`cmd-q`、`cmd-w`、`cmd-enter` 都在这一类里。',
    mutates: true,
    timeoutMs: settings.actTimeoutMs,
    parameters: params,
  }
}

/**
 * 从参数里取坐标。
 * @param args 原始参数。
 */
export function pointOfArgs(args: unknown): Point | undefined {
  if (!isRecord(args)) return undefined
  const x = args['x']
  const y = args['y']
  if (typeof x !== 'number' || typeof y !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x, y }
}

/**
 * 从参数里取文本。
 * @param args 原始参数。
 */
export function textOfArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const text = args['text']
  return typeof text === 'string' ? text : undefined
}

/**
 * 从参数里取键名。
 * @param args 原始参数。
 */
export function keyOfArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const key = args['key']
  return typeof key === 'string' ? key : undefined
}
