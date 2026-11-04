/**
 * 三家的请求整形与响应解析。**唯一有「协议知识」的文件**。
 *
 * ## 为什么三家能共用一个实现
 *
 * §12.1 第一条：能融就融，把差异参数化。三家的差别只有两处：
 *
 * | | 路径 | 图片字段 |
 * |---|---|---|
 * | ollama | `/api/chat` | `messages[0].images: [base64]`（**裸 base64，不带 data: 前缀**） |
 * | openai | `/chat/completions` | `content[1].image_url.url: "data:image/png;base64,..."` |
 * | qwen | `/chat/completions`（compatible-mode） | 同 openai |
 *
 * 其余全部相同：都是 POST JSON、都要 `stream:false`、都是「提示词 + 一张图」。
 * 所以这里只有一张表 + 两个整形函数，没有三套分支。
 *
 * ## 为什么温度写死 0
 *
 * 视觉描述不是创作。温度一高，「图里有没有狗」这种问题会开始摇摆：
 * 同一张图问两次得到两个答案，而记忆只存第一条。0 不是最优，是**可复现**。
 *
 * ## 为什么提示词里逐字要求「不要猜」
 *
 * 手册 §2.2 的写入门控要求「数字必须有出处」。一段「她好像在海边」的猜测
 * 一旦入库，就变成一条永远查不到出处的记忆。视觉模型天生爱补全（看到半张桌子
 * 就说「正在吃饭」），所以提示词必须把「看不到就说看不到」写死。
 */

import type {
  DetectionBox,
  ImageSize,
  ResolvedEndpoint,
  VisionAction,
  VisionProvider,
} from './types.js'
import type { Config } from './settings.js'
import { firstJsonObject, numberOr, squeeze, stringOr } from './text.js'

/** 一次待发的请求。 */
export interface WireRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** 定位解析的结果。 */
export interface BoxParse {
  readonly boxes: readonly DetectionBox[]
  /** 被丢掉了几条（形状不对、坐标全零、非数字）。 */
  readonly rejected: number
  /** 补充说明（像素坐标换算过、全部被丢的原因）。 */
  readonly detail?: string
}

/** 生成描述用的提示词。 */
export function describePrompt(maxChars: number): string {
  return [
    '请用中文客观描述这张图片。',
    '第一句是一句总述（不超过 30 字），然后用短句列出关键细节：人物、场景、物体、画面里出现的文字。',
    '只写你确实看到的东西；看不清、被裁掉、无法判断的部分，直接说「看不清」，不要推测原因、不要补全剧情。',
    '不要评价、不要抒情、不要以「图片中」「这张图」开头。',
    `总字数不超过 ${maxChars} 字。`,
  ].join('\n')
}

/** 生成 OCR 用的提示词。 */
export function ocrPrompt(): string {
  return [
    '请逐字提取这张图片里所有可见的文字，保持原有的换行与先后顺序。',
    '不要翻译、不要解释、不要补标点、不要纠正错别字。',
    '若图中没有任何文字，只回答四个字：没有文字。',
  ].join('\n')
}

/** 生成定位用的提示词。 */
export function locatePrompt(target: string): string {
  return [
    `请在这张图片里定位「${target}」。`,
    '只输出一个 JSON 对象，不要输出任何解释、不要加代码块标记：',
    '{"boxes":[{"label":"名称","x":0.12,"y":0.34,"w":0.2,"h":0.15}]}',
    'x / y 是方框左上角相对图片宽高的比例，w / h 是相对宽高，全部是 0 到 1 之间的小数。',
    '每一项必须是这样的对象，不要写成四个数字的数组。',
    '如果图里没有这个东西，输出 {"boxes":[]}。',
  ].join('\n')
}

/** 按动作取提示词。 */
export function promptOf(action: VisionAction, maxChars: number, target: string): string {
  if (action === 'ocr') return ocrPrompt()
  if (action === 'locate') return locatePrompt(target)
  return describePrompt(maxChars)
}

/**
 * 估算输出 token 上限。
 *
 * 中文一个字大约 1–1.5 token（各家分词器不同）。按 1.5 估并留 10% 余量：
 * 估少了会截在半句话上（而 `finish_reason` 是 `length`，不报错），
 * 估多了只是把上限抬高，不花钱。
 * @param maxChars 正文字数上限。
 */
