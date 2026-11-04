# ondra-grow · 养成

> 台账 O-097（第 17 组 · L9 扩展池，B13 批次）｜档位〔研〕自研｜**默认开启**（只读派生，开着无副作用）

**一句话：把「相处天数、互动次数、活跃记忆条数、关系阶序」这四项已经存在的读数，翻译成「她跟你走到哪一步了」的一句话，并给一个不含任何数字的下一步方向。**

---

## 1. 它到底做什么

```
O-031 关系四维 ──┐
                 ├─→ 归一化（各自除以目标值，夹到 0–1）
O-010 记忆条数 ──┤        ↓
                 │   加权和（.35 / .25 / .25 / .15）
O-003 时钟 ──────┘        ↓
                      里程分 0–1 → 五档 → 一句人话
```

| 档位 | 里程分下限 | 中文名 | 一句话 |
|---|---|---|---|
| `sprout` | 0 | 萌芽 | 刚开始。她还在认你的说话习惯。 |
| `bud` | 0.2 | 抽枝 | 有来有往了，她开始主动提起几天前的事。 |
| `leaf` | 0.4 | 成荫 | 日常已经成型，她记得你不吃什么、几点犯困。 |
| `bloom` | 0.65 | 开花 | 攒下的东西开始互相咬合，旧事能翻出来接上。 |
| `fruit` | 0.85 | 结果 | 长期经历沉淀成稳定底子，换话题也不会掉回陌生。 |

**档位名刻意不复用关系七阶**（敌意/试探/心动/占有/病态/献祭/落定）：那七个词带情绪与伦理含义，养成讲的是「一起走过多久」。同一档换两套词，应用外壳才能把两条放在一屏里而不打架。

### 四项因子与权重（`src/types.ts` 的 `FACTOR_WEIGHTS` / `FACTOR_TARGETS`，唯一真源）

| 因子 | 权重 | 满值分母 | 为什么是这个数 |
|---|---|---|---|
| 相处天数 | 0.35 | 60 天 | 与 O-031 落定阶的 60 天同口径，避免「养成满了、关系还没落定」的错位 |
| 互动次数 | 0.25 | 600 次 | 60 天里平均每天 10 次，是个「天天都聊」的量 |
| 活跃记忆 | 0.25 | 500 条 | 裁决⑧「180 天清理」下长期活跃用户的稳态量级 |
| 关系阶序 | 0.15 | 6 | 七阶最后一阶序号，直接除 |

> ⚠️ 这四组数字**手册无出处，是本插件的工程取值**（手册只写了「养成系统」四个字）。依据逐条写在上面的注释里，改动时请连同依据一起改。**刻意不做成配置项**——做成旋钮就一定会有人把「天数满值」改成 5，而「坚持才有养成感」这条产品口径就没了，界面上还看不出是配置改的。

---

## 2. 三条硬纪律

1. **不建第二套数值。** 养成最诱人的错误是单开一张 `growth_point` 表、每次对话 +3 分。那样立刻多出三个真源（关系四维 / 记忆条数 / 相处天数），读数会慢慢漂开，而且**界面上两处都说得通**，没人能判定哪个对。本插件只读不造，四项全部来自上游。
2. **不报分数、不报比例、不报「还差多少」。** 这是内感受铁律（P0 第 3 条）的同一条道理：一旦可量化，人就开始刷数据，而养成本来要的是「自然过日子」。`score` / `toNext` 留在结构里**只给应用外壳画进度条**，`hint` 里一个数字都没有。
3. **唯一的写只写「庆祝过没有」。** `user/grow.json` 里只存「哪几个里程碑庆祝过了」，**不存档位、不存分数、不存四项读数**。那份文件丢了最坏只是应用外壳重复播报一次「满三十天了」——养成进度绝不在这个文件里。

---

## 3. 服务键与契约

**服务键：`ondra-grow`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓仅本插件 provide。

`GrowService` 方法集：

| 方法 | 说明 |
|---|---|
| `view(at?)` | **只读**取快照：档位 / 里程分 / 四项明细 / 里程碑 / `fresh` / `missing` |
| `levels()` | 五档表（应用外壳画进度条分母用） |
| `milestones()` | 六条里程碑的判定条件 |
| `ack(ids, at?)` | **唯一写动作**：把一批里程碑标记为「已庆祝」，返回落盘是否成功 |
| `stats()` | 统计快照（含 `writeFailures` / `sources` / `computes`） |
| `available` / `reason` | 可用性与原因（`disabled` / `no-source`） |

```ts
const grow = ctx.get('ondra-grow')
if (grow === undefined) return           // 优雅降级：没有养成就不显示
const view = grow.view()
render(view.levelZh, view.levelDoc, view.score)   // 分数只进进度条
if (view.fresh.length > 0) {
  toast(view.fresh.map(m => m.zh).join('、'))     // 播报归应用外壳
  grow.ack(view.fresh.map(m => m.id))            // 播完立刻标记，避免重启重复播
}
```

---

