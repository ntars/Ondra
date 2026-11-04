# ondra-avatar

> O-054 · L4 表达（第 10 组第 5 项）· 档位〔复〕 · 服务键 `ondra-avatar`

**把「脸上该是什么」解析成「该显示哪张图 / 哪个模型」。** 不渲染一个像素，不判一次情绪，不造一张图。

手册 §1.7 对 O-054 的裁决原话是「**不必自研**：airi（50.9k★）、ondra-whale-girl-live2d、ondra-pet、agentpet」，§13.2 链 D 给的形态是：

```
airi / ondra-whale-girl-live2d
  └─ Live2D Cubism / VRM 模型
       └─ 表情驱动 ← 情绪状态（Ondra 的 emotion-express）
```

本插件就是那条「表情驱动 ← 情绪状态」的**接线**。渲染在生态那一侧，本插件只负责把态翻成表情名、把素材路径交出去。

---

## 一、职责

| 能力 | 方法 | 说明 |
|---|---|---|
| 取一帧（推荐入口） | `frame(input?)` | 推进"上一帧"，`motion` 才有意义 |
| 只看上一帧 | `peek()` | 不推进任何东西（面板轮询用） |
| 纯解析 | `resolve(state, opts?)` | 不读上游、不记状态、不计统计 |
| 可用的图 | `assets()` | 按目录优先级去重，一个键最多一张 |
| 可用的模型 | `models()` | 只认 `.model3.json` / `.model.json` |
| 某态用哪张图 | `assetOf(state)` | 含兜底链 `neutral` → `default` |
| 最近一次扫描 | `lastScan()` | **不重扫**；含每个目录的"在不在 / 读不读得了" |
| 重扫 | `refresh()` | 上传 / 删除图之后调 |
| 注册渲染器 | `registerRenderer(spec)` | 返回撤销函数；**唯一对外接线口** |
| 统计 | `stats()` | 只在内存，进程重启归零 |

**一帧长这样**（`AvatarFrame`）：

```ts
{
  state: 'bristled',        // 六态之一（与 O-031 / O-052 同名同序）
  zh: '炸毛',                // 只给面板与日志
  source: 'text',            // text | state | default —— 决定能不能换脸
  expression: 'exp_anger',   // 渲染层用的表情名（live2d 有映射时用映射值）
  provider: 'static',        // static | live2d | none —— 此刻的能力
  asset: { key: 'bristled', path: '…/bristled.png', format: 'png', … },
  motion: 'switch',          // switch | hold —— 渲染方据此决定要不要重播动作
  since: 1762000000000,      // 这个表情从何时开始
  at: 1762000000500,
  degraded: ['asset-fallback'],
}
```

**目录约定**（一个表情一张图，文件名即键）：

```
~/.ondra/user/
├── avatar/                     ← 默认根（配置项 dir，只允许一层目录名）
│   ├── calm.png                ← 六态：joyful / soft / calm / wilted / bristled / sleepy
│   ├── joyful.webp
│   ├── neutral.png             ← 兜底：当前态没图时用它
│   ├── default.png             ← 第二兜底
│   └── whale.model3.json       ← Live2D 模型入口（可选）
└── personas/<personaId>/avatar/ ← 人设包自带（只读兼容层，**先查它**）
```

---

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 六态判定（雀跃 / 软和 / 平静 / 蔫 / 炸毛 / 困） | `ondra-emotion-express`（O-031）。本插件只读 `stateOf()` |
| 「正文 → 表情标记」 | `ondra-expression-decide`（O-052）。本插件只读 `mark.state` 与 `mark.source` |
| 渲染、动画、眨眼、呼吸、口型 | 界面层（L8）或外部 Live2D 运行时（airi / ondra-whale-girl-live2d） |
| 贴纸 | `ondra-sticker`（O-053） |
| 把图变成 URL、缩略图、预加载 | 应用侧的静态资源服务 |
| 什么时候说话、说多长 | 对话链（O-036~O-041）与闸门（O-051） |
| 记住"上次是什么表情" | 不记。表情是瞬时的，落盘会让"重启后她还板着昨天的脸" |

