# ondra-emotion-hormone · 激素维度扩展

> 手册 §3.2 / §14.3｜台账 O-123（第 16 组 · 多方案分支）｜档位〔研〕自研｜默认**关闭**

**一句话：激素只读叠加——读得出、解释得清，一个字节都不写回情绪。**

---

## 1. 它到底做什么

把 O-026 化学池里的激素读出来，压成三个无量纲的量和一个倾向，供面板与解释使用：

| 量 | 含义 | 来源 |
|---|---|---|
| `load` | 应激负荷 0–1（只取上行） | 皮质醇相对基线的上行空间占比 |
| `drive` | 奖赏驱动 0–1 | 多巴胺相对基线的上行占比，基线取气质 `enthusiasm` |
| `bond` | 联结 0–1 | 催产素相对基线的上行占比 |
| `tilt` | 五档倾向：绷着 / 压着事 / 平稳 / 舒展 / 轻快 | 三个量按固定顺序判定 |

**它不是第二个心情值。** `overlay()` 里没有 `mood`、没有 `energy`、没有任何可写字段，
`applied` 的类型是字面量 `false`——「顺手写回去」在编译期就写不出来。

---

## 2. 服务键与契约

**服务键：`ondra-emotion-hormone`**（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。

```ts
interface HormoneService {
  readonly available: boolean
  readonly reason?: 'disabled'

  specs(): readonly HormoneDimSpec[]
  read(at?: number): HormoneRead              // 只读，不造维度
  overlay(at?: number): HormoneOverlay        // applied: false（字面量）
  bandOf(name: string, value?: number): HormoneBand
  explain(at?: number): readonly string[]
  ensure(names?: readonly string[], at?: number): EnsureResult  // 唯一写动作
  stats(): HormoneStats
}
```

配套类型：`HormoneDimSpec` / `HormoneDim` / `HormoneBand`(5) / `HormoneReading` / `HormoneRead` /
`HormoneTilt`(5) / `HormoneWeights` / `HormoneOverlay` / `EnsureResult` / `HormoneStats` /
`HormoneCounters` / `HormoneUnavailableReason`(1)。

维度表 `HORMONE_SPECS` 是**唯一真源**（4 行：cortisol / dopamine / oxytocin / serotonin）。

---

## 3. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| 持有激素数值 | O-026 `ondra-emotion-core` | 第二份数值就是第二真源，改一次参数会有一半不生效 |
| 造 `oxytocin` 的存储 | O-026 的动态激素通道 | 手册 §3.2 的 `inflict()` 就是为「现场造一种」设计的，用它才是复用 |
| 写 PAD / 改 mood / 改 energy | O-026 | 本插件 `EmotionLike` 结构对位里**刻意没有** `setAxis` / `feel` |
| 出提示词片段 | O-032 `ondra-emotion-project` | 文本出口唯一；O-029 已在皮质醇 ≥80 时出「你在应激」指令 |
| 判六态 / 判冲突锁 | O-031 / O-030 | 六态归表达层，锁归关系层；本插件只给「倾向」 |
| 判应激倍率 | O-029 | 它读的是同一批激素，但用的是另一套倍率口径 |

---

## 4. 关键裁决（八条，全部可在 diff 里复看）

1. **不持有任何激素状态。**
   台账写「与核心三维并存只读叠加」，最省事的实现是自己建一张 `hormone` 表存三列。
   那样做的直接后果是：O-026 的衰减、O-026 的 `sensitivity`、O-026 的存档全绕过去了，
   而界面上两处读数会慢慢漂开且不报错。故本插件**只读**。

2. **`oxytocin` 走动态激素通道，不新增字段。**
   O-026 出厂三激素是 `dopamine / cortisol / serotonin`，台账要的是 `cortisol / oxytocin / dopamine`。
   两个名字集合不一样是事实：台账用催产素，化学池用血清素。
   本插件不偷偷改 O-026，而是用它的 `inflict('oxytocin', 0)` 造一个「停在基线」的维度
   （通用参数 50 / 30 分钟，上限 12 种）。这是**复用已有机制**，不是绕过契约。

3. **`read()` 绝不写，`ensure()` 才是唯一写动作。**
   如果 `read()` 顺手把缺的维度造出来，「看一眼面板」就变成一次写库
   （O-028 踩过同一个坑：面板每秒刷新就是每秒一次写）。
   故 `read()` 只把缺失维按基线代入并标 `missing`；
   补造由 `ensure()` 显式做，`autoSeed` 只在 `apply` 时调一次。

