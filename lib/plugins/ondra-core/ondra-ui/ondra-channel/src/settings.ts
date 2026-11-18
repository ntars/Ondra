/** 配置真源：五个字段。 */
export interface ConfigShape {
  readonly enable: boolean
  readonly allowGroups: boolean
  readonly sandbox: boolean
  readonly busyPolicy: 'queue' | 'steer' | 'drop'
  readonly maxQueue: number
}

export const FIELD_SPECS = [
  { key: 'enable', note: '总开关；关掉后不再受理任何入站消息。' },
  { key: 'allowGroups', note: '是否回应群聊；关掉只回应私聊。' },
  { key: 'sandbox', note: 'QQ 沙箱环境：先在测试频道跑通。' },
  { key: 'busyPolicy', note: '通道繁忙时：排队 / 插话 / 丢弃。' },
  { key: 'maxQueue', note: '排队上限，超过按策略处理。' },
] as const

export const DEFAULT_CONFIG: ConfigShape = {
  enable: true, allowGroups: false, sandbox: true, busyPolicy: 'queue', maxQueue: 20,
}

export function completeConfig(input: Partial<ConfigShape> = {}): ConfigShape {
  const policy = input.busyPolicy === 'steer' || input.busyPolicy === 'drop' ? input.busyPolicy : 'queue'
  return {
    enable: input.enable ?? true,
    allowGroups: input.allowGroups ?? false,
    sandbox: input.sandbox ?? true,
    busyPolicy: policy,
    maxQueue: Math.min(200, Math.max(1, Math.trunc(input.maxQueue ?? 20))),
  }
}