---

## 三、服务键与装载

- 服务键 **`ondra-avatar`**（连字符；符合 §8.4 `^[a-z][a-z0-9_-]{1,63}$`）。
- `package.json` 里必须有 `"ondra": { "bundle": { "patch": "./cordis.patch.yml" } }` 且**真的给出该文件**。
  漏了它，宿主只在 stderr 打一行 `declares no ondra.bundle`，**插件永远不加载**——这是最隐蔽的失败。
- 补丁是 `insert` 不带 `id` → 追加根入口。**不写 `config`**（默认值唯一真源在 `src/settings.ts` 的 `FIELD_SPECS`），**不写 `inject`**（七个依赖全软）。
- 装载期只做三件事：解析配置 → 扫一遍素材 → `provide` 服务并报现状。**不取帧**：此刻 O-031 可能还没起来，算出的「脸上是平静」会被当成结论，而它其实只是「那会儿还没装好」。

**依赖（全软）**：`ondra-emotion-express`（O-031）、`ondra-expression-decide`（O-052）、`ondra-path-layout`（O-002）、`ondra-persona-core`（O-020）、`ondra-config-schema`（O-005）、`ondra-clock`（O-003）、`ondra-identity`（O-001）。

> 台账 O-054 的依赖列只写了 `ondra-emotion-express`。实际还读 O-052 / O-002 / O-020 / O-005 / O-003 / O-001，已在台账补登记（**能力重复不算契约冲突**）。

---

## 四、配置

段键 `avatar`，七个字段。全部有默认值，非法值一律回退默认并记一条 `drift`。

| 键（camel / kebab） | 默认 | 范围 | 说明 |
|---|---|---|---|
| `enable` / `enable` | `true` | 布尔 | 关掉后服务照常注册，`frame()` 一律给"已关闭"的空帧 |
| `provider` / `provider` | `auto` | `auto` / `static` / `live2d` | 通道偏好 |
| `dir` / `dir` | `avatar` | 一层目录名 | 共享素材目录（相对 `user` 区域） |
| `usePersonaDir` / `use-persona-dir` | `true` | 布尔 | 先查人设包自带的 `personas/<id>/avatar/` |
| `minHoldMs` / `min-hold-ms` | `1200` | 0–10000 | 一个表情至少停留多久；0 = 不设下限 |
| `defaultState` / `default-state` | `calm` | 六态 | 既没线索也拿不到六态时的表情 |
| `verbose` / `verbose` | `true` | 布尔 | 换脸时打一行日志 |

`dir` **只允许一层相对目录名**：拒绝空串、绝对路径、`..`、路径分隔符、冒号、点开头。
理由不是洁癖——`path-layout` 的 `fileIn` 会把片段拼进数据根，一个 `../../etc` 就能把"素材目录"指到数据根外面。

---

## 五、四条口径（都对应一类静默故障）

### 1. `source` 决定能不能换脸，`state` 不能

O-052 的三种来源里，只有 `text` 表示「正文里有依据，可以换脸」。`state` 的语义是**脸上不动**——她可以心里平静、嘴上阴阳。

只看 `state` 字段的实现会得到"每句话都换脸"，而每句话都换脸 = 每句话都抖一下。所以本插件把 `source` 当一等公民，`motion` 由它算出来。

**优先级写死为：`mark.source === 'text'` > O-031 当前六态 > 配置默认。** 同一帧只认一个来源，`source` 字段显式说明是哪个。

### 2. `default` 来源不改变脸

`mark.source === 'default'` 表示一条依据都没有。此时**保持上一帧的态**，而不是回落成平静：没有依据不该让她的脸动一下。只有在没有任何上一帧时，才用上游给的态（或 `defaultState`）。

### 3. 最短停留挡的是"态变化"，不是"取帧"

被挡住时仍返回一帧（`motion: 'hold'`，`since` 保持原值），绝不返回空。返回空会让调用方退回自己的兜底逻辑，那时屏幕上的脸和面板上的态就对不上。

