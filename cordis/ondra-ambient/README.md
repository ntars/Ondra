# ondra-ambient · 键鼠反应

> 一句话：**主人此刻在不在、手是不是在动——只回答到这个程度，然后决定「该不该出现」。**

**档位：〔薄〕薄封装**（master-plan §3.8）。包一层适配与护栏，不重写输入监听。

---

## 1. 一句话定位

把「在不在 / 手在不在动」翻译成**最低限度的存在感**，只给三态：

| 态 | 中文 | 含义 | 能不能接一句 |
|---|---|---|---|
| `quiet` | 别打扰 | 正忙着，或者什么都不知道 | 不能 |
| `near` | 在，但不用说话 | 有动静但不密、没停够，或者已经静默很久 | 不能 |
| `ready` | 可以接一句 | 密集做事之后**刚刚停下来**，且已稳定 | 能 |

它**不监听真实键鼠**（那要辅助功能授权，且是常驻监听，属应用外壳），只提供 `observe()`
端口由宿主/外壳喂事件，事件类型只有 `key` / `mouse` / `idle` 三类。

**事件里没有任何内容**：没有键值、没有坐标、没有窗口标题、没有应用名、没有输入法候选。
不是「先收下来不用」，而是**接口形状里就没有这些字段**——想加一个，得先改 `src/types.ts`。

### 四条裁决（写在类型里，不是写在文档里）

1. **反应态里一个数字都不给。** `Reaction` 与 `Snapshot` 都没有任何数值字段，
   连 `confidence` 都是枚举而不是概率。计数只出现在 `stats()`，那个方法的文档第一句
   就是「诊断用，禁止进台词」。理由很直接：只要有数字，它迟早会被某句台词直接念出来，
   而「你已连续敲了三千多次」不是关心，是把陪伴变成仪表盘。
2. **高频输入 → 更安静，不是更热闹。** 手飞快动的时候，是这个人最专注的时候，
   也是任何插话最刺人的时候。故密度一高只会往 `quiet` 走，**永远走不到 `ready`**。
   忙碌时打扰，是所有打扰里最典型的一种。
3. **空闲很久 → `near`，不是 `ready`。** 久不说话的人回来，第一句话该由「他回来了」
   决定，不该由「检测到空闲」决定。所以静默只会让状态停在 `near`；
   `ready` 的唯一来路是「密集输入刚刚停下来」这个**行为变化本身**。
4. **存档里没有按键明细。** 只有三个计数（`beats` / `bursts` / `ignored`）与两个时刻
   （最近一次输入、最近一次空闲声明）。**只存时刻不存字并不安全**：间隔序列足以让
   击键动力学反推出「打的是拼音还是英文」「打的是不是一串密码」。所以不存明细才安全。

## 2. 服务键与契约

服务键：`ondra-ambient`（连字符，匹配 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。

```ts
ctx.get('ondra-ambient')   // AmbientService | undefined
```

| 方法 | 签名 | 写盘 | 说明 |
|---|---|---|---|
| `observe` | `(event, at?) => Snapshot` | **是**（唯一写盘入口） | 记一次事件，返回快照 |
| `decide` | `(at?) => Reaction` | 否 | 只读裁决：现在该怎么对待我 |
| `snapshot` | `(at?) => Snapshot` | 否 | 只读快照：状态、来源、是否稳定 |
| `nudge` | `(at?) => Nudge` | 否 | 要不要冒个泡（**不产生台词、不发送**） |
| `stats` | `() => AmbientStats` | 否 | 运维计数，**禁止进台词** |

```ts
interface AmbientEvent {
  readonly type: 'key' | 'mouse' | 'idle'
  readonly at?: number
}

interface Snapshot {
  readonly state: 'quiet' | 'near' | 'ready'
  readonly stateZh: string
  readonly confidence: 'read' | 'none'
  readonly source: 'none' | 'busy' | 'settle' | 'idle' | 'steady'
  readonly settled: boolean      // 刚翻档的 5 秒内为 false，防临界点来回闪
  readonly measured: boolean     // 是否真的观测到过事件
  readonly stored: boolean       // 是否真的落盘
}

interface Reaction {
  readonly state: 'quiet' | 'near' | 'ready'
  readonly stateZh: string
  readonly confidence: 'read' | 'none'
  readonly maySpeak: boolean     // 只有 ready + read + settled 才为 true
  readonly reason: string        // 为什么是这一档（不含数字）
  readonly mustNot: readonly string[]   // 恒定五条，每一档都在
}

interface Nudge {
  readonly worth: boolean
  readonly state: 'quiet' | 'near' | 'ready'
  readonly reason: string
  readonly mustNot: readonly string[]
}
```

