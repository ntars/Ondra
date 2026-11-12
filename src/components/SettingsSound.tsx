/**
 * 设置 · 声音。
 *
 * ## 一页管两件事，但分成四段
 *
 * 提示音（界面的音效）、朗读（她的声音）、口吻（句子里像不像人）、
 * 节奏（说得多快）、规矩（该不该说）。它们是一条流水线上相邻的工位：
 * 口吻决定句子、节奏决定快慢、朗读决定出不出声、过滤决定删不删。
 *
 * 合成一格会让修法看起来只有一条路，而实际是四条——合成坏了节奏照跑、
 * 节奏关掉了声音照出。分段是它们的独立性在界面上的样子。
 */

import { usePreferences, setPreferences } from '../lib/preferences.ts'
import { playCue, previewCue } from '../lib/sound.ts'
import type { SoundCue } from '../lib/sound.ts'
import { FilterCard } from './FilterCard.tsx'
import { OralCard } from './OralCard.tsx'
import { RhythmCard } from './RhythmCard.tsx'
import { VoiceCard } from './VoiceCard.tsx'
import { Heading, Note, Row, Toggle } from './settingsUi.tsx'

/**
 * 三种音的展示清单。
 *
 * 顺序即用户在会话里听到它们的顺序：先发出去，她才开口，出错收尾。
 * 文案用动词/名词的原样，不写「音效一」「提示音 A」——那种命名
 * 让用户不知道该期待什么。
 */
const CUES: Array<{ key: SoundCue; label: string; hint: string }> = [
  { key: 'send', label: '发送', hint: '消息发送时' },
  { key: 'speak', label: '回复开始', hint: '开始生成回复时' },
  { key: 'error', label: '出错', hint: '本轮失败时' },
]

export function SettingsSound(): React.JSX.Element {
  const prefs = usePreferences()

  /**
   * 打开或关闭提示音。
   *
   * 打开的同时播一声：用户不知道它到底开没开时，只能等下一次真实发消息。
   * 这一声用 `previewCue`——它绕开开关本身，此刻开关已设为开，走哪条都一样。
   */
  const changeSound = (next: boolean): void => {
    setPreferences({ sound: next })
    if (next) previewCue('send')
  }

  return (
    <section className="pref__section">
      {/*
        小节名与卡内标题不能同名。
        
        「提示音」这个标题底下的第一行就叫「提示音」，「朗读」这个标题底下
        的第一行也叫「朗读」——两行字一模一样、上下相隔 20px，读起来像
        渲染了两遍。小节名要回答「这一堆是管什么的」，所以它写的是范围
        （音效 / 她的声音），卡内标题写的是那个开关本身。
      */}
      <Heading>音效</Heading>

      <Row label="提示音" hint="发送、回复开始、出错时各播放一次">
        <Toggle label="提示音" checked={prefs.sound} onChange={changeSound} />
      </Row>

      <Heading>语音输入</Heading>
      <Row label="语音输入" hint="在输入框显示麦克风按钮，可录音转为文字">
        <Toggle label="语音输入" checked={prefs.voiceInput} onChange={(next) => { setPreferences({ voiceInput: next }) }} />
      </Row>
      <Note>
        首次使用麦克风时，系统会请求授权。语音转写在本机完成，需要您的环境中装有本地语音识别模型
        （如 whisper）；未安装时，录音后会给明确提示而非静默失败。
      </Note>

      <div className="pref__slider" data-off={prefs.sound ? undefined : ''}>
        <div className="pref__slider-head">
          <span className="pref__row-label">音量</span>
          <span className="pref__slider-readout" aria-hidden="true">{prefs.soundVolume}</span>
        </div>
        <input
          type="range"
          className="pref__range control-range"
          min={0}
          max={100}
          step={1}
          value={prefs.soundVolume}
          aria-label="提示音音量"
          aria-valuetext={String(prefs.soundVolume)}
          disabled={!prefs.sound}
          /* 已填充比例（§12.16）。0–100 的连续档，直接用值当百分比。 */
          style={{ '--fill': `${String(prefs.soundVolume)}%` } as React.CSSProperties}
          onChange={(event) => {
            setPreferences({ soundVolume: Number(event.target.value) })
          }}
          /*
            松手才试听（§6.5「音量 → 播放一声 200ms 的提示音」）。
            拖动过程中每帧都响会变成一串机关枪，那不是预演是噪音。
            `onChange` 在 WebKit 上随拖动连续触发，所以预演挂在 pointerup 上。
          */
          onPointerUp={() => { playCue('send') }}
          onKeyUp={() => { playCue('send') }}
        />
      </div>

      {/*
        三种音逐个可听。没有这三个入口，「只有三种音」就只是一句话：
        用户没法知道「她开口」和「发送」听起来有什么不同，也就没法判断要不要开。
      */}
      <div className="pref__cues">
        {CUES.map((cue) => (
          <button
            key={cue.key}
            type="button"
            className="pref__cue"
            aria-disabled={prefs.sound ? undefined : 'true'}
            title={prefs.sound ? undefined : '先打开提示音'}
            onClick={() => {
              if (!prefs.sound) return
              playCue(cue.key)
            }}
          >
            <span className="pref__cue-name">{cue.label}</span>
            <span className="pref__cue-hint">{cue.hint}</span>
          </button>
        ))}
      </div>

      <Note>
        本档音量仅作用于上述三种提示音，不改变系统音量。本应用不提供打字音与环境音：打字音会与逐字输出叠加成噪声，环境音会使应用偏离陪伴定位。
      </Note>

      <Heading>朗读声音</Heading>
      <VoiceCard />

      <Heading>说话口吻</Heading>
      <OralCard />

      <Heading>说话节奏</Heading>
      <RhythmCard />

      <Heading>说话的规矩</Heading>
      <FilterCard />
    </section>
  )
}
