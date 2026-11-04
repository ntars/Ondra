/**
 * 后端端口与「没有后端」的默认实现。
 *
 * ## 为什么本包不自带截屏与合成事件
 *
 * 手册与 master-plan 只说了旧项目**用了** `screencapture` 与 `osascript`，
 * **没给**具体命令、参数、权限声明与返回格式；而这两件事的细节决定成败：
 *
 * - `screencapture` 的参数决定截图有没有光标、是整屏还是窗口、输出是 PNG 还是 JPEG；
 * - `osascript` 的脚本要精确到 `System Events` 的哪个动作，写错一个字就是「静默什么都没发生」；
 * - 两者都依赖「辅助功能 / 屏幕录制」两项系统授权，未授权时的失败形态与「点错了」完全同形。
 *
 * 本仓（`desktop/packages`）里只有 `@ntars/ondra-native-command` 这个**库**
 * 提供了「无 shell 跑原生命令」的能力（其 README 的示例恰好是 `osascript`），
 * 但它是库不是插件服务键：本仓禁止跨包 import，也禁止装依赖。
 *
 * 所以：**端口化 + 明确原因码**。`NoRunner` 如实报 `no-runner`，
 * 而不是写一版「看起来能跑」的调用——那种版本的坏形态是「能连上、能截屏、
 * 但点击永远落空」，与「根本没接」在界面上完全同形（纪律 101）。
 *
 * ## 接进来要满足什么
 *
 * 1. `supports` 必须含 `observe`，否则本包仍判 `no-runner`；
 * 2. `act()` **只做一下**：不许内部重试、不许连点、不许自己 sleep 后补点；
 * 3. 坐标是**整屏像素**、左上原点；实现方负责换算到自己的坐标系；
 * 4. 失败要回 `RunnerResult.ok=false` 而不是抛错（抛了本包也会接住，但会丢原因）。
 */

import type { ActionKind, GuiRunner, Observation, RunnerActInput, RunnerOutcome, RunnerResult } from './types.js'

/** 空支持列表（冻结，防止实现方在运行期改它）。 */
const NO_SUPPORT: readonly ActionKind[] = Object.freeze([] as readonly ActionKind[])

/**
 * 「没有后端」的实现。
 *
 * 它存在本身就是信息：`status().runner === 'none'` 与 `reason === 'no-runner'`
 * 能让人立刻分清「没接后端」与「后端坏了」——两者的排查方向完全相反。
 */
export class NoRunner implements GuiRunner {
  /** 来源名。 */
  readonly id = 'none'
  /** 什么都不支持。 */
  readonly supports: readonly ActionKind[] = NO_SUPPORT

  /**
   * 看一眼（永远失败）。
   * @param _timeoutMs 超时（未使用）。
   */
  async observe(_timeoutMs: number): Promise<RunnerResult<Observation>> {
    return {
      ok: false,
      reason: 'no-runner',
      detail: '没有图形界面后端：本包只做判定与审计，不做截屏。',
    }
  }

  /**
   * 做一个动作（永远失败）。
   * @param _input 动作（未使用）。
   * @param _timeoutMs 超时（未使用）。
   */
  async act(_input: RunnerActInput, _timeoutMs: number): Promise<RunnerResult<RunnerOutcome>> {
    return {
      ok: false,
      reason: 'no-runner',
      detail: '没有图形界面后端：本包不会真的点鼠标或敲键盘。',
    }
  }
}

/**
 * 判后端是否可用（有 `observe` 才算）。
 * @param runner 后端。
 */
export function runnerReady(runner: GuiRunner): boolean {
  return runner.supports.includes('observe')
}
