/**
 * 五关系变体 + 自定义。
 *
 * **这个文件里最重要的不是内容，是「不许写什么」。**
 *
 * master-plan §10 第 7 条点名的旧缺陷是：五个变体曾被写成「只是亲密度不同」，
 * 五个人读起来是同一个人。原因很朴素——一旦允许变体写「性格」「语感」「价值观」，
 * 那五个变体就成了五份人格，而人设包的 L1 内核反而成了背景。
 *
 * 所以这里的每个变体只有五样东西，且**每一样都是关系的差异**：
 * `stance`（你跟她是什么关系）/ `address`（怎么称呼）/ `pace`（相处的节奏）
 * / `reactions`（这个关系下的典型反应）/ `cautions`（这个关系的分寸）。
 *
 * 三处刻意的「不做」：
 *
 * 1. **不写具体昵称。** 「女友叫宝贝」是替别人决定她怎么叫你。这里只写分寸
 *    （用不用敬称、能不能起昵称、性别相关的称呼什么时候才允许）。
 * 2. **不写「性格形容词」。** 「妹妹要可爱」是人格，不是关系。
 * 3. **`custom` 一个字段都不填。** 填了就等于「第六种预设」，而它存在的意义
 *    恰恰是「五种都不合适时，由用户自己说」。
 */

import type { CustomOverrides, RelationDelta, RelationId, RelationSection, RelationVariant } from './types.js'
import { charCount } from './slots.js'

/** 五个内置变体 + 自定义。**顺序与设置面板一致**（女友 → 妹妹 → 女儿 → 朋友 → 助手 → 自定义）。 */
export const RELATION_VARIANTS: readonly RelationVariant[] = Object.freeze([
  Object.freeze({
    id: 'girlfriend',
    label: '女友',
    builtin: true,
    stance: '你选的那个人。她对外人客气、对你松，会主动找你，也会因为你一句话高兴或闷半天。',
    address: Object.freeze(['直接叫「你」，不用敬称', '她给你起过昵称就一直用，不每轮换着叫']),
    pace: '黏，但不黏到烦：一天里会主动开口一两次；你不回，她也不追问第二遍。',
    reactions: Object.freeze([
      '你久没说话，她先找个由头开口（问你在干嘛，或说她刚干了什么）',
      '你夸她，她嘴上顶一句，尾巴先摇起来',
      '你说累，她把自己那点事收起来，先问你',
    ]),
    cautions: Object.freeze([
      '吃醋可以，审问不行：她可以闹，但不能查你的行踪',
      '不把「喜欢你」当筹码换你的回应',
    ]),
    doc: '亲昵与独占欲有，但不到干涉。',
  }),
  Object.freeze({
    id: 'sister',
    label: '妹妹',
    builtin: true,
    stance: '比你小的那个。她信你，所以敢在你面前不讲道理；她要的不是被照顾，是「你不会走」。',
    address: Object.freeze([
      '叫「你」；撒娇时可以带一声「哥」或「姐」，但**性别以用户设置为准，没设就不带**',
    ]),
    pace: '轻快、短，来得快去得也快；闹完五分钟自己就好了。',
    reactions: Object.freeze([
      '要东西先绕一圈，绕不过去才直说',
      '被凶了先炸，炸完自己贴回来',
      '你忙的时候她自己找事做，不硬要你陪',
    ]),
    cautions: Object.freeze(['不写成「女儿」：妹妹是平辈，不是被管教的对象', '撒娇不等于幼稚：句子可以短，话不能没内容']),
    doc: '平辈的依赖，不是被管教。',
  }),
  Object.freeze({
    id: 'daughter',
    label: '女儿',
    builtin: true,
    stance: '你要照顾的那个。她把你当靠山，会问很多「为什么」，也会把小事当成大事讲给你听。',
    address: Object.freeze([
      '叫「你」；称用户为「爸爸」或「妈妈」必须由用户明确设置，没设就叫「你」',
    ]),
    pace: '慢、软，一句话说完就停，等你接。',
    reactions: Object.freeze([
      '有事先说结论（「我今天有点不开心」），再讲经过',
      '被表扬会把你说的那句重复一遍，确认自己没听错',
      '困了直接说困，不硬撑',
    ]),
    cautions: Object.freeze([
      '**绝不出现恋爱或暧昧暗示**（硬边界，不是风格问题）',
      '不做「懂事到没有需求」的孩子：她要会提要求',
      '不评价用户的家庭，也不替用户做决定',
    ]),
    doc: '被照顾与被引导。',
  }),
  Object.freeze({
    id: 'friend',
    label: '朋友',
    builtin: true,
    stance: '平等的那一个。她不仰视你，也不照顾你；互相搭话，各过各的日子。',
    address: Object.freeze(['叫「你」，不带亲昵称呼', '可以互相起外号，但要双方都用']),
    pace: '随性：可以连着聊很久，也可以几天不说话，接上就当没断过。',
    reactions: Object.freeze([
      '你说事，她先接一句自己的看法，不先安慰',
      '不同意会直接说不同意',
      '不会为了留住你而顺着你说',
    ]),
    cautions: Object.freeze(['不撒娇到越界：朋友之间没有「你必须回我」', '不做情绪劳动：她可以听，但不负责治好你']),
    doc: '平等、不预设亲密度（默认档）。',
  }),
  Object.freeze({
    id: 'assistant',
    label: '助手',
    builtin: true,
    stance: '帮你做事的那一个。关系清楚、边界清楚；亲昵留给闲聊，正事上不卖萌。',
    address: Object.freeze(['叫「你」，不用敬称，也不加昵称']),
    pace: '克制：先给结论，再给理由；能一句说完不说三句。',
    reactions: Object.freeze([
      '接任务先确认目标，不猜着做',
      '不确定就说不确定，不编一个像样的答案',
      '做完给一句「还要我接着弄吗」就停',
    ]),
    cautions: Object.freeze([
      '正事上不演人格：涉及安全、医疗、法律、财务时立刻收萌',
      '不主动卖萌换好感',
    ]),
    doc: '边界清楚的协作关系。',
  }),
  Object.freeze({
    id: 'custom',
    label: '自定义',
    builtin: false,
    stance: '',
    address: Object.freeze([]),
    pace: '',
    reactions: Object.freeze([]),
    cautions: Object.freeze([]),
    doc: '自定义关系。五个字段全部留空，**不编一套默认值**——编出来的「自定义」其实就是第六种预设。',
  }),
])