`since` 的语义是「**这个表情**从何时开始」：换脸时置为 `at`，保持时沿用上一帧。不能用 `at` 兜底——那样每一帧看起来都是"刚开始"，而"停留了多久"正是判断「她是不是闪了一下」的唯一依据。

**时钟回拨**（`at < previous.since`）单独处理：直接换脸并把 `since` 重置。若照常判「还没停够」，表情会永远 hold 住。

### 4. 显式 `provider` 也要能降级

钉死 `live2d` 但一个模型都没有时，**退回静态图**并记 `no-model` / `no-renderer`。台账对 O-054 的原话就是「只做接线与**静态降级**」；钉死就等于没有降级，这条能力等于没做。

顺位：`live2d`（有模型**且**有就绪渲染器）→ `static`（有图）→ `none`（都没有，给原因码）。
`reason` 的优先级：`no-path`（不知道目录在哪）> `read-error`（读不了）> `no-renderer` / `no-asset`。顺序反了会把「没装路径服务」报成「你没放图」，用户会去翻一个不存在的目录。

---

## 六、渲染器接线（Live2D 那一半）

```ts
const dispose = avatar.registerRenderer({
  id: 'airi',
  expressions: { joyful: 'exp_happy', bristled: 'exp_anger', sleepy: 'exp_sleep' },
  ready: true,
})
```

- **只有 `id` 必填**，其余可省。省了 `expressions` 就用六态英文名。
- 本插件**不 import 任何渲染库**，也不校验模型内容（`.model3.json` 的结构随 Cubism 版本变，而本插件不解析它）。
- 传不合规的 `id` 会**抛 `TypeError`**。这不是运行时数据而是代码调用，静默返回一个空 disposer 会让调用方以为接上了——症状是"接了 airi 但一直是静态图"，而日志里一个字都没有。
- `ready: false` 表示"注册了但此刻不能用"（模型还没下载完）：不参与选择，但仍在 `stats().registered` 里可见。

---

## 七、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| Live2D 立绘 + 表情驱动的完整链路 | `moeru-ai/airi` | github.com/moeru-ai/airi | **未核对**（本仓无副本、未读 LICENSE） | 「模型 → 表情驱动 ← 情绪状态」这条链的形状 | 只做**接线点**：`registerRenderer()` + 六态→表情名映射 | 否 |
| 鲸鱼娘 Live2D（ONDRA 网页版一条命令装） | `Andersen216/ondra-whale-girl-live2d` | github.com/Andersen216/ondra-whale-girl-live2d | **未核对** | 「立绘直接可用」的交付形态：模型目录 + 一个入口 json | 扫描 `*.model3.json` / `*.model.json`，交 `ModelRef` 给渲染方 | 否 |
| 桌宠/立绘不自研 | 手册 §1.7 第 130 行 | —（手册内） | — | 「O-054 avatar / O-074 pet 不必自研」 | 档位定〔复〕，一行渲染代码都不写 | 否 |
| 文件名即键、目录即索引 | `ondra-sticker`（O-053，本仓） | — | AGPL-3.0 | 不写清单文件、按文件名取素材、0 字节跳过 | 同一套扫描纪律（`src/scan.ts`） | 否（同仓同规则，未复制代码） |
| 六态集合与顺序 | `ondra-emotion-express`（O-031，本仓） | — | AGPL-3.0 | 雀跃/软和/平静/蔫/炸毛/困，不许增删改名 | `AVATAR_STATES` 与上游同序同名（表情按名字找文件） | 否 |

**档位判定：〔复〕。** 生态里已有成熟的 Live2D 实现（airi 50.9k★、ondra-whale-girl-live2d 直接可用），手册明确裁定「不必自研」。本插件只做三件接线的事：**读态 → 找素材 → 给帧**。任何"顺手写个渲染器"的冲动都是违规——那是把 50.9k 星的实现重写一遍，而且是重写一个本仓根本没有运行时依赖的版本。

---

