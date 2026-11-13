/**
 * 手机端的提示词装配。
 *
 * ## 桌面版有五层，这里有三层
 *
 * 桌面版的 system 提示词由 `ondra-prompt-inject` 拼：人设、世界书、记忆、
 * 语感、情绪六态、边界条目……手机端保留**用户能感觉到的那三层**：
 *
 * | 层 | 作用 | 缺席的后果 |
 * | --- | --- | --- |
 * | 人设 | 她是谁、怎么说话 | 她会变成一个通用助手 |
 * | 记忆 | 她记得你什么 | 她每次都像第一次见你 |
 * | 情绪 | 她此刻什么状态 | 她的语气一成不变 |
 *
 * 砍掉的是世界书、语感统计、边界条目注入——那些需要插件系统与长期
 * 统计，手机端的数据量撑不起来。
 *
 * ## 为什么情绪要写进提示词而不只是画在界面上
 *
 * 界面上的「精力 60 / 平静」是给用户看的读数。模型看不到界面，它只知道
 * 你给它的文字。所以情绪必须**翻译成措辞指令**：「今天有点累」比
 * `energy: 60` 对模型更有用。
 */

import type { EmotionState } from './emotion.ts'
import { LABEL_ZH } from './emotionTypes.ts'
import { dominantLabel } from './emotion.ts'
import type { LocalFact } from './memory.ts'
import { memoryPrompt } from './memory.ts'

/** 人设。手机端只有一份，用户可改名字与称呼。 */
export interface Persona {
  /** 她的名字。 */
  name: string
  /** 她怎么称呼用户。留空表示用「你」。 */
  userAddress: string
}

/** 出厂人设。 */
export const DEFAULT_PERSONA: Persona = Object.freeze({
  name: '空谷',
  userAddress: '',
})

/**
 * 把情绪翻成一句措辞指令。
 *
 * ## 为什么是「一句」而不是把六个数全列出来
 *
 * 六个裸数字（`pleasure: 0.42, arousal: 0.51...`）对模型几乎没有约束力——
 * 它不知道 0.42 算高还是低。而「今天有点提不起劲，说话短一些」是可直接
 * 执行的指令。
 *
 * ## 阈值为什么比桌面版宽
 *
 * 桌面版的档位（energy < 40 疲惫、mood < 0.4 偏低）是给**长期累积**的
 * 状态用的——那里的情绪由几十轮对话与模型判定推动。手机端单条消息的
 * 位移上限是 0.12（乘 100 等于 12 点），要连续说四五句很累的话才够得着
 * 40 那条线，而多数会话根本到不了那么长。
 *
 * 结果就是「她永远用同一个语气」——而这正是要避免的。
 *
 * 所以这里改用**相对基线的偏移**判档，不设绝对阈值：偏离基线 15% 就算
 * 有倾向。一句话（12 点）就够触发，而它同时也不会把「有点累」说成
 * 「崩溃」——偏移量本身还是小的。
 */
export function moodInstruction(state: EmotionState): string {
  const mood = state.axes.mood
  const energy = state.axes.energy
  const tension = state.axes.tension
  const parts: string[] = []

  /* 精力：基线 60，偏离 ±9（15%）就算有倾向 */
  if (energy < 51) parts.push('今天有点提不起劲，说话短一些，不要主动展开话题')
  else if (energy > 69) parts.push('精神不错，可以多说两句')

  /*
   * 心情：基线 0.5，偏离 0.05 就算有倾向。
   *
   * 比精力的 15% 更敏感：心情是底色，0.05 已经是「明显不同的一天」，
   * 而精力 15% 只是「今天没那么有劲」。两者不该用同一个比例。
   */
  if (mood < 0.45) parts.push('心情偏低，语气收着，不要强行活泼')
  else if (mood > 0.55) parts.push('心情不错，语气可以松快些')

  /* 张力：基线 0，只有明显升高才提 */
  if (tension > 0.25) parts.push('心里还有话没说完，措辞会谨慎一些')

  const label = dominantLabel(state, 0.2)
  if (label !== undefined) parts.push(`此刻的情绪偏向「${LABEL_ZH[label]}」`)

  if (parts.length === 0) return ''
  return `## 你此刻的状态\n${parts.join('；')}。`
}

/** 人设段。 */
export function personaPrompt(persona: Persona): string {
  const address = persona.userAddress.trim() === '' ? '对方' : persona.userAddress.trim()
  return [
    `你是${persona.name}，一个长期陪伴对方的对话者。`,
    `你称呼对方为「${address}」。`,
    '说话像即时消息：短句、口语、不用列表和标题、不解释自己在做什么。',
    '不知道的事就说不知道，不要编。',
  ].join('\n')
}

/**
 * 装配完整 system 提示词。
 *
 * 顺序有讲究：**人设在前，记忆在中，情绪在后**。
 *
 * 模型读提示词时靠前的约束权重更高。人设是最不能违背的（她不能变成
 * 客服腔），所以排第一；情绪是最容易变的（一小时后就不同了），排最后
 * 也不会盖掉人设。
 */
export function assembleSystem(persona: Persona, facts: LocalFact[], state: EmotionState, now: number): string {
  const blocks = [personaPrompt(persona)]
  const memory = memoryPrompt(facts, now)
  if (memory !== '') blocks.push(memory)
  const mood = moodInstruction(state)
  if (mood !== '') blocks.push(mood)
  return blocks.join('\n\n')
}