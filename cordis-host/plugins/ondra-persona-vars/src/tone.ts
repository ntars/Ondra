/**
 * 说话浓度（五档滑杆）与浓度提示段。
 *
 * 这个文件回答一件事：**「说话浓度」调到不同档，到底改变了什么？**
 *
 * 四条硬规则，写在这里防止下一轮有人「顺手扩充」：
 *
 * 1. **浓度只调「量」，不扩「库」。**
 *    两个人设包都有一节「4.3 语气词只有这些」与「4.7 用词白名单 / 黑名单」。
 *    浓度段若写「多加语气词」，模型就会开始造词，一次调档就把人设调没了。
 *    所以五档文案里每一档都夹一句「只改同一种说法用多少，不新增内核里没有的词」。
 *
 * 2. **浓度不写进内核。** `tone()` 永远返回**独立一段**（`order = 2`）。
 *    揉进内核就等于「热情档是另一个人设」，而那正是本产品最不该有的东西。
 *
 * 3. **五档是「刻度名」不是「性格形容词」。**
 *    叫「偏热情」而不是「活泼」——后者会被人当成第二套人格设定，
 *    于是下一次就有人往档位里塞「活泼的说话方式」，浓度就变成了人格覆盖。
 *
 * 4. **不做「暖场语料」。** 每档的 `sample` 只给设置面板做**预览**（§7.4 人设卡要求
 *    「示例回复实时预览」），**永不进提示词**。一旦进提示词，它就是第二套台词库，
 *    而人设包才是台词的唯一真源。
 *
 * 旧三档的映射（手册 §7.4：「旧三档口径（清淡/标准/浓）映射到滑杆两端与中位」）：
 * `清淡 → 0` / `标准 → 50` / `浓 → 100`。映射表是 `LEGACY_LEVELS`，一处定义。
 */

import { TONE_BAND_IDS } from './types.js'
import type { ToneBand, ToneBandId, ToneSection } from './types.js'
import { charCount } from './vars.js'

/**
 * 五个档位。
 *
 * 分界不是平均分的（0–20 / 21–40 / …）：滑杆的中位 50 必须落在**中间那一档的正中间**，
 * 否则「默认档」在界面上会偏向一侧。实测按 0/21–40/41–60/61–80/81–100 分配时，
 * 中位 50 落在 `balanced`（41–60）的中心，与旧三档的「标准 → 50」一致。
 */
export const TONE_BANDS: readonly ToneBand[] = Object.freeze([
  Object.freeze({
    id: 'restrained',
    label: '很克制',
    min: 0,
    max: 20,
    doc: '话少、收着说。关心用做事的方式表达，不铺情绪。',
  }),
  Object.freeze({
    id: 'reserved',
    label: '偏克制',
    min: 21,
    max: 40,
    doc: '句子短、留白多。情绪点到就收，不追问第二遍。',
  }),
  Object.freeze({
    id: 'balanced',
    label: '适中',
    min: 41,
    max: 60,
    doc: '默认档。人设包怎么写就怎么说，不多加也不刻意收。',
  }),
  Object.freeze({
    id: 'warm',
    label: '偏热情',
    min: 61,
    max: 80,
    doc: '主动多说一句，语气词和拖音多一点，情绪说得更明白。',
  }),
  Object.freeze({
    id: 'effusive',
    label: '很热情',
    min: 81,
    max: 100,
    doc: '最外放的一档。情绪写在句子里，愿意重复强调。',
  }),
])

/**
 * 每档写给模型的**一段话**。
 *
 * 结构统一为三句：①这一档整体多浓；②具体改哪三样（句长 / 语气词密度 / 情绪显性度）；
 * ③**不许越界的一句**。第三句每档都不同，是这一档最容易越界的地方：
 * 克制档最容易把「收着」说成冷淡，热情档最容易把「热」说成造词。
 */
