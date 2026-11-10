# ondra-memory-heal · 记忆自愈

> 台账 O-100（第 17 组 · L9 扩展池，B13 批次）｜档位〔研〕自研｜**默认开启**（按需巡检，开着无副作用）

**一句话：把「记忆库里留下了什么不该留的东西」变成一份能照着核对的清单，并分三档说清「哪些能修、哪些要你点头、哪些压根不该我修」。**

---

## 1. 它到底做什么

```
O-010 listFacts/strengthOf ─┐
O-010 tombstoned ───────────┤
O-017 pinned/unpin/forget ──┼─→ 七类判定（纯函数）→ 三档分类 → 计划 → 逐项执行
O-017 scan().resurfaceDue ──┤                              ↑
O-012 scan() ───────────────┘                    必须 { confirm: 'repair' }
```

### 七类问题与三档（`src/types.ts` 的 `FINDING_SPECS`，唯一真源）

| 问题 | 档位 | 动作 | 说明 |
|---|---|---|---|
| `dangling-pin` 悬空钉子 | **auto** | `audit.unpin(id)` | 钉子指向的记忆已删。清掉不损失任何数据 |
| `tombstone-leak` 墓碑泄漏 | **confirm** | `audit.forget(id)` | 墓碑里有这段内容，库里还有活的同内容记录。**不可逆，必须点名** |
| `resurface-ghost` 待曝光幽灵 | advise | — | 下一轮扫描自动消失，不用动手 |
| `zero-strength` 强度归零仍活跃 | advise | — | 沉底归 O-010 的批量口（`archiveDue`），本插件没有「按 id 沉底」的接口 |
| `empty-summary` 无摘要 | advise | — | 摘要归 O-019 夜间重写 / O-011 提炼链 |
| `duplicate-group` 疑似重复 | advise | — | 合并归 O-012（它有 0.4 包含度口径与决策日志） |
| `pin-overflow` 钉子偏多 | advise | — | 手册口径 ≤8，超了只报告，删钉子由人定 |

> **`advise` 档在 `plan()` 里 `planned` 恒为 `false`**，`apply()` 收到它的 key 一律抛 `not-actionable`。这不是漏实现，是防止「自愈」变成「替别的插件干活」。

---

## 2. 四条硬纪律

1. **不做后台常驻自愈。** 插件形态只允许 `apply(ctx)`，§17 也不做常驻服务。巡检由人按需触发。装载期**刻意不跑巡检**——扫全库会拖慢启动，且那时上游可能还没就绪。
2. **不做无人确认的修复。** `apply()` 必须传 `{ confirm: 'repair' }`，少这道闸，「自愈」就变成了「无人复核地改记忆库」。
3. **不越权。** 摘要、合并、沉底三件事全部落 `advise`。自己写摘要会被当成产品资产抄进包里，且没人知道是机器写的；自己合会多出第二套判重口径。
4. **不直连表。** 全部修复经 O-017 的公开方法。直连 `memory_fact` / `memory_pin` 会漏掉 O-017 额外做的两件事（清钉子、清孤儿边）。

---

## 3. 服务键与契约

**服务键：`ondra-memory-heal`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓仅本插件 provide。

`MemoryHealService` 方法集：

| 方法 | 说明 |
|---|---|
| `specs()` | 七种问题的说明书（全量） |
| `diagnose(limit?)` | **只读**巡检：`findings` / `counts` / `complete` / `missing` |
| `plan(report?)` | 出计划：`items`（含 advise 档）+ `actionable` / `advisory` |
| `apply(keys, { confirm: 'repair' })` | 逐项执行，每项独立 try/catch；**执行前会重新巡检一次** |
| `stats()` | `diagnoses` / `findings` / `repaired` / `failed` |
| `available` / `reason` | 可用性（`disabled` / `no-core`） |

```ts
const heal = ctx.get('ondra-memory-heal')
if (heal === undefined) return
const report = heal.diagnose()
renderList(report.findings)                        // 已按 auto → confirm → advise 排序
const plan = heal.plan(report)                     // 复用报告，不重复扫
const keys = plan.items.filter(i => i.tier === 'auto').map(i => i.key)
if (keys.length > 0) {
  const out = heal.apply(keys, { confirm: 'repair' })   // 少 confirm 会抛 confirmation-required
  for (const item of out) if (!item.ok) toast(item.detail)
}
```

**为什么 `apply()` 要重新巡检**：人看完计划到点确认之间可能隔几分钟，这期间库可能已被别处改过。拿过期计划去修，会去动一条已经不存在、或已经不再有问题的记录。

---

