/**
 * 观察结果的整形：**把后端给的东西收成契约，再决定它够不够用来做决策**。
 *
 * 后端是外部实现（见 README 限制 1），它可能给：
 *
 * - 缺字段（只给了截图，没给前台应用）；
 * - 类型不对（`width: "1512"`）；
 * - 尺寸为 0（窗口最小化、权限没给、虚拟显示器没就绪）。
 *
 * 三种都必须在这里被挡住。放过去的表现是「坐标换算全错但流程全绿」：
 * `x / 0` 得到 `Infinity`，落不进任何危险区，于是**黑名单静默失效**。
 *
 * ## 为什么正文里没有截图路径
 *
 * 观察正文会进模型上下文。路径形如 `/Users/<用户名>/…`，
 * 用户名、项目名、客户名都可能出现在里面。需要看图的是视觉通道，
 * 它有自己的入口；本结构只交「有没有截到、多大」。
 */

import type { FormState, Observation } from './types.js'

/** 表单状态的中文说法（面板与正文共用，避免两处各写一份）。 */
const FORM_LABEL: Readonly<Record<FormState, string>> = Object.freeze({
  none: '没有表单',
  filled: '有已填表单（红线：已收手）',
  unknown: '表单状态未知',
})

/**
 * 判「正数」。
 * @param value 待判值。
 */
function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 判空对象。
 * @param value 待判值。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把后端返回收成 `Observation`。
 *
 * 屏幕尺寸不合法时返回 `null`——**没有尺寸就没有坐标系**，
 * 后续任何坐标判定都失去意义，宁可判「这次没看到」。
 * @param raw 后端返回。
 * @param fallbackAt 后端没给时刻时的兜底（通常是调用时刻）。
 */
export function normalizeObservation(raw: unknown, fallbackAt: number): Observation | null {
  if (!isRecord(raw)) return null

  const screen = raw['screen']
  if (!isRecord(screen)) return null
  const width = screen['width']
  const height = screen['height']
  if (!isPositive(width) || !isPositive(height)) return null

  const foregroundRaw = raw['foreground']
  const appRaw = isRecord(foregroundRaw) ? foregroundRaw['app'] : undefined
  const app = typeof appRaw === 'string' && appRaw.trim() !== '' ? appRaw.trim() : 'unknown'
  const titleRaw = isRecord(foregroundRaw) ? foregroundRaw['title'] : undefined
  const title = typeof titleRaw === 'string' && titleRaw.trim() !== '' ? titleRaw.trim() : undefined

  const formRaw = raw['formState']
  const formState: FormState =
    formRaw === 'none' || formRaw === 'filled' || formRaw === 'unknown' ? formRaw : 'unknown'

  const atRaw = raw['at']
  const at = isPositive(atRaw) ? atRaw : fallbackAt

  const bytesRaw = raw['screenshotBytes']
  const screenshotBytes = isPositive(bytesRaw) ? bytesRaw : undefined

  const observation: Observation = {
    at,
    screen: { width, height },
    foreground: title === undefined ? { app } : { app, title },
    formState,
    ...(screenshotBytes === undefined ? {} : { screenshotBytes }),
  }
  return observation
}

/**
 * 观察的模型可见正文。
 * @param observation 观察。
 */
export function describeObservation(observation: Observation): string {
  const lines: string[] = [
    `屏幕：${observation.screen.width}×${observation.screen.height}`,
    `前台：${observation.foreground.app}`,
    `表单：${FORM_LABEL[observation.formState]}`,
  ]
  if (observation.screenshotBytes === undefined) {
    lines.push('截图：无（后端没给画面，只能按前台应用与尺寸判断）')
  } else {
    lines.push(`截图：${Math.max(1, Math.round(observation.screenshotBytes / 1024))} KB`)
  }
  lines.push('坐标以左上角为原点、单位像素。一次只规划一步。')
  return lines.join('\n')
}
