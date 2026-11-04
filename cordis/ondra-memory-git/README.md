# ondra-memory-git · 记忆版本线

> 台账 O-099（第 17 组 · L9 扩展池，B13 批次）｜档位〔研〕自研｜**默认开启**（只读视图，开着无副作用）

**一句话：把「这条记忆现在在哪一步、上次被改了什么、那一刻的样子还找不找得回来」三件事讲清楚——不存第二份正文，也不假装有完整历史。**

---

## 1. 它到底做什么

```
O-010 memory_fact ──┐
                    ├─→ 阶段投影（sealed > archived > active）→ 「活跃/沉底/封存/已遗忘」
O-010 oldText/text ─┤
                    ├─→ 字符级 LCS → 最近一次订正的 diff（内存里算，不落盘）
O-009 snapshot ─────┤
                    └─→ 检查点标签：label → snapshotId（0600 原子写）
```

| 你能问的 | 调什么 | 拿到什么 |
|---|---|---|
| 它现在在哪一步 | `view(id)` | `stage` / `stageZh` / `depth` / `strength` / `remainingHours` / `preview` |
| 上次改了哪几个字 | `diff(id)` | `hunks`（equal/insert/delete 片段）+ `insertedChars` / `deletedChars` |
| 那一刻还留得下吗 | `tag('before-cleanup')` | 一份 O-009 真快照 + 一条 `label → snapshotId` |
| 回得去吗 | `checkout('before-cleanup')` | **只登记待恢复**；换库仍需人二次确认 |

### 能力上限写死在代码里：`CAPABILITY = 'latest-only'`

```ts
export const CAPABILITY = 'latest-only' as const
```

消费方**在编译期就能读到这个上限**，而不是先画完一条「历史时间轴」再发现只有两个点。

---

## 2. 四条硬纪律

1. **不存第二份正文。** 最诱人的做法是单开 `memory_version` 表，每次订正塞一份正文，于是就有了完整 `git log`。代价三条：①正文上限 200 字，逐版存 5 次就是 5 份，**隐私面按版本数线性放大**；②`text` 的真源在 `memory_fact`，版本表必然漂开且两边都说得通；③「被遗忘权」要删时得删每一版，**漏一版就是留了残留**——那就成了「说忘了其实没忘」。
2. **不做完整历史。** `MemoryRecord` 只有 `revisions` 计数与最近一份 `oldText`。要完整历史必须改 O-010 表结构，属「必须改上游」——按纪律应 `blocked`，不硬做。
3. **不做自动回滚。** 契约里**连 `restore()` 都不镜像**。`checkout()` 最多把待恢复票递到人手上，换库必须人经 O-009 的二次确认。让代码里根本没有那条路，比在文档里写「请勿自动调用」有效。
4. **不起子进程、不跑 git。** 禁装依赖；插件形态只允许 `apply(ctx)`。

---

## 3. 服务键与契约

**服务键：`ondra-memory-git`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓仅本插件 provide。

`MemoryGitService` 方法集：

| 方法 | 说明 |
|---|---|
| `stages()` | 四阶段说明书（活跃 / 沉底 / 封存 / 已遗忘，固定四条） |
| `view(id, at?)` | **只读**取版本视图：阶段 / 深度 / 强度 / 预览 / `hasPreviousText` |
| `diff(id)` | 最近一次订正的字符级差异。**纯函数调用**，不写库不落盘 |
| `tags()` | 检查点列表，`present` 每次现查（KEEP 轮转会删文件） |
| `tag(label, note?)` | 打检查点：**先 `snapshot.create()` 成功、才存标签** |
| `dropTag(label)` | 删标签，**不动快照文件**（快照归 O-009 的 KEEP） |
| `checkout(label)` | 把快照登记为待恢复。**不换库** |
| `stats()` | `capability` / `checkpoints` / `snapshots` / `viewed` / `diffed` / `failed` / `writeFailures` |
| `available` / `reason` | 可用性（`disabled` / `no-core`） |

```ts
const git = ctx.get('ondra-memory-git')
if (git === undefined) return                      // 优雅降级：没有版本线就不显示
const v = git.view(id)
if (v === undefined) return
renderStage(v.stageZh, v.depth)                    // 深度 = 订正次数 + 1
const d = git.diff(id)
if (d !== undefined) renderDiff(d.hunks)           // hunks 已合并同类相邻片段
// 打点归应用外壳的「清理前先打个点」按钮：
try { git.tag('before-cleanup', '准备整理旧记忆') } catch (e) { toast(e.message) }
```

---

