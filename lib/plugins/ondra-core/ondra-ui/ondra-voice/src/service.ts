/**
 * 语音服务：把一段回答切成「念哪几段、怎么念」，以及识别端的状态。
 *
 * 只产出计划，不真的调用 TTS——发声是平台能力（ondra-flutter 的 system 服务），
 * 这里管的是「念什么、按什么参数念」。
 */
export interface Utterance {
  text: string
  timbre: string
  rate: number
  /** 段落在原文中的序号，方便界面高亮。 */
  index: number
}

export class VoiceService {
  private listening = false

  constructor(
    private readonly tts: boolean,
    private readonly timbre: string,
    private readonly rate: number,
  ) {}

  /** 长回答只念前两段：念完一整屏没人听，中途打断又很怪。 */
  plan(answer: string): Utterance[] {
    if (!this.tts) return []
    const paragraphs = answer.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    return paragraphs.slice(0, 2).map((text, index) => ({
      text, timbre: this.timbre, rate: this.rate, index,
    }))
  }

  startListening(): void { this.listening = true }
  stopListening(): void { this.listening = false }
  isListening(): boolean { return this.listening }

  /** 识别结束后交回文本与耗时，供上层决定是否当作一次发言。 */
  heard(text: string, elapsedMs: number): { text: string; accept: boolean } {
    const clean = text.trim()
    return { text: clean, accept: clean.length > 0 && elapsedMs < 60_000 }
  }
}