export function maxTokensOf(maxChars: number): number {
  return Math.min(8000, Math.max(256, Math.ceil(maxChars * 1.5) + 64))
}

/**
 * 拼一次请求。**纯函数**：不发请求、不读文件、不读环境变量。
 * @param provider 哪一家。
 * @param endpoint 解析后的接入点。
 * @param config 配置（取模型名与细节档）。
 * @param action 动作。
 * @param image 图片（base64 与 mime）。
 * @param apiKey 已解析出的密钥；没有就不带 `Authorization`（本机 Ollama 不需要）。
 * @param target 定位目标（只有 locate 用）。
 */
export function buildRequest(
  provider: VisionProvider,
  endpoint: ResolvedEndpoint,
  config: Config,
  action: VisionAction,
  image: { readonly base64: string; readonly mime: string; readonly dataUrl: string },
  apiKey: string | undefined,
  target: string,
): WireRequest {
  const prompt = promptOf(action, config.maxOutputChars, target)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey !== undefined && apiKey !== '') {
    headers['authorization'] = `Bearer ${apiKey}`
  }

  if (provider === 'ollama') {
    // Ollama 的 images 收**裸 base64**：带 `data:` 前缀会被当成非法图片，回 400。
    const body = {
      model: config.model,
      stream: false,
      options: { temperature: 0 },
      messages: [{ role: 'user', content: prompt, images: [image.base64] }],
    }
    return { url: `${endpoint.base}/api/chat`, headers, body: JSON.stringify(body) }
  }

  const body = {
    model: config.model,
    stream: false,
    temperature: 0,
    max_tokens: action === 'locate' ? 600 : maxTokensOf(config.maxOutputChars),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: image.dataUrl, detail: config.detail } },
        ],
      },
    ],
  }
  return { url: `${endpoint.base}/chat/completions`, headers, body: JSON.stringify(body) }
}

/**
 * 从响应里取正文。
 *
 * 三家都试一遍而不是按 provider 分支：`ollama` 的部分版本也支持
 * OpenAI 兼容的 `/v1/chat/completions`，用户可能把 base-url 指到那儿。
 * 按 provider 分支会让这种「配对了但走错字段」的用法静默拿到空串。
 * @param json 响应对象。
 */
export function textOfResponse(json: Record<string, unknown>): string | undefined {
  const direct = stringOr(json['response'])
  if (direct !== undefined && direct !== '') return direct

  const message = json['message']
  if (typeof message === 'object' && message !== null) {
    const content = contentOf((message as Record<string, unknown>)['content'])
    if (content !== undefined && content !== '') return content
  }

  const choices = json['choices']
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0]
    if (typeof first === 'object' && first !== null) {
      const message = (first as Record<string, unknown>)['message']
      if (typeof message === 'object' && message !== null) {
        const content = contentOf((message as Record<string, unknown>)['content'])
        if (content !== undefined && content !== '') return content
      }
      const text = stringOr((first as Record<string, unknown>)['text'])
      if (text !== undefined && text !== '') return text
    }
  }
  return undefined
}

