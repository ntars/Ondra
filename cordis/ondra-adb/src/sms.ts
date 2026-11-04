/**
 * 短信查询的**命令组合**与**输出解析**。全包只有这里知道 `content query` 长什么样。
 *
 * ## 命令的依据边界（必须说清）
 *
 * master-plan §9.11 给了四件事：URI `content://sms/inbox`、未读 20 条、
 * 15 秒轮询、`seen` 集合 1000→500。它**没给**命令行。
 * 手册正文检索 `adb` 只有 3 处（§1.7 修订行、§7.4 设置入口、书签表），
 * 也没有 `content query` 的用法。
 *
 * 所以这里的 argv 是**按 Android 公开的 `content` 工具用法写的、仓内无副本、未实跑**，
 * 已登记进 README「已知限制」第 1 条。
 * 一旦真机行为不同，症状很具体：`ok:true` 但 `read:0` 且 `badRows:0`（一条都解析不出），
 * 或 `exit` 非零并带 usage —— 改本文件一处即可，`policy.ts` 与 `service.ts` 不用动。
 *
 * ## 为什么不用 `--sort 'date DESC'`
 *
 * `adb shell` 会把 argv 拼成一行再交给设备侧的 sh 重解析，所以带空格的
 * `--sort "date DESC"` 必须自带引号才能活着到设备上。塞一对引号进去
 * 就等于把「命令拼接」这件事悄悄搬回本包——`policy.ts` 特意禁掉的那类风险。
 *
 * 改为：**不要服务端排序，本地排**。多读几行的代价是几十字节的 stdout，
 * 换掉的是「引号转义在设备侧行为不确定」这个不可测变量。
 *
 * ## 为什么每次取「最早的未读」而不是「最新的 20 条」
 *
 * 未读有 300 条时，如果只取最新的 20 条，中间那 280 条**永远轮不到**——
 * 用户只会看到她在回三天前的旧短信，而昨天那条石沉大海。按时间升序取前 N 条，
 * 队列才会真正被走完。代价是「刚收到的短信要排一会儿队」，这是可接受的。
 */

import type { SmsMessage } from './types.js'
import { SMS_URI, UNREAD_BATCH } from './types.js'

/** 只要四列：主键、号码、正文、时间。多要一列就多读一份隐私。 */
export const SMS_PROJECTION = '_id:address:body:date'

/**
 * 拼一条只读查询命令。
 *
 * 形状：`adb -s <serial> shell content query --uri content://sms/inbox
 * --projection _id:address:body:date --where read=0`
 *
 * `-s` 由执行器在**外层**加（它属于 adb 本体参数，不属于 `shell` 之后），
 * 所以这里返回的第一个元素恒为 `shell`——`policy.ts` 就是这么判的。
 * @param unreadOnly 只看未读。
 */
export function queryArgv(unreadOnly: boolean): readonly string[] {
  const argv: string[] = [
    'shell',
    'content',
    'query',
    '--uri',
    SMS_URI,
    '--projection',
    SMS_PROJECTION,
  ]
  if (unreadOnly) {
    // 不带空格，故不需要引号；`read=0` 是短信表里「未读」的标志位。
    argv.push('--where', 'read=0')
  }
  return argv
}

/**
 * 把 `content query` 的一行拆成键值对。
 *
 * 输出形如：`Row: 0 _id=12, address=10086, body=hello, date=1690000000000`。
 *
 * **已知短板**：正文里若出现「逗号 + 空格 + 字母串 + 等号」（例如 `a, b=c`），
 * 它会被误当成下一对的起点。这不是懒，是 `content query` 的输出格式本身
 * 没有转义约定——想要严格，只能换 `sqlite3` 直读（要 root）或自备桥接端。
 * 误判的症状是「正文被截断」，不会串到别的字段上，也不会把消息搞丢。
 * @param text 去掉 `Row: n ` 前缀之后的部分。
 */