## 4. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| 记忆的写入、订正、删除、封存 | O-010 `ondra-memory-core` / O-017 `ondra-memory-audit` | 契约里**不镜像任何写方法**——镜像一个，就一定会有人从版本线直接改库 |
| 真备份与换库（`VACUUM INTO` / `restore`） | O-009 `ondra-snapshot` | 本插件只存「标签 → 快照 id」。**连 `restore()` 都不镜像** |
| 快照文件的轮转与保留份数 | O-009 的 KEEP 策略 | `dropTag()` 删标签不删快照——跨插件删别人的备份是越界 |
| 寿命计算、强度、清晰度话术 | O-010 / O-013 | 全部直接读上游已算好的值，**一个 `Math.exp` 都不写** |
| 完整历史 / 逐版正文 / 回滚到任意版本 | **本插件不做**（`latest-only`） | 见 §2 第 1、2 条；要做得先改 O-010 表结构 |
| **渲染、三栏、设计令牌、主题、Toast、时间轴视图、差异高亮** | **应用外壳（`desktop/`）** | L8 界面 14 个插件已整批下线。插件只交结构化数据（`hunks` / `stage` / `depth`），怎么画归外壳 |
| 检查点该在什么时候打 | 应用外壳 / 人 | 本插件不装定时器：O-009 已有 KEEP 轮转，再装一个定时器会出现两套规则抢同一目录 |

---

## 5. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | **`true`** | 总开关。只读视图，关掉后服务仍注册但 `available=false` |
| `preview-chars` | number | `25` | 正文预览最多几个字（0–120）。清单要能扫，但不能变成第二个正文出口 |
| `diff-chars` | number | `400` | 差异最多比对多少个字符（50–4000）。设上限防超长记录卡住一次渲染 |
| `verbose` | boolean | `true` | 降级与上游缺席时打一行日志，只影响日志噪声 |

**刻意没有的配置项**：历史深度（表结构决定，做了就是假开关）、自动打检查点（与 O-009 的 KEEP 抢目录）、恢复前是否确认（硬纪律不是偏好）。

---

## 6. 降级与缺席（一张表说清）

| 缺席的上游 | 表现 | 用户看到 |
|---|---|---|
| `ondra-memory-core` | `available=false`、`reason='no-core'`，`view`/`diff` 返回 `undefined` | 显示「记忆服务还没起来」 |
| `ondra-snapshot` | 视图与差异**照常可用**；`tag()` 抛 `no-snapshot` | 能看版本与差异，打点按钮显示不可用 |
| `ondra-path-layout` | 标签只在内存 | 重启后标签丢失（快照文件仍在 O-009 目录） |
| `ondra-clock` | 退回系统时间 | 无感 |
| `ondra-config-schema` | 退回插件实例配置 | 无感 |

