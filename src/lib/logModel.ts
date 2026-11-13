/**
 * 日志的投影层：一串事件 → 一行行「她做了什么」。
 *
 * ## 为什么单独一层
 *
 * 渲染只负责画，投影只负责算。分开之后：整份读法可以在没有浏览器的情况下
 * 验证；同一份读法将来要给导出、给第二视图、给测试，都不必重新实现一遍。
 *
 * ## 五类，不是十类
 *
 * | 类 | 覆盖 | 读者的问题 |
 * | --- | --- | --- |
 * | `channel` | 收到消息、注入上下文 | 信息怎么进出的 |
 * | `model` | 思考、回复 | 模型在做什么 |
 * | `tool` | 工具调用与结果 | 她动了什么手 |
 * | `pace` | 轮次开始、结束、被打断 | 节奏 |
 * | `error` | 失败 | 哪儿不对 |
 *
 * 颜色只是扫描辅助，词才是语义。所以每一类都必须有一个能读的中文名，
 * 不能只靠底色区分。
 *
 * ## 分组只认轮次自己声明的边界
 *
 * 轮次之外的条目（清空前的残留、被拒绝的主动开口）`round` 为 0，不硬造
 * 一个组头——「第 0 轮」是界面在编。
 */

import type { LogEntry } from './types.ts'
import type { SystemLogRow } from './api.ts'
import { spokenDuration, toolDuration, toolLine, toolSubject } from './logText.ts'

/** 日志的五类。顺序即徽标的调色顺序。 */
export type LogCategory = 'channel' | 'model' | 'tool' | 'pace' | 'error'

/** 徽标文字。两字：一个字的「收」「具」读不出类别。 */
export const CATEGORY_LABEL: Readonly<Record<LogCategory, string>> = Object.freeze({
  channel: '收发',
  model: '思考',
  tool: '工具',
  pace: '节奏',
  error: '出错',
})

/**
 * 系统日志的级别词。
 *
 * 为什么必须有字：`.logp__dot` 是一枚 4px 圆点，级别只体现在它的颜色上，
 * 而且它带 `aria-hidden`——色觉障碍用户看不出 warn 与 error 的差别，
 * 读屏用户则完全拿不到这一维。项目在 `titlebar.css` 里已经定过规矩
 * 「状态词用文字，不只靠颜色」（`titlebar__presence` 就是那么做的），
 * 这里必须同一口径。
 *
 * `info` 给空串：常态不必逐行标注，标了反而让满屏都是噪声；warn / error
 * 才是需要一眼挑出来的少数。
 */
export const LEVEL_LABEL: Readonly<Record<SystemLogRow['level'], string>> = Object.freeze({
  info: '',
  warn: '注意',
  error: '错误',
})

/** 角色词。与消息气泡的「你 / 她」同口径，不另起说法。 */
export const ACTOR_LABEL: Readonly<Record<LogRow['actor'], string>> = Object.freeze({
  system: '系统',
  user: '你',
  assistant: '她',
})

/** 一行可渲染的日志。 */
export interface LogRow {
  id: string
  /** 发生时刻，epoch ms。 */
  at: number
  /** 所属轮次。0 表示不属于任何一轮。 */
  round: number
  category: LogCategory
  actor: 'system' | 'user' | 'assistant'
  /** 一行叙述。已经是人话，渲染层不再加工。 */
  text: string
  /** 可展开的正文（收到的话 / 她想的 / 她说的）。null 表示没有。 */
  body: string | null
  /** 正文折叠条的标题。「收到的话」「她想的过程」「她说的话」。 */
  bodyLabel: string | null
  /** 正文字数。 */
  chars: number | null
  /**
   * 独立时长，只有工具行才有。
   *
   * 回复与轮次的时长已经写进 `text` 的句子里（「想了 1.2 秒」），
   * 再挂一个数字就是把同一件事说两遍。工具没有那样的句子，
   * 所以它是唯一需要独立时长的一类。
   */
  duration: string | null
}

/** 一轮日志。 */
export interface LogGroup {
  /** React key。用轮次而不带上时间：同一轮只可能有一个组。 */
  key: string
  /** 第几轮；0 表示轮次之外。 */
  round: number
  /** 组内最早一条的时刻。 */
  at: number
  rows: LogRow[]
}

