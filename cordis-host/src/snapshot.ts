/**
 * 快照的**宿主侧调用方** —— `list()` / `create()` / `verify()` 的界面出口。
 *
 * ## 它补的是哪条断掉的边
 *
 * `ondra-snapshot` 与 `ondra-memory-heal` / `ondra-memory-dream` 不同：
 * 它**不缺调用方**——五个插件早就在 `ctx.get('ondra-snapshot')` 等它，
 * `create()` 会在做梦前、遗忘前被真的调用。所以装它本身就有效果。
 *
 * 但它缺的是**人能看到它的那一条路**：
 *
 * | 谁调 | 调的是 |
 * | --- | --- |
 * | 五个插件 | 只有 `create()`（备份是它们的内部动作） |
 * | **没有人** | `list()` / `verify()` / `prune()` / `stats()` |
 *
 * 于是「备份到底做没做成、坏没坏、占多少地方」这三件事，在整个产品里
 * 都是不可见的。而这三件恰好是备份唯一的用户价值：**一份没人验过的备份，
 * 和没有备份，在需要它的那一刻是同一件事。**
 *
 * ## 为什么不做「恢复」的界面入口
 *
 * 插件自己把恢复做成两道闸：字面量 `{ confirm: 'restore' }` + 库必须已关闭。
 * 第二条在当前进程里**永远不成立**——宿主自己正持有那个库。所以任何
 * 「点一下恢复」的按钮都只会返回 `db-open` 拒绝，那是个假按钮。
 *
 * 真正的恢复必须走「退出应用 → 手动替换文件」，那属于安装器/CLI 的地盘，
 * 不属于这里的 HTTP 路由。故本文件**不提供** `restore`，并在诊断里
 * 如实报 `restoreWired: false`，不让下一个人以为接好了。
 *
 * ## 为什么 `create()` 与 `prune()` 也不做成按钮
 *
 * `create()` 已经会被做梦自动调用（那是它的真实用途）；`prune()` 的轮转
 * 也在同一处由插件自己跑。再给两颗手按的按钮，只会让人以为「不按就不备份」。
 * 界面要看的是**结果**：有几份、最新一份什么时候、验过没有。
 */

import type { Context } from '@ntars/cordis'

/** 快照记录（与插件的 `SnapshotRecord` 结构对位，只取界面要用的字段）。 */
interface SnapshotRecordLike {
  readonly id: string
  readonly fileName: string
  /** 用户可见写法。`filePath` 是绝对路径，**不进界面**（插件契约里就这么写的）。 */
  readonly displayPath: string
  readonly createdAtMs: number
  readonly sizeBytes: number
  readonly schemaVersion: number | null
}

/** 快照统计（与插件的 `SnapshotStats` 结构对位）。 */
interface SnapshotStatsLike {
  readonly available: boolean
  readonly unavailableReason: string | null
  readonly displayDir: string | null
  readonly count: number
  readonly newestAtMs: number | null
  readonly oldestAtMs: number | null
  readonly totalBytes: number
  readonly pendingRestore: boolean
  readonly keep: number
}

/** 快照服务的结构对位子集。 */
interface SnapshotPort {
  readonly available: boolean
  readonly unavailableReason: string | null
  list(): readonly SnapshotRecordLike[]
  verify(id: string): {
    readonly ok: boolean
    readonly check?: string
    readonly refusal?: { readonly code: string; readonly detail: string }
  }
  stats(): SnapshotStatsLike
}

/** 快照的探针读数。 */
export interface SnapshotProbe {
  /** 服务在不在。 */
  readonly loaded: boolean
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因（**这是一句人话，不是原因码**——插件侧给的就是字符串）。 */
  readonly reason?: string
  /** 快照目录的用户可见写法。 */
  readonly dir?: string | null
  /** 保留份数。 */
  readonly keep?: number
  /** 快照清单（新→旧）。 */
  readonly items?: readonly SnapshotRecordLike[]
  /** 总字节数。 */
  readonly totalBytes?: number
  /** 待执行的恢复登记（**只提醒，不执行**）。 */
  readonly pendingRestore?: boolean
  /**
   * 恢复入口接上了没有。
   *
   * 恒 `false`，如实回答。理由见文件头：宿主持有着库，恢复的第二道闸
   * 在本进程内永远不成立。
   */
  readonly restoreWired: false
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 读一次快照状态。**只读**，不建快照、不改任何文件。
 *
 * @param ctx 宿主上下文。
 */
export function snapshotProbe(ctx: Context): SnapshotProbe {
  const service = ctx.get('ondra-snapshot') as SnapshotPort | undefined
  if (service === undefined) {
    return Object.freeze({ loaded: false, available: false, reason: 'not-loaded', restoreWired: false })
  }
  if (service.available !== true) {
    /*
     * 「不可用时明确拒绝」是这个插件的设计（内存后端上快照没有意义）。
     * 所以这里把 `unavailableReason` 原样带出去——它已经是人话了，
     * 再包一层原因码只会让界面更难说清。
     */
    return Object.freeze({
      loaded: true,
      available: false,
      ...(service.unavailableReason === null ? {} : { reason: service.unavailableReason }),
      restoreWired: false,
    })
  }

  try {
    const stats = service.stats()
    return Object.freeze({
      loaded: true,
      available: true,
      dir: stats.displayDir,
      keep: stats.keep,
      items: service.list(),
      totalBytes: stats.totalBytes,
      pendingRestore: stats.pendingRestore,
      restoreWired: false,
    })
  } catch (error) {
    // 读清单抛错（目录权限、文件被删）要能说出来，不能回一个空数组冒充「没有快照」。
    return Object.freeze({
      loaded: true,
      available: true,
      reason: messageOf(error),
      restoreWired: false,
    })
  }
}

/**
 * 校验一份快照能不能读。**只读**：`ATTACH` + `quick_check`，不动原库。
 *
 * ## 为什么要暴露它
 *
 * 这是「一份没人验过的备份」与「备份」之间唯一的分界线。插件把 `verify()`
 * 写好了、`create()` 里默认也会自检（`verifyAfterCreate: true`），
 * 但**人去核对**这一步从来没有入口。界面上按一下，才知道那份躺在
 * `backups/` 里的文件到底能不能用。
 *
 * @param ctx 宿主上下文。
 * @param id 快照 id（`list()` 给的那个）。
 */
export function verifySnapshot(
  ctx: Context,
  id: string,
): { readonly ok: boolean; readonly check?: string; readonly reason?: string } {
  const service = ctx.get('ondra-snapshot') as SnapshotPort | undefined
  if (service === undefined) return Object.freeze({ ok: false, reason: 'not-loaded' })
  if (service.available !== true) {
    return Object.freeze({ ok: false, reason: service.unavailableReason ?? 'unavailable' })
  }
  if (typeof id !== 'string' || id.trim() === '') {
    return Object.freeze({ ok: false, reason: 'bad-id' })
  }
  try {
    const outcome = service.verify(id.trim())
    if (outcome.ok) return Object.freeze({ ok: true, ...(outcome.check === undefined ? {} : { check: outcome.check }) })
    return Object.freeze({
      ok: false,
      reason: outcome.refusal === undefined ? 'verify-failed' : `${outcome.refusal.code}：${outcome.refusal.detail}`,
    })
  } catch (error) {
    return Object.freeze({ ok: false, reason: messageOf(error) })
  }
}
