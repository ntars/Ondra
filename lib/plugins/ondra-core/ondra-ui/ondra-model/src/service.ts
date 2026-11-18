/**
 * 模型基座服务：与 DSH 的 provider / model 字段同形。
 *
 * 校验只在这里做一次：界面上填错时立刻报，内核侧拿到的一定是合法的。
 */
export interface ProviderModel {
  id: string
  name?: string
  contextWindow?: string
  maxTokens?: string
  input?: string[]
  reasoningEfforts?: { label: string; apiValue: string }[]
}

export interface Provider {
  id: string
  name: string
  baseURL: string
  apiKeyEnv?: string
  models: ProviderModel[]
}

const ID = /^[a-z][a-z0-9-]*$/
const CAP = /^\d+(\.\d+)?[KkMm]?$/

export class ModelService {
  private providers: Provider[] = []

  setProviders(list: Provider[]): void {
    this.providers = list.map(p => ({ ...p, models: [...p.models] }))
  }

  providers_(): Provider[] { return this.providers }

  /** 添加提供商：地址必填、id 唯一且合法、至少一个模型。 */
  add(p: Provider): string | null {
    if (!ID.test(p.id)) return '需以小写字母开头，之后可用小写字母、数字和短横线'
    if (this.providers.some(x => x.id === p.id)) return '已有提供商使用了这个 ID'
    if (!p.baseURL.trim()) return '自定义模型 API 需要填写 API 地址'
    if (p.models.length === 0) return '自定义模型 API 至少需要一个模型'
    this.providers.push(p)
    return null
  }

  /** 模型校验：非空、不重复、容量写法合法。 */
  checkModel(p: Provider, m: ProviderModel): string | null {
    if (!m.id.trim()) return '模型 ID 不能为空'
    if (p.models.filter(x => x.id === m.id).length > 1) return '模型 ID 不能重复'
    if (m.contextWindow && !CAP.test(m.contextWindow)) return '上下文窗口必须是正数，例如 131072、256K 或 1M'
    if (m.maxTokens && !CAP.test(m.maxTokens)) return '最大输出 token 数必须是正数，例如 8192、64K 或 1M'
    return null
  }

  remove(id: string): boolean {
    const before = this.providers.length
    this.providers = this.providers.filter(p => p.id !== id)
    return this.providers.length !== before
  }

  /** 解析出真正要用的模型与它所属的提供商。 */
  resolve(defaultModel = ''): { provider: Provider; model: ProviderModel } | undefined {
    const want = defaultModel.trim()
    for (const p of this.providers) {
      for (const m of p.models) {
        if (!want || m.id === want) return { provider: p, model: m }
      }
    }
    const first = this.providers[0]
    return first?.models[0] ? { provider: first, model: first.models[0] } : undefined
  }
}
