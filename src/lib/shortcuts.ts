/**
 * 快捷键：唯一真源。
 *
 * ## 为什么要有这个文件
 *
 * 如果每条键在两处各写一遍「⌘K」和 `event.key === 'k'`，迟早出现
 * 「表上写 ⌘K、实际要按 ⌘Shift+K」这类不一致。
 *
 * 所以：**键位只在这里定义一次**，界面提示与事件匹配都从 `SHORTCUTS` 读。
 *
 * ## 历史注记
 *
 * 2.3.0 移除了快捷键总表（`Cmd/Ctrl + /` 的速查浮层）：组合键数量有限、
 * 且都已在各自的入口旁露出，一张总表的维护成本高于查阅价值。
 * 本文件因此只剩「事件匹配」这一个消费者。
 *
 * ## 两条平台规则
 *
 * 1. 修饰键只有一处差异：macOS 用 `Cmd`，Windows / Linux 用 `Ctrl`。
 *    不做交叉映射（不是 `Cmd` 也能用 `Ctrl`），否则同一操作有两个说法。
 * 2. `key` 比较一律小写：`Cmd+Shift+C` 在按下 Shift 时 `event.key`
 *    是 `'C'`，不按 Shift 是 `'c'`。比较前统一转小写，免得每处各写
 *    `key === 'C' || key === 'c'`。
 */

import { isMac } from './platform.ts'

/** 一条快捷键的定义。 */
export interface Shortcut {
  /** 稳定标识。事件处理用它分支，不用键位字符串。 */
  id: ShortcutId
  /** 中文名。菜单项与总表共用。 */
  label: string
  /** 主键。小写，与 `KeyboardEvent.key` 的小写形式一致。 */
  key: string
  /** 是否需要平台修饰键（macOS 的 `Cmd` / 其余 `Ctrl`）。 */
  mod: boolean
  shift?: boolean
  /** 键位提示。`mod` 为真时按平台渲染 `⌘` 或 `Ctrl+`。 */
  hint: string
}

/** 全部快捷键的标识。 */
export type ShortcutId =
  | 'send'
  | 'newline'
  | 'sendAlt'
  | 'newSession'
  | 'searchMemory'
  | 'rail'
  | 'preferences'
  | 'closeLayer'
  | 'inspector'
  | 'stop'
  | 'editLast'
  | 'jumpLatest'
  | 'cycleTheme'
  | 'copyLast'

/**
 * §9.1 的完整表。
 *
 * 顺序即总表的显示顺序，不另排。带 `rail` 的那条是「切换 Rail 项」，
 * 主键是数字 1–3（§5.2：会话 / 日志 / 扩展三个抽屉，齿轮走 `preferences`），
 * 所以这里 `key` 留空串，匹配交给 `Rail.tsx` 的数字分支。
 */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'send', label: '发送', key: 'enter', mod: false, hint: 'Enter' },
  { id: 'newline', label: '换行', key: 'enter', mod: false, shift: true, hint: 'Shift+Enter' },
  { id: 'sendAlt', label: '另一种发送', key: 'enter', mod: true, hint: 'mod+Enter' },
  { id: 'newSession', label: '清空对话', key: 'n', mod: true, hint: 'mod+N' },
  { id: 'searchMemory', label: '搜索记忆', key: 'k', mod: true, hint: 'mod+K' },
  { id: 'rail', label: '切换左侧入口', key: '', mod: true, hint: 'mod+1..3' },
  { id: 'preferences', label: '偏好设置', key: ',', mod: true, hint: 'mod+,' },
  { id: 'closeLayer', label: '关闭当前层', key: 'escape', mod: false, hint: 'Esc' },
  { id: 'inspector', label: '打开或关闭检查器', key: 'i', mod: true, shift: true, hint: 'mod+Shift+I' },
  { id: 'stop', label: '停止生成', key: 'escape', mod: false, hint: 'Esc' },
  { id: 'editLast', label: '编辑上一条', key: 'arrowup', mod: false, hint: '↑' },
  { id: 'jumpLatest', label: '跳到最新', key: 'arrowdown', mod: true, hint: 'mod+↓' },
  { id: 'cycleTheme', label: '切换主题', key: 'l', mod: true, shift: true, hint: 'mod+Shift+L' },
  { id: 'copyLast', label: '复制最后一条回复', key: 'c', mod: true, shift: true, hint: 'mod+Shift+C' },
]

/**
 * 把 `mod` / `mod+Shift+X` 这样的模板渲染成平台键位。
 *
 * 修饰键之间统一用 `+` 分隔，界面按 `+` 切成一个个键帽。macOS 用符号
 * （`⌘+Shift+I`），其余用单词（`Ctrl+Shift+I`）——这是两端的既有习惯，
 * 强行统一反而让一边觉得陌生。
 *
 * @param hint `Shortcut.hint`。
 * @returns 可直接显示的键位提示。
 */
export function formatHint(hint: string): string {
  if (!hint.includes('mod')) return hint
  return isMac() ? hint.replace('mod', '⌘') : hint.replace('mod', 'Ctrl')
}

/**
 * 把键位提示切成键帽。
 *
 * `'⌘+Shift+I'` → `['⌘', 'Shift', 'I']`。切不出多段时原样返回一段，
 * 调用方不必判长度。
 *
 * @param hint `Shortcut.hint`。
 * @returns 每个键帽的文字。
 */
export function keycaps(hint: string): string[] {
  return formatHint(hint).split('+').filter((part) => part !== '')
}

/** 按 id 取键位提示。取不到返回空串，界面不显示错的键位。 */
export function hintOf(id: ShortcutId): string {
  const found = SHORTCUTS.find((item) => item.id === id)
  return found === undefined ? '' : formatHint(found.hint)
}

/** 一次按键的解析结果。 */
export interface KeyContext {
  /** 平台修饰键是否按下。 */
  mod: boolean
  shift: boolean
  alt: boolean
  /** 小写的 `event.key`。 */
  key: string
}

/**
 * 从原生事件取出用于匹配的上下文。
 *
 * @param event 键盘事件。
 * @returns 归一化后的按键上下文。
 */
export function keyContext(event: KeyboardEvent): KeyContext {
  return {
    mod: isMac() ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    key: event.key.toLowerCase(),
  }
}

/**
 * 判断一次按键是否命中某条快捷键。
 *
 * 三个修饰键都要**精确**比较：多按一个 `Shift` 就不算命中。
 * 宽松匹配会让 `Cmd+Shift+C` 同时触发 `Cmd+C`，而后者在消息区
 * 意味着「复制整段」，用户按一个组合键得到两件事。
 *
 * @param context 归一化后的按键。
 * @param id 目标快捷键。
 * @returns 是否命中。
 */
export function matches(context: KeyContext, id: ShortcutId): boolean {
  const shortcut = SHORTCUTS.find((item) => item.id === id)
  if (shortcut === undefined || shortcut.key === '') return false
  if (shortcut.key !== context.key) return false
  if (shortcut.mod !== context.mod) return false
  if ((shortcut.shift ?? false) !== context.shift) return false
  // 任何快捷键都不接受 Alt：Alt 在各平台是输入法或菜单的修饰键。
  return !context.alt
}

/** 焦点是否在可输入的地方。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
