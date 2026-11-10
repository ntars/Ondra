# ondra-snapshot

> O-009 · L1 存储 · 〔研〕自研 · 服务键 **`ondra-snapshot`**（连字符）

空谷 Ondra 的**记忆快照**。`VACUUM INTO` 出一致副本、KEEP=3 轮转、
`quick_check` 校验，**恢复必须显式确认且绝不自动执行**。

它接的是整条链路的最后一环：

```
迁移前自动备份（挂在 O-008 的钩子上） → 日常备份 → 出问题 → 人工挑一份 → 显式 restore
```

## 职责

- **做快照**：`VACUUM INTO` 导出某个时刻的一致副本到 `backups/snapshots/`，
  文件名 `ondra-YYYYMMDDTHHmmssZ-NN.db`（UTC + 两位序号）。
- **验快照**：`ATTACH` 挂上来读 `PRAGMA quick_check` 与 `user_version`——
  校验不过的立刻改名 `.corrupt` 保留现场，**不删**。
- **轮转**：保留最新 `keep` 份（默认 3，最小 1），只动自己命名的 `ondra-*.db`。
- **登记待恢复**：`stage()` 只写一张待办票，**不动库**。
- **显式恢复**：`restore(id, { confirm: 'restore' })`，两道闸（字面量确认 + 库已关闭），
  换库前把原库挪到 `backups/pre-restore-<时间>.db`，并把旧的 `-wal` / `-shm` 一起挪走。
- **迁移前钩子**：把「备份」注册到 O-008 的 `onBeforeApply` 上，备份失败即中止迁移。

## 明确不负责

