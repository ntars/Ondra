# ondra-store-json · JSONL 持久化后端

> 手册 §12.3「持久化后端」行 / §12.2 分支纪律｜台账 O-121（第 16 组 · 多方案分支）｜档位〔研〕自研｜**默认关闭**

**一句话：给「没有 SQLite、又不想退出即丢」的环境一个不依赖 SQLite 的持久化后端——追加日志保崩溃安全，压缩原子重写保文件干净。**

---

## 1. 它到底做什么

实现与 O-006 `ondra-store-sqlite`、O-007 `ondra-store-memory` **同一个 `StorePort` 形状**（结构对位镜像），注册第三个服务键：

| 能力位 | SQLite（O-006） | 内存（O-007） | **JSONL（本插件）** |
|---|---|---|---|
| `persist` | true | false | **true** |
| `sql` | true | false | false |
| `fts` | 视库而定 | false | false |
| `transaction` | true | false | **true**（撤销日志回滚） |

数据形态：`user/jsonl-store/` 目录下，每张表两个文件——

```
<表名>.jsonl          # 追加日志：每行一条 {"__key":"主键串","v":{行}} 或 {"__key":"...","__del":true}
<表名>.schema.json    # 表声明（tmp + rename 原子写）
```

读取时按主键取**最后**出现的一条，墓碑行删除——「最后一条为准」让追加日志天然幂等。

---

## 2. 三条落盘纪律（本插件的全部安全边际）

1. **先落盘、后改内存。** 追加写失败时内存保持原样、直接抛错。消费方看到的是一次干净的失败，不是「内存说成功、盘上没有」的静默漂移。
2. **追加日志 + 坏行容忍。** 进程崩溃最多丢正在写的那半行；加载时坏行跳过并计入 `stats().corruptLines`，已完成的行永远完整。
3. **压缩才是原子重写。** `compact()` / 自动压缩：写 `<表名>.jsonl.tmp` → fsync → rename 覆盖。任何时刻断电，文件要么是旧完整版、要么是新完整版。自动压缩阈值：某表追加行数达到「存活行数与 64 的较大者」的 `compactFactor` 倍。

---

## 3. 服务键与契约

**服务键：`ondra-store-json`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。

提供 `StorePort`（与 O-006/O-007 同形状，`provider` 多一个 `'jsonl'` 取值——这是契约镜像的唯一允许差异，O-007 已立先例）。方法集：`ensureTable / tableExists / insert / upsert / update / delete / get / select / count / transaction / compact / stats / close`。

**消费方取用纪律**：三个后端**不会自动同步**，按配置只取一个、只写一个：

```ts
const store = ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory') ?? ctx.get('ondra-store-json')
```

---

## 4. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| SQL / FTS5 / `VACUUM INTO` | O-006 `ondra-store-sqlite` | 本插件 `caps.sql = false`；需要全文索引的消费方必须留在 SQLite 分支 |
| 自动兜底（SQLite 挂了顶上） | O-007 `ondra-store-memory` | 兜底是可用性探测；分支切换是用户的显式选择，两者不是一层 |
| 数据目录的创建与越界校验 | O-002 `ondra-path-layout` | 目录归它建（0700 + 防 `..` 逃逸），本插件不自己 mkdir |
| 后端选择（provider 切换） | 消费方的配置 | 三个后端同时在位时本插件不越权裁决，只打警告 |
| 数据迁移（SQLite → JSONL） | O-009 `ondra-data-migrate` | 迁移是独立能力；本插件只做「从空开始也能跑」 |

---

## 5. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | **`false`** | 总开关。台账第 16 组：默认分支「否（SQLite 默认）」 |
| `max-rows-per-table` | number | `20000` | 单表行数上限，到上限**拒绝新增**，不悄悄淘汰旧行 |
| `compact-factor` | number | `4` | 自动压缩倍数；`0` 关闭自动压缩（只能手跑 `compact()`） |
| `tighten-permissions` | boolean | `true` | 目录 0700 / 文件 0600；Windows 上自动跳过 |

---

## 6. 多方案分支（手册 §12）

