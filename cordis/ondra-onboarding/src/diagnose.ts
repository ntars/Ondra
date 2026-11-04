/**
 * 新手坑诊断（手册 §6.4 逐条）。**只出建议，不改任何设置**。
 *
 * ## 为什么这些坑值得单独一个文件
 *
 * §6.4 的原话是「部署类教程里的高频新手坑（onboarding 必须吸收）」，且 6.3 写着
 * 「大量用户卡在『下载安装』与『接扩展』——onboarding 是真实流失点」。
 * 五个坑里有四个的共同点是**报错不指向原因**：Node 太旧只报「装不上」、密钥错只报
 * 「模型无响应」、权限不足只报「装不上」、插件装了没启用则是**完全没报错**。
 * 所以这里每一条都必须给出「下一步做什么」，而不是复述现象。
 *
 * ## 缺事实就不判
 *
 * `nodeVersion` 没给就不出「Node 太旧」这条，而不是假设它是好的。诊断列表是
 * 「已知问题清单」，不是「体检通过证明」。
 */

import type { DiagnoseFacts, Diagnosis } from './types.js'

/**
 * 从版本号里取主版本。
 * @param version 例如 `v20.11.1` 或 `20`。
 */
function majorOf(version: string): number | null {
  const matched = /^v?(\d+)/.exec(version.trim())
  if (matched === null) return null
  const major = Number(matched[1])
  return Number.isFinite(major) ? major : null
}

/**
 * 跑一遍诊断。
 * @param facts 事实。
 * @param requiredNodeMajor 配置里的要求（默认 20）。
 */
export function diagnoseOf(facts: DiagnoseFacts, requiredNodeMajor: number): readonly Diagnosis[] {
  const out: Diagnosis[] = []

  // 1. Node 版本过低。
  if (typeof facts.nodeVersion === 'string' && facts.nodeVersion.trim() !== '') {
    const required = typeof facts.requiredNodeMajor === 'number' ? facts.requiredNodeMajor : requiredNodeMajor
    const major = majorOf(facts.nodeVersion)
    if (major !== null && major < required) {
      out.push({
        code: 'node-too-old',
        severity: 'block',
        cause: `Node ${facts.nodeVersion} 低于要求的 ${required}`,
        action: `先升到 Node ${required} 以上再装。低版本装不上是部署教程里最高频的一个坑，而报错通常只说「安装失败」`,
        source: '§6.4 新手坑 1',
      })
    }
  }

  // 2. 市场拉不到。
  if (facts.marketReachable === false) {
    out.push({
      code: 'market-unreachable',
      severity: 'warn',
      cause: '插件市场索引拉不到（通常是网络）',
      action:
        facts.proxyConfigured === true
          ? '已经配了代理：确认代理对 Node 进程生效，而不是只对浏览器生效（终端里的环境变量与系统代理是两套）'
          : '先配代理再试。直连 GitHub 在部分网络下会稳定失败，而界面只会显示「市场为空」',
      source: '§6.4 新手坑 2',
    })
  }

  // 3. 密钥校验没过。
  if (facts.apiKeyChecked === true && facts.apiKeyValid === false) {
    out.push({
      code: 'api-key-invalid',
      severity: 'block',
      cause: '密钥校验没过，但聊天界面只会显示「模型无响应」',
      action: '先单独跑一次密钥校验，别靠发一句话来判断——「无响应」有六种可能，密钥错只是其中一种',
      source: '§6.4 新手坑 3',
    })
  }

  // 4. 会话权限不足。
  if (typeof facts.sessionPermission === 'number' && facts.sessionPermission < 3) {
    out.push({
      code: 'permission-too-low',
      severity: 'warn',
      cause: `会话权限是 ${facts.sessionPermission} 级，低于装插件需要的 3 级`,
      action: '把会话权限设到三级再装。装美化类插件前尤其要检查，否则表现是「装不上」而不是「没权限」',
      source: '§6.4 新手坑 4',
    })
  }

  // 5. 装了没启用。
  const pending = facts.installedNotEnabled ?? []
  if (pending.length > 0) {
    const names = pending.slice(0, 3).join('、')
    const more = pending.length > 3 ? ` 等 ${pending.length} 个` : ''
    out.push({
      code: 'plugin-not-enabled',
      severity: 'warn',
      cause: `已安装但没启用：${names}${more}`,
      action: '到插件页逐个启用。**装了不等于生效**，而且这条通常完全不报错，所以最容易被当成 bug',
      source: '§6.4 新手坑 5',
    })
  }

  return out
}
