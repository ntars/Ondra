# ondra-memory-vector · 向量检索分支 + 混合检索

> 手册 §12.3「记忆检索」行 / §12.2 分支纪律｜台账 O-122（第 16 组 · 多方案分支）｜档位〔研〕自研｜**默认关闭**

**一句话：给 O-014 的 2-gram 倒排配一个可选的语义分支——零依赖确定性哈希嵌入起步，按语料规模在字面 / 混合 / 向量三档间自动切换；倒排不动，本分支只增不改。**

---

## 1. 它到底做什么

O-014 `ondra-memory-recall` 已经在消费侧写死了本插件的形状（`VectorSourceLike`：`available?` + `search(text, {limit})`），本插件按该契约提供语义召回：

| 模式（`mode()` 实时可见） | 触发条件（台账裁决④口径） | 检索路径 |
|---|---|---|
| `literal` | 索引 < 300 条 | 字符 bigram 包含率（本分支内建，**不是** O-014 的替代） |
| `hybrid` | 300–1000 条 | 字面 + 向量各取 2×limit，RRF（k=60，与 O-014 的 `RRF_K` 同值）融合 |
| `vector` | > 1000 条 | 嵌入余弦召回；≥ 200 条才建 IVF 分桶索引，探桶数 `annProbes` |

数据来源两条路，**都不写 O-010**：

1. `sync()`：从记忆内核 `listFacts()` 拉全量，按 `id + 文本指纹` 增量，只重嵌变化的条目；装载时若 `auto-sync: true` 自动跑一次，之后由消费方按需调（**不装定时器**）。
2. `upsert(id, text)` / `remove(id)`：内核缺席时的手动兜底。

---

## 2. 服务键与契约

**服务键：`ondra-memory-vector`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。**本键是全仓此前唯一的悬空键，本轮建好即归零。**

```ts
interface VectorService {
  readonly available: boolean
  readonly reason?: string
  search(text: string, options?: { limit?: number }): readonly VectorHit[]   // O-014 消费入口
  hybridSearch(text: string, options?: { limit?: number }): readonly VectorHit[]
  mode(): 'literal' | 'hybrid' | 'vector'
  sync(): VectorSyncResult
  upsert(id: string, text: string): void
  remove(id: string): void
  count(): number
  setEmbedder(embedder: EmbedderLike | null): void
  stats(): VectorStats
}
```

配套类型：`VectorHit`（`{id, score}`，与 O-014 的 `ExternalHitLike` 结构对位）/ `VectorSyncResult` / `VectorStats` / `EmbedderLike` / `MemoryCoreLike` / `StorePortLike` / `VectorError`。常量：`EMBED_DIM`(128) / `MODE_THRESHOLD_LITERAL`(300) / `MODE_THRESHOLD_VECTOR`(1000) / `HYBRID_RRF_K`(60) / `IVF_MIN_DOCS`(200)。

---

## 3. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| 五因子归一化（语义 .18 + 关键词 .46 + 图谱 .11 + 重要 .14 + 新鲜 .11） | O-014 `ondra-memory-recall` | 本插件只回答「语义上像不像」；做进这里就是第二套检索模型 |
| 召回不按条数砍（`dropped` 恒 0） | O-014 | P0 第二条是召回层纪律；本插件的 `limit` 只是分支返回上限 |
| 记忆的写入 / 衰减 / 归档 | O-010 / O-013 | 本插件只调 `listFacts()`，对内核零写入 |
| 建边 / 图谱 | O-015 | 与本分支无关；图谱因子在 O-014 侧参与融合 |
| 真向量模型的推理 | 宿主注入（`setEmbedder`） | 仓内没有已确认的 embedding 服务键，本插件**不编造 API** |
| 倒排检索本体 | O-014 | 本分支的字面侧只服务内部混合融合，**不开服务键对外** |

---

## 4. 关键裁决（六条）

