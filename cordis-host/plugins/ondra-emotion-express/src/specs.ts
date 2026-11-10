/**
 * 六态 → 三处表达参数的**唯一系数表**。
 *
 * 手册 §3.2 那一行原文（逐字段拆开）：
 *
 * > 雀跃（mood>0.7 且 energy>0.6：短句多 2-3 条、！～多、贴纸高概率、语速 +10%、主动额度 +1）
 * > ｜软和（0.55-0.7：中句、呢吧、正常）
 * > ｜平静（0.45-0.55）
 * > ｜蔫（mood<0.35：长句一条说完、嗯哦、语速 −15% 音量低、额度 −1）
 * > ｜炸毛（tension>0.5：极短常单字、？！、无语气词、不朗读、主动暂停）
 * > ｜困（energy<0.3：短句含省略、唔困、慢、静默）
 *
 * ## 三条「不写」的纪律
 *
 * 1. **手册没给的数字，这里就不写**。困那一档写着「慢」，没写百分比 →
 *    只出 `tempo: 'slow'`，`speechRateDelta` 留 `undefined`。
 *    编一个 −10% 看着无害，但它会变成事实上的产品口径，日后无人敢改。
 * 2. **句长百分比不在这里**。「句长 −40%」是 §3.2 的**应激倾斜**，
 *    归 O-038（节奏）与 O-040（口语化）——O-029 的 README 已明确声明不实现。
 *    六态只说「短句多 2-3 条 / 中句 / 长句一条说完」，那是**句形**，不是系数。
 * 3. **不写任何文案**。语气的具体措辞归 O-032 的投影模板与人设包；
 *    这里只有 `particles: 'sparse'` 这样的档位名。
 *
 * ## 为什么 `speechRateDelta` 是可选
 *
 * `undefined` 与 `0` 是两件事：
 * - `0` = 「确认不变」；
 * - `undefined` = 「手册没给数，请沿用引擎默认」。
 *
 * 四档里有四档是后者。压成 `0` 会让「引擎默认 1.05 倍速」被静默压回 1.0，
 * 而没有任何地方报错——这正是那种「上线三个月才发现所有人都慢了一点」的缺陷。
 */

import type {
  ExpressState,
  PromptStyle,
  RhythmProfile,
  RhythmSpec,
  TtsProfile,
} from './types.js'

/**
 * 六态的系数表。**全仓唯一**，改这里即改全部三处。
 *
 * 注：能量阈值的换算（手册的 `energy > 0.6` → 这里的 `> 60`）不放在本文件，
 * 而是落在 `types.ts` 的 `STATE_SPECS` 与 `judge.ts` 的 `ENERGY_SCALE` 两处，
 * 各写一次、互相引用。本文件只管「状态 → 表达参数」，不参与判定。
 */
export const RHYTHM_SPECS: Readonly<Record<ExpressState, RhythmSpec>> = Object.freeze({
  /* 雀跃：短句多 2-3 条、！～多、贴纸高概率、语速 +10%、主动额度 +1 */
  joyful: Object.freeze({
    speechRateDelta: 0.1,
    tempo: 'brisk',
    volume: 'normal',
    sentenceShape: 'burst',
    punctuation: 'exclaim',
    particles: 'rich',
    stickerChance: 'high',
    proactiveQuotaDelta: 1,
    proactivePaused: false,
    readAloud: true,
    silenceBias: false,
  }),
  /* 软和：中句、呢吧、正常 */
  soft: Object.freeze({
    tempo: 'normal',
    volume: 'normal',
    sentenceShape: 'medium',
    punctuation: 'normal',
    particles: 'normal',
    stickerChance: 'normal',
    proactiveQuotaDelta: 0,
    proactivePaused: false,
    readAloud: true,
    silenceBias: false,
  }),
  /* 平静：手册只给了 mood 区间，没有额外表达要求 → 全默认 */
  calm: Object.freeze({
    tempo: 'normal',
    volume: 'normal',
    sentenceShape: 'plain',
    punctuation: 'plain',
    particles: 'normal',
    stickerChance: 'normal',
    proactiveQuotaDelta: 0,
    proactivePaused: false,
    readAloud: true,
    silenceBias: false,
  }),
  /* 蔫：长句一条说完、嗯哦、语速 −15%、音量低、额度 −1 */
  wilted: Object.freeze({
    speechRateDelta: -0.15,
    tempo: 'slow',
    volume: 'low',
    sentenceShape: 'long-single',
    punctuation: 'plain',
    particles: 'sparse',
    stickerChance: 'normal',
    proactiveQuotaDelta: -1,
    proactivePaused: false,
    readAloud: true,
    silenceBias: false,
  }),
  /* 炸毛：极短常单字、？！、无语气词、不朗读、主动暂停 */
  bristled: Object.freeze({
    tempo: 'normal',
    volume: 'normal',
    sentenceShape: 'clipped',
    punctuation: 'interrobang',
    particles: 'none',
    stickerChance: 'none',
    proactiveQuotaDelta: 0,
    proactivePaused: true,
    readAloud: false,
    silenceBias: false,
  }),
  /* 困：短句含省略、唔困、慢、静默 */
  sleepy: Object.freeze({
    tempo: 'slow',
    volume: 'normal',
    sentenceShape: 'ellipsis',
    punctuation: 'plain',
    particles: 'sparse',
    stickerChance: 'normal',
    proactiveQuotaDelta: 0,
    proactivePaused: false,
    readAloud: true,
    silenceBias: true,
  }),
})