const BAND_TEXTS: Readonly<Record<ToneBandId, string>> = Object.freeze({
  restrained:
    '【说话浓度：很克制】这一档整体比平时更收。句子偏短，一句里只说一件事；' +
    '语气词只用内核里已经有的那几个，且能省就省；情绪不直接说出口，用做了什么来表达。' +
    '注意：克制不是冷淡——不敷衍、不省略回应，只是不铺陈。' +
    '只改这些说法用多少，不新增内核里没有的词，也不改内核定下的句式和禁忌。',
  reserved:
    '【说话浓度：偏克制】这一档比默认再收一点。句子偏短，留白多；' +
    '语气词保持内核的原样，只在句尾偶尔落一个；情绪点到就收，不追问第二遍。' +
    '注意：收着说也要把话说完，不要把「关心」省成「嗯」。' +
    '只改这些说法用多少，不新增内核里没有的词，也不改内核定下的句式和禁忌。',
  balanced:
    '【说话浓度：适中】按内核给人的说话方式说，不额外加浓也不刻意收着。' +
    '句式、语气词、情绪显性度都照内核的默认刻度来。' +
    '只改这些说法用多少，不新增内核里没有的词，也不改内核定下的句式和禁忌。',
  warm:
    '【说话浓度：偏热情】这一档比默认更外放一点。可以在同一句里多带一个小分句；' +
    '内核允许的语气词可以比平时多用一两个；情绪说得更明白，愿意先把自己的感受讲出来。' +
    '注意：热心不等于话多——仍然一条一条说，不堆感叹号，不加内核里没有的语气词。' +
    '只改这些说法用多少，不新增内核里没有的词，也不改内核定下的句式和禁忌。',
  effusive:
    '【说话浓度：很热情】这一档是外放的。句子可以连着说，愿意重复强调同一件事；' +
    '内核允许的语气词用得比平时密；情绪直接写在句子里，不用藏着。' +
    '注意：热情不等于失真——不叠感叹号、不连发同一句、不发明新语气词、' +
    '也不越过内核的表情动作预算（内核说给几个动作，就是几个）。' +
    '只改这些说法用多少，不新增内核里没有的词，也不改内核定下的句式和禁忌。',
})

/**
 * 每档的预览样句 —— **只给设置面板看，永不进提示词**。
 *
 * 手册 §7.4 的人设卡规格要求「卡内带示例回复实时预览」（宣传片演示：调到热情档，
 * 示例回复「好呀～我已经记下来啦！」）。本插件只提供**每档一句**的对照样句，
 * 真正的实时预览由界面用当前人设重新生成（那是 O-125 提示词预览的事）。
 *
 * 这五句是**本仓写的产品文案**，不是人设包里的台词，登记待裁决。
 */
export const BAND_SAMPLES: Readonly<Record<ToneBandId, string>> = Object.freeze({
  restrained: '记下了。',
  reserved: '好，我记下了。',
  balanced: '好呀，我记下来啦。',
  warm: '好呀～我记下来了，你放心。',
  effusive: '好呀～我已经记下来啦！你放心，我记着呢。',
})

/** 旧三档 → 滑杆值（手册 §7.4-⑦ 的映射）。 */
export const LEGACY_LEVELS: Readonly<Record<'清淡' | '标准' | '浓', number>> = Object.freeze({
  清淡: 0,
  标准: 50,
  浓: 100,
})

/** 档位 id 列表（与 `TONE_BAND_IDS` 同序，导出一份便于自检比对）。 */
export const BAND_ORDER: readonly ToneBandId[] = TONE_BAND_IDS

/**
 * 夹档位到 0–100 的整数。
 * @param value 原始值。
 * @param fallback 非法时用的兜底（配置值）。
 */
export function clampLevel(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * 档位值 → 档位。
 * @param level 已夹好的 0–100 整数。
 */
export function bandOf(level: number): ToneBand {
  const found = TONE_BANDS.find(band => level >= band.min && level <= band.max)
  // `find` 理论上必中（0–100 被五档无缝覆盖）；留兜底是为了「改了分界但没改全」
  // 时不至于返回 undefined 让下游崩在一句 `band.label` 上。
  return found ?? (TONE_BANDS[2] as ToneBand)
}

/**
 * 拼浓度提示段。
 * @param level 已夹好的 0–100 整数。
 */
export function toneSectionOf(level: number): ToneSection {
  const band = bandOf(level)
  const text = BAND_TEXTS[band.id]
  return Object.freeze({
    order: 2 as const,
    level,
    band: band.id,
    label: band.label,
    text,
    chars: charCount(text),
  })
}