/** 取 content：可能是字符串，也可能是分段数组（新版兼容端点会给数组）。 */
function contentOf(value: unknown): string | undefined {
  const text = stringOr(value)
  if (text !== undefined) return text
  if (!Array.isArray(value)) return undefined
  const parts: string[] = []
  for (const part of value) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    if (typeof part === 'object' && part !== null) {
      const piece = stringOr((part as Record<string, unknown>)['text'])
      if (piece !== undefined) parts.push(piece)
    }
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/**
 * 从模型回复里解析方框。
 *
 * 三件事必须做，否则「定位」会安静地给出错位框：
 * 1. **像素坐标要换算**。模型常说「只输出比例」，实际常回 `x: 420`；
 *    不换算的话，420 会被夹成 1.0，框全挤在右下角。
 * 2. **夹紧到 0–1**，并丢掉 `w<=0` / `h<=0` 的退化框。
 * 3. **换算不了就整批拒收**。尺寸解析失败 + 坐标像像素 = 无法换算，
 *    这时给出一批假框比给 0 个框更糟：下游会把它画到记忆里。
 * @param raw 模型原文。
 * @param size 图片真实尺寸（解析不出则为 undefined）。
 */
export function parseBoxes(raw: string, size: ImageSize | undefined): BoxParse {
  const obj = firstJsonObject(raw)
  if (obj === undefined) {
    return { boxes: [], rejected: 0, detail: '回复里找不到 JSON 对象' }
  }
  const list = obj['boxes']
  if (!Array.isArray(list)) {
    return { boxes: [], rejected: 0, detail: 'JSON 里没有 boxes 数组' }
  }

  // 数组形式的方框一律拒收：`[x, y, w, h]` 与 `[x1, y1, x2, y2]` 在数值上无法区分。
  //
  // 曾经写过「两种写法按角点解释恰好等价」——那是错的，对拍当场抓出来：
  // `[0.1, 0.2, 0.3, 0.4]` 若是 `[x,y,w,h]`，矩形右下角是 (0.4, 0.6)；
  // 按角点解释只到 (0.3, 0.4)，框会整体缩小三成，而且不报错。
  // 判错的框会被画进记忆，比没有框糟得多，所以这里不猜：拒收、计数、说明。
  const arrayItems = list.filter(item => Array.isArray(item)).length
  if (arrayItems > 0) {
    return {
      boxes: [],
      rejected: list.length,
      detail:
        '模型回了数组形式的方框（无法区分 [x,y,w,h] 与 [x1,y1,x2,y2]），整批拒收；'
        + '本包只认 {"boxes":[{"x":..,"y":..,"w":..,"h":..}]}',
    }
  }

  // 先扫一遍判断量级：只要有一个绝对值大于 1，就按像素处理。
  let pixelish = false
  for (const item of list) {
    for (const value of rawNumbers(item)) {
      if (Math.abs(value) > 1.001) pixelish = true
    }
  }
  if (pixelish && (size === undefined || size.width <= 0 || size.height <= 0)) {
    return {
      boxes: [],
      rejected: list.length,
      detail: '模型回的是像素坐标，但解析不出图片尺寸，无法换算——整批拒收，不猜',
    }
  }

  const boxes: DetectionBox[] = []
  let rejected = 0
  for (const item of list) {
    const box = oneBox(item, size, pixelish)
    if (box === undefined) {
      rejected += 1
      continue
    }
    boxes.push(box)
  }
  const detail = pixelish ? `模型回了像素坐标，已按 ${size?.width}×${size?.height} 换算成比例` : undefined
  return { boxes, rejected, detail }
}

/** 取一条里的坐标值（只认对象形式；数组在 `parseBoxes()` 里已经整批拒收）。 */
function rawNumbers(item: unknown): readonly number[] {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
  const record = item as Record<string, unknown>
  const keys = ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2']
  const out: number[] = []
  for (const key of keys) {
    const value = numberOr(record[key])
    if (value !== undefined) out.push(value)
  }
  return out
}

/** 归一化一条方框；形状不对返回 undefined。 */
function oneBox(item: unknown, size: ImageSize | undefined, pixelish: boolean): DetectionBox | undefined {
  let label = ''
  let x: number | undefined
  let y: number | undefined
  let w: number | undefined
  let h: number | undefined

  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const record = item as Record<string, unknown>
    label = stringOr(record['label']) ?? stringOr(record['name']) ?? ''
    x = numberOr(record['x']) ?? numberOr(record['x1'])
    y = numberOr(record['y']) ?? numberOr(record['y1'])
    const right = numberOr(record['x2'])
    const bottom = numberOr(record['y2'])
    w = numberOr(record['w']) ?? numberOr(record['width'])
    h = numberOr(record['h']) ?? numberOr(record['height'])
    if (w === undefined && x !== undefined && right !== undefined) w = right - x
    if (h === undefined && y !== undefined && bottom !== undefined) h = bottom - y
  } else {
    return undefined
  }

  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined

  if (pixelish) {
    if (size === undefined) return undefined
    x /= size.width
    y /= size.height
    w /= size.width
    h /= size.height
  }

  const box: DetectionBox = {
    label: squeeze(label) === '' ? '目标' : squeeze(label),
    x: clamp01(x),
    y: clamp01(y),
    w: clamp01(w),
    h: clamp01(h),
  }
  if (box.w <= 0 || box.h <= 0) return undefined
  return box
}

/** 夹到 0–1。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
