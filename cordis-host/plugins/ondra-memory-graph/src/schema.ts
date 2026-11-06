/**
 * 边表声明（**只声明，不建表**；建表由存储端口的 `ensureTable()` 执行）。
 *
 * 表结构对应手册 §9.7 的链路表：
 * `card_links(from_id, to_id, relation, weight∈[0,1], hits, last_fired, decayed_at)`，
 * 本插件补了三列，每列都有理由：
 *
 * | 补的列 | 为什么 |
 * |---|---|
 * | `id` | 确定性主键（`from~to~relation`）。没有它就只能「先查再插」，中间留一个竞态窗口 |
 * | `surreal` | 荒诞联想边的标记。它可以从 `relation` 推出来，但**查询要用它**（`neighbors` 默认排除），推一次就要扫全表 |
 * | `approved` | 人工批准，软剪枝豁免（手册「`surreal` / `approved` 豁免」） |
 *
 * **绝不建外键**：两端指向 `memory_fact.id`，但记忆会被 `forget()` 真删，
 * 而外键级联会把「她忘了一件事」变成「她忘了那件事的所有关联」——
 * 后者是本插件要显式处理的（`forgetOf()`），不该由数据库替我们决定。
 * 孤儿边由 `forgetOf()` 清，清不掉也只是多一条查不到端点的边，不会让写入失败。
 */

import { TABLE_LINK } from './types.js'
import type { TableSpecLike } from './types.js'

/** 边表声明。 */
export const TABLE_LINK_SPEC: TableSpecLike = Object.freeze({
  name: TABLE_LINK,
  columns: Object.freeze([
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'from_id', type: 'TEXT', notNull: true },
    { name: 'to_id', type: 'TEXT', notNull: true },
    { name: 'relation', type: 'TEXT', notNull: true },
    { name: 'weight', type: 'REAL', notNull: true },
    { name: 'hits', type: 'INTEGER', notNull: true },
    { name: 'last_fired_at', type: 'INTEGER', notNull: true },
    { name: 'decayed_at', type: 'INTEGER', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
    { name: 'approved', type: 'INTEGER', notNull: true },
    { name: 'surreal', type: 'INTEGER', notNull: true },
  ]),
  indexes: Object.freeze([
    // 两个方向的邻居查询各一个索引；缺了它们，`neighbors()` 会退化成全表扫。
    { name: 'idx_link_from', columns: Object.freeze(['from_id']) },
    { name: 'idx_link_to', columns: Object.freeze(['to_id']) },
    // 统计与按关系筛选用。
    { name: 'idx_link_relation', columns: Object.freeze(['relation']) },
    // 衰减 / 剪枝按游标扫，缺了它每次夜跑都是全表扫。
    { name: 'idx_link_decayed', columns: Object.freeze(['decayed_at']) },
  ]),
} satisfies TableSpecLike)
