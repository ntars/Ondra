/**
 * 音色表与语音包预设（手册 §1.7：19 音色 + 8 套预设）。
 *
 * ## 这张表为什么是「数据」而不是「逻辑」
 *
 * 19 个音色、8 套预设的**全部信息就是映射关系**。写成数据结构之后，
 * 「换一批音色」= 改这一个文件，而不是去三个分支里各改一遍。
 *
 * ## 组成口径（务必与 README「已知限制」对照看）
 *
 * 手册只写了「19 音色」与 8 套预设的名字，**没有逐条列出音色名单**；
 * 上游 `coopanion-fatfish` 的原始清单在本仓没有副本，无法逐条核对。
 * 因此这里按 8 套预设能覆盖的语言**反推**组成了 19 条：
 * 普通话 8 + 粤语 3 + 台湾 3 + 英文 3 + 日 1 + 韩 1。
 * 音色 id 本身是 Edge 的公开标识，写成可替换数据；换表不动任何逻辑。
 *
 * 不做「音色越多越好」：多出来的 11 条不是预设的主音色，而是给面板手动选。
 * 预设只钉住 8 条主音色，剩下的做备选池。
 */

import type { PresetId, PresetView, VoiceView } from './types.js'

/**
 * 19 个可选音色。
 *
 * `id` 是 Edge TTS 的 `voice` 参数值；其它分支不认这个 id（`macos-say`
 * 用自己的系统音色名，见 `settings.sayVoice`）。
 */
export const VOICES: readonly VoiceView[] = Object.freeze([
  // 普通话 8
  Object.freeze({ id: 'zh-CN-XiaoxiaoNeural', zh: '晓晓', locale: 'zh-CN', gender: 'female' as const }),
  Object.freeze({ id: 'zh-CN-XiaoyiNeural', zh: '晓伊', locale: 'zh-CN', gender: 'female' as const }),
  Object.freeze({ id: 'zh-CN-YunjianNeural', zh: '云健', locale: 'zh-CN', gender: 'male' as const }),
  Object.freeze({ id: 'zh-CN-YunxiNeural', zh: '云希', locale: 'zh-CN', gender: 'male' as const }),
  Object.freeze({ id: 'zh-CN-YunxiaNeural', zh: '云夏', locale: 'zh-CN', gender: 'male' as const }),
  Object.freeze({ id: 'zh-CN-YunyangNeural', zh: '云扬', locale: 'zh-CN', gender: 'male' as const }),
  Object.freeze({ id: 'zh-CN-liaoning-XiaobeiNeural', zh: '晓北', locale: 'zh-CN', gender: 'female' as const }),
  Object.freeze({ id: 'zh-CN-shaanxi-XiaoniNeural', zh: '晓妮', locale: 'zh-CN', gender: 'female' as const }),
  // 粤语 3
  Object.freeze({ id: 'zh-HK-HiuMaanNeural', zh: '曉曼', locale: 'zh-HK', gender: 'female' as const }),
  Object.freeze({ id: 'zh-HK-HiuGaaiNeural', zh: '曉佳', locale: 'zh-HK', gender: 'female' as const }),
  Object.freeze({ id: 'zh-HK-WanLungNeural', zh: '雲龍', locale: 'zh-HK', gender: 'male' as const }),
  // 台湾 3
  Object.freeze({ id: 'zh-TW-HsiaoChenNeural', zh: '曉臻', locale: 'zh-TW', gender: 'female' as const }),
  Object.freeze({ id: 'zh-TW-HsiaoYuNeural', zh: '曉雨', locale: 'zh-TW', gender: 'female' as const }),
  Object.freeze({ id: 'zh-TW-YunJheNeural', zh: '雲哲', locale: 'zh-TW', gender: 'male' as const }),
  // 英文 3
  Object.freeze({ id: 'en-US-AriaNeural', zh: 'Aria', locale: 'en-US', gender: 'female' as const }),
  Object.freeze({ id: 'en-US-JennyNeural', zh: 'Jenny', locale: 'en-US', gender: 'female' as const }),
  Object.freeze({ id: 'en-US-GuyNeural', zh: 'Guy', locale: 'en-US', gender: 'male' as const }),
  // 日 / 韩 各 1
  Object.freeze({ id: 'ja-JP-NanamiNeural', zh: '七海', locale: 'ja-JP', gender: 'female' as const }),
  Object.freeze({ id: 'ko-KR-SunHiNeural', zh: '선히', locale: 'ko-KR', gender: 'female' as const }),
])

/**
 * 8 套语音包预设（手册 §1.7 原顺序）。
 *
 * `alt` 一律取**同语种的另一条**，而不是随便挑一条：首选被通道拒绝时
 * 换到别的语种，用户听到的是「突然开始说粤语」，比没人出声更糟。
 */
export const PRESETS: readonly PresetView[] = Object.freeze([
  Object.freeze({
    id: 'soft' as PresetId,
    zh: '温柔',
    voice: 'zh-CN-XiaoxiaoNeural',
    alt: 'zh-CN-XiaoyiNeural',
    locale: 'zh-CN',
  }),
  Object.freeze({
    id: 'lively' as PresetId,
    zh: '活泼',
    voice: 'zh-CN-XiaoyiNeural',
    alt: 'zh-CN-XiaoxiaoNeural',
    locale: 'zh-CN',
  }),
  Object.freeze({
    id: 'broadcast' as PresetId,
    zh: '播音',
    voice: 'zh-CN-YunjianNeural',
    alt: 'zh-CN-YunyangNeural',
    locale: 'zh-CN',
  }),
  Object.freeze({
    id: 'dongbei' as PresetId,
    zh: '东北',
    voice: 'zh-CN-liaoning-XiaobeiNeural',
    alt: 'zh-CN-XiaoyiNeural',
    locale: 'zh-CN',
  }),
  Object.freeze({
    id: 'shaanxi' as PresetId,
    zh: '陕西',
    voice: 'zh-CN-shaanxi-XiaoniNeural',
    alt: 'zh-CN-XiaoxiaoNeural',
    locale: 'zh-CN',
  }),
  Object.freeze({
    id: 'cantonese' as PresetId,
    zh: '粤语',
    voice: 'zh-HK-HiuMaanNeural',
    alt: 'zh-HK-HiuGaaiNeural',
    locale: 'zh-HK',
  }),
  Object.freeze({
    id: 'taiwan' as PresetId,
    zh: '台湾',
    voice: 'zh-TW-HsiaoChenNeural',
    alt: 'zh-TW-HsiaoYuNeural',
    locale: 'zh-TW',
  }),
  Object.freeze({
    id: 'english' as PresetId,
    zh: 'English',
    voice: 'en-US-AriaNeural',
    alt: 'en-US-JennyNeural',
    locale: 'en-US',
  }),
])

/** 音色 id 集合，用于 O(1) 判「这个 id 认不认识」。 */
const VOICE_IDS: ReadonlySet<string> = new Set(VOICES.map(voice => voice.id))

/**
 * 这个音色 id 在不在表里。
 * @param id 候选 id。
 */
export function isVoiceId(id: string): boolean {
  return VOICE_IDS.has(id)
}

/**
 * 按 id 取预设。**不认识返回 `undefined`**，不抛、不猜。
 * @param id 预设 id。
 */
export function presetOf(id: string): PresetView | undefined {
  return PRESETS.find(preset => preset.id === id)
}