## 八、多方案说明（§12）

**一处真正的多方案：显示通道。**

| 方案 | 来源 | 处置 |
|---|---|---|
| Live2D（airi / ondra-whale-girl-live2d） | 手册 §1.7 / §13.2 链 D | 分支：需要**模型 + 就绪渲染器**两个条件，缺一即降级 |
| 静态图 | 本插件默认 | 主通道，零依赖，最稳 |
| 无图 | 空态 | 给 `no-asset` 原因码，**不内置占位图** |

按 §12.1 的判定顺序：两者**不能融**（一个是实时渲染、一个是 `<img>`，机制不同），**能兼容**——所以做成"一个接口、每分支独立文件（`src/resolve.ts` 的通道判定）、默认选最稳（static）、独立降级（live2d 失败退回 static 而不是整块失效）"。

**不共享缓存、不共享定时器**：本插件一个定时器都没有，也没有缓存——`frame()` 每次现算（一次数组 `find`，代价可忽略），所以不存在"两条分支互相污染"的可能。

---

## 九、隔离五问

1. **独立服务键？** 是，`ondra-avatar`，全仓唯一。
2. **可独立启停？** 是，`enable=false` 时服务照常注册、`frame()` 给"已关闭"的空帧，界面能显示原因而不是白屏。
3. **独立失败域？** 是。读 O-031 抛错 → 折成 `no-express` 并保持上一帧；读目录失败 → `read-error`；注册渲染器失败 → 抛给调用方（编程错误），不影响服务本身。
4. **不横向 import？** 是。七个依赖全部走服务键 + 结构对位（`src/types.ts` 的 `*Like`），`from 'ondra-*'` 零处。
5. **不越界写？** 是。只读文件系统（`src/fs.ts` 一处 `node:fs`），不写任何文件、不建目录、不碰 `desktop/`。

---

## 十、已知限制

1. **Live2D 分支默认永不启用。** 本仓没有 Live2D 运行时包，也没有任何 `.model3.json` 素材（`desktop/packages` 全量 grep 零命中）。必须由外部注册渲染器，`registerRenderer()` 是唯一入口。这不是"没做完"，是〔复〕档的正确形态：机制在生态那边。
2. **不解析模型内容。** 只认文件存在与文件名；`.model3.json` 是否合法、贴图是否齐全，一概不验。
3. **只按扩展名判图片格式**，不读文件头。改扩展名能骗过扫描（渲染时才会发现）。
4. **不做多图轮转。** 一个表情一张图；同一态放多张只有文件名排序第一的那张生效，并记一条 issue。
5. **不提供图片的 URL / 缩略图 / 预加载。** 那是界面侧静态资源服务的事。
6. **不做贴纸、不做表情判定、不做六态。** 见第二节。
7. **`minHoldMs` 是自定参数**（手册全文没有"立绘停留""换脸间隔"这类条款）。
8. **未实装运行。** 本轮只写代码 + 静态自检，没有 `pnpm install`、没有 `tsc`、没有启动宿主。

---

## 十一、待裁决

1. `minHoldMs = 1200` 是否合适。取它的理由是手册 §9.2 的标点附加最长 500ms、长停顿 3000–9000ms——1200ms 是"一句话里不会被打断、又不会把下一句拖住"的量级，但这是**推断**，没有实测。
2. `neutral` / `default` 两个兜底文件名是自定的（手册没有）。
3. 一个表情要不要支持多张轮转（当前只认一张）。
4. `expression` 的默认键用六态英文名，是否要允许配置成别的（当前只能靠渲染器映射覆盖）。
5. 要不要给渲染层提供 idle 参数（眨眼频率、呼吸幅度）——当前完全没有，全归渲染层自理。
6. 「人设包自带立绘」的目录名 `avatar/` 是自定的（手册 §7.3 只规定了 `stickers/`）。

---

## 十二、自检记录（2026-11-02 第 48 轮）

共 14 个文件（7 必需 + `src/types.ts` / `src/settings.ts` / `src/scan.ts` / `src/resolve.ts` / `src/service.ts` / `src/fs.ts` + `icon.svg`）。

