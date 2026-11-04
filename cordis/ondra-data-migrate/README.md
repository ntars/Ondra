# ondra-data-migrate

> O-008 · L1 存储 · 〔研〕自研 · 服务键 **`ondra-data-migrate`**（连字符）

空谷 Ondra 的**表结构版本迁移**。补的正是 O-006 那条明写了的缺口：

> O-006 的补列只补「缺的列」，不管「同名列类型改了」，也不管主键要换；
> 遇到 `ALTER TABLE` 做不到的事，它记一条 `primary-key-skipped` 然后跳过。

数据还在，结构永远是错的，而且没人知道——这个插件就是来收这条尾巴的。

消费方（域插件的典型写法）：

```ts
const migrations = ctx.get('ondra-data-migrate')
if (migrations && migrations.available) {
  migrations.register({
    id: 'memory-add-channel',
    toVersion: 1,
    description: '记忆表加 channel 通道列',
    up: (ctx2) => {
      const diff = ctx2.diff(MEMORY_TABLE_SPEC)
      if (diff.needsRebuild) ctx2.rebuild(MEMORY_TABLE_SPEC)
      else ctx2.align(MEMORY_TABLE_SPEC)
    },
  })
  const report = migrations.ensure()   // ★ 登记完立刻 ensure，执行时机才确定
  if (report.issues.length > 0) { /* 记日志，但不要阻断主对话 */ }
}
```

## 职责

- **版本真源 = `PRAGMA user_version`**（库头里的整数），随事务一起提交/回滚。
- **每条迁移一个事务**：迁移体 + 历史记录 + 版本号自增在同一个事务里；崩了整体回滚，版本号不会半升。
- **幂等执行**：`ensure()` 只跑「版本号 > 当前」的迁移，重复调用安全。
- **表重建**：类型漂移、主键变更、非空约束变更三类 `ALTER TABLE` 做不到的事，按 SQLite 官方十二步流程收敛实现。
- **结构差异比对**：`inspect()` / `diff()` 给出「库里到底是什么样 vs 声明要什么样」，六组差异分开报，不混成一个布尔。
- **迁移前钩子**：`onBeforeApply()` 让别的插件（O-009 快照）在改结构前插手；钩子拒绝则中止。

## 明确不负责

