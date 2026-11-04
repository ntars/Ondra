# ondra-store-sqlite

> O-006 · L1 存储 · 〔薄〕薄封装 · 服务键 **`ondra-store-sqlite`**（连字符）

空谷 Ondra 的**唯一 SQL 出口**。业务域插件（记忆、人格、情绪）只声明「我要一张什么样的表」，
开库、开 WAL、开外键、建表、补列、建索引、收权限、事务、语句缓存全部在这里做一次。

消费方一律：

```ts
const store = ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')
if (!store) return          // 两个后端都没有：安静降级，不阻断主对话
```

**只取一个、只写一个。** 同时写两个后端就是双真源，比没有后端更糟。

## 职责

- 用 `node:sqlite`（Node 内建，**不引第三方驱动**）打开库文件，默认落在 `user/ondra.db`。
- 应用并**读回**四项 PRAGMA：`journal_mode`（默认 wal）、`foreign_keys`（默认开）、
  `synchronous`（默认 normal）、`busy_timeout`（默认 5000ms）。
- 建表用 `STRICT`，自动补缺失列（`ALTER TABLE ADD COLUMN`）与索引（`CREATE INDEX IF NOT EXISTS`）。
- 库文件与 `-wal` / `-shm` 收紧到 `0600`（POSIX；Windows 跳过）。
- 提供 `insert / upsert / update / delete / get / select / count / transaction` 表级操作，
  以及 `caps.sql === true` 时的 `raw` 原始 SQL 面（`exec / run / all / get`，参数一律 `?` 绑定）。
- 探测 FTS5 是否**真的可建表**，写进 `caps.fts`——不靠「文档说有」。

## 明确不负责