## 4. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| 关系四维的增减、阶段判定与防跃迁四闸 | O-031 `ondra-emotion-stage` | 养成连 `adjust()` 都不镜像进契约——不许改关系 |
| 记忆的写入、寿命计算、召回排序 | O-010 `ondra-memory-core` | 本插件只 `countFacts({state:'active'})`，**不读正文** |
| 相处天数与互动次数的权威来源 | O-031 `ondra-emotion-stage` | 重算第三份纯属自找分叉 |
| 时间与时区 | O-003 `ondra-clock` | 缺席退回系统时间，并在 `missing` 里记一笔 |
| **渲染、三栏、设计令牌、主题、Toast、成长面板** | **应用外壳（`desktop/`）** | L8 界面 14 个插件已整批下线。插件只交结构化数据（`levelZh` / `score` / `fresh`），弹不弹、怎么弹归外壳 |
| 里程碑播报的时机与文案 | 应用外壳 | 本插件只说「哪几条刚达成」，不说「怎么庆祝」 |

---

## 5. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | **`true`** | 总开关。养成是只读派生，关掉后服务仍注册但 `available=false` |
| `celebrate` | boolean | `true` | 是否产出「刚达成、还没庆祝」的 `fresh` 列表。外壳不打算播报就关掉，免得白算 |
| `verbose` | boolean | `true` | 降级与上游缺席时打一行日志，只影响日志噪声 |

**刻意没有的配置项**：权重、目标值、档位阈值、是否读记忆——前三项是产品口径（见 §1），第四项是降级不是开关。

---

## 6. 降级与缺席（一张表说清）

| 缺席的上游 | 表现 | 用户看到 |
|---|---|---|
| `ondra-emotion-stage` | 天数/互动/阶序记 0，`missing` 加一项 | 进度条偏低，`hint` 指「多来找她说说话」 |
| `ondra-memory-core` | 记忆项记 0，`missing` 加一项 | 同上 |
| `ondra-clock` | 退回系统时间 | 无感（跨时区部署时可能差几小时） |
| `ondra-path-layout` | 状态只在内存 | 重启后里程碑可能重复播报一次 |
| 三项数据上游全缺 | `available=false`、`reason='no-source'` | 显示「数据还不够」 |

> 全缺时判「不可用」而不是硬算：四项全是 0 的「萌芽」毫无信息量，显示它等于告诉用户「你还没开始」，而真相是「读数服务没起来」。这两种情况必须能分开。

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。默认开启但零副作用；关掉后依赖 `ondra-grow` 的外壳面板拿不到服务，对话链完全不受影响。
2. **我的状态存在哪？** `user/grow.json`（O-002 区域内，0600，tmp + rename 原子写），只存「已庆祝里程碑」与最近庆祝时刻。路径服务缺席时只在内存。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.grow`；`stats()` 给出 `available` / `sources` / `writeFailures` / `computes`，`view().missing` 逐项点名缺了谁。
4. **我依赖谁？缺席时怎么降级？** 三项数据上游（阶段 / 记忆 / 时钟）+ 两项支撑（路径 / 配置）。**全部软依赖**，逐项降级见 §6；初始化任何一步失败都不抛错。
5. **我和同域的谁共享了可变状态？** **没有**。只读别人的服务和原子文件；唯一的写是自己那个可丢的 JSON。

---

## 8. 已知限制（诚实清单）

1. **档位阈值的 0.2 / 0.4 / 0.65 / 0.85 与四项权重全是工程取值**，手册未给。已在 §1 逐条写明依据，属可讨论项而非定论。
2. **「互动次数」的口径由 O-031 定义**（每次 `adjust()` 且带实际变化才 +1）。用户若从不触发关系变化，天数涨了但互动不涨，进度条会显得慢——这是上游口径，本插件不改。
3. **不区分「深度对话」与「随口几句」**。同为一轮互动，权重相同。做区分需要读正文或依赖 O-015 图谱，成本与隐私代价都更大，本轮刻意不做（登记为待裁决）。
4. **不做历史曲线**。只给当前快照，不记录每日分数。要曲线的话应由应用外壳定时采样后自行存，插件不维护第二份时间序列。
5. **`view()` 每次重算四项**。四项都是 `count` 级操作（不打表、不算分），比维护缓存安全得多；高频轮询（>10 次/秒）时应由外壳自己节流。

---

## 9. 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 养成/成长档位分档 | 电子宠物类养成（Tamagotchi 系、`ondra-pet` 生态） | —（生态共性，非单一仓库） | — | 「多因子加权 → 阈值分档」这一常见形态，以及「档位名与画面状态一一对应」 | 自研纯函数 `score.ts`（`factorOf` / `scoreOf` / `levelOf`），权重与分母带依据注释 | 否 |
| 关系阶段数据 | O-031 `ondra-emotion-stage`（本仓） | 本仓 `cordis/ondra-emotion-stage` | AGPL-3.0 | 只借「四维 + 阶序」的读数口径，不取 `adjust()` | 经服务键消费，结构对位镜像 `StageLike` | 否 |
| 记忆计数 | O-010 `ondra-memory-core`（本仓） | 本仓 `cordis/ondra-memory-core` | AGPL-3.0 | 只借 `countFacts({state})` 的查询口径 | 经服务键消费，结构对位镜像 `MemoryLike` | 否 |
| 原子状态写 | O-049 `ondra-onthisday` 的落盘纪律（本仓） | 本仓 `cordis/ondra-onthisday` | AGPL-3.0 | tmp + `rename` 原子替换、`0600` 收紧、坏存档退化成空状态 | 自写 `store.ts`（40 行），口径同源 | 否 |

**为什么是〔研〕而不是〔复〕/〔薄〕**：
- 生态里的养成数值系统都是**独立存档的第二套数值**（喂食加经验、经验升级），与本仓「四项读数全部已存在于别的插件、绝不新造」的前提**语义相反**。引入任何一套都要先把它拆掉重写，成本高于自写。
- 〔薄〕要求「有可用实现、只包一层适配」。这里没有可包的上游实现——「把四项已有的数翻译成一句话」这件事，生态里没有对应物。
- 台账第 17 组「来源方案：养成系统」未指定上游项目，本插件按 §11.2 逐条写明借鉴点与不引入代码。

---

## 10. 多方案分支（手册 §12）

| 项 | 内容 |
|---|---|
| 是否涉及多方案 | **否**。本插件是单一方案的只读派生层，无分支 |
| 与 O-031 的关系 | 只读消费，不提供替代分支 |
| 与 O-122 `ondra-memory-vector` 的关系 | 无。本插件不碰检索，只 `countFacts` |

---

## 11. 文件清单（13）

```
package.json          # ondra.bundle.patch → ./cordis.patch.yml（漏了插件永远不加载）
tsconfig.json         # NodeNext + strict + declaration
cordis.patch.yml      # insert 块自身不带 id，条目带 id → 追加根入口
src/index.ts          # name / apply / Config；inject 刻意不声明（依赖全软）
src/types.ts          # 服务键 + 五档表 + 里程碑表 + 权重/分母（唯一真源）+ 结构对位镜像
src/settings.ts       # FIELD_SPECS（默认值唯一真源）→ DEFAULT_CONFIG / SectionDecl / completeConfig
src/score.ts          # 纯函数：归一化、加权、分档、hint、里程碑视图
src/store.ts          # user/grow.json 读 / 归一化 / tmp+rename 原子写
src/service.ts        # Grow：view / levels / milestones / ack / stats
locale/zh.json        # meta.title / meta.description
locale/en.json
README.md
icon.svg              # 由 tools/sync-plugin-icons.mjs 从根 icon.svg 生成
```

---

## 12. 快速上手

```yaml
# cordis.yml（节选）
- id: ondra-grow
  name: ondra-grow
  config:
    enable: true          # 默认 true
    celebrate: true       # 不需要播报就关掉
