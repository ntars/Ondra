/**
 * 票据档的读写。
 *
 * ## 落点与写法
 *
 * `user/sandbox-tickets.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * 为什么一定要 0600：票据本身就是「这个进程被允许做哪些事」的一份清单。
 * 让它可被同机其他用户读到，等于把一份待执行的授权书贴在门上。
 *
 * ## 存什么、不存什么
 *
 * 存：票据 id、谁、做什么、级别、签发/截止时刻、已用次数、上限、终态时刻与原因。
 *
 * **不存调用内容**——参数、返回值、调用理由、拒绝时用户说了什么，一律不写。
 * 理由：一份「谁在什么时候调了什么」的记录，事实上就是一份行为日志；
 * 而行为日志最自然的下一步是拿去解释她的动机，那是最难查的一类错误归因。
 * 本包只需要回答「这张票还有效吗」，不需要知道票是怎么被用掉的。
 *
 * ## 丢了会怎样
 *
 * 重启后所有票作废，所有主体回到 default-deny。**这是安全的方向**：
 * 丢了票的后果是「原本能干的事干不了了」，而不是「原本不能干的事能干了」。
 * 因此读失败一律退成空档 + 一行 `warn`，不重试、不备份、不写第二份。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { STATE_VERSION } from './types.js'
import type { TicketRecord } from './types.js'
import { normalizeRecord } from './tickets.js'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 读盘结果。 */
export interface LoadResult {
  /** 合法票据（读不到就是空）。 */
  readonly tickets: readonly TicketRecord[]
  /** 是否是**首次**读（文件原本不存在）。 */
  readonly fresh: boolean
  /** 读失败原因（中文）；读成功或文件不存在为 `undefined`。 */
  readonly issue?: string
  /** 被丢弃的非法条目数。**不为 0 就要在日志里说**，否则票会无声消失。 */
  readonly dropped: number
}

/**
 * 从磁盘读票据档。**永不抛错。**
 * @param filePath 绝对路径；`undefined` 表示只在内存。
 */
export function readTickets(filePath: string | undefined): LoadResult {
  if (filePath === undefined) return { tickets: [], fresh: true, dropped: 0 }
  let text: string
  try {
    text = readFileSync(filePath, { encoding: 'utf8' })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { tickets: [], fresh: true, dropped: 0 }
    return {
      tickets: [],
      fresh: false,
      dropped: 0,
      issue: '读不到票据档：' + String(code ?? '未知错误'),
    }
  }
  if (text.trim() === '') return { tickets: [], fresh: false, dropped: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      tickets: [],
      fresh: false,
      dropped: 0,
      issue: '票据档不是合法 JSON，已按「没有票」处理',
    }
  }
  // JSON 可以是 `null` / 数组 / 标量：先判形状再取 `tickets`，否则一个 `null` 就会让
  // 「永不抛错」这句承诺当场作废。
  const holding = typeof parsed === 'object' && parsed !== null ? (parsed as { tickets?: unknown }) : {}
  const list = (holding as { tickets?: unknown }).tickets
  if (!Array.isArray(list)) {
    return {
      tickets: [],
      fresh: false,
      dropped: 0,
      issue: '票据档缺少 tickets 数组，已按「没有票」处理',
    }
  }
  const tickets: TicketRecord[] = []
  let dropped = 0
  for (const item of list) {
    const record = normalizeRecord(item)
    if (record === null) dropped += 1
    else tickets.push(record)
  }
  return { tickets: Object.freeze(tickets), fresh: false, dropped }
}

/**
 * 写票据档：临时文件 + `rename` 原子替换。
 *
 * 字段逐个写出，**不用展开运算符**：展开会把将来新增的字段悄悄写进盘，
 * 而「存了什么」必须是能一眼读完的一份清单（见文件头第二条）。
 * @param filePath 绝对路径。
 * @param tickets 全部票据（含已终态的）。
 */
export function writeTickets(filePath: string, tickets: readonly TicketRecord[]): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      tickets: tickets.map(ticket => ({
        id: ticket.id,
        subject: ticket.subject,
        action: ticket.action,
        level: ticket.level,
        issuedAt: ticket.issuedAt,
        expiresAt: ticket.expiresAt,
        uses: ticket.uses,
        maxUses: ticket.maxUses,
        lastUsedAt: ticket.lastUsedAt,
        endedAt: ticket.endedAt,
        endedBy: ticket.endedBy,
      })),
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