1. **默认关闭不是保守，是分支纪律**。台账第 16 组写明「否（倒排默认）」。倒排在 300 条以内又快又准，向量的价值在语料变大后才出现；默认开着等于让每台机器都付建索引的钱。
2. **哈希嵌入是「诚实的假嵌入」**。禁装依赖、禁网络、无已确认 embedding 服务键——三重约束下，自研确定性字符 n-gram 哈希投影是唯一可落地的起点。它**不懂**同义词与跨语言语义（「birthday ≈ 生日」召回不出来）；这个边界写进「已知限制」，不伪装。
3. **三档阈值照抄台账裁决④（300 / 1000），不重新发明**。常数 `MODE_THRESHOLD_LITERAL` / `MODE_THRESHOLD_VECTOR` 是台账原文的代码化；裁决改了只动这两行。
4. **混合检索的字面侧留在分支内部，不开服务键**。O-014 消费本插件（recall → vector 单向）；若本插件再去消费 O-014 的倒排就是环。字面侧只是 ~40 行的 bigram 包含率，够混合融合用，多余的 BM25 / IDF 都是越界。
5. **IVF 用确定性 k-means（固定步长采样初始化）**，不用随机初始化——同一批文档永远同一套桶，重启不漂、对拍可复现。桶数上限 64，探桶默认 3。
6. **持久化是尽力而为，内存索引才是真源**。存储端口（O-006 / O-007 / O-121 三后端通用）写失败只记 `lastError`，绝不因持久化失败让检索挂掉。

---

## 5. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | **`false`** | 总开关。台账第 16 组：默认分支「否（倒排默认）」 |
| `mode` | string | `auto` | `auto / literal / hybrid / vector`；钉死某档用于调试与对拍 |
| `auto-sync` | boolean | `true` | 装载时从记忆内核同步一次全量索引 |
| `persist` | boolean | `true` | 索引持久化到存储端口；缺席时纯内存 |
| `ann-probes` | number | `3` | IVF 探桶数（1–64），多探更准、更慢 |
| `verbose` | boolean | `false` | 读数与同步打一行日志 |

---

## 6. 多方案分支（手册 §12）

