/**
 * 生态桌宠清单与**许可证闸门**。
 *
 * ## 为什么这段代码值得存在
 *
 * 手册 §9.1 的话是「`Pal-AI-Lab/Coopanion` 是 AGPL-3.0，只能读思路」。
 * 写成人能读的规矩，第一次遇到「装的人顺手就接了」时会失效；写成判定，
 * 它会在 `summon()` 之前把请求挡下来，并且**在面板里说明为什么**。
 *
 * 许可证不是「风险提示」，是**能不能进这台机器**的问题：AGPL 静态并入后，
 * 整个产品的分发义务都变了，而这件事发生在某次「就试一下」里。
 *
 * ## 为什么 MIT 的也标 `verified: false`
 *
 * 手册 §9.1 末尾写「新仓库 LICENSE 许可需正式确认」。本轮禁联网核对，
 * 所以 `dsh-pet` / `agentpet` 的 MIT 是**手册的转述**，不是我们亲手看过的 LICENSE。
 * 这个差别必须留在数据里：面板显示「MIT（未核对）」，比显示「MIT」诚实。
 */

import type { PetAdapter, PetLicense } from './types.js'

/**
 * 生态里的四个桌宠实现。
 *
 * 只登记手册点过名的四个——不在手册里的实现，许可证无从核对，
 * 列进来就等于替它背书（手册 §9.1 的纪律：核实前按「只读思路」处理）。
 */
export const PET_ADAPTERS: readonly PetAdapter[] = Object.freeze([
  Object.freeze({
    id: 'ondra-pet',
    title: 'dsh-pet（大肥鱼）',
    license: 'MIT' as PetLicense,
    verified: false,
    reusable: true,
    note: '手册 §6.3 与 §1.8 都点名它为首选：MIT，且手册说它已验证「省 token + 语音对话 + 屏幕检测」。LICENSE 本轮未逐字核对。',
  }),
  Object.freeze({
    id: 'agentpet',
    title: 'agentpet',
    license: 'MIT' as PetLicense,
    verified: false,
    reusable: true,
    note: '手册 §6.3 与它的备选。LICENSE 本轮未逐字核对。',
  }),
  Object.freeze({
    id: 'airi',
    title: 'Project AIRI',
    license: 'unknown' as PetLicense,
    verified: false,
    reusable: false,
    note: '手册只说它是「soul container of AI waifu」（50.9k★），**没有给许可证**。按 §9.1「核实前按只读思路处理」，不接。',
  }),
  Object.freeze({
    id: 'coopanion',
    title: 'Coopanion（大肥鱼捉宠）',
    license: 'AGPL-3.0' as PetLicense,
    verified: false,
    reusable: false,
    note: '**AGPL-3.0，不能接。** 手册 §9.1 原话「只能读思路；桌宠复用优先 MIT 的 ondra-pet / agentpet」。静态并入会让整个产品的分发义务变掉。',
  }),
])

/** 按 id 查适配器（查不到返回 `undefined`，调用方必须处理）。 */
export function adapterOf(id: string): PetAdapter | undefined {
  return PET_ADAPTERS.find(candidate => candidate.id === id)
}

/**
 * 许可证判定。
 *
 * `MIT` / `Apache-2.0` → 可接；`AGPL-3.0` / `unknown` → 不接。
 * 这里刻意**不看 `verified`**：MIT 未核对是「风险待确认」，AGPL 是「确定性禁止」，
 * 两者不是同一类事。把未核对也算成禁止，会让本插件在合法配置下永远不可用。
 */
export function licenseVerdict(adapter: PetAdapter): 'ok' | 'blocked' {
  if (adapter.license === 'MIT' || adapter.license === 'Apache-2.0') return 'ok'
  return 'blocked'
}

/**
 * 适配器能不能接（许可证 + 登记结论都要过）。
 * @param id 适配器 id。
 */
export function adapterUsable(id: string): { readonly usable: boolean; readonly detail: string } {
  const adapter = adapterOf(id)
  if (adapter === undefined) {
    return { usable: false, detail: `未知适配器 \`${id}\`：不在手册点名的四个实现里。` }
  }
  if (licenseVerdict(adapter) === 'blocked') {
    return { usable: false, detail: `${adapter.title} 的许可证是 ${adapter.license}，按手册 §9.1 不能接入。` }
  }
  if (!adapter.reusable) {
    return { usable: false, detail: `${adapter.title} 被标为不可复用：${adapter.note}` }
  }
  return { usable: true, detail: `${adapter.title}（${adapter.license}${adapter.verified ? '' : '，未逐字核对'}）` }
}
