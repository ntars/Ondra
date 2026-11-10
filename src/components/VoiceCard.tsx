/**
 * 「她真的会说话」这一格（偏好设置 → 声音）。
 *
 * ## 为什么它不能只是一个开关
 *
 * `tts.enable` 只回答「用户想不想让她说话」。真正出不出声还取决于三件
 * 别的事：合成通道在不在（这台机器有没有 `say` / `edge-tts` / GPT-SoVITS）、
 * 语音闸门放不放行（句长 6–30 字、情绪强度、3 秒频控、连读上限）、
 * 宿主有没有把两段接起来。
 *
 * 四件事的症状**完全一样**：安静。所以这里必须把「安静」拆成一句话，
 * 否则用户只会得到一个结论——「语音坏了」，然后查四轮。
 *
 * ## 三个数各自证明什么
 *
 * | 数 | 为 0 时说明 | 大于 0 时说明 |
 * | --- | --- | --- |
 * | `decisions` | 宿主那条线断了，一次都没判过 | 每一轮回复都在过闸门 |
 * | `spoken` | 全被闸门拦下了（`blocked` 会说哪道） | 真的放行过、合成过 |
 * | `cacheFiles` | 缓存目录是空的 | 磁盘上有音频文件 |
 *
 * 三者混成一句「语音正常」，就会把「没接线」和「被拦下」说成同一件事。
 *
 * ## 为什么开关写 `tts.enable` 而不是另存一个偏好
 *
 * 那个键是插件自己的总开关，`enable=false` 时它自报 `reason='disabled'`、
 * 合成通道置 `none`。在这里另存一个布尔值就有了两个真源，而用户能改的
 * 那个通常是漂掉的那个。
 */

import { useCallback, useEffect, useState } from 'react'
import { getVoiceState } from '../lib/api.ts'
import type { VoiceState } from '../lib/api.ts'
import { getSettings, saveSetting } from '../lib/settings.ts'

/** 通道名翻成人话。`none` 单独说，因为它是「没有任何一条通道」而不是「某条坏了」。 */
function engineText(engine: string): string {
  if (engine === 'macos-say') return '系统语音'
  if (engine === 'edge-tts') return 'Edge TTS'
  if (engine === 'gpt-sovits') return 'GPT-SoVITS'
  if (engine === 'none') return '没有可用通道'
  return engine
}

/** 闸门拒绝码翻成人话。只翻常用的四个，其余原样给出——编造文案比原码更误导。 */
function blockedText(reason: string): string {
  if (reason === 'too-short') return '太短'
  if (reason === 'too-long') return '太长'
  if (reason === 'cooldown') return '太密'
  if (reason === 'text-only') return '连着说了几条'
  if (reason === 'flat') return '语气太平'
  if (reason === 'harsh') return '正在生气'
  return reason
}

/** 渲染语音状态与开关。 */
export function VoiceCard(): React.JSX.Element {
  const [voice, setVoice] = useState<VoiceState | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  /** 用户层里 `tts.enable` 的覆盖值；`undefined` 表示没改过、用插件默认。 */
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  /** 插件默认值，来自设置段的字段声明。 */
  const [fallback, setFallback] = useState(true)

  const load = useCallback((): void => {
    void getVoiceState()
      .then((next) => { setVoice(next); setFailed(false) })
      .catch(() => { setFailed(true) })
    void getSettings()
      .then((snapshot) => {
        const section = snapshot.sections.find((item) => item.id === 'tts')
        const field = section?.fields.find((item) => item.key === 'enable')
        if (typeof field?.default === 'boolean') setFallback(field.default)
        const value = snapshot.user['tts']?.['enable']
        setOverride(typeof value === 'boolean' ? value : undefined)
      })
      .catch(() => { /* 读不到设置不影响状态显示，开关按插件默认值渲染 */ })
  }, [])

  useEffect(() => { load() }, [load])

  const enabled = override ?? fallback

  const change = useCallback((next: boolean): void => {
    /*
     * 与插件默认值相同时**删键**而不是写同值。
     *
     * 写同值会在 `settings.json` 里留下一行与默认一样的设置，从此
     * 「恢复默认」再也回不到「没改过」的状态——用户分不清哪些是他真改的。
     * 这是设置页「恢复默认」的统一口径。
     */
    const value = next === fallback ? undefined : next
    setOverride(value)
    void saveSetting('tts', 'enable', value).catch(() => { setOverride(override) })
  }, [fallback, override])

  if (failed) {
    return (
      <div className="pref__row">
        <div className="pref__row-text">
          <span className="pref__row-label">朗读</span>
          <span className="pref__row-hint">读不到语音状态，宿主可能没在跑</span>
        </div>
      </div>
    )
  }

  /*
   * 三个分支必须分开说，因为它们对应三种不同的用户动作：
   * 没装插件（去装）、没通道（去装引擎）、能出声（去说话）。
   */
  const note = voice === undefined
    ? '正在读语音状态…'
    : voice.note !== ''
      ? voice.note
      : ''

  const stats = voice?.gateStats
  const ttsStats = voice?.ttsStats
  const blocked = stats === undefined ? [] : Object.entries(stats.blocked)

  return (
    <>
      <div className="pref__row">
        <div className="pref__row-text">
          <span className="pref__row-label">朗读</span>
          <span className="pref__row-hint">
            {voice === undefined ? '读状态中' : `她说完的话会念出来（${engineText(voice.engine)}）`}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="朗读"
          className="pref__switch pref__switch--voice control-switch"
          onClick={() => { change(!enabled) }}
        >
          <span className="pref__switch-knob control-switch-knob" />
        </button>
      </div>

      {note !== '' ? (
        <p className="pref__note">{note}</p>
      ) : null}

      {/*
       * 账本只在真的开始过之后才有意义。全零时不说「0 次」，那读起来像坏了；
       * 说「还没有轮次经过闸门」才是准确的——装上但还没说话，本来就是这个数。
       */}
      {voice !== undefined && stats !== undefined ? (
        stats.decisions === 0 ? (
          <p className="pref__note">
            还没有一轮回复经过语音闸门。说一句话就会开始记账。
          </p>
        ) : (
          <p className="pref__note">
            {`判过 ${String(stats.decisions)} 次，放行 ${String(stats.spoken)} 次`
              + (ttsStats === undefined ? '' : `，合成 ${String(ttsStats.calls)} 次（成功 ${String(ttsStats.ok)}）`)
              + (blocked.length === 0
                ? ''
                : `，拦下：${blocked.map(([reason, count]) => `${blockedText(reason)} ${String(count)}`).join('、')}`)}
          </p>
        )
      ) : null}

      <p className="pref__note">
        不是每一句都会念。太短的（不足 6 字）、连着说好几条的、刚念过不到 3 秒的，都会留成文字——
        一句「在。」被念出来反而像机器。想让她什么都念，可以在「模块」里调闸门的三个数。
      </p>
    </>
  )
}