- **不定义业务表结构**：表由各域插件用 `TableSpec` 声明，本插件只执行。
- **不决定数据根在哪、也不建目录**：目录（0700、越界校验）归 O-002 `ondra-path-layout`。
- **不做版本迁移**：`user_version` 与表结构版本演进归 O-008 `ondra-data-migrate`。
- **不做快照与恢复**：`VACUUM INTO`、KEEP=3 归 O-009 `ondra-snapshot`。
- **不做内存兜底**：那是 O-007 `ondra-store-memory`，两个插件互不 import（§15.5）。
- **不做序列化**：对象/数组不会自动转 JSON——端口会**拒收**并抛 `unsupported-value`，
  要存 JSON 请调用方自己 `JSON.stringify`（与上游 `ondra-storage-sqlite` 的 `value TEXT` 口径一致）。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-store-sqlite` | 唯一归属 |
| 消费 | `ondra-path-layout` | **软依赖**（`ctx.get` 判空，缺失即拒绝落盘并报错） |
| 消费 | `ondra-identity` | **软依赖**（只取日志命名空间） |

契约定义在 `src/types.ts`：`StorePort` / `StoreCaps` / `TableSpec` / `ColumnSpec` / `IndexSpec` /
`Filter` / `SelectQuery` / `EnsureResult` / `StoreIssue` / `StoreStats` / `RawSqlFacet` / `StoreError`。

## 配置（全部有默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| `path` | `''`（自动 `user/ondra.db`） | 也支持 `:memory:`（仅自检用） |
| `journalMode` | `wal` | 网络盘上 WAL 的共享内存文件不可用时改 `delete`/`truncate`/`persist` |
| `synchronous` | `normal` | WAL+normal：应用崩溃不丢事务，断电可能丢最后一批 |
| `busyTimeoutMs` | `5000` | 0 表示撞锁立刻失败；夹在 0–60000 |
| `foreignKeys` | `true` | 外键是连接级开关，每次开库都要重设 |
| `tightenPermissions` | `true` | Windows 自动跳过 |
| `strictTables` | `true` | 建 `STRICT` 表；旧 SQLite 不支持时退回普通表并记 issue |

## 关键取舍（每条都有代价，写在这里防后人踩回去）

1. **接口是同步的，不包 Promise。**
   `node:sqlite` 只给 `DatabaseSync`。包成 Promise 不会让它变快，只会让每个消费方被迫
   `async`，并把一种失败形态（抛错）裂成两种（抛错 + 忘了 catch 的 rejection）。
   代价：将来接远程库要重写接口。取舍依据是「正确 > 稳定 > 可维护 > 省资源」，
   而当前所有后端（SQLite / 内存 / JSONL）都是本地同步的。

2. **`PRAGMA journal_mode = WAL` 必须读回。**
   这条语句在 WAL 不可用的卷上**不报错**，只把返回行里的模式改成实际值。
   只 `exec()` 不看返回，就会以为在跑 WAL 而实际在 rollback-journal 上，
   现象是「偶发 `SQLITE_BUSY`，查不出原因」。现在读回值进 `stats().journalMode` 与日志。

3. **`busy_timeout` 必须在任何事务之前设。**
   两个连接（本进程 + O-009 快照进程）撞车时，没有 `busy_timeout` 会立刻 `SQLITE_BUSY`；
   有了它才排队等待。这也是本插件用 `BEGIN IMMEDIATE` 而不是 `BEGIN` 的原因：
   deferred 事务在「读转写」那一刻才拿写锁，那时重试要重做全部业务逻辑。

4. **嵌套事务直接抛错，不静默加入外层。**
   SQLite 不支持嵌套 `BEGIN`。静默「加入外层」会让内层的成功/失败语义消失
   （内层以为提交了，实际取决于外层），是最难查的一类错。代价：调用方要把事务边界想清楚。

5. **补列时「非空但无默认值」降级为可空，并记 issue。**
   SQLite 的 `ALTER TABLE ADD COLUMN` 不能加非空无默认值的列。
   两个选择：拒绝开库（数据还在但整个 app 用不了），或降级并**显式记录**。
   选后者，因为 issue 会进 `EnsureResult` 与日志，O-077 看得见；
   拒绝开库则是「为了一个字段的正确性炸掉整个存储」。
   代价：那一列在旧行上是 `NULL`，业务写入必须自己兜底——issue 文案里写死了这句话。

6. **补列时「主键列」直接跳过。**
   SQLite 同样不允许 `ADD COLUMN PRIMARY KEY`。要加主键只能重建表，
   那是 O-008 的活。跳过并记 `primary-key-skipped`，不假装成功。

7. **`-wal` / `-shm` 一起 chmod 0600。**
   主库收紧到 0600 但旁挂文件是 0644 时，数据照样能被同机其他用户读到——
   上游只 `open(path,'wx',0o600)`，管不到这两个文件。

8. **列类型刻意不含 `NUMERIC`。**
   `STRICT` 表只接受 `INT / INTEGER / REAL / TEXT / BLOB / ANY`。
   收一个 `NUMERIC` 进来，会在「严格表」建表那一刻直接报错——那是把坑埋在建表期。

9. **`boolean` 归一化成 `0 | 1`，其余不做隐式编码。**
   SQLite 没有布尔类型，绑 `true` 在部分驱动实现里会抛。统一转成 0/1，
   两个后端做同样的转换（只有一处做就会变成「换后端数据含义变了」）。

10. **语句缓存 256 条 FIFO，不按 LRU。**
    SQL 是有限集合，真风险只有「动态拼 SQL 无界增长」。FIFO 足够，且不需要维护访问序。

11. **不用 Cordis `inject`。**
    `inject` 是硬依赖：服务缺席时插件保持 PENDING、**静默不加载**。
    存储是 L1 命脉，PENDING 的表现是「什么都没读写，也没报错」。
    改成运行时 `ctx.get` 判空 + 一条中文 error，换可观测性。

12. **绝不落到当前工作目录。**
    未配置 `path` 又取不到 O-002 时，**拒绝注册服务**而不是 `./ondra.db`。
    否则「换个目录启动就换了一个库」，是「记忆忽然全没了」最脏的来源。

## 边界

- 属于 L1，崩溃后果是「记忆回不来」，因此**零运行时依赖**：只用 `node:sqlite` / `node:fs` /
  `node:module` / `node:path`。加载 `node:sqlite` 走 `createRequire` + try/catch，
  静态 `import` 会在缺内建模块的 Node 上让整个模块求值期崩掉——那是「插件没加载」的静默失败。
- 与 O-007 的边界：**同一接口、两个服务键、各自一个文件实现**；默认 SQLite，内存兜底；
  **不共享缓存、不共享连接、不共享定时器**（§14.2）。
- 不做「多库并存」：一个进程一个主库。需要第二个库（如 `emotion.db`）时，用第二个插件实例 +
  不同 `path`，**不得新增第二个服务键**（违反 §15.4）。

## 已知限制

1. **不做类型漂移检测。** 补列只补「缺的列」，不管「同名列类型改了」。
   后者要么手工迁移、要么 O-008 重建表。静默按旧类型继续用，会让你写进去的值被 SQLite 亲和性
   悄悄转换（`'123'` 进 INTEGER 列变 123），所以**宁可不管，也不假装在管**。
2. **不做 `realpath` 逃逸校验。** 数据根内部若有指向外部的软链，写入会穿透。
   理由与 O-002 相同（`realpathSync` 要求路径已存在）；风险已登记给 O-076 `ondra-privacy`。
3. **`-wal` / `-shm` 可能在开库之后才被创建**，那时本次 chmod 覆盖不到。
   缓解事实：所在目录已由 O-002 收紧到 0700，同机其他用户进不来。
   要彻底解决只能上 `umask` 或文件系统 ACL，本轮不做。
4. **不支持 `ATTACH` 多库事务**。`transaction()` 只保证单库原子性。
5. **`STRICT` 表要求 SQLite ≥ 3.37**。Node 22.5+ 自带版本满足，但不满足时只是退回普通表
   （记 `strict-unavailable`），不会失败。
6. **FTS5 探测是「建临时表再删」**，在只读挂载或 `PRAGMA query_only=ON` 的连接上会误报不可用。
   本插件不开 `query_only`，故当前无影响。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 开库序列与 PRAGMA | `@ntars/ondra-storage-sqlite`（本仓 `desktop/packages/storage/storage-sqlite/src/schema.ts`） | github.com/ntars/Ondra | MIT | `PRAGMA foreign_keys=ON` → `journal_mode` 四值 → `user_version` 戳的顺序；`open(path,'wx',0o600)` 建库；`STRICT` 表；`mkdir(dir,{mode:0o700})` | 自研 `open.ts`：同序列 + **读回生效值** + `busy_timeout` + 旁挂文件 chmod + FTS5 探测。不依赖该包（它是 kv 后端，服务对象是 storage hub） | 否 |
| 事务与语句预编译 | 同上 `src/unit.ts` | 同上 | MIT | 语句「预编译后复用」；`BEGIN IMMEDIATE` 而非 `BEGIN`；回滚失败标记 `unknown-state` 后连接不可再用 | 自研 `port.ts`：语句缓存 256 条 FIFO、嵌套事务抛错、回滚失败转 `degraded` 并锁死 | 否 |
| 标识符规则 | `@ntars/ondra-storage`（`backend.ts` 的 `UNIT_NAME_RE`） | 同上 | MIT | `^[a-z][a-z0-9_]*$`：表/列/索引名不用连字符（SQL 标识符要永远加引号，太容易漏） | `types.ts` 的 `IDENT_RE`，比服务键正则更严 | 否 |
| SQLite 端口设计 | `better-sqlite3` 的 API 取舍（`prepare/get/all/run`、嵌套事务抛错） | github.com/WiseLibs/better-sqlite3 | MIT | 「同步 API + 预编译 + 嵌套事务显式报错」这套使用手感 | 自研，未引入其代码（本项目用 Node 内建 `node:sqlite`） | 否 |

**档位判定（§1.8）**：〔薄〕薄封装。上游有可用的开库机制，但它服务的是 **kv 文档后端**
（`key TEXT / value TEXT` JSON），表达不了「业务表 + 任意 SQL + FTS5 + `VACUUM INTO`」。
本插件保留上游机制、把契约换成业务表端口，属于「包一层适配与护栏」，不是重写驱动；
也没有「能复用却自研」——真正的驱动是 Node 内建的 `node:sqlite`，本插件一行驱动代码都没写。

## 多方案分支说明（§12）

涉及多方案：**持久化后端 = SQLite（默认/最稳）/ JSONL（O-121，无 SQLite 环境）/ 内存（O-007，兜底）**。

| 要求 | 落地 |
|---|---|
| 接口唯一 | 只有一个 `StorePort`（`src/types.ts`），三个后端都实现它，不许各自定义返回形状 |
| 文件隔离 | 本插件 = `src/port.ts`；O-007 = `ondra-store-memory/src/port.ts`；O-121 另建 |
| 默认最稳 | SQLite + WAL 为默认；JSONL 与内存只在 SQLite 不可用时被选中 |
| 独立降级 | 本插件开库失败时**不注册服务**（不打半个服务），消费方自然回落到下一个键 |
| 可观测 | `stats().provider` / `state` / `journalMode` / `degraded` 全部可读，界面与 O-077 不许黑箱 |
| 不共享状态 | 三个后端各自一个连接/一张表/一个缓存，零共享 |

**分支选择不做成运行期开关**，而是**服务键优先级**：`ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')`。
理由：运行期 `if (mode === ...)` 铺三套逻辑，正是 §12.3 明令禁止的写法。