## 4. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| 摘要的生成与重写 | O-019 `ondra-memory-dream` / O-011 提炼链 | 机器编的摘要会被人当成产品资产，且无法追溯来源 |
| 重复记忆的合并 | O-012 `ondra-memory-dedupe` | 建第二套判重口径必然与 0.4 包含度打架 |
| 按 id 沉底、归档窗口判定 | O-010 `ondra-memory-core` | 上游只有批量 `archiveDue()`，没有单个入口 |
| 记忆内容的订正 | 人 / O-017 `revise()` | 自愈不做内容改写：机器改的就没人认 |
| 孤儿边清理 | **本插件查不到**（见 §8 限制 1） | O-015 `GraphService` 没有「列举全部边」的入口 |
| **渲染、三栏、设计令牌、主题、Toast、体检面板、日志视图** | **应用外壳（`desktop/`）** | L8 界面 14 个插件已整批下线。插件只交结构化数据（`findings` / `counts` / `plan`），怎么画归外壳 |
| 什么时候巡检 | 应用外壳 / 人 | 本插件不装定时器（常驻自愈属违规形态） |

---

## 5. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | **`true`** | 总开关。只读巡检，关掉后服务仍注册但 `available=false` |
| `scan-limit` | number | `400` | 单次巡检最多翻多少条记忆（20–2000）。撞上限时 `complete=false`，**不静默截断** |
| `check-duplicates` | boolean | `true` | 是否顺带查疑似重复（它本来就只报告不合并） |
| `verbose` | boolean | `true` | 降级与上游缺席时打一行日志，只影响日志噪声 |

**刻意没有的配置项**：自动修复开关（`confirm` 档那些不可逆动作会被人顺手放过）、健康分公式（一旦有分数就开始刷分）、跳过某类问题（跳过等于把问题藏起来，面板会显示「0 问题」）。

---

## 6. 降级与缺席（一张表说清）

| 缺席的上游 | 表现 | 查不了的类 |
|---|---|---|
| `ondra-memory-core` | `available=false`、`reason='no-core'` | 全部七类 |
| `ondra-memory-audit` | 巡检照跑，`missing` 加一项 | 悬空钉子、待曝光幽灵、钉子偏多 |
| `ondra-memory-dedupe` | 巡检照跑，`missing` 加一项 | 疑似重复 |
| `ondra-clock` | 退回系统时间 | 无感 |
| `ondra-config-schema` | 退回插件实例配置 | 无感 |