`source` 单列而不是折进 `state`：`quiet` 既可能是「正忙着」（该尊重），也可能是
「什么都不知道」（该降级），这两件事的处理方式完全相反，折起来就再也查不出来了。

`confidence` 只有 `read` 与 `none` 两档，**刻意没有「猜的」**：一旦允许猜，
就一定会有一次猜错被当成知道。

### 判定怎么走

```
不知道（没观测过）                        → quiet / none
最近一次信号是 idle 声明                  → near  / idle
最近 20 秒密度 ≥ busyPerMin               → quiet / busy
静默 ≥ idleSec                            → near  / idle
静默 ≥ settleSec 且 < settle+readyWindow
   且静默前 burstMinSec 内是密集的          → ready / settle
其余                                      → near  / steady
```

「静默前那一段是否密集」是 `ready` 的门槛：**没忙碌过，就谈不上「刚停下来」**。
空转一整天的手不会得到 `ready`，那正是它该得到的。

## 3. 明确不负责（逐条写归谁）

| 不负责的事 | 归谁 |
|---|---|
| 监听真实键鼠、辅助功能授权、常驻采集 | 应用外壳（`desktop/`）。插件不认识硬件，只接事件 |
| 连续使用时长、健康四档、休息提醒 | O-105 `ondra-digital-health`。本插件不读它的快照，也不复制它的阈值 |
| 什么时候开口、额度与静默时段 | O-042 / O-047 的六道闸。`nudge()` 只回答「要不要」，不代表「可以」 |
| 说什么话、什么语气、说不说 | O-020 人格 / O-037 九步过滤。本插件**一行台词都没有** |
| 主动发送消息 | O-042。本插件连一条能自己开口的路径都没有 |
| 屏幕上在做什么（类目判断） | O-109 `ondra-screen-sense`。那个问题需要读屏，本插件连字段都没有 |
| **渲染、指示器、Toast、主题、日志视图** | **应用外壳（`desktop/`）**。L8 界面插件已整批下线，永久不得再新建 `ondra-ui-*` |
| 日历与日界 | O-003 `ondra-clock`（`dayKey`）。本插件不自己用毫秒除一天 |
| 数据目录与权限 | O-002 `ondra-path-layout`（`fileIn('user', ...)`） |
| 默认值的四层合并与来源追溯 | O-005 `ondra-config-schema` |

## 4. 技术来源

### 档位判定

| 档位 | 定义 | 本插件 | 依据 |
|---|---|---|---|
| 〔复〕复用 | 直接接现成服务 | 否 | 线上没有「把输入事件翻成存在感」的现成服务；`ondra-screen-sense` 判的是**类目**，输入它不接 |
| 〔薄〕薄封装 | 包一层适配与护栏，不重写机制 | **是** | 采集属外壳（要授权），判定属插件（要可测试、要能降级）。本插件只做节流、密度、静默、三态与「什么不能说」 |
| 〔研〕自研 | 自研机制并对外提供 | 否 | 「怎么读键鼠」是平台 API 的事，自研只会绕开授权流程，是更差的路 |

**生态检索结论**：现成实现要么是**常驻守护进程 + 本地库**（ActivityWatch 的 watcher 体系），
要么需要**原生模块编译**（`active-win` 这类），两者都撞在「禁装依赖、禁常驻后台、
插件只接线」这三条硬约束上。故一律**只读思路、不引代码、不引依赖**。