## 隔离五问（§16.4）

1. **关掉我，谁受影响？** 所有需要持久化的插件（记忆域 O-010~O-019、情绪 O-026、人格 O-020~025、
   主动 O-042 等）取到 `undefined`，按各自契约回落到 O-007 内存后端或直接跳过；
   主对话仍能进行（只是她记不住）。
2. **我的状态存在哪？** `user/ondra.db`（0600）+ 同目录 `-wal` / `-shm`；
   进程内存里是语句缓存与表元信息缓存，卸载即清。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.store-sqlite`；
   开库失败打 `error`、WAL 降级与权限失败打 `warn`；运行期指标走 `stats()`
   （`state` / `degraded` / `failures`），由 O-077 `ondra-startup-check` 汇总。
4. **我依赖谁？缺席时怎么降级？** `ondra-path-layout`（软）：缺席且未配 `path` → 拒绝注册并报错；
   `ondra-identity`（软）：缺席 → 日志命名空间退化为 `ondra.store-sqlite`。
5. **我和同域的谁共享可变状态？** 没有。与 O-007 是两个独立实现、两个服务键、两个缓存。

## 自检（master-plan §16.1 九项 + §16.2 语言五项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（6 必需 + icon） | 过（12 文件：7 必需 + `src/types.ts` / `src/schema.ts` / `src/open.ts` / `src/port.ts` + `icon.svg`） |
| 2 | 清单合法 | 过（JSON 可解析、`ondra-*`、`type: module`、`main`/`types`/`exports`/`files` 齐、cordis 双声明、`ondra.bundle.patch` 在且文件真实存在） |
| 3 | 编译配置 | 过（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） |
| 4 | 入口契约 | 过（`name` + `apply(ctx, config)` + `Config` 七字段全有默认值，与 `DEFAULT_CONFIG` 键集合逐一对齐） |
| 5 | 服务键唯一 | 过（`ondra-store-sqlite` 全仓仅本插件 `provide`） |
| 6 | 依赖可解析 | 过（`ctx.get` 两个键：`ondra-identity`、`ondra-path-layout`，均在台账有提供方且已 done） |
| 7 | 无越界 import | 过（无 `from 'ondra-`；对 O-002 走结构对位，不引源码） |
| 8 | 降级到位 | 过（两个 `ctx.get` 结果均先判 `undefined` 再使用，未直接调用） |
| 9 | 交付物齐全 | 过（技术来源表 / 多方案分支说明 / 隔离五问齐） |
| 语言 1–5 | 括号配平 / 无残留半句 / `import type` 正确 / 无 TODO / UTF-8 无 BOM | 过 |

> 判定由本轮静态脚本产出（只读文件 + JSON 解析 + 括号配平 + 标识符交叉核对），
> 未执行 `tsc` / `build` / `pnpm install`（§16.3 禁止实装运行）。