| 项 | 内容 |
|---|---|
| 所属多方案 | 持久化后端三方案：SQLite（WAL）/ JSONL / 内存 |
| 本插件位置 | **JSONL 分支**，默认关闭 |
| 底座 | O-006 `ondra-store-sqlite`（默认） |
| 分支间共享 | **无**。不共享缓存、不共享连接、不共享文件 |
| 独立降级 | 目录建不了 / 初始化失败 → 不注册服务，打一行 error，消费方回退其余后端 |
| 可观测 | `stats()` 暴露 provider / state / corruptLines / appendedSinceCompact，供 `ondra-startup-check` 读取 |

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。默认就是关的；关掉后依赖 `ondra-store-json` 的配置项拿不到服务。
2. **我的状态存在哪？** `user/jsonl-store/`（O-002 区域内，0700 目录 / 0600 文件）。内存里只有「已接入表」的行索引。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.store-json`；`stats().state` 区分 `open / degraded / closed`，`corruptLines` 与 `failures` 给出量化线索。
4. **我依赖谁？缺席时怎么降级？** 依赖 O-002 `ondra-path-layout`（**硬**：没有它拒绝落盘到工作目录，不注册服务）；`ondra-identity`（软，只影响日志命名空间）。初始化任何一步失败 → 不注册服务 + 一行 error。
5. **我和同域的谁共享了可变状态？** **没有**。与 O-006 / O-007 各写各的文件；同时启用时也不互相同步（README §3 已写明纪律）。

---

## 8. 已知限制（诚实清单）

1. **无 SQL 面**：`raw` 恒为 `undefined`。FTS5 检索、`VACUUM INTO` 快照、跨表 JOIN 在本分支不可用——消费方必须在装载期检查 `caps.sql` 后分支，这是 O-006 契约里的既有纪律。
2. **无主键表能力受限**：`insert / select / count` 可用；`get / update / delete / upsert / transaction 内写入` 不可用（无法稳定定位行）。
3. **追加不是逐条 fsync**：进程崩溃（非断电）最多丢内核缓冲里最后一小段；断电级安全靠 `compact()` 后的已压缩部分。要逐事务强持久化的数据应该留在 SQLite（`synchronous=full`）。
4. **补列只加不减**：删列、改类型、非空收紧都不回溯旧行（旧行里可能已有 null）；收紧只对新写入生效并记 issue。
5. **性能边界**：全表在内存，单表百万行级是合理上限（`maxRowsPerTable` 上限 2,000,000）。更大的量请回 SQLite。
6. **错误码集与上游有一处已知分叉（2026-11-03 交叉发现）**：O-006（`port.ts:186`）与 O-007（`port.ts` 4 处）都在抛 `'constraint'`，但它**不在两包自己声明的 `StoreErrorCode` 闭集（11 码）内**，strict 下是编译错。本包不复制该越界用法，主键冲突 / 行数上限一律用闭集内的 `'bad-argument'` 并在 detail 写明。已按 §15.7 登记台账，**不擅自改 O-006 / O-007**；修法二选一待主人裁决：上游闭集补 `'constraint'`，或两包改用闭集内码。

---

## 9. 技术来源

| 项 | 档位 | 依据与借鉴点 |
|---|---|---|
| 追加日志（append-only log）+ 按主键取最后一条 | 〔研〕 | 机制是日志型存储的标准形态（LSM/WAL 同思想）；借鉴「顺序写 + 幂等重放」，代码自写 |
| 原子替换（tmp + fsync + rename） | 〔研〕 | POSIX rename 同目录原子性；O-006 对 `-wal/-shm` 旁挂与 0600 收紧的口径沿用到本包 |
| `node:sqlite` 不可用环境的兜底诉求 | 〔复〕 | 手册 §11.5「SQLite：`node:sqlite`（Node 内建）直接用」的反面：本插件服务于**没有**该内建模块的环境 |
| O-007 内存后端的接口纪律 | 〔复〕 | 「结构对位镜像 + 允许差异仅 provider 取值」的先例直接沿用；上限拒绝写入、不悄悄淘汰的口径同源 |

**为什么不是〔复〕**：生态里 JSONL 持久化方案（如 lowdb 类）提供的是「整文件读改写」，与本仓需要的「表级 CRUD + 主键 + 事务 + 原子压缩」语义不匹配；引入整库再包适配层反而多一层出错面。台账第 16 组明确标〔研〕。

---

## 10. 文件清单（10）

```
package.json          # ondra.bundle.patch → ./cordis.patch.yml（漏了插件永远不加载）
tsconfig.json         # NodeNext + strict + declaration
cordis.patch.yml      # insert 带 id：目标须为 group
src/index.ts          # name / apply / Config；enabled=false 默认不注册
src/types.ts          # StorePort 结构对位镜像 + 服务键（唯一真源）
src/port.ts           # JsonlStore：追加日志 / 撤销日志事务 / 原子压缩
locale/zh.json        # meta.title / meta.description
locale/en.json
icon.svg              # 由 tools/sync-plugin-icons.mjs 从根 icon.svg 生成
README.md
```

---

## 11. 快速上手

```yaml
# cordis.yml（节选）——确认 SQLite 不可用时才打开
- id: ondra-store-json
  name: ondra-store-json
  config:
    enabled: true            # 默认 false
    max-rows-per-table: 20000
    compact-factor: 4
```

```ts
// 消费方（分支选择纪律：只取一个、只写一个）
const store =
  ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory') ?? ctx.get('ondra-store-json')
if (store === undefined) return // 全部缺席：安静降级，不要抛
if (!store.caps.sql) {
  // JSONL / 内存分支：检索留在 2-gram 倒排，不试 FTS5
}
store.ensureTable(spec)
```

---

## 12. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整 | 过（10 文件：7 必需 + `src/types.ts` / `src/port.ts` + `icon.svg`） |
| 2 | 清单合法 | 过（JSON 可解析、`ondra-*`、`type: module`、四字段齐、cordis 双声明、`ondra.bundle.patch` 在且文件真实存在） |
| 3 | 编译配置 | 过（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） |
| 4 | 入口契约 | 过（`name` 字符串 + `apply(ctx, config)` + `Config` 四字段全有默认值；不声明 `inject`——两个依赖全软，缺席应降级而非停在 PENDING） |
| 5 | 服务键唯一 | 过（`ondra-store-json` 全仓仅本插件 provide） |
| 6 | 依赖可解析 | 过（`ctx.get` 三键：`ondra-path-layout` / `ondra-identity` / `ondra-store-sqlite`，均有提供方） |
| 7 | 无越界 import | 过（无 `from 'ondra-`） |
| 8 | 降级到位 | 过（三处 `ctx.get` 均判空：路径服务缺席→拒绝注册；sqlite 只读探测） |
| 9 | 交付物齐全 | 过（技术来源 / 多方案分支 / 隔离五问齐） |
| 语言 1–5 | 括号配平 / 无残留半句 / import type 分清 / 无 TODO / UTF-8 无 BOM | 过 |
| 图标 | 与根 `icon.svg` 逐字节一致（`node tools/sync-plugin-icons.mjs`） | 过 |

> 判定由静态检查产出（只读 + JSON 解析 + 括号配平 + 服务键交叉核对），未执行 `tsc` / `build` / `pnpm install`（§16.3）。