> `missing` 不是摆设：它让体检面板能显示「这次只查了四类，因为审计服务没起来」，而不是让用户看着「0 问题」以为库很干净。

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。默认开启但零副作用——巡检只在被调用时发生；关掉后依赖 `ondra-memory-heal` 的外壳面板拿不到服务，对话链完全不受影响。
2. **我的状态存在哪？** **不落盘**。全部统计只在内存（`diagnoses` / `findings` / `repaired` / `failed`），进程重启归零。自愈没有需要跨重启保留的状态——巡检结论随时可以重算。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.memory-heal`；`stats().failed` 记每一类上游调用的失败次数；`diagnose().missing` 逐项点名缺了谁。
4. **我依赖谁？缺席时怎么降级？** 记忆内核（硬）+ 审计（软）+ 判重（软）+ 时钟 / 配置（软）。逐项见 §6；初始化任一步失败都不抛。
5. **我和同域的谁共享了可变状态？** **没有**。只读 O-010 / O-012，只调 O-017 的两个公开方法（`unpin` / `forget`），**不直连任何表**。修完之后库的变化全部归 O-017 的账。

---

## 8. 已知限制（诚实清单）

1. **查不了孤儿边。** O-015 `GraphService` 只给 `edgeOf(from,to,relation)` / `neighbors(id)` / `forgetOf(id)`，**没有「列举全部边」的入口**。要查孤儿边只能直连 `memory_link` 表，那是绕过服务边界，本插件不做。**这是本轮最大的能力缺口**，属「必须改上游」范畴（需 O-015 暴露 `listEdges()` 或 `orphans()`），已登记为待裁决。
2. **查不了归档窗口违例。** `archiveDue()` 是批量无差别动作，没有「查询哪些该沉底」的只读面。
3. **巡检是抽样而非全库。** 受 `scan-limit`（默认 400）限制；撞上限时 `complete=false`，清单不完整。库很大时应分批巡检或调高上限（上限 2000）。
4. **墓碑泄漏的判定依赖 `tombstoned(text)`。** 它按「去空白后的摘要」比对，所以**改了一个字的同内容记录查不出来**。这是上游比对口径，本插件不重算。
5. **钉子数量只看前 200 条**（`MAX_PINS`）。钉子本来该 ≤8，超到 200 说明库里已经乱了，那时数量本身没意义。
6. **疑似重复只报锚点，不列全部成员。** 清单要能扫；要看成员工界走 O-012 的 `scan()`。
7. **`apply()` 的复核是多一次扫描。** 库很大时这一步有成本。取舍：宁可慢一次，也不拿过期计划去删东西。
8. **不做「修完自动复检」以外的验证。** 修完后的库状态归 O-017 的 `scan()` / O-010 的 `stats()` 报，本插件不另建一套核对口径。

---

## 9. 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 引用完整性检查（外键孤儿 / 悬空引用） | SQLite `PRAGMA foreign_key_check` | sqlite.org | Public Domain | 借「先出清单、再逐项修、修前再核一遍」的流程；以及「孤儿行只能报告、删除要人定」的边界 | 自研 `src/checks.ts` 的 `danglingPinsOf()`；修复走 O-017 的 `unpin()` | 否（仅思想参考） |
| 存储自愈（scrub / repair） | ZFS scrub、`e2fsck` | openzfs.org / e2fsprogs | CDDL-1.0 / GPL-2.0 | 借「巡检与修复分离、修复前先出一份可核对的计划」这套两段式设计 | 自研 `diagnose()` / `plan()` / `apply()` 三段接口 | 否（仅思想参考） |
| 三档分级的动手术安全模型 | 数据库迁移工具（Flyway / Liquibase）的「可逆 / 不可逆 / 建议」分类 | flywaydb.org | Apache-2.0 | 借「无损操作可自动、不可逆操作必须点名、能力外操作只建议」的分档原则 | 自研 `REPAIR_TIERS` + `FINDING_SPECS.tier` | 否（仅思想参考） |
| 判重清单 | 直接复用 O-012 | — | — | **不复用实现，改为复用服务**：`dedupe.scan()` 只出清单 | 只读调用，不合并 | 否 |
| 钉子与四态删除 | 直接复用 O-017 | — | — | 钉住清单、清钉、忘记全归 O-017 | 只调 `pinned()` / `unpin()` / `forget()` | 否 |

**档位判定（master-plan §3.8）**：「记忆去重 / 衰减 / 存储维护」在手册里属**复用档**（生态有 344 个实现）。但生态里没有「**按 Ondra 的钉子表 + 墓碑表 + 四态删除语义**做一致性巡检」这种东西——引一个通用 DB 修复工具进来，它不认识 `memory_pin` 与墓碑的语义，会照通用规则删数据。故判定：**判定规则自研（薄），执行全部复用 O-017 / O-010 的公开方法**。这是「薄封装」的实质：本插件只贡献判据，不贡献机制。

---

## 10. 多方案分支（master-plan §12）

按 §14.1 三条判定顺序，**不跳级**：

| 分歧点 | 处理 | 理由 |
|---|---|---|
| 巡检时机：常驻定时 / 按需 | **只做按需，不分支** | 常驻自愈违反插件形态（§12.4 禁常驻服务）。留一个「定时开关」就等于留了一条违规路径 |
| 修复粒度：全自动 / 全人工 / 三档 | **融合成一套三档模型** | 三档本身就是对「全自动 vs 全人工」的融会贯通：无损的自动、不可逆的点名、能力外的建议 |
| 修复通道：直连表 / 经服务 | **只经服务，不分支** | 直连表是「必须改上游」的偷懒替代，会绕过 O-017 的清钉子与清孤儿边 |
| 健康度呈现：分数 / 清单 | **只出清单** | 分数会诱发刷分，且无法解释「为什么掉了一分」；清单能被人直接照着做 |

**稳定优先**：任何一类检查失败都只让该类跳过并在日志里记一笔，**不让整个巡检失败**——体检挂了一片红比「少查一类」更糟。

---

## 11. 文件清单（12）

| 文件 | 作用 |
|---|---|
| `package.json` | 清单，含 `ondra.bundle.patch` |
| `tsconfig.json` | NodeNext + strict + declaration |
| `cordis.patch.yml` | 宿主补丁：`insert` 无 id → 追加根入口 |
| `src/index.ts` | 入口：`name` / `apply(ctx)` / `Config`，注册配置段与服务 |
| `src/types.ts` | 契约唯一真源：服务键、七种问题、三档、错误码、上游镜像 |
| `src/settings.ts` | 配置唯一真源（`FIELD_SPECS` → `DEFAULT_CONFIG` / `SectionDecl` / `completeConfig`） |
| `src/checks.ts` | 纯函数判定层（七类 + 去重 + 排序 + 计数） |
| `src/service.ts` | 服务实现（巡检只读 + 修复需确认） |
| `locale/zh.json` / `locale/en.json` | 中文 / 英文元数据 |
| `README.md` | 本文 |
| `icon.svg` | 由 `node tools/sync-plugin-icons.mjs` 从根 `icon.svg` 刷成（唯一真源） |

---

## 12. 快速上手

```yaml
# cordis.yml（节选）
plugins:
  - ondra-memory-heal         # 依赖 ondra-memory-core（硬）；ondra-memory-audit / ondra-memory-dedupe（软）
```

```ts
// 干净卸载：本插件不持有任何独占资源，也不落盘
// ctx.effect 会在卸载时自动撤掉配置段注册与服务 provide
```

---

## 13. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

本轮为**静态自检**，未 `pnpm install`、未 `build`、未 `tsc`、未启动 app。逐项结果见交付简报。
