/** 配置真源：五个字段。 */
export interface ConfigShape {
  readonly enable: boolean
  readonly tts: boolean
  readonly timbre: 'warm' | 'clear' | 'low'
  readonly rate: number
  readonly asrLanguage: 'zh' | 'yue' | 'en'
}

export const FIELD_SPECS = [
  { key: 'enable', note: '总开关；关掉后既不朗读也不识别。' },
  { key: 'tts', note: '朗读回复；长回答只念前两段。' },
  { key: 'timbre', note: '音色：暖 / 清 / 沉。' },
  { key: 'rate', note: '语速百分比，60–160。' },
  { key: 'asrLanguage', note: '识别语言：普通话 / 粤语 / English。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = {
  enable: true, tts: false, timbre: 'warm', rate: 100, asrLanguage: 'zh',
}

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  const timbre = input.timbre === 'clear' || input.timbre === 'low' ? input.timbre : 'warm'
  const lang = input.asrLanguage === 'yue' || input.asrLanguage === 'en' ? input.asrLanguage : 'zh'
  return {
    enable: input.enable ?? true,
    tts: input.tts ?? false,
    timbre,
    rate: Math.min(160, Math.max(60, Math.trunc(input.rate ?? 100))),
    asrLanguage: lang,
  }
}