- **不自动恢复**：任何情况下都不会「启动时发现有待恢复票就自己换库」。
- **不做热恢复**：库处于 `open` 时 `restore()` 直接返回 `store-open` 拒绝，见「已知限制」。
- **不管库怎么开**：连接、PRAGMA、事务全归 O-006；本插件只经 `store.raw` 发 SQL。
- **不做版本迁移**：结构演进归 O-008；本插件只把备份挂在它的钩子上。
- **不做增量备份 / 异地备份**：整库全量，落本机。
- **不加密**：手册决策 89 明确不给记忆库加密，快照同理。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-snapshot` | 唯一归属 |
| 消费 | `ondra-store-sqlite` | 首选；`ctx.get` 判空 |
| 消费 | `ondra-store-memory` | 兜底；取到它时服务**仍注册但 `available=false`** |
| 消费 | `ondra-path-layout` | 快照目录必须落在数据根内，缺席即不可用 |
| 消费 | `ondra-identity` | **软依赖**，只取日志命名空间 |
| 消费 | `ondra-data-migrate` | **单向、可选**：把备份注册成它的迁移前钩子 |

契约定义在 `src/types.ts`：`SnapshotService` / `SnapshotRecord` / `SnapshotOutcome` /
`VerifyOutcome` / `PruneOutcome` / `RestoreTicket` / `StageOutcome` / `RestoreOutcome` /
`SnapshotStats` / `SnapshotRefusal`。

## 配置（全部有默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| `keep` | `3` | 保留份数；夹在 1–50，配成 0 会被抬到 1 |
| `verifyAfterCreate` | `true` | 做完立刻 `ATTACH` + `quick_check` |
| `snapshotBeforeMigration` | `true` | 是否挂迁移前备份钩子 |
| `minIntervalMs` | `300000`（5 分钟） | 迁移前备份的最小间隔，防启动时连做五份把窗口冲光 |

## 关键取舍（每条都有代价，写在这里防后人踩回去）

1. **用 `VACUUM INTO`，不用 `cp`。**
   直接复制文件在 WAL 模式下会漏掉 `-wal` 里还没落盘的事务，复制出来的是一份
   「结构完整、数据缺一截」的库——**看起来能用，其实已经错了**。
   `VACUUM INTO` 走同一条读事务，拿到的是某个时刻的一致快照，顺带把碎片整理掉。

2. **恢复要两道闸，少一道都不行。**
   第一道是 `{ confirm: 'restore' }` 字面量（防代码里手滑）；第二道是「库必须已关闭」
   （防在连接持有文件时把库从底下抽走）。只做第一道，等于相信调用方永远不出错。

3. **换库之后旧 `-wal` / `-shm` 必须一起挪走。**
   它们记的是旧库的事务，留在原处会让 SQLite 拿旧 WAL 去「恢复」新文件，
   结果是新数据被旧事务覆盖，而且报的错看起来跟恢复毫无关系。
   实现里把它们改名成 `pre-restore-<时间>.db-wal`，跟原库一起归档。

4. **不做哈希，用 `quick_check` 做身份校验。**
   算 sha256 要把整个库读一遍，几百 MB 的库放在启动路径上不可接受
   （`VACUUM INTO` 本身已经读写了一遍）。`quick_check` 能发现「这不是一个 SQLite 库」，
   而这正是恢复前最需要排除的失败。要密码学校验请交给外部备份工具。

5. **校验不过的快照改名 `.corrupt`，不删。**
   它可能是唯一能说明「哪里坏了」的证据。代价：需要人工清理，已写进已知限制。

6. **恢复时的二次校验只做文件级。**
   库已关闭 → 连接不可用 → 没法 `ATTACH`。所以比对的是「快照大小有没有变」
   （与 `stage()` 时记下的 `sizeBytes` 比）。**真正的内容校验发生在 `stage()`**，
   那时库还开着。这条限制是结构性的，不是偷懒。

7. **迁移前备份有 5 分钟节流。**
   启动时多个域插件会各调一次 `ensure()`，不节流就会连做五份一模一样的备份，
   把 KEEP=3 的窗口瞬间冲掉——那等于「有备份」和「没备份」一样。

8. **快照不可用时不拦迁移。**
   备份是增强能力，让它决定「能不能启动」是本末倒置。但会打 warn，
   否则用户会以为自己有备份。

9. **装载顺序不确定，所以用 `ctx.inject` 挂钩子。**
   本插件可能先于 `ondra-data-migrate` 被 apply。直接取不到就开一个子作用域，
   等它出现再挂；子 fiber 随本插件一起卸载，钩子自动撤销。
   **这与插件级 `inject` 不是一回事**：插件级 `inject` 是硬依赖，服务缺席会让整个插件
   保持 PENDING（静默不加载，最糟的失败形态），本插件不用它。

10. **文件名用 UTC 时间戳。**
    本地时间会随夏令时、时区修改而回退，一退排序就乱，而「哪份最新」正是恢复时
    唯一要看的东西。

## 边界

- 属于 L1，零第三方依赖：只用 `node:fs` 与 `@ntars/cordis` 的类型。
  不碰网络、不碰 `node:sqlite`（那是 O-006 的事）。
- 与 O-008 的方向**单向**：本插件 → O-008（注册钩子）。O-008 不知道本插件存在，
  钩子表为空时照常迁移，不会因为「没有备份插件」而拒绝工作。
- 与 O-006 的方向：本插件 → O-006（消费 `StorePort`）。绝不自己开库、自己建连接。

## 已知限制

1. **无法热恢复（结构性阻塞点）。**
   换掉正在被连接持有的库文件需要「关闭 → 换文件 → 重开」三步，而**重开连接是
   O-006 的职责**，`StorePort` 没有 `reopen()`。本插件不硬做，只在
   `store.state === 'closed'` 时执行，否则返回 `store-open` 并提示
   「请先关闭存储连接或退出应用」。
   **要彻底解决，需要 O-006 补一个 `reopen(path)` 或「未开库前的接管点」——
   属于改上游契约，按手册 §8 不硬做，登记为阻塞点。**
2. **恢复时的内容校验降级为文件级。** 原因见取舍 6。
3. **`.corrupt` 文件需要人工清理**，不进轮转。
4. **只做全量、只落本机**：没有增量、没有异地、没有压缩。
5. **不做 `integrity_check`（全量索引校验）**：`quick_check` 够回答「能不能打开」；
   全量校验在大库上要跑几秒到几十秒，不适合放在启动路径。年度体检类场景本轮不做。
6. **快照是单文件，不含 `-wal`**：`VACUUM INTO` 产出的是一份已 checkpoint 的独立库，
   这正是要的结果；但反过来说，它**不是**原库的逐字节副本，不能拿去做二进制级比对。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 一致副本导出 | SQLite 官方文档《VACUUM》的 `VACUUM INTO` 一节 | sqlite.org/lang_vacuum.html | 公有领域（文档） | 「`VACUUM INTO` 产出一致快照、目标文件必须不存在」这两条语义 | 自研 `backup.ts` 的 `vacuumInto()`，只发一条语句，不引任何库 | 否 |
| 快照校验 | SQLite `PRAGMA quick_check` / `integrity_check` | sqlite.org/pragma.html | 公有领域（文档） | 「`quick_check` 跳过索引、`integrity_check` 全量」的取舍，以及「正常只返回一行 ok」的判定方式 | 自研：`ATTACH` 挂上来读，而不是另开连接（另开就要抄一遍 O-006 的开库逻辑） | 否 |
| 保留窗口轮转 | `litestream` 的 retention 设计 | github.com/benbjohnson/litestream | Apache-2.0 | 「按份数保留 + 永不删最新 + 只动自己命名的文件」 | 自研 `registry.ts` 的 `prune`；未引入代码（它是流式复制 WAL 的守护进程，形态完全不同） | 否 |
| 备份前/迁移前钩子 | `flyway` 的 `beforeMigrate` | github.com/flyway/flyway | Apache-2.0 | 「迁移前可插入一个动作并允许它中止」的通知模型 | 自研：往 O-008 的 `onBeforeApply` 注册，返回字符串即中止 | 否 |
| 原子写 | SQLite 官方文档《Atomic Commit In SQLite》 | sqlite.org/atomiccommit.html | 公有领域（文档） | 「临时文件 + rename 才是原子替换」 | 自研：待恢复票先写 `.tmp` 再 `renameSync` | 否 |

**档位判定（§1.8）**：〔研〕自研。`VACUUM INTO` 是 SQLite 自带能力，本插件一行驱动代码都没写；
但「什么时候做、留几份、怎么验、怎么恢复」这套编排生态里没有现成插件
（备份工具全是命令行 + cron，而手册 §12.4 禁止产出独立 CLI）。
所以属于「生态没有，允许写厚」的自研档。

## 多方案分支说明（§12）

涉及多方案：**备份方式 —— `VACUUM INTO`（默认）/ 文件复制 / Online Backup API**。

处理方式是 **§12.1「能融会贯通 → 融」+ 明确排除**，不做三分支：

| 方案 | 结论 | 理由 |
|---|---|---|
| `VACUUM INTO` | **默认且唯一** | 一致副本、零依赖、单条语句、顺带整理碎片 |
| 直接复制 `.db` | **明确排除** | WAL 模式下会漏掉未落盘事务，产出「结构完整、数据缺一截」的假备份。这不是「慢一点」，是「错」 |
| Online Backup API（`sqlite3_backup_*`） | **本轮不做** | `node:sqlite` 未暴露增量备份接口；要它就得引第三方驱动，违背「Node 内建优先」。若将来 `node:sqlite` 提供 `backup()`，作为 `provider` 分支加入——接口已经是 `create()`，加分支不需要改契约 |

| 要求 | 落地 |
|---|---|
| 接口唯一 | 只有一个 `SnapshotService`，换实现不改调用方 |
| 文件隔离 | 备份逻辑在 `backup.ts`，命名与轮转在 `registry.ts`，编排在 `service.ts` |
| 默认最稳 | `VACUUM INTO` + 做完即校验 |
| 独立降级 | 校验失败 → 改名 `.corrupt` 并拒绝返回记录；快照不可用 → 服务仍注册但 `available=false` |
| 可观测 | `stats()` 给出 `available` / `count` / `newestAtMs` / `totalBytes` / `pendingRestore` |
| 不共享状态 | 与 O-006 / O-008 零共享；目录、票据、轮转计数全是实例私有 |

## 隔离五问（§16.4）

1. **关掉我，谁受影响？** 没有自动备份，O-008 的迁移前钩子表为空（迁移照常跑，
   只是没有「改结构前先备份」这层保险）。已有快照文件留在磁盘上，不会消失。
   主对话完全不受影响。
2. **我的状态存在哪？** 三处：`backups/snapshots/ondra-*.db`（快照本体）、
   `user/restore-pending.json`（0600，待恢复票）、进程内的目录缓存（卸载即清）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.snapshot`；
   备份失败打 `error` 并带原因码，校验失败额外说明「已改名 .corrupt」；
   运行期指标走 `stats()`，由 O-077 汇总。