/**
 * 通道 → 五类。
 *
 * `rhythm` 是轮次节奏的旧名，对外统一叫 `pace`：界面上读的是「节奏」，
 * 数据层沿用旧键名，避免为了改个标签动一遍落盘数据。
 *
 * @param channel 数据层的通道名。
 * @returns 五类之一。
 */
function categoryOf(channel: LogEntry['channel']): LogCategory {
  switch (channel) {
    case 'rhythm': return 'pace'
    case 'channel': return 'channel'
    case 'model': return 'model'
    case 'tool': return 'tool'
    case 'error': return 'error'
  }
}

/**
 * 一条日志的叙述句。
 *
 * 四种来源各有各的说法，但都对读者成立：
 * - 工具行说「动词 · 主体」；
 * - 模型行把时长写进句子（只说一次）；
 * - 其余用宿主给的摘要原样；
 * - 摘要为空时说明发生了什么缺失，而不是留一行空白。
 *
 * @param entry 一条原始日志。
 * @returns 一行正文。
 */
function textOf(entry: LogEntry): string {
  if (entry.channel === 'tool') {
    const subject = entry.tool === undefined ? null : toolSubject(entry.args)
    return toolLine(entry.tool ?? '', subject)
  }
  const said = entry.summary.trim()
  if (entry.channel === 'model') {
    const spoken = spokenDuration(entry.ms)
    /* 「想完了，用了 10.1 秒」：时长并进句子，行尾不再挂第二个数字。 */
    if (spoken !== null) return said === '' ? `想了 ${spoken}` : `${said}，用了 ${spoken}`
  }
  return said === '' ? '（这一步没有留下说明）' : said
}

/**
 * 正文折叠条的标题。
 *
 * 三句话对应三类正文，读者一眼知道展开的是谁说的、还是她想的过程。
 * 认不出的一律「原文」——猜错来源比不给标题更糟。
 *
 * @param entry 一条原始日志。
 * @param hasBody 这一条到底有没有正文。
 * @returns 标题，或 null（没有正文时不渲染折叠条）。
 */
function bodyLabelOf(entry: LogEntry, hasBody: boolean): string | null {
  if (!hasBody) return null
  if (entry.channel === 'channel') return '收到的话'
  if (entry.channel === 'model') return entry.chars !== undefined && entry.summary.includes('想') ? '她想的过程' : '她说的话'
  return '原文'
}

/**
 * 把原始日志投影成可渲染的行。
 *
 * @param entries 原始日志，任意顺序（不排序：顺序由数据层负责，界面照用）。
 * @returns 与输入等长、一一对应的行。
 */
export function projectLog(entries: readonly LogEntry[]): readonly LogRow[] {
  return entries.map((entry) => {
    const body = entry.detail === undefined || entry.detail.trim() === '' ? null : entry.detail.trim()
    return {
      id: entry.id,
      at: entry.at,
      round: entry.round,
      category: categoryOf(entry.channel),
      actor: entry.actor,
      text: textOf(entry),
      body,
      bodyLabel: bodyLabelOf(entry, body !== null),
      chars: entry.chars ?? null,
      duration: entry.channel === 'tool' ? toolDuration(entry.ms) : null,
    }
  })
}

/**
 * 按轮次切组，保持原有顺序。
 *
 * 只合并**相邻**同轮的行：日志是按时间到达的，同一轮的行天然连在一起；
 * 若按 `round` 全局归并，一次回填的旧日志会被搬到最前面，顺序与时间轴不符。
 *
 * @param rows 已投影的行。
 * @returns 组的数组，顺序与输入一致。
 */
export function groupRounds(rows: readonly LogRow[]): readonly LogGroup[] {
  const groups: LogGroup[] = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (last !== undefined && last.round === row.round) {
      last.rows.push(row)
      continue
    }
    groups.push({
      /* 轮次之外（round 0）可能有多段，用 id 区分，避免同 key。 */
      key: row.round === 0 ? `loose-${row.id}` : `round-${String(row.round)}`,
      round: row.round,
      at: row.at,
      rows: [row],
    })
  }
  return groups
}