function splitPairs(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const keyAt = /(?:^|,\s*)([A-Za-z_][A-Za-z0-9_]*)=/g
  const hits: { key: string; valueStart: number; at: number }[] = []
  let match = keyAt.exec(text)
  while (match !== null) {
    hits.push({ key: match[1], valueStart: match.index + match[0].length, at: match.index })
    match = keyAt.exec(text)
  }
  for (let index = 0; index < hits.length; index += 1) {
    const current = hits[index]
    const end = index + 1 < hits.length ? hits[index + 1].at : text.length
    out.set(current.key, text.slice(current.valueStart, end).replace(/,\s*$/, '').trim())
  }
  return out
}

/**
 * 归一化时间戳。
 *
 * 短信表的 `date` 是毫秒（约 1.7e12）。如果读到 10 位数字（秒），说明设备
 * 或 provider 口径不同——**按秒再乘 1000**，因为排序的正确性比绝对时刻更重要，
 * 而一个 1970 年的时间戳会让新消息永远排在最后。
 * @param raw 原始字符串。
 */
function normalizeDate(raw: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 0
  return value < 1e11 ? value * 1_000 : value
}

/**
 * 解析一条 `Row:` 行。
 * @param line 一行原始输出。
 */
export function parseRow(line: string): SmsMessage | null {
  const head = /^\s*Row:\s*\d+\s*(.*)$/.exec(line)
  if (head === null) return null
  const pairs = splitPairs(head[1])
  const id = pairs.get('_id') ?? ''
  if (id === '') return null
  return {
    id,
    address: pairs.get('address') ?? '',
    body: pairs.get('body') ?? '',
    date: normalizeDate(pairs.get('date') ?? ''),
  }
}

/**
 * 解析整段输出。
 *
 * 「一条都没有」与「格式变了」是两件事，必须分开：
 * `content query` 在没有结果时打印 `No result found.`，这是**正常的空**；
 * 若既没有 `Row:` 也没有这句，才可能是格式变了（记 `badRows`）。
 * 把两者混成「空」，用户会以为她真的没有未读短信。
 * @param stdout 标准输出。
 */
export function parseSmsOutput(stdout: string): {
  readonly rows: readonly SmsMessage[]
  readonly badRows: number
  readonly sawMarker: boolean
} {
  const rows: SmsMessage[] = []
  let badRows = 0
  let sawMarker = false
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    if (text.startsWith('No result found')) {
      sawMarker = true
      continue
    }
    if (text.startsWith('Row:')) {
      const row = parseRow(text)
      if (row === null) {
        badRows += 1
        continue
      }
      rows.push(row)
      sawMarker = true
      continue
    }
    // 其余是 usage / 错误回显，交给 `badRows` 计数，不猜。
    badRows += 1
  }
  return { rows: Object.freeze(rows), badRows, sawMarker }
}

/**
 * 从读到的行里挑出本轮要处理的。
 *
 * 三步：剔掉已答的 → 按时间升序 → 取前 `limit` 条。
 * 同一批里若出现重复 `_id`（provider 偶发重复行），只留第一条。
 * @param rows 读到的行。
 * @param seen 已答集合的判定函数。
 * @param limit 本轮上限。
 */
export function orderForBatch(
  rows: readonly SmsMessage[],
  seen: (id: string) => boolean,
  limit: number = UNREAD_BATCH,
): readonly SmsMessage[] {
  const picked: SmsMessage[] = []
  const ids = new Set<string>()
  for (const row of rows) {
    if (seen(row.id)) continue
    if (ids.has(row.id)) continue
    ids.add(row.id)
    picked.push(row)
  }
  picked.sort((left, right) => {
    if (left.date !== right.date) return left.date - right.date
    // 时间相同（同一秒多条）时按 _id 排：`_id` 是自增整数，字符串比较会出错。
    return Number(left.id) - Number(right.id)
  })
  const cap = Math.max(1, Math.trunc(limit))
  return Object.freeze(picked.slice(0, cap))
}