- **不定义任何业务表结构**：表由域插件声明，本插件只按声明对齐。
- **不建表**（「只增不改」那一半）：交给 O-006 的 `ensureTable`，本插件只调它。
- **不写文件、不建目录**：不碰 `fs`。
- **不做快照与恢复**：`VACUUM INTO`、KEEP=3 归 O-009，本插件只留一个钩子位。
- **不做数据搬迁**（行内容改写）：那是迁移体自己的事，本插件只保证它有事务与回滚。
- **不自动跑**：不装定时器、不监听「启动完成」事件。**谁登记谁 `ensure()`**，理由见下。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-data-migrate` | 唯一归属 |
| 消费 | `ondra-store-sqlite` | 首选；`ctx.get` 判空 |
| 消费 | `ondra-store-memory` | 兜底；取到它时服务**仍注册但 `available=false`** |
| 消费 | `ondra-identity` | **软依赖**，只取日志命名空间 |

契约定义在 `src/types.ts`：`MigrationService` / `Migration` / `MigrationContext` / `MigrationReport` /
`MigrationIssue` / `MigrationRecord` / `TableDiff` / `TableShape` / `RebuildResult` / `MigrateError`。

## 配置（全部有默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| `recordHistory` | `true` | 写历史表 `meta_migration`；关掉只影响审计视图，**版本号照旧准** |
| `abortOnHookFailure` | `true` | 钩子（如迁移前备份）失败就中止迁移 |
| `checkForeignKeys` | `true` | 重建后跑 `PRAGMA foreign_key_check` |

## 关键取舍（每条都有代价，写在这里防后人踩回去）

1. **版本真源是 `user_version`，不是历史表。**
   历史表 `meta_migration` 只服务「给人看」与审计，**不参与判定**。两者不一致时以
   `user_version` 为准。反过来做（历史表是真源）的代价是：用户手工修一次库、
   或从别处拷来一份 `.db`，就会出现「历史说跑过、版本说没跑」两个答案，
   而且**没有任何自动手段能判断哪个对**。

2. **一条迁移 = 一个事务 = 一次版本自增。**
   幂等不靠迁移作者自觉，靠执行器结构：`up()` → 写历史 → 写 `user_version`，
   三段在同一事务里。中途崩掉必然整体回滚，下次启动从头再来。
   唯一例外是 `transactional: false`（给 `VACUUM` 这类不许进事务的语句），
   那种迁移**必须自身幂等**，代价已写进「已知限制」。

3. **迁移体拿不到 `store`，只能拿 `raw`。**
   给了 `store.transaction` 就一定会有人套出嵌套事务，而 SQLite 的嵌套 `BEGIN`
   会抛错或静默吃掉内层提交——这是最难查的一类故障。接口层面堵死，比文档里写一句
   「请不要嵌套」有用得多。

4. **`PRAGMA foreign_keys` 只在 `rebuild.ts` 里开关，且必须在事务外。**
   这条 PRAGMA 在事务内**静默无效**：不报错，但外键照旧开着，
   于是 `DROP TABLE` 会级联删数据或直接失败。「自己以为自己关了」是这类事故的唯一成因。

5. **丢列必须显式批准（`dropColumns`）。**
   `extraColumns` 里没被批准的列会让重建**直接抛错**，而不是「先丢了再说」。
   丢列不可逆，不能藏在「顺手对齐一下」的调用里。

6. **库版本高于程序版本时拒绝迁移，绝不改回去。**
   用户装回旧版程序时，库里的版本可能已经是 3 而代码只认识到 2。
   把版本号改回 2 等于宣称「旧代码认识新表」，下一次写入就会毁数据。
   现在返回 `version-regression` 并打 error，让人去升级或从快照恢复。

7. **不装定时器、不等「启动完成」。**
   插件装载顺序不确定，定时器跑在第几个插件之后是运气。改成「谁登记谁调 `ensure()`」，
   执行时机变成确定的：第一个登记者跑自己那条，后面的登记者跑后面那些。

8. **主键列不参与「非空」比对。**
   `PRAGMA table_info` 对 `INTEGER PRIMARY KEY` 报 `notnull = 0`。照直比对会让
   每一张带整型主键的表都被判成「非空约束不一致」，然后触发一次毫无必要的整表重建。

9. **历史表建不出来不阻断迁移。**
   `STRICT` 表在旧 SQLite 上会失败，此时退回普通表并打 warn。历史表只是审计，
   不能因为它建不了就让整个启动流程失败。

10. **内存后端不注册「半个服务」。**
    取到 `ondra-store-memory`（`caps.sql === false`）时服务**仍然注册**，
    但 `available = false`，`ensure()` 返回带 `sql-unsupported` 的报告。
    这样下游能区分「没装」与「装了但不支持」——静默返回空报告会让
    「迁移一条都没跑」和「没有迁移要跑」看起来一模一样。

## 边界

- 属于 L1，零运行时依赖：只用 `@ntars/cordis` 的类型。不碰 `fs`、不碰 `path`、不碰网络。
- 与 O-006 的分工写死在两边 README：**O-006 管「只增不改」，本插件管「改不动的」**。
  两者都走同一个 `StorePort`，不互相 import，不共享缓存（§14.2）。
- 与 O-009 的方向是单向的：**O-009 → 本插件**（快照插件把自己的备份动作注册成迁移前钩子）。
  本插件**不知道 O-009 存在**，钩子表为空时照常跑，不会因为缺备份能力而拒绝迁移。

## 已知限制

1. **`transactional: false` 的迁移只能靠自身幂等。**
   这类迁移没有事务兜底，`up()` 成功但版本号没写上时会重跑。
   当前唯一需要的场景是 `VACUUM`（且它已归 O-009），所以本插件不提供任何内置的
   `transactional: false` 迁移。要用请自己确认幂等性。
2. **不检测索引定义漂移。** 只判「索引名在不在」。同名不同列的索引
   `CREATE INDEX IF NOT EXISTS` 改不动，需要 `DROP` 再建——本轮不做，宁可不管也不假装在管。
3. **不重建表达式索引。** `PRAGMA index_info` 对表达式列返回 `null`，拿不到原始表达式文本，
   硬写只会建出一个错的索引。带表达式索引的表重建后需要手工补。
4. **重建期间外键是关着的。** 单进程同步执行，窗口在毫秒级；但如果同一时刻有别的连接
   在写这个库，它看到的是一个「外键被关掉」的库。当前架构一进程一主库，故无影响。
5. **不支持跨库（`ATTACH`）重建。** 只在主库内做。
6. **`STRICT` 表要求 SQLite ≥ 3.37。** 重建时若目标声明 `strict` 而本机不支持，
   `CREATE TABLE ... STRICT` 会抛错，需要把该表声明的 `strict` 设为 `false`。
   （O-006 在**建新表**那条路径上会自动退回普通表，重建路径不自动退回——
   因为重建是显式操作，静默换一种表类型比报错更危险。）
7. **`B1` 阶段本插件没有任何内置迁移。** 业务表要到 O-010 记忆域才落地，
   此刻的产出是契约与执行器。`ensure()` 在零迁移时返回 `applied: []`，不是异常。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 版本表 + 单调版本号 | `dbmate` | github.com/amacneil/dbmate | MIT | 「一个整数版本 + 迁移按版本升序执行 + 失败即停」这套骨架 | 自研 `runner.ts`。差异：版本存 `PRAGMA user_version` 而非独立表（理由见取舍 1） | 否 |
| 每条迁移一个事务 | `umzug` / `knex` migrations | github.com/sequelize/umzug · github.com/knex/knex | MIT | 「迁移体与版本记录同事务、失败回滚」的语义 | 自研：`applyOne()` 里 `up()` → 写历史 → 写版本三段同事务 | 否 |
| 表重建十二步 | SQLite 官方文档《Making Other Kinds Of Table Schema Changes》 | sqlite.org/lang_altertable.html | 公有领域（文档） | 「建新表→复制→删旧→改名→重建索引→提交前 `foreign_key_check`」的顺序，以及「`foreign_keys` 必须在事务外关」这条关键约束 | 自研 `rebuild.ts`，收敛为 `withRebuildWrap` 一个入口；补了「丢列需显式批准」「非空无默认值提前拦」两道前置校验 | 否 |
| 迁移前钩子 | `dbmate` 的 `--migrations-table` 前置钩子思路、`flyway` 的 `beforeMigrate` | github.com/flyway/flyway | Apache-2.0 | 「迁移前可插入一个动作并允许它中止」的通知模型 | 自研：`onBeforeApply()` 返回 disposer，返回值给字符串即中止 | 否 |
| 嵌套事务显式报错 | `better-sqlite3` 的 `transaction()` 语义 | github.com/WiseLibs/better-sqlite3 | MIT | 「嵌套事务不静默加入外层，直接抛错」 | O-006 已实现；本插件在**接口层面**不给 `store`，从源头避免 | 否 |

**档位判定（§1.8）**：〔研〕自研。生态里的迁移工具（dbmate / node-pg-migrate / knex / flyway）
**全部是命令行工具**，绑的是「部署时在服务器上跑一次」的模型；本项目是「插件随 app 启动在用户机器上跑」，
且手册 §12.4 明令禁止产出独立 CLI。可借的只有机制（单调版本、一迁移一事务、历史表仅审计），
这三条已独立实现，未复制任何代码。

## 多方案分支说明（§12）

涉及多方案：**版本号载体 —— `PRAGMA user_version`（默认）vs 独立历史表**。

处理方式是 **§12.1「能融会贯通 → 融」**，不是做分支：

| 要求 | 落地 |
|---|---|
| 接口唯一 | 只有一个 `MigrationService`，调用方不感知版本存在哪 |
| 融合方式 | `user_version` 做**判定真源**，历史表做**审计视图**，两者职责正交而非二选一 |
| 默认最稳 | 判定只读 `user_version`（单次 `PRAGMA`，无表、无锁、无并发问题） |
| 独立降级 | 历史表建不出来（旧 SQLite 不支持 `STRICT`）→ 退回普通表 → 再不行只打 warn，**判定不受影响** |
| 可观测 | `stats().version` / `latestVersion` / `historyRows` / `lastReport` 全可读 |
| 不共享状态 | 与 O-006 / O-009 零共享；钩子表是实例私有 |

不做成配置开关的理由：两个真源同时存在时，「哪个说了算」会随调用路径漂移，
而迁移判定**只能有一个答案**。

## 隔离五问（§16.4）

1. **关掉我，谁受影响？** 各域插件取到 `undefined`，表结构停在当前版本。
   已有的表照旧能读写（O-006 的 `ensureTable` 仍会补缺失列），只是「改不动的结构变更」不会发生。
   主对话不受影响。
2. **我的状态存在哪？** 三处：库头 `user_version`（权威）、`meta_migration` 表（审计）、
   进程内存里的已登记迁移列表与版本缓存（卸载即清）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.data-migrate`；
   迁移失败打 `error` 并带上迁移 id 与回滚说明；运行期指标走 `stats()`
   （`available` / `version` / `pending` / `lastReport.issues`），由 O-077 汇总。