4. **`serotonin` 单列为参考维度，不进叠加权重。**
   不读它，「压着一股气时整个人的底色也沉下去」解释不出来；
   算进主叠加，又会与台账的三激素口径打架。故只读、只展示、不参与 `weights`。

5. **档位用「占比」不用「绝对差」。**
   皮质醇涨 20 是翻倍，多巴胺涨 20 只是走了一小段。同一个 +20 在两维上分量完全不同。
   占比的分母**必须分段**（上行除以 `100 − baseline`，下行除以 `baseline`），
   否则基线 20 的皮质醇跌到 0 只算出 −0.2，「彻底放松」看起来像「稍微低一点」。

6. **只有皮质醇的两条档位边界有手册出处。**
   `aboveRatio 0.5` → 值 60（§3.8「60 → ×2」）、`highRatio 0.75` → 值 80（§3.8「≥80 → ×3」）。
   多巴胺 `0.5 / 0.8`、催产素 `0.4 / 0.7` 是工程取值，已登记待裁决——**没有伪装成有出处**。

7. **`notes` 不带数字、不带维度名、不带六态名。**
   三条都防同一件事：被人顺手塞进提示词。塞进去就是内感受铁律（§4.3）违规，
   而且日志里完全看不出来。要带维度名的详细版走 `explain()`（面板专用）。

8. **权重归一化时缺失维退出分母。**
   手册 §2.3：「归一化只除以参与权重的因子」。把缺失维按 0 计入分母，
   「只读得到两维」时三根柱子会一起矮一截，而没有任何报错。
   三维都贴在基线上时**均分 1/3**——全零会让下游除出 `NaN`，
   而「没有主导维度」本身是有意义的信息。

---

## 5. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | **`false`** | 总开关。台账第 16 组：默认分支「否（关闭）」 |
| `auto-seed` | boolean | `true` | 装载时用动态通道补造缺失主维（默认只补 `oxytocin`） |
| `include-serotonin` | boolean | `true` | 是否把血清素作为参考维度读出（只影响展示） |
| `verbose` | boolean | `false` | 读数与叠加打一行日志 |

**配置键用 kebab，Config 字段用 camel**：§8.4 的配置键正则不认大写。
`KEY_PAIRS` 是双向唯一映射，段声明 / 用户层归一化 / 结果回填三处全部由它派生。
用户写 `autoSeed` 或 `auto-seed` 都认。

**默认关闭不是保守，是口径纪律**：激素是核心三维之外的**可选增强**（§14.3）。
默认开着，六态、应激倍率、投影三处都会多一层解释，而用户从没要求过。

---

## 6. 多方案分支（手册 §14）

