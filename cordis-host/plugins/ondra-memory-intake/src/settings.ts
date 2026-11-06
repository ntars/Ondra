/**
 * `ondra-memory-intake` 的配置：声明 + 补全。
 *
 * 字段只在这一处写默认值（`FIELD_SPECS` 的 `default`），`cordis.patch.yml`
 * 与 `Config` 都不重复写——三处各写一份默认值，改一处就会漂。
 */

import type { IntakeConfig } from './types.js'
import { CONFIG_SECTION_ID, DEFAULT_CONFIG } from './types.js'

export { CONFIG_SECTION_ID }

/** 一个字段在设置页上的样子。 */
interface FieldSpec {
  readonly kind: 'boolean' | 'number'
  readonly label: string
  readonly doc: string
  readonly default: boolean | number
  readonly min?: number
  readonly max?: number
}

/** 段内字段（单一真源）。 */
export const FIELD_SPECS: Readonly<Record<string, FieldSpec>> = {
  enable: {
    kind: 'boolean',
    label: '收对话进记忆',
    doc: '关掉后服务照常注册，但一轮都不收（右栏会一直显示「暂无记忆」）。',
    default: DEFAULT_CONFIG.enable,
  },
  extract: {
    kind: 'boolean',
    label: '自动抽事实',
    doc: '关掉只写原文：她记得「有过这段对话」，但说不出「你叫什么」。',
    default: DEFAULT_CONFIG.extract,
  },
  maxConcurrent: {
    kind: 'number',
    label: '同时提炼数',
    doc: '每轮提炼要调一次模型。调高会更跟手，也更费。',
    default: DEFAULT_CONFIG.maxConcurrent,
    min: 1,
    max: 4,
  },
  maxFacts: {
    kind: 'number',
    label: '每轮最多几条',
    doc: '留空交给提炼服务自己定（它的默认按证据强度收）。',
    default: 6,
    min: 1,
    max: 30,
  },
  verbose: {
    kind: 'boolean',
    label: '记日志',
    doc: '收下与失败都打一行，排查「为什么她记不住」时用得到。',
    default: DEFAULT_CONFIG.verbose,
  },
}

/**
 * `Config` 必须是标准 schema 形状（`~standard.validate`），不是「字段表」。
 *
 * 三处各写一份默认值是漂移之源：`FIELD_SPECS` 只负责「设置页长什么样」，
 * 真正的默认值住在 `DEFAULT_CONFIG`，校验入口把任意输入补成完整形态。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) =>
      | { readonly value: IntakeConfig }
      | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // `completeConfig` 永不抛错：越界值夹紧、类型错回退默认——都是「能补的」。
      return { value: completeConfig(value) }
    },
  },
}

/**
 * 把任意来源的配置补成完整形态。任何非法值回退默认，**绝不抛**。
 * @param raw 配置行内容。
 * @returns 补全后的配置。
 */
export function completeConfig(raw: unknown): Required<IntakeConfig> {
  const source = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bool = (key: keyof IntakeConfig, fallback: boolean): boolean =>
    typeof source[key] === 'boolean' ? source[key] as boolean : fallback
  const num = (key: keyof IntakeConfig, fallback: number, min: number, max: number): number => {
    const value = source[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(value)))
  }
  return {
    enable: bool('enable', DEFAULT_CONFIG.enable),
    extract: bool('extract', DEFAULT_CONFIG.extract),
    maxConcurrent: num('maxConcurrent', DEFAULT_CONFIG.maxConcurrent, 1, 4),
    maxFacts: num('maxFacts', 6, 1, 30),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  }
}
