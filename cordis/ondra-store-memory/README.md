# ondra-store-memory

> O-007 · L1 存储 · 〔研〕自研 · 服务键 **`ondra-store-memory`**（连字符）

**内存兜底存储**。存在理由只有一条（决策 92）：**SQLite 打不开时，主对话还能进行**。

数据库文件损坏、所在卷不支持 WAL 的共享内存文件、Node 缺 `node:sqlite`——
这些都会让 O-006 干脆不注册服务。没有本插件的话，记忆域 / 情绪域 / 人格域会全部拿到
`undefined`，表现是「她失忆了，而且什么都不说」。

消费方统一写法：

```ts
const store = ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')
if (!store) return
if (!store.caps.sql) { /* 走 2-gram 倒排等不需要 SQL 的分支 */ }
```

## 职责

- 用 `Map` 实现与 O-006 **同一套** `StorePort`：`ensureTable / tableExists / insert / upsert /
  update / delete / get / select / count / transaction / stats / close`。
- 支持 `Filter` 全部十个算子（`eq / ne / gt / gte / lt / lte / like / in / is-null / not-null`）、
  多列排序、`limit` / `offset`。
- 与 SQLite 后端**对齐**三处语义：`boolean` → `0 | 1`；对象/数组拒收；嵌套事务抛
  `nested-transaction`。
- 单表行数上限保护（默认 20000），到上限**抛错**，不淘汰旧行。

## 明确不负责

- **不持久化**：进程退出即丢。`caps.persist = false`，这不是缺陷，是定位。
- **不支持原始 SQL**：`caps.sql = false`，`raw` 恒为 `undefined`。要 FTS5 / `VACUUM INTO` 的
  能力必须检查能力位后分支。
- **不建真索引**：`IndexSpec` 只登记名字并回进 `EnsureResult`，不做加速。
- **不做事务回滚**：`caps.transaction = false`。回调抛错只保证「异常不被吞」，已写入的行留在内存里。
  真要原子性请检查能力位。