```

```ts
// 应用外壳：把档位给面板、把分数给进度条、把 fresh 给提示
const view = ctx.get('ondra-grow')?.view()
if (view?.available) {
  panel.title = view.levelZh          // 萌芽 / 抽枝 / 成荫 / 开花 / 结果
  panel.body = view.levelDoc          // 一句话解释这一档
  panel.ratio = view.score            // 只用数字画条，不显示数字
  panel.hint = view.hint              // 不含任何数字的方向提示
}
```

---

## 13. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整 | 过（13 文件：7 必需 + `src/types.ts` / `src/settings.ts` / `src/score.ts` / `src/store.ts` / `src/service.ts` + `icon.svg`） |
| 2 | 清单合法 | 过（JSON 可解析、`ondra-*`、`type: module`、`main`/`types`/`exports`/`files` 齐、cordis 双声明、`ondra.bundle.patch` 在且文件真实存在） |
| 3 | 编译配置 | 过（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） |
| 4 | 入口契约 | 过（`name` 字符串 + `apply(ctx, config)` + `Config` 三字段全有默认值；不声明 `inject`——依赖全软） |
| 5 | 服务键唯一 | 过（`ondra-grow` 全仓仅本插件 provide） |
| 6 | 依赖可解析 | 过（五键 `ondra-emotion-stage` / `ondra-memory-core` / `ondra-clock` / `ondra-path-layout` / `ondra-config-schema` 均有提供方） |
| 7 | 无越界 import | 过（无 `from 'ondra-`） |
| 8 | 降级到位 | 过（每个 `ctx.get` 后均判空；`#readInput` 逐项 try/catch 转 0 + `missing`） |
| 9 | 交付物齐全 | 过（技术来源表 / 多方案说明 / 隔离五问齐） |
| 语言 1–5 | 括号配平 / 无残留半句 / `import type` 分清 / 无 TODO / UTF-8 无 BOM | 过 |
| 图标 | 与根 `icon.svg` 逐字节一致（`node tools/sync-plugin-icons.mjs`） | 过 |

> 判定由静态检查产出（只读 + JSON 解析 + 括号配平 + 服务键交叉核对），未执行 `tsc` / `build` / `pnpm install`（§16.3）。
