/**
 * ondra-beichen-api：合作 API。
 *
 * 它不实现请求，也不存密钥——只回答一个问题：**合作方的这套接口长什么样**。
 * 模型基座把它当成一组 provider 预设（id / name / baseUrl / apiKeyEnv / models），
 * 换合作方就是换这个插件的配置，界面与基座一行不用改。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { completeConfig, type ConfigShape } from './settings.js'

export const name = 'ondra-beichen-api'

export interface PartnerPreset {
  id: string
  name: string
  baseUrl: string
  apiKeyEnv: string
  models: { id: string }[]
  note: string
}

class PartnerApiService extends Service {
  private config: ConfigShape

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'partnerApi')
    this.config = config
  }

  /** 当前合作方的预设。地址为空时界面会让用户先补地址再添加。 */
  catalog(): PartnerPreset[] {
    return [
      {
        id: 'partner',
        name: this.config.label,
        baseUrl: this.config.baseUrl,
        apiKeyEnv: this.config.apiKeyEnv,
        models: this.config.models.map(id => ({ id })),
        note: '地址与模型目录由合作方提供；换一家改本插件配置即可',
      },
    ]
  }
}

export function apply(ctx: Context, input: Partial<ConfigShape> = {}): void {
  void new PartnerApiService(ctx, completeConfig(input))
}
