/**
 * 提示音（§12.12、§6.5「音量」那一行）。
 *
 * ## 只有三种音
 *
 * 规范写死三种：**发送**、**她开口**、**错误**。不做打字音、不做环境音——
 * 打字音会跟着逐字流式输出响成一片，环境音则是把陪伴做成白噪音播放器，
 * 两件都不是这个产品想要的。
 *
 * ## 默认关闭
 *
 * §12.12 第一行就是「默认关闭」。声音是**用户主动要的**，不是开箱就有的
 * 一层打扰：一个在图书馆打开应用的人，第一声提示音就够他关掉整个应用。
 *
 * ## 为什么用振荡器合成，不加载音频文件
 *
 * 三个音各不到一秒。为它们放三个 `.mp3`，要处理格式兼容、要算进打包体积、
 * 还要让 WebView 在首帧前预加载。用 `OscillatorNode` 现场合成，没有资源
 * 加载、没有格式问题，且音量与包络都能量化到毫秒。
 *
 * 代价是音色朴素。这对提示音是**优点**：提示音只需要"被听见"，不需要
 * 好听；好听的提示音会让人想听第二遍，那它就从提示变成了娱乐。
 *
 * ## 它和静音（`mute.ts`）是什么关系
 *
 * 静音是**总闸**。用户按「静音 1 小时」，期待的是「这一小时别出声」——
 * 提示音当然也包括在内。若声音无视静音继续响，那个菜单项就没意义了。
 * 所以这里在发声前问一次 `isMuted()`，静音期一律不出声。
 *
 * 反方向不成立：声音关掉不等于静音。静音还会影响她主动开口与系统通知，
 * 声音只影响这三个音。两者共用「出声」这一个交集，但语义不同层。
 *
 * ## 音量为什么独立于系统音量
 *
 * §12.12 明写「独立于系统音量」。系统音量是全局的，用户调它是为了别的
 * 应用；改我们的音量不该动他整台机器的响度。这里用 `GainNode` 缩放，
 * 不碰系统设置。
 */

import { getPreferences } from './preferences.ts'
import { isMuted } from './mute.ts'

/** 三种音的键。与 §12.12 的三种一一对应。 */
export type SoundCue = 'send' | 'speak' | 'error'

/** 一种音的配方。 */
interface CueSpec {
  /** 起止频率（Hz）。两者不同即是一次滑音，比单音更像"应答"。 */
  from: number
  to: number
  /** 时长（毫秒）。 */
  ms: number
  /** 波形。正弦最软；三角稍亮，用在错误上才不至于被忽略。 */
  wave: OscillatorType
  /** 相对峰值。三个音之间要能听出区别，又不能一个盖住另一个。 */
  peak: number
}

/**
 * 三种音的配方。
 *
 * | 音 | 走向 | 为什么 |
 * | --- | --- | --- |
 * | 发送 | 660 → 880（上行） | 上行 = 送出去。短，90ms，说完就收 |
 * | 她开口 | 880 → 1174（上行，更高） | 比发送更高更软，是"应答"不是"动作" |
 * | 错误 | 311 → 220（下行） | 下行 = 没成。稍长稍亮，但不超过 200ms |
 *
 * 三个音都在 220–1200Hz 之间：低于 200Hz 在小喇叭上听不见，高于 2kHz
 * 在安静环境里刺耳。
 */
const CUES: Record<SoundCue, CueSpec> = {
  send: { from: 660, to: 880, ms: 90, wave: 'sine', peak: 0.5 },
  speak: { from: 880, to: 1174, ms: 140, wave: 'sine', peak: 0.45 },
  error: { from: 311, to: 220, ms: 200, wave: 'triangle', peak: 0.5 },
}

/**
 * 音量换算成增益。
 *
 * ## 为什么不是线性
 *
 * 人耳对响度的感知接近指数：线性音量 50% 听起来还有七成响，拉到 10%
 * 才刚有点声音。用平方曲线，滑杆在中段时增益约 0.25，听感才与数字一致。
 *
 * 上限 0.35 而不是 1：提示音是背景级的，留出余量，用户在音量 100 时
 * 也不会被吓一跳。
 */
function gainOf(volume: number): number {
  const clamped = Math.min(100, Math.max(0, volume)) / 100
  return clamped * clamped * 0.35
}

/**
 * 全局音频上下文。
 *
 * ## 为什么懒建、且只建一个
 *
 * 浏览器的 `AudioContext` 数量有上限（Chrome 6 个左右），每次发声新建一个
 * 迟早会抛 `NotSupportedError`。而且新建上下文要初始化音频线程，几十毫秒
 * ——正好是提示音最该立刻响的那几十毫秒。
 *
 * 懒建还有第二个理由：**没开声音的人不该付这份开销**。默认关闭意味着
 * 多数用户永远不会走到这里。
 */
