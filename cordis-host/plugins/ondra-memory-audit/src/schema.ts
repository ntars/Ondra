/**
 * 钉子表声明（**只声明，不建表**；建表由存储端口的 `ensureTable()` 执行）。
 *
 * 为什么钉子单独一张表，而不是给 `memory_fact` 加一列：
 *
 * 1. **`memory_fact` 的表结构归 O-010**。加一列要改它的 schema、补它的迁移
 *    （`ondra-data-migrate`）、同步它的 `MemoryRecord` 镜像——三个插件一起动，
 *    而收益只是省一次 JOIN。端口没有 JOIN，所以「省一次 JOIN」也不成立。
 * 2. **钉子是「视图层的选择」，不是「记忆的属性」**。同一条记忆在不同界面上
 *    可以被钉也可以不被钉；写进记忆本体就把一次界面操作固化成了数据事实。
 * 3. **`forget()` 要能顺带清钉子**。单独一张表，`forget()` 里一行 `delete` 就够了；
 *    写进本体则要「删行前先读列」，多一次读。
 *
 * **不建外键**：`id` 指向 `memory_fact.id`，但记忆会被真删。外键级联在这里是
 * 有害的——它会让人以为「钉子一定和记忆同生共死」，而实际上 `forget()` 之后
 * 如果钉子没被清掉（例如进程在两步之间崩了），我们**需要看见**这条孤儿钉子
 * 并报出来，而不是让数据库悄悄替我们决定。
 */

import { TABLE_PIN } from './types.js'
import type { TableSpecLike } from './types.js'

/** 钉子表声明。 */
export const TABLE_PIN_SPEC: TableSpecLike = Object.freeze({
  name: TABLE_PIN,
  columns: Object.freeze([
    // 主键就是记忆 id：一条记忆最多一根钉子，天然幂等（重复钉 = upsert）。
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'pinned_at', type: 'INTEGER', notNull: true },
    // 备注：为什么钉住它。空串表示没写。
    { name: 'note', type: 'TEXT', notNull: true },
  ]),
  indexes: Object.freeze([
    // 注入块 ② 要按「钉住时间」稳定排序（钉住的顺序不该随写入顺序乱跳）。
    { name: 'idx_pin_pinned_at', columns: Object.freeze(['pinned_at']) },
  ]),
} satisfies TableSpecLike)