| 能力 | 参考项目 / 依据 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|
| AFK 判定：以「一段时间没有新事件」为离开，而非以「关了窗口」为离开 | ActivityWatch `aw-watcher-afk` | MPL-2.0 | 用时间差判静默，不依赖事件钩子 | `decideOf()` 里 `silence >= idleMs` | 否 |
| 只统计「有没有输入」、不记录输入内容 | ActivityWatch `aw-watcher-input` | MPL-2.0 | 把「计数」与「内容」彻底分开的取舍 | `AmbientEvent` 只有 `type` + `at`，`store.ts` 只有三个计数 | 否 |
| 系统空闲计时器是权威（外壳的 `idle` 声明优先于本插件推算） | macOS `CGEventSourceSecondsSinceLastEventType`（平台 API，非开源项目） | — | 「别自己猜空闲，去问系统」 | `idle` 事件一到即照单全收，并把内存密度窗口清零 | 否 |
| 击键动力学的隐私风险（间隔序列可反推内容） | 公开研究结论（击键动力学方向） | — | 「不存明细」这条纪律的依据 | 存档只有三个计数与两个时刻，**没有间隔序列** | 否 |
| 前台窗口类目 | `active-win` | MIT | 只作为「为什么这件事不归我」的对照 | **不引入**：需原生编译，且类目判定归 O-109 | 否 |

> MPL-2.0 的纪律：**只读思路，不复制代码**。本包没有一个函数是从上述仓库搬来的，
> 也没有一个依赖。

## 5. 配置

| 字段 | 默认 | 区间 | 说明 |
|---|---|---|---|
| `enable` | `true` | — | 总开关。关掉后服务照常注册，`observe()` 抛 `disabled`，`decide()` 恒 `quiet` |
| `busyPerMin` | `90` | 20–600 | 判「密集」的每分钟事件数。越高越不容易被判成忙 |
| `settleSec` | `45` | 5–3600 | 停下后需静默多久才算「停稳」。**`ready` 唯一的来路** |
| `readyWindowSec` | `180` | 5–3600 | 停稳后可接话的窗口长度，窗口一过退回 `near` |
| `idleSec` | `600` | 5–3600 | 判「静默很久」的时长。只会得到 `near`（**自动保持 > `settleSec + readyWindowSec`**） |
| `burstMinSec` | `20` | 5–3600 | 一段输入要连续密集多久才算「在做一件事」。只影响诊断计数 |
| `cooldownMin` | `20` | 1–240 | 同一段窗口里两次「值得冒泡」之间的冷却 |
| `dailyNudgeCap` | `3` | 1–12 | 一天最多冒几次泡。再多就不叫「冒个泡」了 |

> **这些数从哪来**：master-plan §9 参数速查里**没有**「键鼠反应」这一组，故全部是
> 本插件的工程取值，依据写在 `src/settings.ts` 的 `FIELD_SPECS` 与文件头注释里
> （90 次/分 ≈ 正常打字 1.5 次/秒；45 秒 ≈ 打完一段停下来想一想；10 分钟与 O-105 的离开同量级）。

**`idleSec` 的约束是向上抬，不是向下压**：若「静默很久」短于「停稳 + 可接话窗」，
静默会先吃掉整个可接话窗口，三态就退化成两态，而 `ready` 正是这个插件存在的理由。
宁可让「静默很久」来得晚一点，也不能让它把「刚好停下来」盖掉。

### 没有的配置项（三条，都是刻意）

1. **没有「报不报次数 / 多久」。** `Reaction` 里没有数值字段，连开关的位置都不留。
2. **没有「忙碌时也说一句」。** `quiet` 不给 `maySpeak`；忙碌时打扰不该是可选项。
3. **没有「事件类型自定义」。** 事件是闭集，外壳只能填 `key` / `mouse` / `idle`。
   能新增就等于允许某个外壳把「应用名」当事件发进来。

另有一个**不可配**的常量：两条输入之间最小间隔 `EVENT_FLOOR_MS = 250` 毫秒
（`src/settings.ts`）。这是隐私线不是性能旋钮：全收下来就等于收了一份击键节奏。
写成配置，就等于允许把这条线调回去。

## 多方案分支（master-plan §12）

不涉及 §14 已裁决事项，也不做并存的多套实现：

