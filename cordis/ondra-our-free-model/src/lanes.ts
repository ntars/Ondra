/**
 * 两条免费车道的定义。
 *
 * ## 默认全部关闭（不是「默认开、可关」）
 *
 * 这两条车道的共同点是：**凭证不是用户的**。OpenCode 走公开的
 * `Authorization: Bearer public`，Kilo 走免费池——用户没有注册、没有同意任何条款，
 * prompt 就已经离开了本机。这与 Ondra「数据本地化、出站清单可枚举」的承诺正面冲突。
 *
 * 所以策略是：装好、可查、默认关，用户显式打开时再展示风险原文。
 * 关闭状态下本插件**不发任何请求**（包括模型清单与地区判定）。
 *
 * ## 风险文案为什么逐字保留英文原句
 *
 * Kilo 的模型卡原文是 "Not suitable for production or sensitive data workloads"。
 * 这是对方自己写的免责声明，翻译或概括都会削弱它的法律含义。中文说明放在下面，
 * 原文一字不改地引在说明里。
 */

import type { FreeLane } from './types.js'

/**
 * 免费车道清单。顺序即界面顺序。
 *
 * 渠道键带 `ofm-` 前缀：pi-ai 的 provider 路由名是全局唯一的，
 * 加前缀能让「这条路由是谁声明的」在日志与冲突报错里一眼可见。
 */
export const FREE_LANES: readonly FreeLane[] = Object.freeze([
  Object.freeze({
    id: 'ofm-opencode',
    name: 'OpenCode 免费车道',
    baseUrl: 'https://opencode.ai/inference/v1',
    api: 'openai-completions' as const,
    bearer: 'public',
    modelsPath: '/models',
    risk:
      '这条车道用的是 OpenCode 的公开免密额度（Bearer public），不消耗你自己的 Key，' +
      '但请求会经第三方网关中转。对话内容是否被留存由对方策略决定，本应用无法控制。' +
      '不要在其中发送密钥、身份证件、未公开的商业材料。',
  }),
  Object.freeze({
    id: 'ofm-kilo',
    name: 'Kilo 免费池',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    api: 'openai-completions' as const,
    bearer: null,
    modelsPath: '/models',
    risk:
      'Kilo 免费池的模型卡原文写着："Not suitable for production or sensitive data workloads"，' +
      '并声明 prompt 可能被记录用于改进服务。这是免费额度的对价，不是可以被忽略的提示。' +
      '只适合闲聊与试玩，不要用于任何含隐私或商业信息的内容。',
  }),
] as const)


