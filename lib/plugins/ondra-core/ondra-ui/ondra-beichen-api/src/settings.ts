/** 配置真源：合作方的地址、密钥变量名与展示名。 */
export interface ConfigShape {
  readonly label: string
  readonly baseUrl: string
  readonly apiKeyEnv: string
  readonly models: string[]
}

export const FIELD_SPECS = [
  { key: 'label', note: '界面上显示的名字，例如合作方品牌名。' },
  { key: 'baseUrl', note: '合作方给的兼容 OpenAI 协议的地址（含 /v1）。' },
  { key: 'apiKeyEnv', note: '密钥回退用的环境变量名；密钥本体存钥匙串。' },
  { key: 'models', note: '模型 id 列表，由合作方提供。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = {
  label: '合作 API',
  baseUrl: '',
  apiKeyEnv: 'PARTNER_API_KEY',
  models: [],
}

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  return {
    label: (input.label ?? '').trim() || DEFAULT_CONFIG.label,
    baseUrl: (input.baseUrl ?? '').trim(),
    apiKeyEnv: (input.apiKeyEnv ?? '').trim() || DEFAULT_CONFIG.apiKeyEnv,
    models: Array.isArray(input.models) ? input.models.filter(Boolean) : [],
  }
}