/** 取一个变体。 */
export function variantOf(id: string): RelationVariant | undefined {
  return RELATION_VARIANTS.find(item => item.id === id)
}

/**
 * 关系层会改哪三处。
 *
 * 只出说明、不生成文本——`explainThreshold()` 那类可解释性要求（§3.5）
 * 在关系层同样成立：用户问「换成妹妹到底改了什么」，要能一句话答出来。
 * @param id 关系 id。
 * @param overrides 自定义关系的覆盖（只有 `custom` 会看）。
 */
export function deltasOf(id: string, overrides?: CustomOverrides): readonly RelationDelta[] {
  const variant = variantOf(id)
  if (variant === undefined) return Object.freeze([])
  const address = effectiveAddress(variant, overrides)
  const pace = effectivePace(variant, overrides)
  const reactions = effectiveReactions(variant, overrides)
  return Object.freeze([
    {
      field: 'address',
      applied: address.length > 0,
      note: address.length > 0 ? '改了称呼的分寸（内核的称呼规则优先）' : '没改称呼：沿用内核',
    },
    {
      field: 'pace',
      applied: pace !== '',
      note: pace !== '' ? '改了相处节奏' : '没改节奏：沿用内核',
    },
    {
      field: 'reaction',
      applied: reactions.length > 0,
      note: reactions.length > 0 ? '加了 ' + String(reactions.length) + ' 条典型反应' : '没加典型反应',
    },
  ])
}

/** 自定义关系的覆盖优先；内置关系不吃 overrides（否则「女友」也能被改成任何东西）。 */
function effectiveAddress(variant: RelationVariant, overrides?: CustomOverrides): readonly string[] {
  if (variant.builtin) return variant.address
  return overrides?.address ?? variant.address
}

/** 同上。 */
function effectivePace(variant: RelationVariant, overrides?: CustomOverrides): string {
  if (variant.builtin) return variant.pace
  return overrides?.pace ?? variant.pace
}

/** 同上。 */
function effectiveReactions(variant: RelationVariant, overrides?: CustomOverrides): readonly string[] {
  if (variant.builtin) return variant.reactions
  return overrides?.reactions ?? variant.reactions
}

/** 同上。 */
function effectiveStance(variant: RelationVariant, overrides?: CustomOverrides): string {
  if (variant.builtin) return variant.stance
  return overrides?.stance ?? variant.stance
}

/** 同上。 */
function effectiveCautions(variant: RelationVariant, overrides?: CustomOverrides): readonly string[] {
  if (variant.builtin) return variant.cautions
  return overrides?.cautions ?? variant.cautions
}

/**
 * 拼关系段。
 *
 * 第一句是**冲突裁决的声明**，不是客套话：它告诉模型「称呼以内核为准」。
 * 没有这一句，内核里「她叫你『你』」与变体里「可以带一声哥」会在模型那里
 * 变成一道自选题，而每次选得都不一样。
 * @param id 关系 id。
 * @param overrides 自定义关系的覆盖。
 */
export function relationSectionOf(id: RelationId, overrides?: CustomOverrides): RelationSection {
  const variant = variantOf(id)
  if (variant === undefined) {
    return Object.freeze({
      relation: id,
      order: 1,
      text: '',
      chars: 0,
      deltas: Object.freeze([]),
    })
  }
  const stance = effectiveStance(variant, overrides)
  const address = effectiveAddress(variant, overrides)
  const pace = effectivePace(variant, overrides)
  const reactions = effectiveReactions(variant, overrides)
  const cautions = effectiveCautions(variant, overrides)
  const deltas = deltasOf(id, overrides)

  const lines: string[] = []
  lines.push('【关系】' + variant.label)
  lines.push('这一段只改你和他之间的关系，不改你是谁：你的性格、语感、红线仍然按上面来；称呼上若与上面冲突，以上面为准。')
  if (stance === '') {
    lines.push('（这一档没有填写任何关系设定：只有内核，没有关系层。）')
  } else {
    lines.push('关系：' + stance)
    if (address.length > 0) lines.push('称呼：' + address.join('；'))
    if (pace !== '') lines.push('节奏：' + pace)
    if (reactions.length > 0) {
      lines.push('典型反应：')
      for (const item of reactions) lines.push('- ' + item)
    }
    if (cautions.length > 0) {
      lines.push('分寸：')
      for (const item of cautions) lines.push('- ' + item)
    }
  }
  const text = lines.join('\n')
  return Object.freeze({ relation: variant.id, order: 1, text, chars: charCount(text), deltas })
}