4. **我依赖谁？缺席时怎么降级？** `ondra-store-sqlite` / `ondra-store-memory`（硬，判空后
   **不注册服务**）；`ondra-identity`（软，缺席时日志命名空间退化为 `ondra.data-migrate`）。
5. **我和同域的谁共享可变状态？** 没有。与 O-006 是两个插件两个服务键，与 O-009 只有
   一个「钩子」单向引用（O-009 注册进我，我不认识它）。

## 自检（master-plan §16.1 九项 + §16.2 语言五项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（6 必需 + icon） | 过（12 文件：7 必需 + `src/types.ts` / `src/inspect.ts` / `src/rebuild.ts` / `src/runner.ts` + `icon.svg`） |
| 2 | 清单合法 | 过（JSON 可解析、`ondra-*`、`type: module`、`main`/`types`/`exports`/`files` 齐、cordis 双声明、`ondra.bundle.patch` 在且文件真实存在） |
| 3 | 编译配置 | 过（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） |
| 4 | 入口契约 | 过（`name` + `apply(ctx, config)` + `Config` 三字段全有默认值，与 `DEFAULT_CONFIG` 键集合逐一对齐） |
| 5 | 服务键唯一 | 过（`ondra-data-migrate` 全仓仅本插件 `provide`） |
| 6 | 依赖可解析 | 过（`ctx.get` 三个键：`ondra-store-sqlite` / `ondra-store-memory` / `ondra-identity`，台账均有提供方） |
| 7 | 无越界 import | 过（无 `from 'ondra-`；对 O-006 / O-009 走结构对位） |
| 8 | 降级到位 | 过（存储是 `undefined` → 不注册并 warn；`caps.sql=false` → 注册但 `available=false`；三个 `ctx.get` 结果均先判空） |
| 9 | 交付物齐全 | 过（技术来源表 / 多方案融合说明 / 隔离五问齐） |
| 语言 1–5 | 括号配平 / 无残留半句 / `import type` 正确 / 无 TODO / UTF-8 无 BOM | 过 |

> 判定由静态脚本产出（只读文件 + JSON 解析 + 括号配平 + 标识符交叉核对），
> 未执行 `tsc` / `build` / `pnpm install`（§16.3 禁止实装运行）。