| 项 | 内容 |
|---|---|
| 所属多方案 | 记忆检索三方案：2-gram 倒排 + 时间半衰（默认）/ 向量（bge-m3 1024 维）/ 混合 BM25+向量+重排 |
| 本插件位置 | **向量 + 混合分支**（混合在向量分支内提供，符合 §12.3 登记行的安排） |
| 底座 | O-014 `ondra-memory-recall`（倒排默认，一个字节不改） |
| 分支间共享 | **无**。不共享缓存、不共享倒排索引、不共享打分器 |
| 独立降级 | 内核缺席 → 空索引 + 手动喂；存储缺席 → 纯内存；嵌入失败 → 该路返回空 + `lastError` |
| 可观测 | `stats()` / `mode()` 全暴露，供 `ondra-startup-check` 与界面读，不黑箱切换 |

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。O-014 的探测看到服务缺席，语义因子退出归一化，四因子照跑；默认就是关的。
2. **我的状态存在哪？** 内存索引（`docs` Map + 向量池）；`persist: true` 时镜像到存储端口的 `vector_doc` 表（id / text / fp / dim / vec / updated）。**原文会进存储端口**——它本来就在记忆内核里，本插件不新增暴露面。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.memory-vector`；`stats().lastError` 给最后一次错误；`available + reason` 区分「关了」「内核缺席」「嵌入器坏了」。
4. **我依赖谁？缺席时怎么降级？** `ondra-memory-core`（软，缺席→空索引手动喂）、存储三后端之一（软，缺席→纯内存）、`ondra-identity`（软，只影响日志名）。全缺席时服务照常注册，`search()` 返回空。
5. **我和同域的谁共享了可变状态？** **没有**。只读内核；与 O-014 的唯一交点是「它消费我的 `search()`」，单向、经服务键、无 import。

---

## 8. 已知限制（诚实清单）

1. **哈希嵌入不懂语义**，只抓字符 bigram 共现。同义词、转述、跨语言召回需要真向量模型——通过 `setEmbedder(embedder)` 注入（`EmbedderLike.embed(texts) => Float64Array[]`），注入后全量重嵌；**没有**配置项式接入，因为仓内没有可确认的 embedding 服务键，编造一个就是 `not-available` 陷阱。
2. **IVF 是近似召回**：探 3 桶可能漏掉落在冷门桶里的相关条目。精度敏感的场景把 `ann-probes` 调大，或 `mode: 'hybrid'` 钉死（hybrid 的向量路是暴力精确的）。
3. **k-means 初始化是固定步长采样**，聚类质量低于 k-means++；对「分桶加速」够用，不是学术级实现。替换计划：sqlite-vec（手册 §11.5 预案）或外部嵌入器 + hnsw。
4. **`sync()` 是全量拉取**（分页 500 行、保险丝 10 万行）。记忆内核在数十万条量级时同步会慢——那是 O-010 该提供增量游标的事，本插件不越界替它设计。
5. **模式切换的滞后**：`auto` 按当前索引条数实时判定，跨阈值时检索路径会变（300 / 1000 两处）；对拍与回归测试建议钉死 `mode`。

---

## 9. 技术来源

| 项 | 档位 | 依据与借鉴点 |
|---|---|---|
| 三档阈值（300 / 1000） | 〔复〕 | 台账第 16 组裁决④原文逐字；代码化为两个常量 |
| RRF 融合（k=60） | 〔研〕 | O-014 的 `rrfFuse` 已实现同一算法；本分支**自写一份 ~20 行副本**（跨包 import 被禁止、成环），`HYBRID_RRF_K` 注释锚定与 O-014 的 `RRF_K` 同源同步 |
| 字符 n-gram 哈希投影（hashing trick） | 〔研〕 | 机制来自特征哈希的标准做法（sklearn `HashingVectorizer` 同思想）；参数（单字权 1.0 / 二元权 0.7、FNV-1a、L2 归一化）为本仓工程取值；代码自写 |
| IVF / k-means 分桶 | 〔研〕 | 机制来自向量检索通用做法（Faiss IVF 同思想）；确定性初始化为本仓自定；README 登记**临时自研 + 替换计划**（sqlite-vec / hnsw） |
| bigram 包含率（字面侧） | 〔研〕 | O-014 的 `searchBigram` 已有同思想；本分支为避免成环自写极简版，刻意不带 BM25 / IDF（那是 O-014 的职责） |
| bge-m3 真向量模型 | 〔复·待接入〕 | 手册 §9.8 登记 1024 维；本插件留 `EmbedderLike` 端口，禁装依赖期间不引入 |

**为什么不是〔复〕**：可复用的「记忆底层检索」已被 O-014 / O-010 吃掉；本插件剩下的全部内容是「无依赖环境下的向量语义分支」，生态里没有零依赖、确定性、可嵌入 Cordis 生命周期的现成实现，故按台账标〔研〕。

---

## 10. 文件清单（13）

```
package.json          # ondra.bundle.patch → ./cordis.patch.yml（漏了插件永远不加载）
tsconfig.json         # NodeNext + strict + declaration
cordis.patch.yml      # insert 带 id：目标须为 group
src/index.ts          # name / apply / Config；enabled=false 默认不注册
src/types.ts          # 契约 + 阈值常量（唯一真源）+ 三后端结构对位子集
src/embed.ts          # 确定性哈希嵌入 + 余弦 + 指纹（无 ctx，纯函数）
src/literal.ts        # bigram 包含率 + RRF 融合（无 ctx，纯函数）
src/ann.ts            # IVF-lite：确定性 k-means 分桶 + 探桶检索
src/service.ts        # 门面：索引持有、三模式分派、同步、持久化
locale/zh.json        # meta.title / meta.description
locale/en.json
icon.svg              # 由 tools/sync-plugin-icons.mjs 从根 icon.svg 生成
README.md
```

---

## 11. 快速上手

```yaml
# cordis.yml（节选）——语料过了 300 条、字面召回开始丢同义改述时再打开
- id: ondra-memory-vector
  name: ondra-memory-vector
  config:
    enabled: true          # 默认 false
    mode: auto             # <300 字面 / 300–1000 混合 / >1000 向量+ANN
    auto-sync: true
```

```ts
// O-014 已经这样消费本插件（无需任何改动）：
const vector = ctx.get('ondra-memory-vector')
if (vector?.available === true) {
  const hits = vector.search('她上次说想去看海', { limit: 20 })
  // hits: { id, score }[]，score 0–1，语义因子随后参与 O-014 的五因子归一化
}
```