- 输入事件的形状只有一个契约（`key` / `mouse` / `idle` 三类）。宿主有几个监听器、走哪条系统 API，本插件都不关心，也不需要按来源分支——它只吃归一化后的事件。
- 若将来出现「多种输入源」的差异，按 §12 的「能融就融」处理：把差异收进配置（阈值与冷却），而不是分成两套反应逻辑。两套反应逻辑必然分叉出两种「她什么时候该安静」的口径，这比功能少更糟。
- 本插件**没有**提供第二套阈值表，也没有第二种反应态命名。唯一真源是 `src/settings.ts` 的 `FIELD_SPECS` 与 `src/types.ts` 的三态枚举。

## 6. 已知限制（诚实清单）

- **事件质量由外壳决定，本插件无法验证。** 外壳若把每次 `keydown` 都送进来，本插件
  只能按 250 毫秒抽稀；抽稀后仍是「有节奏」的信息。真正的约束是**外壳先合并再送**
  （建议 ≤ 1 条/秒），这一条本插件管不到，只能写在契约里。
- **`idle` 声明照单全收，不做交叉验证。** 外壳若在刚有输入时声明空闲，本插件会立刻
  给 `near`。这是刻意的：系统空闲计时器比「用事件间隔推算」准，宁可听它的。
  代价是外壳若误报，本插件会跟着误判，且没有任何字段能表示「这次空闲可疑」。
- **密度窗口只在内存，重启后需要重新积累。** 进程刚起来的 20 秒内密度恒为 0，
  所以刚重启的一小段时间里不会因为「忙」而 `quiet`，可能给出 `near`。
- **`ready` 需要「静默前那一段是密集的」。** 若外壳只在人停下来时才送一个事件
  （不送连续事件），密度永远不达标，本插件**永远到不了 `ready`**，只会一直 `near`。
  这是保守的失败方向：想接话的人会发现她安静，而不是发现她乱说话。
- **`settled` 有 5 秒滞后。** 翻档后 5 秒内 `maySpeak` 为 `false`。若把
  `settleSec` / `readyWindowSec` 配到很短（如各 5 秒），可接话时间会被这 5 秒吃掉大半。
- **日上限依赖 O-003 的 `dayKey`。** 缺时钟服务时日上限退化为「进程内累计」，
  日志里会明说一句；重启会清空，于是理论上一天可能多冒几次。
- **`nudge()` 判为「值得」即视为建议已发出**，立刻进入冷却，**不需要 ack**。
  好处是外壳重复轮询不会连拿好几次 `true`；代价是外壳若丢弃了这次建议，冷却照样被消耗。
- **原子写只保证不读到半截。** 临时文件 + `rename` 不防同机多进程同时写同一份文件
  （后写的覆盖先写的）。本插件按「一个数据根一个进程」使用，不额外加锁。
- **`bursts` 计数不参与判定。** 它只是诊断值，口径是「密度从低跨到高、再到低」的一段；
  与 `decideOf()` 里「静默前密集」用的窗口不是同一个口径，两者数值不必相等。

## 7. 隔离五问（master-plan §16.4）

1. **会不会写别人的数据？** 不会。只写 `user/ambient.json` 这一个文件，
   路径由 O-002 的 `fileIn('user', ...)` 拼，不碰其他插件的数据根、不共享文件、不共用键。
2. **会不会自己开口？** 不会。`nudge()` 只回一个布尔 + 一句原因，**没有任何台词字段**；
   `decide()` 的 `maySpeak` 只是「这一刻适合不适合出现」。真要说话，必须由 O-042 的六道闸
   去取人格与语气——本插件连发送函数都不 import。
3. **卸载后留下什么？** 只留下 `user/ambient.json`（三个计数、两个时刻，200 字节量级），
   里面没有任何内容、没有窗口信息、没有间隔序列。删掉它不影响任何其他插件：
   本插件不 provide 别人依赖的东西，撤销靠 `ctx.effect` 的 disposer。
