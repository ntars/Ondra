/**
 * 隐私闸门。**本包唯一决定「一条数据能不能整段交给模型」的地方。**
 *
 * ## 为什么只读不够
 *
 * 「只读」保证的是**不改设备**，它不保证**不泄露人**。
 * 模型拿到的每个字都会进对话、进上下文缓存、进可能被导出的会话记录。
 * 所以只读能力的默认输出必须比原始数据**更少**：
 *
 * | 能力 | 默认返回 | 理由 |
 * |---|---|---|
 * | 通知 | 应用 + 标题（截断），**不带正文** | 通知正文里常有验证码、私信、银行提醒 |
 * | 短信 | 正文截断 + `truncated` 标记，号码打码 | 一条短信可能整段是私事 |
 * | 联系人 | 姓名 + **打码号码**，且关键词必填 | 一次能拿走一群人，是五个能力里最重的 |
 * | 电池 | 电量 / 充电 / 温度 | 本身无害 |
 * | 前台 App | 包名 + 界面名 | 本身无害（不取窗口内容） |
 *
 * 手册 §9.4 的口径是「desktop 感观刻意不暴露项（进程不取命令行、剪贴板只返回长度）」，
 * 本包照同一思路做：**能少给就少给，要更多请显式改配置**。
 *
 * ## 为什么截断不吞信息
 *
 * 截断必须**标出来**（`truncated: true`）。悄悄截断会让模型把半句话当成全部，
 * 于是她可能对一条被截掉后半段的短信作出完全错误的判断——
 * 这比直接不给她看更糟：不给她看，她会说「我看不到」；给她半句，她会自信地答错。
 */

import type { ContactItem, NotificationItem, SmsItem } from './types.js'
import { TITLE_MAX } from './types.js'

/** 号码打码结果。 */
export interface MaskedPhone {
  /** 打码后的号码。 */
  readonly phone: string
  /** 是否真的改过。 */
  readonly masked: boolean
}

/**
 * 号码打码：保留前 3 后 2，中间用 `*`。
 *
 * 短号（服务号、银行短号）整段只剩后 2 位——它们的「前 3 位」本身就是全部信息。
 * 分隔符与 `+` 保留，因为「这是国码」这件事对判断有用，而它不泄露个人。
 * @param phone 原始号码。
 */
export function maskPhone(phone: string): MaskedPhone {
  const text = phone.trim()
  if (text === '') return { phone: '', masked: false }
  const digits = text.replace(/\D/g, '')
  if (digits.length === 0) return { phone: text, masked: false }
  // 太短：只留后 2 位。
  if (digits.length <= 5) {
    const tail = digits.slice(-2)
    return { phone: '*'.repeat(Math.max(1, digits.length - 2)) + tail, masked: true }
  }
  const head = digits.slice(0, 3)
  const tail = digits.slice(-2)
  return { phone: head + '*'.repeat(digits.length - 5) + tail, masked: true }
}

/**
 * 截断并报告。
 *
 * 不补省略号：补了之后「正文多长」就不可判（模型会数到省略号本身）。
 * 用 `truncated` 布尔说清楚，比一个符号可靠。
 * @param text 原文。
 * @param max 上限（字符）。
 */
export function truncate(text: string, max: number): { readonly text: string; readonly truncated: boolean } {
  // 先压平空白：多行正文在单行展示里会把结构信息变成噪声。
  const flat = text.replace(/\s+/g, ' ').trim()
  const cap = Math.max(1, Math.trunc(max))
  if (flat.length <= cap) return { text: flat, truncated: false }
  // 不切代理对（emoji）中间：切一半会得到乱码。
  let end = cap
  const code = flat.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return { text: flat.slice(0, end), truncated: true }
}

/**
 * 加工一条通知。
 * @param item 来源给的通知。
 * @param includeBody 是否带正文。
 * @param bodyMax 正文上限。
 */
export function shapeNotification(
  item: NotificationItem,
  includeBody: boolean,
  bodyMax: number,
): { readonly value: NotificationItem; readonly degraded: boolean } {
  const app = truncate(item.app, TITLE_MAX)
  const title = truncate(item.title, TITLE_MAX)
  let degraded = app.truncated || title.truncated
  const shaped: NotificationItem = {
    app: app.text,
    title: title.text,
    at: item.at,
  }
  if (includeBody) {
    const body = truncate(item.body ?? '', bodyMax)
    degraded = degraded || body.truncated
    return { value: { ...shaped, body: body.text }, degraded }
  }
  // 刻意**不返回** `body` 键，而不是返回空串：空串会被读成「通知没有正文」。
  return { value: shaped, degraded }
}

/**
 * 加工一条短信。
 * @param item 来源给的短信。
 * @param mask 是否打码号码。
 * @param bodyMax 正文上限。
 */
export function shapeSms(
  item: SmsItem,
  mask: boolean,
  bodyMax: number,
): { readonly value: SmsItem; readonly degraded: boolean } {
  const body = truncate(item.body, bodyMax)
  const address = mask ? maskPhone(item.address) : { phone: item.address.trim(), masked: false }
  return {
    value: {
      id: item.id,
      address: address.phone,
      body: body.text,
      date: item.date,
      truncated: body.truncated,
    },
    degraded: body.truncated || address.masked,
  }
}

/**
 * 加工一条联系人。
 * @param item 来源给的联系人。
 * @param mask 是否打码号码。
 */
export function shapeContact(
  item: ContactItem,
  mask: boolean,
): { readonly value: ContactItem; readonly degraded: boolean } {
  const name = truncate(item.name, TITLE_MAX)
  const phone = mask ? maskPhone(item.phone) : { phone: item.phone.trim(), masked: false }
  return {
    value: { name: name.text, phone: phone.phone },
    degraded: name.truncated || phone.masked,
  }
}