- **不做外键、不做并发控制、不做类型强校验**（`STRICT` 被忽略）。
- **不接管 SQLite 的位置**：没有降级「写穿到磁盘」的隐藏逻辑，绝不悄悄生成一个 JSON 文件冒充持久化。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-store-memory` | 唯一归属 |
| 消费 | `ondra-store-sqlite` | **只读探测**（仅用于打一句「SQLite 已在位，我在备用」的日志；**不调用它的任何方法**） |
| 消费 | `ondra-identity` | **软依赖**（只取日志命名空间） |

契约定义在 `src/types.ts`，是 O-006 `StorePort` 的**结构对位镜像**（见下方「关键取舍」第 1 条）。

## 配置（全部有默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉 = 放弃兜底；SQLite 一挂，持久化能力全拿不到服务 |
| `maxRowsPerTable` | `20000` | 单表行数上限，夹在 1–2,000,000；到上限拒绝写入 |
| `announceFallback` | `true` | 装载时打一条「不落盘」提醒；关掉只是少一行日志 |

## 关键取舍

1. **契约靠结构对位镜像，不 import O-006 的源码。**
   §15.5 / §18.5 明令禁止同轮两个插件互相 import——任一单独卸载都会让另一个编译失败。
   §18.3 说「第二个插件只 `import type` 该契约」，两条在这里**直接冲突**。
   选择服从 §15.5（更硬的约束：编译耦合比字段漂移更难修），用「同名同形状的结构对位」替代，
   并靠消费方那一行 `??` 赋值做形状校验：字段一分叉，赋值处立刻报类型错。
   **代价**：两边要人工同步。所以 `src/types.ts` 文件头写死了维护纪律。

2. **即使 SQLite 在位也照常注册。**
   若改成「SQLite 在就不注册」，兜底能力就取决于**装载顺序**——同一份配置有时有兜底、
   有时没有，这种不确定性比多存一个空对象贵得多。「只用其中一个」由消费方取值顺序保证。

3. **不静默淘汰。**
   到行数上限就抛 `constraint`。悄悄删最旧的行能让程序继续跑，但那是**在用户不知情时删数据**，
   比「写不进去」糟得多。上限本身可配。

4. **`caps.transaction = false` 而不是「假装支持」。**
   真回滚要对全表做快照，而内存后端存在的意义是「最小可用」，不是「小号 SQLite」。
   标成 false，消费方在装载期就能决定「这段写入在内存模式下干脆跳过」。

5. **`like` 只实现 `%` 与 `_`。**
   与 SQL `LIKE` 的最小公共子集一致；用正则翻译而不是手写匹配，避免把通配符语义翻译错。
   不支持 `ESCAPE` 子句——SQLite 那边也只在显式声明时才需要。

6. **`get()` 返回副本，`select()` 返回副本数组。**
   返回内部 `Map` 的话，调用方改一下返回值就改了存储内容，且**没有任何写入计数**——
   这是「状态被谁改了」最难查的来源。代价是每次读一次浅拷贝；内存后端数据量本来就小。

7. **主键编码用 `\u0000` 分隔。**
   用 `|` 做分隔符时，主键值里带 `|` 会撞键（`a|b` + `c` 与 `a` + `b|c` 同码）。
   `\u0000` 不可能出现在正常业务主键里。

8. **无主键的表不让 `get/update/delete/upsert`。**
   与 SQLite 后端同口径：没有主键就无法定位一行，硬造一个「按值扫描」的语义会让两个后端行为分叉。

## 边界

- 属于 L1，崩溃后果是「记忆回不来」，但本后端**丢了也不心疼**（它本来就不落盘）。
  因此零依赖：只用标准库 `Map` / `RegExp` / `Object.fromEntries`。
- 与 O-006 的关系：**同一接口、两个服务键、各自一个文件实现**；不共享缓存、连接、定时器（§14.2）。
- 不做「内存 + 磁盘双写」：那等于把双真源做进存储层，是最糟的一种「稳妥」。

## 已知限制

1. **完全不持久化。** 这是设计，不是待修项。要长期记忆必须修好 SQLite 后端。
2. **`select()` 是全表扫描 + JS 排序**，`limit` 在排序后才裁剪。表大时 O(n log n)，
   本后端的定位就是不承载大表。
3. **不校验列类型。** 声明 `INTEGER` 的列可以存字符串——内存后端不做 `STRICT`。
   需要类型强校验的场景必须走 SQLite。
4. **`like` 对 `bigint` / `Uint8Array` 的值会先 `String()` 再匹配**，语义与 SQL 不完全一致。
   业务里不要对二进制列用 `like`。
5. **并发安全靠 JS 单线程。** 同进程内不会撕裂，跨线程（Worker）不共享，也没有锁。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 表级 CRUD 与过滤语义 | `better-sqlite3` 的 API 形状（`insert/get/update/delete` + 条件对象） | github.com/WiseLibs/better-sqlite3 | MIT | 「同步 API + 条件对象查询」的使用手感；嵌套事务显式报错 | 自研 `port.ts`，用 `Map` 实现；未引入其代码 | 否 |
| 内存兜底的定位 | 旧项目决策 92（`DECISIONS.md`）：「SQLite 打不开时用内存实现」 | 本项目历史文档 | — | 「兜底不假装能力」这条原则：能力位显式声明，不靠运行期试探 | `caps` 四项全部写死为 false/true，消费方装载期分支 | 否 |
| 能力位（capability flags）设计 | `node:sqlite` / `ondra-storage` 的 backend 能力探测思路 | 本仓 `desktop/packages/storage` | MIT | 「后端把做不到的事显式标明」而不是抛异常让调用方猜 | `StoreCaps` 四项：`sql / fts / persist / transaction` | 否 |
| `LIKE` 通配符语义 | SQLite 文档（`%` / `_`） | sqlite.org/lang_expr.html | Public Domain | 只实现最小公共子集，不实现 `ESCAPE` | 自研：`%`/`_` 转成正则后匹配 | 否 |

**档位判定（§1.8）**：〔研〕自研。生态里的「内存 SQLite」要么是 `:memory:` 数据库（那不叫兜底——
前提正是 SQLite 打不开）、要么是完整 ORM 的内存驱动（体量远超本插件）。
本插件要的是「同一接口、零依赖、能力位诚实」的极小实现，没有可复用的现成件，
因此不构成「能复用却自研」。

## 多方案分支说明（§12）

涉及多方案：**持久化后端 = SQLite（默认）/ JSONL（O-121）/ 内存（本插件，兜底）**。

| 要求 | 落地 |
|---|---|
| 接口唯一 | 只有一份 `StorePort` 形状（本插件 `src/types.ts` = O-006 `src/types.ts` 的镜像） |
| 文件隔离 | 本插件 = `src/port.ts`，不与 SQLite 实现同文件、不同分支 |
| 默认最稳 | 默认选中 SQLite；本插件只在其缺席时被 `??` 选中 |
| 独立降级 | 本插件不依赖 SQLite 是否可用，注册与否只看自己的 `enabled` |
| 可观测 | `stats().provider = 'memory'`、`degraded = true`，界面与 O-077 不许黑箱 |
| 不共享状态 | 与 SQLite 后端零共享：无共享缓存、无共享连接、无共享定时器 |

**不把分支做成运行期 `if (mode)`**：分支选择 = 服务键优先级（`??` 链），
写死在消费方一行代码里，可读可查（§12.3 禁止在同一文件里铺三套逻辑）。

## 隔离五问（§16.4）

1. **关掉我，谁受影响？** SQLite 可用时：没有影响。SQLite 不可用时：依赖存储的插件全部
   拿不到后端，按各自契约跳过（她失忆但还能说话）；主对话不崩。
2. **我的状态存在哪？** **仅在内存**（`Map`）。进程退出即丢，磁盘上零痕迹。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.store-memory`；
   装载时一条 warn「不落盘」；运行期 `stats().degraded === true`。
