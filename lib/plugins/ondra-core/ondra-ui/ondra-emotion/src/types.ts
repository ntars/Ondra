/** 情绪等级 0–5：0 平静，5 破防。整数，不许小数——刻度越细越像演的。 */
export type EmotionLevel = 0 | 1 | 2 | 3 | 4 | 5

/** 表现强度：同一情绪可以说、可以只写在脸上、也可以不表现。 */
export type Express = 'none' | 'subtle' | 'open'

/** 在场状态：「正在输入」只在真的在打字时亮，走神的长停顿必须熄灭。 */
export type Presence = 'typing' | 'thinking' | 'away'

export interface EmotionState {
  level: EmotionLevel
  /** 一句人类可读的成因，用于日志与调试，不发给模型。 */
  cause: string
  at: number
}

export const EMOTION_SERVICE = 'emotion'
