/**
 * 快照的「做」与「验」。
 *
 * 只做两件事：`VACUUM INTO` 出一份新库文件，以及用 `ATTACH` 把它读一遍。
 *
 * 为什么用 `VACUUM INTO` 而不是复制文件：
 * 直接 `cp ondra.db` 在 WAL 模式下会漏掉 `-wal` 里还没落盘的那部分事务，
 * 复制出来的是一份「结构完整、数据缺一截」的库——**看起来能用，其实已经错了**。
 * `VACUUM INTO` 是 SQLite 自己提供的「导出一致副本」，它走的是同一条读事务，
 * 拿到的必然是某个时刻的一致快照，而且顺带把碎片整理掉，体积通常更小。
 *
 * 为什么不存 sha256：
 * 算它要把整个库完整读一遍，几百 MB 的库放在启动路径上不可接受
 * （`VACUUM INTO` 本身已经读写了一遍）。改用「文件大小 + `quick_check` + `user_version`」
 * 三项识别同一份文件：`quick_check` 比哈希弱，但它能发现「这不是一个 SQLite 库」，
 * 而这正是恢复前最需要排除的失败。真要密码学校验，交给外部的备份工具。
 */

import type { RawSqlFacetLike } from './types.js'

/**
 * 把路径转成 SQL 字符串字面量。
 *
 * `VACUUM INTO` 的路径**不接受占位绑定**，只能拼。所以这里必须自己把单引号
 * 转义成两个单引号（SQL 标准写法），否则一个带引号的目录名就能改写整条语句。
 * @param value 原始文本。
 */
export function quoteSqlString(value: string): string {
  return `'${value.split("'").join("''")}'`
}

/** 校验结果。 */
export interface CheckResult {
  /** 是否通过。 */
  readonly ok: boolean
  /** 通过了哪一项检查；`skipped` 表示只做了最弱的可读性判断。 */
  readonly check: 'quick_check' | 'skipped'
  /** 快照里的 `user_version`；读不出来为 null。 */
  readonly schemaVersion: number | null
  /** 失败说明（中文）。 */
  readonly detail: string
}

/**
 * 做一份快照。
 *
 * 目标文件**必须不存在**：`VACUUM INTO` 遇到已存在的文件会直接报错，
 * 这是它的保护机制（避免覆盖掉一份可能是唯一可用的备份）。调用方负责给出不冲突的名字。
 * @param raw 原始 SQL 面。
 * @param targetPath 目标文件绝对路径。
 */
export function vacuumInto(raw: RawSqlFacetLike, targetPath: string): void {
  // 注意：这里必须用 exec 而不是 run。VACUUM 不返回行，也不接受绑定参数。
  raw.exec(`VACUUM INTO ${quoteSqlString(targetPath)}`)
}

/**
 * 校验一份快照文件。
 *
 * 用 `ATTACH` 把快照挂到**当前连接**上读，而不是另开一个连接：
 * 另开连接需要自己加载 `node:sqlite`，那就是把 O-006 的开库逻辑抄一遍，
 * 而抄一遍就意味着两处 PRAGMA 迟早不一致。
 *
 * `quick_check` 而不是 `integrity_check`：后者会逐页校验索引，几百 MB 的库要跑几秒到几十秒；
 * `quick_check` 跳过索引校验，只查结构是否自洽，够用来回答「这份文件能不能打开」。
 * 想跑全量校验的场景（比如年度体检）本轮不提供，写进 README。
 * @param raw 原始 SQL 面。
 * @param snapshotPath 快照文件绝对路径。
 */
export function checkSnapshot(raw: RawSqlFacetLike, snapshotPath: string): CheckResult {
  let attached = false
  try {
    // 绑定参数是允许的：ATTACH 的文件名可以是一个表达式。
    raw.exec(`ATTACH DATABASE ${quoteSqlString(snapshotPath)} AS ondra_snapshot_check`)
    attached = true
  } catch (error) {
    return {
      ok: false,
      check: 'skipped',
      schemaVersion: null,
      detail: `快照无法挂载，很可能不是一个完整的 SQLite 库：${errorMessage(error)}`,
    }
  }

  try {
    const rows = raw.all<Record<string, unknown>>('PRAGMA ondra_snapshot_check.quick_check')
    // quick_check 正常时只返回一行 'ok'；有任何问题会返回多行问题描述。
    const first = rows[0]
    const value = first === undefined ? undefined : Object.values(first)[0]
    if (rows.length !== 1 || String(value).toLowerCase() !== 'ok') {
      const problems = rows
        .slice(0, 5)
        .map((row) => String(Object.values(row)[0] ?? ''))
        .filter((text) => text !== '')
      return {
        ok: false,
        check: 'quick_check',
        schemaVersion: null,
        detail: `快照结构检查未通过：${problems.length > 0 ? problems.join('；') : '返回行数异常'}`,
      }
    }
    const versionRow = raw.get<{ user_version: number }>('PRAGMA ondra_snapshot_check.user_version')
    const version = versionRow?.user_version
    return {
      ok: true,
      check: 'quick_check',
      schemaVersion: typeof version === 'number' && Number.isFinite(version) ? Math.trunc(version) : null,
      detail: '结构检查通过',
    }
  } catch (error) {
    return {
      ok: false,
      check: 'quick_check',
      schemaVersion: null,
      detail: `快照结构检查抛错：${errorMessage(error)}`,
    }
  } finally {
    if (attached) {
      try {
        raw.exec('DETACH DATABASE ondra_snapshot_check')
      } catch {
        // 卸载失败不影响校验结论；连接关闭时会自动卸载。
        // 这里不抛：抛出去会把「校验通过了」变成一个异常，反而误导调用方。
      }
    }
  }
}

/**
 * 把任意异常压成一行中文可读文本。
 * @param error 异常。
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
