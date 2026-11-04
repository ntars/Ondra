/**
 * 来源可用性判定 —— **纯函数，不碰网络、不碰 ctx**。
 *
 * 可用性只看一件事：这条来源声明的 `provider` 路由，上游到底注册了没有。
 *
 * 刻意**不做网络探测**：探一次模型就是一次真实计费请求（或者一次真实超时），
 * 把它放在启动路径上，等于用用户的钱去验证「我的配置对不对」。
 * 「密钥错了」这类问题由首次真实调用的 `AUTH` 码回答，那才是唯一可信的答案。
 */

import type { LlmProviderInfoLike, SourceSpec, SourceState } from './types.js'

/**
 * 计算全部来源的可用性。
 * @param sources 已按优先级排序的来源清单。
 * @param providers 上游已注册的 provider 路由；上游缺席时传 `undefined`。
 * @returns 与入参同序的状态列表。
 */
export function probeStates(
  sources: readonly SourceSpec[],
  providers: readonly LlmProviderInfoLike[] | undefined,
): readonly SourceState[] {
  const known = providers === undefined ? undefined : new Set(providers.map(entry => entry.id))
  return sources.map((spec): SourceState => {
    if (!spec.enabled) {
      return { spec, available: false, reason: 'no-source', detail: '这条来源被 enabled=false 关掉了' }
    }
    if (known === undefined) {
      return { spec, available: false, reason: 'gateway-unavailable', detail: '上游模型服务未就绪，无法核对路由' }
    }
    if (!known.has(spec.provider)) {
      return {
        spec,
        available: false,
        reason: 'provider-missing',
        detail: `上游没有注册名为 ${spec.provider} 的 provider 路由（对应的适配器没装或没启用）`,
      }
    }
    return { spec, available: true }
  })
}

/**
 * 挑一条来源。
 * @param states 状态列表（已按优先级排序）。
 * @param source 显式指定的来源 id；省略则取第一条可用的。
 * @returns 选中的状态；没有时 `undefined`。
 */
export function pickSource(states: readonly SourceState[], source?: string): SourceState | undefined {
  if (source !== undefined) return states.find(state => state.spec.id === source)
  return states.find(state => state.available)
}

/**
 * 把来源清单拼成一句人话，给日志与自检用。
 * @param states 状态列表。
 * @returns 形如 `remote-main(remote)✓ / local-first(local)×provider-missing`。
 */
export function describeStates(states: readonly SourceState[]): string {
  if (states.length === 0) return '（空清单）'
  return states
    .map(state => {
      const mark = state.available ? '可用' : `不可用:${state.reason ?? '未知'}`
      return `${state.spec.id}(${state.spec.kind})${mark}`
    })
    .join(' / ')
}
