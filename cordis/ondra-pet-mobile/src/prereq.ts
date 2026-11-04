/**
 * 七条技术前提：**静态定义**（带出处）与**纯函数判定**。
 *
 * 这个文件是本插件的主体。它的价值不在于「跑起来」，而在于把手册分散在三处的原始事实
 * 变成一份**能被执行、也能被反驳**的清单：每条都有出处，判不了就写「判不了」。
 *
 * ## 为什么不用布尔
 *
 * 把「判不了」压进 `false`，用户会去修一个本来就没坏的东西；压进 `true`，
 * 用户会以为配好了然后在三端看到三份记忆。四值（`pass / fail / unverifiable / unshipped`）
 * 是这七条前提里唯一不失真的表示。
 *
 * ## 为什么 `local-api` 要同时看 `webServer` 与端口
 *
 * 手册语料给的链路是「HTTP API 监听 3000」，但端口号本身不是能力——真正的前提是
 * **本机有一个能被三端读到同一份数据的 HTTP 出口**。上游 `webServer` 提供这个出口
 * （`desktop/packages/host/webserver` 里 `ctx.webServer: WebServer`，已读源码确认）。
 * 端口只做形状校验：填 `0` 或 `70000` 时链路必然起不来，而那种错很难从日志里看出来。
 */

import type { Prereq, PrereqFacts, PrereqId, PrereqReport, PrereqResult } from './types.js'

/**
 * 七条前提。
 *
 * `source` 逐条落在手册正文或语料上；`hint` 逐条是**能执行的动作**（§6.6 指路纪律）。
 */
export const PREREQUISITES: readonly Prereq[] = Object.freeze([
  Object.freeze({
    id: 'memory-single-source' as PrereqId,
    title: '三端共用同一份记忆',
    required: true,
    source: '手册 §6.2 与语料庚-7：「桌宠/QQ/微信本是三种插件、记忆不共享……并不是同一只鱼」',
    hint: '装 O-010 `ondra-memory-core`。三端各存一份就是三只，再多的同步也补不回来——这是根因，不是优化项。',
  }),
  Object.freeze({
    id: 'pet-entry' as PrereqId,
    title: '桌宠端入口在位',
    required: true,
    source: '手册 §6.3 桌宠（三端之一）',
    hint: '装 O-074 `ondra-pet`。它开不开是另一件事——这里只要求「入口在」，否则三端只有两端。',
  }),
  Object.freeze({
    id: 'local-api' as PrereqId,
    title: '本机 HTTP 出口可用',
    required: true,
    source: '手册语料庚-5/庚-7：「HTTP API 监听 3000 端口」；上游 `desktop/packages/host/webserver` 提供 `ctx.webServer`',
    hint: '确认宿主带 `webServer`（桌面端默认带），并把 `apiPort` 填成 1–65535 之间的整数。',
  }),
  Object.freeze({
    id: 'ws-bridge' as PrereqId,
    title: 'WS 中继已接入',
    required: true,
    source: '手册语料庚-5/庚-7：「WS 服务端监听 3001 端口」+ 手册 §9.2 桥接安全',
    hint: '写一个 `PetMobileBridge`（`connect` / `disconnect`），用 `useBridge()` 接进来，再填 `relayUrl`。本仓不含实现。',
  }),
  Object.freeze({
    id: 'origin-check' as PrereqId,
    title: '允许来源已配置',
    required: true,
    source: '手册 §9.2：「任何本地 WS 桥接必须校验 Origin + 一次性 token」（CSWSH 教训）',
    hint: '在 `allowedOrigins` 里填三端各自的来源。**空清单等于全拒**：不填就启动，等于不校验 Origin。',
  }),
  Object.freeze({
    id: 'token-consistency' as PrereqId,
    title: '两侧 token 一致',
    required: false,
    source: '手册语料庚-7 三坑之三：「token 复制到 WS 服务端粘贴时误点『重新生成』导致两端 token 不一致」',
    hint: '别点「重新生成」。要确认是否一致，只能去桥的两侧看——本包只在一侧，**判不了**。',
  }),
  Object.freeze({
    id: 'mobile-client' as PrereqId,
    title: '手机客户端已发布',
    required: false,
    source: '手册 §1.11-07：三端体验承诺里「手机标『即将适配』」',
    hint: '等发布。本包不做移动端窗口，只把这条前提钉在这里，免得「三端」被读成「已经三端」。',
  }),
])