| 项 | 内容 |
|---|---|
| 所属多方案 | 情绪维度三方案：核心三维（§9.1）/ 激素 / 效价-唤醒二维 |
| 本插件位置 | **激素分支**，可选增强，默认关闭 |
| 底座 | O-026 的 PAD + mood/energy/tension（本插件一个数都不改） |
| 二维（valence-arousal） | **不在本插件**，属展示层派生 |
| 分支间共享 | **无**。不共享缓存、不共享定时器、不共享状态 |
| 独立降级 | 情绪服务缺席 → 出厂基线 + 平稳倾向，服务照常注册 |

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。面板少一层激素解释；六态、应激、投影全不受影响。
2. **我的状态存在哪？** **不存**。只有内存计数（读数次数、错误次数、补造过哪些维度），
   进程重启归零。激素值全部在 O-026 的池子里。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.emotion.hormone`；
   `stats().lastError` 给最后一次读数错误；`stats().available` + `reason` 区分「关了」与「没装」。
4. **我依赖谁？缺席时怎么降级？** 依赖 `ondra-emotion-core`（软）、`ondra-config-schema`（软）、
   `ondra-identity`（软）。三个全缺席时：读数给出厂基线、叠加给「平稳」、服务照常注册。
5. **我和同域的谁共享了可变状态？** **没有**。不写 O-026 的任何一维，只在 `ensure()` 时
   调它的公开入口登记一个停在基线的维度。

---

## 8. 已知限制（诚实清单）

1. **`oxytocin` 的语义没有手册出处**。手册化学池只有 `dopamine / cortisol / serotonin`，
   台账 §16 组写的是 `cortisol / oxytocin / dopamine`。本插件按台账取催产素，
   行为口径（「联结」）是工程判断，不是手册原文。裁决后只需改 `types.ts` 的 `HORMONE_SPECS` 一行。
2. **多巴胺 / 催产素的档位边界是工程取值**（0.5/0.8 与 0.4/0.7）。手册只给了皮质醇的 60 / 80 两条线。
3. **`load` 的上行线取 0.625**（= 值 70，血清素抽水线）。这条线「有出处但非专为 load 设计」，
   属于「借用相邻条款」，已在代码注释与本文登记。
4. **没有历史曲线**。`read()` 只给当前值，不存时间序列；要看曲线归 O-124 成长面板自己采样。
5. **`ensure()` 会消耗动态激素名额**。上限 12 种是 O-026 的硬口径，占满后 `refused` 非空，
   本插件不淘汰旧维度（手册：「不是怕她造，是不接受每有一点心事就发明一种情绪」）。

---

## 9. 待裁决（三条）

| # | 事项 | 当前执行 |
|---|---|---|
| ① | 台账三激素用 `oxytocin`，手册化学池用 `serotonin`——哪一个是产品口径？ | 按台账取 `oxytocin`，`serotonin` 作参考维度并存；改回只需改 `HORMONE_SPECS` |
| ② | 多巴胺 / 催产素的档位边界（0.5/0.8、0.4/0.7）无手册出处 | 工程取值，参数集中在 `HORMONE_SPECS` 两行 |
| ③ | 「只读叠加」是否应该给 Δ 建议（如「建议 mood −0.03」）？ | **刻意不给**。给了就是第二套情绪模型；若要，必须先改手册 |

---

## 10. 技术来源

| 项 | 档位 | 依据与借鉴点 |
|---|---|---|
| 化学池三激素参数（50/45、20/30、50/120） | 〔复〕 | 手册 §3.2 逐字给出，实读自旧项目 `genome.json`；本插件**只读**，不重写 |
| 动态激素 `inflict` + 通用参数（50 / 30min / 上限 12） | 〔复〕 | 手册 §3.2；O-026 已实现 `applyHormone` / `MAX_DYNAMIC_HORMONES`，本插件只调入口 |
| `y258dd/ondra-hormone`（GitHub，ONDRA 生态） | 参考 | 机制是「越阈值时往系统提示词写一句、值随事件升降、随时间衰减」。**借鉴**：阈值跨越才出话，不每轮刷；**不照搬**：它自持数值并自己注入提示词，与本仓「O-026 持有 / O-032 唯一文本出口」的分工冲突，故不采用其注入路径 |
| 档位用「占比」而非绝对差 | 〔研〕 | 本仓自定。绝对差不可跨维度（皮质醇基线 20、多巴胺 50），占比可共用边界 |
| 五档倾向 `strained/loaded/steady/bright/buoyant` | 〔研〕 | 本仓自定。手册只有六态与七阶，没有「激素倾向」这套词；刻意与六态**同名不同义**地错开（不叫雀跃/蔫/炸毛），防下游混用 |
| 只读叠加（`applied: false` 字面量） | 〔研〕 | 沿用 O-027「只出建议不落笔」的写法，把 C1 从注释变成类型 |

**为什么不是〔复〕**：生态里能复用的只有「激素数值怎么升怎么降」，而那部分已经由 O-026 实现。
本插件剩下的全部内容是**接线口径**（只读、不写、不注入、不产第二套心情），
没有可复用的库，故按台账标〔研〕。

---

## 11. 文件清单（13）

```
package.json          # ondra.bundle.patch → ./cordis.patch.yml（漏了插件永远不加载）
tsconfig.json         # NodeNext + strict + declaration
cordis.patch.yml      # insert 无 id → 追加根入口；刻意不写 config
src/index.ts          # name / apply / Config；配置段注册、延迟取值、补造
src/types.ts          # 契约 + 维度表（唯一真源）+ 宿主结构对位
src/settings.ts       # FIELD_SPECS（默认值唯一真源）+ KEY_PAIRS 双向映射
src/read.ts           # 纯读取：夹紧 / 占比 / 档位 / 权重（无 ctx）
src/overlay.ts        # 纯叠加：load/drive/bond/tilt/notes（无 ctx）
src/service.ts        # 门面：错误不外抛、计数、ensure
locale/zh.json        # meta.title / meta.description
locale/en.json
icon.svg              # 自包含几何：液滴 + 两道波
README.md
```

---

## 12. 快速上手

```yaml
# cordis.yml（节选）
- id: ondra-emotion-hormone
  name: ondra-emotion-hormone
  config:
    enable: true          # 默认关闭，要用才打开
    auto-seed: true
```

```ts
const hormones = ctx.get('ondra-emotion-hormone')
if (hormones?.available) {
  const view = hormones.overlay()
  // view.tilt → 'loaded'；view.load → 0.72
  // view.applied 恒为 false：它只是解释，不是状态
}
```