4. **我依赖谁？缺席时怎么降级？** `ondra-identity`（软，仅日志命名空间）；
   `ondra-store-sqlite`（只读探测，缺席只是少一句日志，不影响注册）。
5. **我和同域的谁共享可变状态？** 没有。与 O-006 是两个独立实现、两个 `Map`、两个计数器。

## 自检（master-plan §16.1 九项 + §16.2 语言五项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（6 必需 + icon） | 过（10 文件：7 必需 + `src/types.ts` / `src/port.ts` + `icon.svg`） |
| 2 | 清单合法 | 过（JSON 可解析、`ondra-*`、`type: module`、四字段齐、cordis 双声明、`ondra.bundle.patch` 在且文件真实存在） |
| 3 | 编译配置 | 过（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） |
| 4 | 入口契约 | 过（`name` + `apply(ctx, config)` + `Config` 三字段全有默认值） |
| 5 | 服务键唯一 | 过（`ondra-store-memory` 全仓仅本插件 `provide`） |
| 6 | 依赖可解析 | 过（`ctx.get` 两个键：`ondra-identity`、`ondra-store-sqlite`，均在台账有提供方） |
| 7 | 无越界 import | 过（无 `from 'ondra-`；契约靠 `src/types.ts` 结构对位） |
| 8 | 降级到位 | 过（两个 `ctx.get` 结果均判 `undefined`，`sqlite` 只读 `state` 不调方法） |
| 9 | 交付物齐全 | 过（技术来源表 / 多方案分支说明 / 隔离五问齐） |
| 语言 1–5 | 括号配平 / 无残留半句 / `import type` 正确 / 无 TODO / UTF-8 无 BOM | 过 |

> 判定由本轮静态脚本产出（只读文件 + JSON 解析 + 括号配平 + 标识符交叉核对），
> 未执行 `tsc` / `build` / `pnpm install`（§16.3 禁止实装运行）。