/** 按 id 查定义（查不到返回 `undefined`）。 */
export function prereqOf(id: PrereqId): Prereq | undefined {
  return PREREQUISITES.find(candidate => candidate.id === id)
}

/**
 * 判一条。
 * @param prereq 定义。
 * @param facts 事实。
 */
function judgeOne(prereq: Prereq, facts: PrereqFacts): PrereqResult {
  const base = { id: prereq.id, title: prereq.title, required: prereq.required }

  switch (prereq.id) {
    case 'memory-single-source':
      return facts.memoryCore
        ? { ...base, verdict: 'pass', detail: '记忆真源（O-010）在位，三端读同一份。' }
        : { ...base, verdict: 'fail', detail: '没有记忆真源：三端会各存一份。', hint: prereq.hint }

    case 'pet-entry':
      return facts.petEntry
        ? { ...base, verdict: 'pass', detail: '桌宠端入口（O-074）在位。' }
        : { ...base, verdict: 'fail', detail: '桌宠端入口不在，三端只剩两端。', hint: prereq.hint }

    case 'local-api': {
      if (facts.portConflict) {
        return {
          ...base,
          verdict: 'fail',
          detail: '本机 API 端口与中继端口是同一个：两个服务会抢同一个监听口。',
          hint: '把 `apiPort` 或中继端口改成不同的值（手册链路是 HTTP 3000 / WS 3001）。',
        }
      }
      if (!facts.webServer) {
        return {
          ...base,
          verdict: 'fail',
          detail: '宿主没有 `webServer`：本机没有可被三端读到的 HTTP 出口。',
          hint: '桌面端默认带它；命令行 / 无头形态可能需要显式启用。',
        }
      }
      return { ...base, verdict: 'pass', detail: '本机 HTTP 出口在位，端口未与中继冲突。' }
    }

    case 'ws-bridge': {
      if (!facts.bridge) {
        return { ...base, verdict: 'fail', detail: '没有 WS 中继实现。', hint: prereq.hint }
      }
      if (!facts.relayConfigured) {
        return { ...base, verdict: 'fail', detail: '中继地址是空的。', hint: '填 `relayUrl`，形如 `ws://127.0.0.1:3001/…`。' }
      }
      if (!facts.relayPortValid) {
        return { ...base, verdict: 'fail', detail: '中继地址的端口不合法（要在 1–65535 之间）。', hint: '检查 `relayUrl` 里的端口。' }
      }
      return { ...base, verdict: 'pass', detail: '中继实现已接入，地址已配置。' }
    }

    case 'origin-check':
      return facts.originCount > 0
        ? { ...base, verdict: 'pass', detail: `允许来源 ${facts.originCount} 条。` }
        : { ...base, verdict: 'fail', detail: '允许来源清单是空的（等于全拒）。', hint: prereq.hint }

    case 'token-consistency':
      return {
        ...base,
        verdict: 'unverifiable',
        detail: '两侧 token 是否一致，本包只在一侧，**结构上判不了**。',
        hint: prereq.hint,
      }

    case 'mobile-client':
      return facts.mobileShipped
        ? { ...base, verdict: 'pass', detail: '手机客户端已发布。' }
        : { ...base, verdict: 'unshipped', detail: '手机客户端还没发布（手册 §1.11-07：即将适配）。', hint: prereq.hint }
  }
}

/**
 * 逐条判定，汇总成报告。
 * @param facts 事实。
 */
export function evaluatePrereqs(facts: PrereqFacts): PrereqReport {
  const all = PREREQUISITES.map(prereq => judgeOne(prereq, facts))
  const passed: PrereqId[] = []
  const blockers: PrereqResult[] = []
  const warnings: PrereqResult[] = []

  for (const result of all) {
    if (result.verdict === 'pass') {
      passed.push(result.id)
      continue
    }
    if (result.required && result.verdict === 'fail') {
      blockers.push(result)
      continue
    }
    // 剩下的都是「不阻塞但必须显示」：判不了、没发布、非必需且没过。
    warnings.push(result)
  }

  return Object.freeze({
    ready: blockers.length === 0,
    mobileShipped: facts.mobileShipped,
    at: facts.at,
    passed: Object.freeze(passed),
    blockers: Object.freeze(blockers),
    warnings: Object.freeze(warnings),
    all: Object.freeze(all),
  })
}
