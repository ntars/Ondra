/**
 * 纯判定：**不碰 ctx、不碰 fs、不碰定时器**。
 *
 * 抽出来的理由只有一个：托管逻辑里最贵的错误是「该停的没停」「该重试的无限重试」，
 * 这两类都能用一个纯函数判定，也就能在禁实装的前提下逐条推演。
 *
 * 本文件里的每个函数都在 README「纯逻辑对拍」一节有对应用例。
 */

import { NAME_RE } from './types.js'
import type { ChildHandleLike, HostPhase, HostReason } from './types.js'

/**
 * 名字是否合规。
 *
 * 与 §8.4 同一条正则：托管项名会进状态文件名，带 `/` 或 `..` 就能写出目录外。
 * 这条校验不是洁癖，是**路径穿越的唯一闸门**。
 * @param name 托管项名。
 */
export function isValidName(name: string): boolean {
  return NAME_RE.test(name)
}

/**
 * 重启决策。
 *
 * 规则只有一条：**已重启次数用满就停**。`maxRestarts: 0` 表示崩了不重启。
 * 刻意不做「指数退避到无限」——那正是「死循环烧 CPU」的标准形状（手册 §8.2 三次跳闸同源）。
 * @param restarts 已重启次数。
 * @param maxRestarts 允许的重启次数。
 */
export function decideRestart(
  restarts: number,
  maxRestarts: number,
): { readonly restart: boolean; readonly reason?: HostReason } {
  if (restarts >= maxRestarts) return { restart: false, reason: 'crash-limit' }
  return { restart: true }
}

/**
 * 这次退出算不算「秒退」。
 *
 * 只影响话术，**不放宽预算**：给用户看的句子从「它退出了」变成
 * 「它起来 300 毫秒就退出了，八成是二进制或参数不对」，但重启次数照旧扣。
 * 把「秒退」当成「可以多试几次」的理由，就是给崩溃循环开后门。
 * @param uptimeMs 存活时长。
 * @param minUptimeMs 判据。
 */
export function crashedFast(uptimeMs: number, minUptimeMs: number): boolean {
  return uptimeMs < minUptimeMs
}

/**
 * 防御式取 pid。
 *
 * **上游 `SubprocessHandle` 没有 pid**（见 `types.ts` 的对照表）。这里只做一件事：
 * 实现万一挂了 `pid`，就把它读出来写进 pidfile；没挂就返回 `null`。
 *
 * 三条纪律：
 * 1. 只读一次，不轮询；
 * 2. 必须是正整数才算数（`0` / `NaN` / 字符串一律当没有）；
 * 3. 结果**不参与任何控制流**——组杀走 `terminate()`，从不 `kill(pid)`。
 *    这样即使这个字段是错的，也不会杀错进程。
 * @param handle 子进程句柄。
 */
export function probePid(handle: ChildHandleLike): number | null {
  const candidate: unknown = (handle as { readonly pid?: unknown }).pid
  if (typeof candidate !== 'number') return null
  if (!Number.isInteger(candidate) || candidate <= 0) return null
  return candidate
}

/**
 * 把阶段翻成一句给人看的话。
 *
 * 界面与日志共用这一处：两处各写一份，迟早出现「界面说已停止、日志说已崩溃」。
 * @param phase 阶段。
 */
export function describePhase(phase: HostPhase): string {
  switch (phase) {
    case 'idle':
      return '还没启动过'
    case 'running':
      return '在跑'
    case 'restarting':
      return '退出了，正在重启'
    case 'stopped':
      return '已停止（是我让它停的）'
    case 'failed':
      return '停了，而且不会再自动重启'
  }
}

/**
 * 把原因码翻成一句**能照做**的话。
 *
 * 手册 §6.6「拒绝提示从『禁止』改成『指路』」——原因码只给开发者，用户要看的是下一步。
 * @param reason 原因码。
 */
export function describeReason(reason: HostReason): string {
  switch (reason) {
    case 'disabled':
      return '托管开关关着，去设置里打开 `enable`'
    case 'no-subprocess':
      return '宿主没提供 `subprocess` 服务，装 `ondra-subprocess` 才有托管能力'
    case 'duplicate':
      return '这个名字已经在托管了；要换参数先 `stop()`'
    case 'bad-name':
      return '名字只能用 `a-z0-9_-`，且以字母开头（它会变成文件名）'
    case 'no-argv':
      return '`argv` 是空的，至少给一个可执行文件'
    case 'spawn-failed':
      return '起不来：路径、权限、参数三处先看一遍（完整原因在日志里）'
    case 'crash-limit':
      return '重启次数用完了，不再自动试；修好再 `start()`'
    case 'timeout':
      return '组杀已发出，但没在超时内等到静默——别急着重启，先确认端口已释放'
    case 'not-found':
      return '没有这个托管项'
    case 'disposed':
      return '插件已卸载，托管全停了'
  }
}

/**
 * 拼一句状态摘要。
 * @param name 托管项名。
 * @param phase 阶段。
 * @param restarts 已重启次数。
 * @param pid pid（可能为 null）。
 */
export function summarize(name: string, phase: HostPhase, restarts: number, pid: number | null): string {
  const tail = pid === null ? '' : `，pid ${pid}`
  const again = restarts === 0 ? '' : `，已重启 ${restarts} 次`
  return `${name}：${describePhase(phase)}${again}${tail}`
}

/**
 * 状态文件名。
 *
 * 名字已过 `isValidName`，所以这里不再做二次清洗——**清洗函数是第二个真源**，
 * 一旦两处规则不一致，就会出现「校验过的名字写到了另一个文件」。
 * @param name 托管项名。
 * @param suffix 后缀（`.json` 或 `.pid`）。
 */
export function fileNameOf(name: string, suffix: '.json' | '.pid'): string {
  return `${name}${suffix}`
}
