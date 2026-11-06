/**
 * 两张表的声明（**只声明，不建表**；建表由存储端口的 `ensureTable()` 执行）。
 *
 * ```
 * memory_promise（承诺）      working_todo（待办）
 * ├─ 进记忆                    ├─ 不进记忆链
 * ├─ fact_id 指回 memory_fact   ├─ 没有 fact_id（根本没有那条记忆）
 * ├─ kept / broken 结算         ├─ done 一列就够
 * └─ 提前 24h / 宽限 24h        └─ 3 天没提起自动过期
 * ```
 *
 * 两张表**绝不合并**（手册 §2.8 + 语料 §17）。合并的代价不是「字段冗余」，
 * 而是让两类条目的生命周期互相污染：待办按 `promise` 的 8000 小时活着会长期
 * 霸占注入名额，承诺按 `todoIdleDays` 三天过期则会静默丢掉一件答应了的事。
 *
 * **不建外键**：`fact_id` 指向 `memory_fact.id`，但记忆会被 `forget()` 真删。
 * 外键级联会把「她忘了一件事」变成「她忘了自己答应过」——后者该由本插件
 * 显式处理（`promiseOf()` 发现事实不在时转 `expired` 并记 issue），
 * 不该由数据库替我们决定。孤儿承诺留着也只是查不到正文，不会让写入失败。
 */

import { TABLE_PROMISE, TABLE_TODO } from './types.js'
import type { TableSpecLike } from './types.js'

/** 承诺表声明。 */
export const TABLE_PROMISE_SPEC: TableSpecLike = Object.freeze({
  name: TABLE_PROMISE,
  columns: Object.freeze([
    // 确定性主键 `p-<factId>`：重放同一句话时可以直接 upsert，不需要「先查再插」。
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'fact_id', type: 'TEXT', notNull: true },
    // 锁住的原文。**不存摘要**：摘要会漂移，而「我说过什么」被改写是第一眼能看出来的。
    { name: 'text', type: 'TEXT', notNull: true },
    // 0 = 无期限（「下次」）。用 0 而不是 NULL：端口没有 NULL 语义，0 判起来只有一处。
    { name: 'due_at', type: 'INTEGER', notNull: true },
    { name: 'remind_at', type: 'INTEGER', notNull: true },
    { name: 'grace_until', type: 'INTEGER', notNull: true },
    { name: 'state', type: 'TEXT', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
    // 0 = 未结算。不用 NULL，理由同上。
    { name: 'settled_at', type: 'INTEGER', notNull: true },
    // 0 = 没提醒过。防重复提醒靠它，不靠内存里的「刚提醒过」——重启会丢。
    { name: 'reminded_at', type: 'INTEGER', notNull: true },
    { name: 'time_word', type: 'TEXT', notNull: true },
  ]),
  indexes: Object.freeze([
    // 到期提醒按 remind_at 扫（`remind_at <= now < grace_until`）。
    { name: 'idx_promise_remind', columns: Object.freeze(['remind_at']) },
    // 清理按 grace_until 扫。
    { name: 'idx_promise_grace', columns: Object.freeze(['grace_until']) },
    // 统计按状态分组。
    { name: 'idx_promise_state', columns: Object.freeze(['state']) },
    // 由事实反查承诺（O-012 合并记忆时要顺手处理承诺）。
    { name: 'idx_promise_fact', columns: Object.freeze(['fact_id']) },
  ]),
} satisfies TableSpecLike)

/** 待办表声明。 */
export const TABLE_TODO_SPEC: TableSpecLike = Object.freeze({
  name: TABLE_TODO,
  columns: Object.freeze([
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'text', type: 'TEXT', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
    // 「3 天没提起」的计时基准。被重新提起时刷新它，不是 created_at。
    { name: 'last_mentioned_at', type: 'INTEGER', notNull: true },
    { name: 'expires_at', type: 'INTEGER', notNull: true },
    { name: 'done', type: 'INTEGER', notNull: true },
  ]),
  indexes: Object.freeze([
    { name: 'idx_todo_expires', columns: Object.freeze(['expires_at']) },
    { name: 'idx_todo_done', columns: Object.freeze(['done']) },
  ]),
} satisfies TableSpecLike)
