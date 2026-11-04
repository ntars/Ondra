/**
 * WMO 天气码 → 中文短语。
 *
 * ## 为什么这张表自己写，而不是复用生态
 *
 * 它是**枚举翻译**，不是算法：28 个码，码值是 WMO 4677 的规定值，不随年份变。
 * 生态里的天气插件各带一份自己的翻译，口径互不相同（「少云」有的写「晴间多云」），
 * 拼起来会让她的措辞一会儿文一会儿白。这张表的价值在**口径统一**，
 * 所以本文件是唯一真源，消费方不许再自建一份。
 *
 * ## 为什么表里没有「类别」字段
 *
 * 曾经加过一个 `tag`（晴/云/雨/雪/雷）用来选语气，但**没有任何消费方读它**——
 * 一个没人读的分类字段，读代码的人会以为「语气是按类别选的」，于是去改一段
 * 从不执行的逻辑。选语气归 O-031/O-040，本插件只给事实。
 */

/**
 * WMO 4677 天气码表（只收 Open-Meteo 会返回的那些码）。
 *
 * 缺码（例如 4–44 的保留段）**不猜**：`phenomenonOf()` 返回 `undefined`，
 * 上层据此只报温度、不报现象。
 */
export const WMO_TABLE: Readonly<Record<number, string>> = Object.freeze({
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '毛毛雨',
  53: '细雨',
  55: '密毛雨',
  56: '冻毛毛雨',
  57: '强冻毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷雨伴冰雹',
})

/** 码是否在表内。 */
export function isWmoCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && WMO_TABLE[value] !== undefined
}

/**
 * 码 → 中文短语。表里没有就返回 `undefined`（**不返回「未知天气」**：
 * 那四个字会被模型原样说给用户，等于把内部缺失暴露成一句话）。
 * @param code WMO 码。
 */
export function phenomenonOf(code: unknown): string | undefined {
  if (!isWmoCode(code)) return undefined
  return WMO_TABLE[code]
}