/**
 * 取节奏侧参数。
 *
 * 用「显式挑字段」而不是 `{ ...spec }`：展开会把 `readAloud` 也带进节奏档，
 * 而朗读是**语音层**的事。多带一个字段不会报错，只会让两个消费方
 * 各读一份 `readAloud`，然后有一天它们不一致。
 * @param state 状态。
 */
export function rhythmOf(state: ExpressState): RhythmProfile {
  const spec = RHYTHM_SPECS[state]
  return Object.freeze({
    speechRateDelta: spec.speechRateDelta,
    tempo: spec.tempo,
    volume: spec.volume,
    sentenceShape: spec.sentenceShape,
    punctuation: spec.punctuation,
    particles: spec.particles,
    stickerChance: spec.stickerChance,
    proactiveQuotaDelta: spec.proactiveQuotaDelta,
    proactivePaused: spec.proactivePaused,
    silenceBias: spec.silenceBias,
  })
}

/**
 * 取语音侧参数。
 * @param state 状态。
 */
export function ttsOf(state: ExpressState): TtsProfile {
  const spec = RHYTHM_SPECS[state]
  return Object.freeze({
    speechRateDelta: spec.speechRateDelta,
    tempo: spec.tempo,
    volume: spec.volume,
    readAloud: spec.readAloud,
  })
}

/**
 * 取提示词侧参数。**只有档位名，没有文本**。
 * @param state 状态。
 */
export function promptStyleOf(state: ExpressState): PromptStyle {
  const spec = RHYTHM_SPECS[state]
  return Object.freeze({
    sentenceShape: spec.sentenceShape,
    punctuation: spec.punctuation,
    particles: spec.particles,
    stickerChance: spec.stickerChance,
  })
}

/** 每个档位的中文说明（面板与日志用，**允许数字**）。 */
export const SHAPE_ZH: Readonly<Record<RhythmSpec['sentenceShape'], string>> = Object.freeze({
  burst: '短句多几条',
  medium: '中句',
  plain: '平常句长',
  'long-single': '长句一条说完',
  clipped: '极短，常单字',
  ellipsis: '短句带省略',
})

/** 标点档中文。 */
export const PUNCT_ZH: Readonly<Record<RhythmSpec['punctuation'], string>> = Object.freeze({
  exclaim: '！～偏多',
  interrobang: '？！偏多',
  normal: '平常',
  plain: '少用强标点',
})

/** 语气词档中文。 */
export const PARTICLES_ZH: Readonly<Record<RhythmSpec['particles'], string>> = Object.freeze({
  rich: '语气词多（只用内核里已有的）',
  normal: '语气词正常（呢、吧）',
  sparse: '语气词稀疏（嗯、哦）',
  none: '不用语气词',
})

/** 音量档中文。 */
export const VOLUME_ZH: Readonly<Record<RhythmSpec['volume'], string>> = Object.freeze({
  normal: '正常音量',
  low: '音量偏低',
})
