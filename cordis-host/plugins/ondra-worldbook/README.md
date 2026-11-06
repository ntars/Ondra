# ondra-worldbook（O-024）

空谷 Ondra 的**世界书选择器**。给一批候选条目 id，它按六层 token 预算把它们装成一段可直接进提示词的文本；装不下的**整条丢**，绝不截字。

- 服务键：**`ondra-worldbook`**（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）
- 档位：**〔研〕自研**（依据见「技术来源」）
- 层级：L2 人格域（PER），编号段 O-020 ~ O-025

## 职责

1. **六层硬分桶**：总 1600 token（L1 350 / L2 180 / L3 100 / L4 500 / L5 200 / L6 150）。每层独立计数，**差额不挪用**。
2. **撞限整条丢**：一层里装不下的条目整条丢弃，并逐条带原因报出（`over-budget` / `slot-lost` / `disabled` / `unknown` / `layer-skipped`）。
3. **常驻段 → 冻结前缀**：`constant: true` 的条目单独成段（`constantBlock()`），供对话层拼在会话开头不再重拼（手册 §8.5）。
4. **稳定序**：层内 `分数 → priority → 注册序号`；常驻段 `priority → 注册序号`（**不看分数**）。
5. **可替换的 token 口径**：默认按「中文 1.6 字/token、其余 4 字符/token」估算；`setMeter()` 是唯一替换口，O-036 装真分词器时调它，换完**重算全部条目**。
6. **文件导入**：从 `user/worldbook.json`（名字可配）加载；逐条校验，一条坏不连累其余。

## 明确不负责

- **不做关键词命中、不做递归展开**——归 `ondra-worldbook-scenes`（O-025）。本插件只回答「这批候选装得下多少」，不回答「哪些该被触发」。
- **不决定层义**。六层只有预算，没有名字（见「已知限制」）。
- **不做注入去重、不做已见记账**——归 `ondra-inject-dedupe`（O-142）。
- **不做字符↔token 的全局换算**。本插件的估算只服务自己的六层预算；跨插件统一换算归 O-036。
- **不改写、不摘要、不重排条目正文**。正文逐字进提示词，只把换行与连续空白折成一个空格（排版，不是改写）。
- **不在每轮都调的地方读盘**（§8.2 反模式②）。文件只在 `apply()` 与显式 `loadFromFile()` 时读。

## 服务契约（`WorldbookService`）

| 方法 | 说明 |
|---|---|
| `layers()` | 六层声明（id / order / label / budget），顺序固定 |
| `entries(filter?)` / `entry(id)` | 条目清单（可按层、来源、常驻、启用筛） |
| `register(input[])` | 逐条校验；同 id **拒收**（不静默覆盖） |
| `remove(id)` / `clear(source?)` | 删除 / 按来源清空 |
| `meter()` / `setMeter(fn?)` / `measure(text)` | 取、换、用量化口径 |
| `constantBlock()` | 常驻段（冻结前缀），按注册版本号缓存 |
| `pack(request?)` | 按六层预算打包，返回 `text / included / dropped / perLayer / digest` |
| `loadFromFile()` | 读 `user/worldbook.json` |
| `stats()` | 条目数、逐层数、常驻 token、1600/1480/120 三个数、计量口径、文件路径、版本号 |

`pack()` 是**纯函数式**的：同样的条目 + 同样的候选，任何时候调都得到同样的结果（含同样的 `digest`）。

## 配置

段键 `worldbook`（`CONFIG_SECTION_ID`）。默认值唯一真源是 `src/settings.ts` 的 `FIELD_SPECS`；`cordis.patch.yml` **刻意不写 config**。