let context: AudioContext | undefined

/** 取上下文。不支持 Web Audio 时返回 undefined（不是抛错）。 */
function ensureContext(): AudioContext | undefined {
  if (context !== undefined) return context
  const Ctor = globalThis.AudioContext
  if (Ctor === undefined) return undefined
  try {
    context = new Ctor()
    return context
  } catch {
    // 某些环境（无音频设备、沙箱内）构造会抛。当作没有音频能力。
    return undefined
  }
}

/**
 * 播一声。
 *
 * ## 为什么失败一律静默
 *
 * 提示音是锦上添花。它播不出来时弹一条「音频设备不可用」，是把一件
 * 无关紧要的事升级成故障——用户既没法处理，也不关心。
 *
 * ## 为什么每声都新建振荡器
 *
 * `OscillatorNode` 是一次性的：`start()` 之后不能重来。复用要改成
 * `AudioBufferSourceNode` 并自己算缓冲区，代码量翻倍而收益为零——
 * 三种音一天最多响几十次。
 *
 * @param cue 哪一种音。
 */
/**
 * 合成并播一声。内部函数，只有 `playCue` 与 `previewCue` 调它。
 *
 * ## 为什么把「三道闸」与「合成」分开
 *
 * 试听要绕开开关（见 `previewCue`），但**不能绕开合成逻辑**。两处各写
 * 一份 `createOscillator` 的后果是：以后改某个音的频率或包络，只改一处，
 * 试听与真实播放听起来不一样——而那种不一致极难发现，因为两者很少
 * 同时被听到。
 *
 * @param cue 哪一种音。
 * @param volume 0–100。调用方已经做过闸门判断。
 */
function emit(cue: SoundCue, volume: number): void {
  const gain = gainOf(volume)
  if (gain <= 0) return

  const ctx = ensureContext()
  if (ctx === undefined) return

  /*
   * 上下文可能被浏览器挂起（自动播放策略：没有用户手势就不出声）。
   * `resume()` 是异步的，这里不等它——等的话第一次发声会延迟几十毫秒，
   * 而这一次多半就在用户刚按过键的手势里，本来就是允许的。
   */
  if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* 下一声再试 */ })

  const spec = CUES[cue]
  const now = ctx.currentTime
  const end = now + spec.ms / 1000

  const osc = ctx.createOscillator()
  osc.type = spec.wave
  osc.frequency.setValueAtTime(spec.from, now)
  // 线性滑到终点频率：指数滑音在下行时会听出"掉下去一截"，线性更稳。
  osc.frequency.linearRampToValueAtTime(spec.to, end)

  const amp = ctx.createGain()
  /*
   * 包络：5ms 淡入、其余时间淡出到 0。
   *
   * 不淡入会有一个"咔"的起音爆点（波形从 0 突跳到峰值）；不淡出则
   * 在截断时同样爆一下。5ms 足够消掉爆点，又短到听不出"渐入"。
   */
  amp.gain.setValueAtTime(0, now)
  amp.gain.linearRampToValueAtTime(spec.peak * gain, now + 0.005)
  amp.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(amp)
  amp.connect(ctx.destination)
  osc.start(now)
  osc.stop(end)

  /*
   * 断开连接。
   *
   * 不断开的话节点会一直挂在上下文里（虽然不再发声），几十次之后
   * 音频图越来越大。`onended` 是唯一可靠的回收点。
   */
  osc.onended = (): void => {
    osc.disconnect()
    amp.disconnect()
  }
}

/**
 * 播一声。全应用的唯一出声入口。
 *
 * ## 为什么失败一律静默
 *
 * 提示音是锦上添花。它播不出来时弹一条「音频设备不可用」，是把一件
 * 无关紧要的事升级成故障——用户既没法处理，也不关心。
 *
 * ## 三道闸的顺序
 *
 * 开关 → 静音 → 音量。按"最常关着"排，开关关着的人连上下文都不建，
 * 一个 `AudioContext` 都不该为它初始化。
 *
 * @param cue 哪一种音。
 */
export function playCue(cue: SoundCue): void {
  const prefs = getPreferences()
  if (!prefs.sound) return
  if (isMuted()) return
  emit(cue, prefs.soundVolume)
}

/**
 * 试听。
 *
 * 设置页的「试听」用它。**它绕开开关**：声音关着的时候用户按试听，
 * 期待的是"让我听听是什么样"，而不是"没反应"——那会让他以为功能坏了，
 * 于是不敢开。
 *
 * 静音仍然生效：静音期按试听不出声，是用户自己刚要求的。
 *
 * @param cue 要试听的那一种。
 */
export function previewCue(cue: SoundCue): void {
  if (isMuted()) return
  emit(cue, getPreferences().soundVolume)
}