**九项机械自检**

| # | 项 | 结果 |
|---|---|---|
| 1 | 六文件齐（`package.json` / `tsconfig.json` / `cordis.patch.yml` / `src/index.ts` / `locale/en.json` / `locale/zh.json`），另加 `README.md` 与 `icon.svg` | 过 |
| 2 | 服务键 `ondra-avatar` 匹配 `^[a-z][a-z0-9_-]{1,63}$`、无冒号、全仓唯一（61 个 provide 键无重复） | 过 |
| 3 | `package.json` 有 `ondra.bundle.patch` 且 `cordis.patch.yml` 真实存在 | 过 |
| 4 | 补丁语义：`insert` 不带 `id`、入口字段仅 `id`/`name`、`name` 与包名一致、不写 `config` | 过 |
| 5 | `src/index.ts` 导出 `name` / `apply(ctx)` / `Config`；**不导出 `inject`**（七个依赖全软） | 过 |
| 6 | `ctx.provide` 包在 `ctx.effect` 内、返回 disposer；配置段注册同样走 `ctx.effect` | 过 |
| 7 | 插件形态：无 CLI、无 HTTP 服务、无常驻定时器、无 DOM、无前端工程 | 过 |
| 8 | 无 `import 'ondra-*'` 越界 import；无未使用导入；无显式 `any` | 过 |
| 9 | `Config` / `FIELD_SPECS` / `KEY_PAIRS` / `DEFAULT_CONFIG` 四集合相等；段键双向唯一；括号配平（去注释/字符串/正则） | 过 |

**语言五项**

| # | 项 | 结果 |
|---|---|---|
| 1 | 注释全中文（源码注释汉字量 > 500） | 过 |
| 2 | 标识符全英文（`Avatar` / `providerOf` / `minHoldMs` …） | 过 |
| 3 | 无外文口语混入（代码、命令、专有名词除外） | 过 |
| 4 | 源码无 emoji / 装饰符号（`★` 这类引用符号也换成了汉字） | 过 |
| 5 | 术语与上游一致：六态英文名与中文名与 O-031 同序同名 | 过 |

**交叉扫描三项**

| # | 项 | 结果 |
|---|---|---|
| 1 | 服务键闭合：本包消费 7 键（`ondra-clock` / `ondra-config-schema` / `ondra-emotion-express` / `ondra-expression-decide` / `ondra-identity` / `ondra-path-layout` / `ondra-persona-core`）全部有提供方 | 过 |
| 2 | 依赖图无环：全仓 61 节点 / 256 边，0 环 | 过 |
| 3 | 无越界 import：`from 'ondra-*'` 0 处 | 过 |

**纯逻辑复刻（Python，非实装）**：把 `providerOf` / `buildFrame` 的判定用 Python 重写一遍对拍，20 例全过（通道 10 例 + 组帧 10 例）。

首轮 3 例「不符」里，**2 例是业务代码的真问题、1 例是对拍用例自己写错**：

1. **`auto` + 零素材时错报 `no-renderer`**。原判定里 `!renderer` 直接给出「有模型但没有渲染器」，可用户一个模型都没有——他会去找一个根本不存在的渲染器。改成要求 `models > 0`。
2. **`auto` + 有模型但没渲染器 + 有静态图时一声不吭**。原判定只在钉死 `live2d` 时记 `no-renderer`，于是 `auto` 用户放了模型、看到的仍是一张静态图，日志里一个字都没有。改成**任何偏好下**都记。
3. 对拍用例把「没有 `neutral` 兜底」当成 `asset-fallback`，实际是 `no-asset`。改用例，未动业务代码。

> 既有悬空仍为 2 条（`ondra-memory-recognition` = O-141 未做、`ondra-memory-vector` 未立号），**本轮 0 新增**。
> 全仓 grep `avatar` / `立绘`，除本包外零命中——立绘职责没有第二个主人，无 §15.7 契约冲突。