| 键（段字段） | 默认 | 说明 |
|---|---|---|
| `enable` | `true` | 总开关。关掉后服务仍注册但 `available=false` |
| `worldbook-file` | `worldbook.json` | 落在 `user` 区；只允许单段文件名（含 `/`、`\`、`..` 一律回退默认） |
| `load-file` | `true` | 启动时从文件加载；文件不存在**不报错** |
| `include-headings` | `true` | 是否给每层加 `【世界书 · 第N层】` |
| `annotate-dropped` | `false` | 段标题是否写「另有 N 条未展开」 |
| `report-dropped` | `true` | 丢弃是否写日志（只报前 5 条，防刷屏） |
| `fit-policy` | `stop` | `stop` = 这层到此为止；`skip` = 跳过这条继续试下一条 |
| `cjk-chars-per-token` | `1.6` | **估算**：中文每 token 折几个字 |
| `ascii-chars-per-token` | `4` | **估算**：非中文每 token 折几个字符 |
| `max-entry-tokens` | `0` | 单条 token 上限，0 = 不限；超限整条拒收（不截断） |

世界书文件格式（`user/worldbook.json`）：

```json
{
  "entries": [
    { "id": "world-tide", "layer": "l1", "title": "潮汐历", "text": "……", "constant": true, "priority": 10 },
    { "id": "city-harbor", "layer": "l2", "title": "雾港", "text": "……", "slot": "place", "priority": 5 }
  ]
}
```

顶层也可直接是一个数组。字段缺失走默认，字段给错（如 `layer` 写错）**拒收并报 `bad-layer`**——「缺失」与「给错」是两条判定。

## 多方案分支说明（§12）

| 能力 | 方案 A（默认） | 方案 B | 处理方式 |
|---|---|---|---|
| 撞限之后 | `stop`：这层到此为止（手册「撞限整条丢弃」字面读法） | `skip`：跳过继续试（记忆注入的装箱制） | **参数化融合**：同一个实现 + 一个枚举，默认 A。理由：世界书条目常有先后依赖（先势力后冲突），捡小的塞会拼出自相矛盾的世界而看不出错 |
| 常驻段排序 | `priority` + 注册序号（稳定） | 按命中次数 | **只保留 A**。B 会让同一会话的前缀每轮都变，缓存命中率归零（§8.5），且现象只是「账单变贵」 |
| token 计量 | 内置估算 | 真分词器（O-036） | **兼容层**：`setMeter()` 换实现，不换接口；换完重算全部条目 |

## 边界与硬约束

1. **层义不猜**：只有 `l1…l6` 六个桶。手册只给了预算数字，一个字没说层名。
2. **1600 与 1480 两个数都保留**：350+180+100+500+200+150 = **1480**，余量 **120** 既不并进某一层、也不擅自把总量改成 1480。
3. **常驻照样占层预算**：不占的话「总 1600」就是空话，而超预算的现象是「模型开始忘事」，没人查得到是世界书撑爆的。
4. **同 id 不覆盖**：要换内容必须 `remove()` 后再注册。静默覆盖会制造「我改了文件、重启、没生效」这类查不出的事故。
5. **切字一律禁止**：只有「进 / 不进」。

## 隔离五问（§16.4）

1. **关掉我，谁受影响？** 只有世界书这一段提示词会消失；人格、记忆、对话编排都不依赖本插件的方法返回值。
2. **状态存在哪？** 条目**仅在内存**（`register()` 进来的）；持久化载体是用户自己的 `user/worldbook.json`，本插件只读不写。
3. **我崩了，界面怎么知道？** 日志命名空间 `ondra.worldbook`（有 O-001 时走 `loggerName('worldbook')`）；`stats()` 里 `available` / `reason` / `revision` / `constantOverBudget` 四个字段足以让面板说清「是没配、还是配错了」。
4. **我依赖谁？缺席时怎么降级？** `ondra-path-layout`（软，缺席则「只在内存里」，`stats().file` 为 `undefined`）、`ondra-config-schema`（软，缺席则退回插件实例配置）、`ondra-identity`（软，只用于日志命名空间）。三者全是 `ctx.get(...) ?? undefined` + 判空分支，无一硬依赖。
5. **我和同域的谁共享了可变状态？** 没有。与 O-025 的分工是「预算」与「触发」，O-025 只调 `measure()` / `layers()`，不共享任何集合。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 世界书（lorebook）分层与预算 | SillyTavern | github.com/SillyTavern/SillyTavern | AGPL-3.0 | 「条目带优先级、按预算装、装不下丢整条」的**机制思路** | 自研 `layers.ts`：六层硬分桶 + 三级稳定序 + 逐条丢弃原因 | 否（AGPL 只读思路，§12.3） |
| 装箱制预算 | ondra-chain | 生态插件（MIT） | MIT | 「拿预算往里装、按权重排序」的机制；手册 §2.6 逐字引用过它的原话 | 同上，但**默认取 `stop` 而非装箱制**（世界书与记忆的取舍相反，见「多方案」） | 否 |
| 前缀缓存三原则 | 手册 §8.5 的实测（5 会话 / 2001 请求 / 命中 99.3–99.6%） | — | — | 「稳定段冻结、只追加增量」 | 常驻段固定序 + `digest` 供上层判断前缀是否变化 | 否 |
| token 估算 | 业界常见口径（中文≈0.6–0.7 token/字） | — | — | 换算比例的**量级** | `meter.ts` 纯函数，比例可配、可整体替换 | 否 |

## 已知限制

1. **六层没有语义名**（待裁决①）。手册只给预算不给层名，本插件只认 `l1…l6`，层义由作者声明。裁决后只改 `layers.ts` 的 `LAYER_LABELS` 一处。
2. **总 1600 与六层之和 1480 不一致**（待裁决②）。两个数都是原文，本插件两个都报、余量 120 不挪用。
3. **token 是估算，不是分词**（待裁决③）。默认 1.6 字/token 是中间偏保守取值；真值只能由 O-036 提供，`setMeter()` 已留口。
4. **不读人设包内的世界书**。人设包里的 `references/scenes.md` 是**场景卡**，归 O-025；本插件只吃 `user/worldbook.json` 与运行时注册。
5. **没有「按 id 沉底」**：条目只有启用/停用，没有「这轮不用但下轮可能用」的中间态（那会变成第二套衰减，归记忆域）。
6. **不写盘**：`register()` 进来的条目随进程消失。要持久化由界面/组合包写 `user/worldbook.json`，本插件只读。

## 文件清单

```
ondra-worldbook/
├── package.json        # name / type: module / main / types / exports / files / ondra.bundle.patch
├── tsconfig.json       # NodeNext + strict + rootDir src + outDir lib + declaration
├── cordis.patch.yml    # 必需（漏了宿主只在 stderr 打一行，插件永不加载）
├── locale/en.json
├── locale/zh.json
├── README.md
├── icon.svg
└── src/
    ├── index.ts        # 入口：name / apply(ctx) / Config；配置段注册、文件加载、现状日志
    ├── types.ts        # 契约：服务键、六层与预算真源、条目/打包/统计类型、对位镜像
    ├── settings.ts     # 配置唯一真源：FIELD_SPECS / KEY_PAIRS / completeConfig
    ├── meter.ts        # 折叠、字符数、token 估算、指纹（纯函数）
    ├── layers.ts       # 六层分桶与排版（纯算术，不碰 ctx）
    ├── registry.ts     # 条目库：校验、注册、删除、文件加载
    └── service.ts      # 门面：可用性、常驻段缓存、打包、统计
```