> `tag()` 在缺快照时**拒绝**而不是存个空 id：存假 id 会让 `checkout()` 到恢复那一刻才发现没用，而那时用户已经信了。

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。默认开启但零副作用；关掉后依赖 `ondra-memory-git` 的外壳面板拿不到服务，对话链完全不受影响。
2. **我的状态存在哪？** `user/memory-git.json`（0600，tmp + rename 原子写），**只存标签 → 快照 id + 备注 + 时刻**。不存正文、不存记录快照、不存阶段。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.memory-git`；`stats()` 给 `capability` / `failed` / `writeFailures`；`view`/`diff` 返回 `undefined` 本身就是「我这儿没有」的稳定信号。
4. **我依赖谁？缺席时怎么降级？** 记忆内核（硬，缺了判不可用）+ 快照（软，只影响打点）+ 路径 / 时钟 / 配置（软）。逐项见 §6；初始化任一步失败都不抛。
5. **我和同域的谁共享了可变状态？** **没有**。只读 O-010 的记录、只调 O-009 的 `create/list/stage`、只写自己那个可丢的 JSON。

---

## 8. 已知限制（诚实清单）

1. **只有最近一次订正的差异。** 更早的版本已被 O-010 覆盖（`oldText` 只留最近一份）。这是 `CAPABILITY = 'latest-only'` 的直接后果，不是缺陷。
2. **`depth` 是「改过几次 + 1」，不是「能读出几版」。** 前者能算，后者读不出来。界面上若把 depth 画成可点击的版本列表，那是错的。
3. **差异按字符而非按词。** 中文没有词边界，按字符在中文上恰好是对的；对英文会出现半个单词的片段（`hel` + `lo`）。记忆正文以中文为主，可接受。
4. **超长正文的差异会退化成「整体替换」。** 超过 `diff-chars` 或 LCS 单元格超 40 万时，返回「全删 + 全增」而不给逐字片段——返回一条假的分词结果比承认「这段没法逐字看」更糟。
5. **`present` 依赖 `snapshot.list()` 能读到。** O-009 缺席时全部显示 `present=false`，如实表示「不知道它还在不在」，不是「它不在了」。
6. **检查点不自动打。** 一切打点由人或外壳触发；本插件不装定时器（会与 O-009 的 KEEP 抢目录）。
7. **`checkout()` 只登记票，不做换库。** 换库本身必须人经 O-009 二次确认——这是设计，不是缺口。

---

## 9. 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 版本线语义（commit / tag / checkout 的心智模型） | git | git-scm.com | GPL-2.0 | **只借语义分层**：阶段对应工作区/归档，`revisions+1` 对应提交数，标签对应 tag，待恢复票对应 checkout 的「先登记再执行」 | 自研 `src/types.ts` 的 `CAPABILITY` / `MEMORY_STAGES` 与 `src/service.ts`；**不跑 git、不起子进程** | 否 |
| 字符级差异（LCS） | diff-match-patch | github.com/google/diff-match-patch | Apache-2.0 | 借「先求 LCS 再合并同类相邻片段」的思路，以及「超长输入退化而非硬算」的边界处理 | 自研 `src/diff.ts` 的 `lcsHunks()` + `mergeHunks()`，用 `Uint32Array` 一维表（不引依赖） | 否（仅思想参考） |
| 版本化存储与清理（vacuum / 快照轮转） | 直接复用 | — | — | **不复用实现，改为复用服务**：真备份与换库全归 O-009 `ondra-snapshot` | 本插件只存「标签 → snapshotId」映射 | 否 |
| 记忆记录与强度读数 | 直接复用 | — | — | 阶段位、订正计数、`oldText`、强度全来自 O-010 `ondra-memory-core` | 只读调用，不重算公式 | 否 |

**档位判定（master-plan §3.8）**：本项目标〔研〕。生态里有成熟的「版本化文件系统 / 文档历史」实现（git、SQLite session extension、各种 CRDT 历史库），但**没有一个是「记忆条目生命周期 + 标签绑定数据库快照」这套语义**——把它们引进来都要改 O-010 的表结构，而那正是本轮禁止的事。故判定：语义映射自研（薄），差异算法自研（可复用度最高但引入依赖被禁），存储与备份全部复用。

---

## 10. 多方案分支（master-plan §12）

按 §14.1 三条判定顺序处理，**不跳级**：

| 分歧点 | 处理 | 理由 |
|---|---|---|
| 「完整历史」vs「最近一次」 | **不分支，取最近一次**（`latest-only`） | 「完整历史」必须改 O-010 表结构；分支意味着两个 provider，其中一个要假装有数据。**留一个诚实的上限，比留一个半真的分支好** |
| 差异粒度：按行 / 按词 / 按字符 | **融合成一套参数化实现，取字符** | 按行在中文上会把「改一个词」判成整行替换；按词需要分词器（禁装依赖）。三者可用同一 LCS 实现，只换切分函数——**能融就融** |
| 快照来源：自己写 / 复用 O-009 | **复用 O-009，不分支** | 自己写 `VACUUM INTO` 就是第二套备份规则，必然与 KEEP 策略冲突 |
| 恢复方式：自动 / 人工确认 | **只做人工确认（且不镜像 `restore()`）** | 不可逆操作没有「自动」这个选项（§17-6 禁假开关，更禁真越权） |

**稳定优先**：`diff()` 在上游任何异常下都返回 `undefined`（不是空 diff），调用方能区分「没有上一版」与「算失败了」。

---

## 11. 文件清单（13）

| 文件 | 作用 |
|---|---|
| `package.json` | 清单，含 `ondra.bundle.patch` |
| `tsconfig.json` | NodeNext + strict + declaration |
| `cordis.patch.yml` | 宿主补丁：`insert` 无 id → 追加根入口 |
| `src/index.ts` | 入口：`name` / `apply(ctx)` / `Config`，注册配置段与服务 |
| `src/types.ts` | 契约唯一真源：服务键、四阶段、`CAPABILITY`、错误码、上游镜像 |
| `src/settings.ts` | 配置唯一真源（`FIELD_SPECS` → `DEFAULT_CONFIG` / `SectionDecl` / `completeConfig`） |
| `src/diff.ts` | 纯函数：阶段判定、预览截断、字符级 LCS、深度 |
| `src/store.ts` | 标签状态读写（0600，tmp + rename 原子写） |
| `src/service.ts` | 服务实现（只读 + 一张映射表的小写） |
| `locale/zh.json` / `locale/en.json` | 中文 / 英文元数据 |
| `README.md` | 本文 |
| `icon.svg` | 由 `node tools/sync-plugin-icons.mjs` 从根 `icon.svg` 刷成（唯一真源） |

---

## 12. 快速上手

```yaml
# cordis.yml（节选）
plugins:
  - ondra-memory-git          # 依赖 ondra-memory-core（硬）、ondra-snapshot（软，仅打点需要）
```

```ts
// 干净卸载：本插件不持有任何独占资源
// ctx.effect 会在卸载时自动撤掉配置段注册与服务 provide
```

---

## 13. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

本轮为**静态自检**，未 `pnpm install`、未 `build`、未 `tsc`、未启动 app。逐项结果见交付简报。