4. **缺依赖怎么降？** 四项全软依赖，见下表；任一缺席都能跑，只是降级，且降级处有日志。
5. **有没有第二个真源？** 没有。
   - 默认值唯一真源是 `src/settings.ts` 的 `FIELD_SPECS`（补丁里刻意不写 `config`）；
   - 状态唯一真源是 `user/ambient.json`（不做内存外副本，不写镜像文件）；
   - 日界唯一真源是 O-003 的 `dayKey`（不自己算日历）；
   - 时长与健康档唯一真源是 O-105（本插件不读、不算、不存）。

### 降级表

| 缺谁 | 表现 | 日志 |
|---|---|---|
| `ondra-identity` | 命名空间退回 `ondra.ambient` | `warn` 一行（装载时报一次） |
| `ondra-clock` | 时刻退回 `Date.now()`；日上限退化为进程内累计 | `warn` 一行（首次缺时钟 / 首次取不到日界时） |
| `ondra-path-layout` | **只在内存**，`stored=false`，重启后当成从没观测过 | `warn` 一行（首次写盘时） |
| `ondra-config-schema` | 只用插件实例配置，无四层合并与来源追溯 | `warn` 一行 |

## 8. 文件清单（12 个，不含 `icon.svg`）

| 文件 | 作用 |
|---|---|
| `package.json` | 清单；含 `ondra.bundle.patch`（宿主读这个键，漏了永远不加载） |
| `tsconfig.json` | NodeNext + strict |
| `cordis.patch.yml` | 入口补丁（`insert` 无 id → 追加根入口） |
| `locale/en.json` / `locale/zh.json` | 元数据标题与描述 |
| `src/index.ts` | 入口：解析配置、建服务、`provide` |
| `src/types.ts` | **契约唯一真源**（服务键、事件闭集、三态、视图、错误码、外部形状对位） |
| `src/settings.ts` | 配置唯一真源（`FIELD_SPECS` → 默认值 / 段声明 / 校验 / 口径换算） |
| `src/react.ts` | 判定核心（纯函数：密度、静默、三态、nudge） |
| `src/store.ts` | 读写存档（0600 + 原子替换，字段逐个写出） |
| `src/service.ts` | 服务实现（节流、落盘、冷却与日上限） |
| `README.md` | 本文 |

`icon.svg` 由 `tools/sync-plugin-icons.mjs` 从仓库根 `icon.svg` 复制，**不许手绘**。

## 9. 快速上手

```yaml
# cordis.yml（节选）
- ondra-ambient:
    busyPerMin: 90
    settleSec: 45
    readyWindowSec: 180
```

```ts
// 外壳侧：只送「有没有动」，不送任何内容
const amb = ctx.get('ondra-ambient')
amb?.observe({ type: 'key' })      // 或 { type: 'mouse' }
amb?.observe({ type: 'idle' })     // 系统空闲计时器触发了

const reaction = amb?.decide()
if (reaction?.maySpeak === true) {
  // 交给 O-042 的六道闸；本插件不负责任何发送
}

const nudge = amb?.nudge()
if (nudge?.worth === true) {
  // 同上：要不要说、说什么、什么语气，全在那边决定
}
```

## 10. 自检（§16.1 九项 + §16.2 语言五项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（7 必需 + 业务模块） | 过（12 文件；`icon.svg` 由主控统一刷写，本包不手绘） |
| 2 | 清单合法（JSON / `ondra-*` / `type: module` / 四字段 / `@ntars/cordis` 双处） | 过 |
| 3 | 编译配置（NodeNext / strict / rootDir / outDir / declaration） | 过 |
| 4 | 入口契约（`name` / `apply` / `Config` 每字段有默认） | 过（无 `inject`：全软依赖） |
| 5 | 服务键唯一（`ondra-ambient` 未被占用） | 过 |
| 6 | 依赖可解析（四个 `ctx.get` 键均有提供方） | 过 |
| 7 | 无越界 import（`from 'ondra-` 零命中） | 过 |
| 8 | 降级到位（每个 `ctx.get` 后均判 `undefined`） | 过 |
| 9 | 交付物齐全（技术来源表 / 隔离五问 / 已知限制） | 过 |

语言五项：括号配平 · 无残留半句 · `import type` 正确 · 无 TODO · UTF-8 无 BOM —— 全过。