4. **我依赖谁？缺席时怎么降级？** 存储（硬，判空后不注册服务）；路径（硬，
   缺席则注册但 `available=false`，因为快照不能落到 cwd）；迁移（软，缺席时挂不上钩子，
   只打一条 info）；身份（软，日志命名空间退化）。
5. **我和同域的谁共享可变状态？** 没有。与 O-006 只读它的 `raw`；与 O-008 只有一个
   单向钩子注册（它不知道我存在）。

## 自检（master-plan §16.1 九项 + §16.2 语言五项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（6 必需 + icon） | 过（12 文件：7 必需 + `src/types.ts` / `src/backup.ts` / `src/registry.ts` / `src/service.ts` + `icon.svg`） |
| 2 | 清单合法 | 过（JSON 可解析、`ondra-*`、`type: module`、`main`/`types`/`exports`/`files` 齐、cordis 双声明、`ondra.bundle.patch` 在且文件真实存在） |
| 3 | 编译配置 | 过（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） |
| 4 | 入口契约 | 过（`name` + `apply(ctx, config)` + `Config` 四字段全有默认值，与 `DEFAULT_CONFIG` 键集合逐一对齐） |
| 5 | 服务键唯一 | 过（`ondra-snapshot` 全仓仅本插件 `provide`） |
| 6 | 依赖可解析 | 过（`ctx.get` 五个键：`ondra-store-sqlite` / `ondra-store-memory` / `ondra-path-layout` / `ondra-identity` / `ondra-data-migrate`，台账均有提供方） |
| 7 | 无越界 import | 过（无 `from 'ondra-`；对 O-006 / O-008 走结构对位） |
| 8 | 降级到位 | 过（存储 `undefined` → 不注册；路径 `undefined` → 注册但不可用；迁移 `undefined` → 用 `ctx.inject` 等就绪；五个 `ctx.get` 均先判空） |
| 9 | 交付物齐全 | 过（技术来源表 / 多方案说明 / 隔离五问齐） |
| 语言 1–5 | 括号配平 / 无残留半句 / `import type` 正确 / 无 TODO / UTF-8 无 BOM | 过 |

> 判定由静态脚本产出（只读文件 + JSON 解析 + 括号配平 + 标识符交叉核对），
> 未执行 `tsc` / `build` / `pnpm install`（§16.3 禁止实装运行）。
