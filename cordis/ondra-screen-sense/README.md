# ondra-screen-sense · 屏幕感知

> 一句话：**她大概知道主人在跟什么东西打交道吗？** 只到「类目」这一级，且只在能说准的时候才说。

**档位：〔薄〕薄封装**（master-plan §3.8）。包一层适配与护栏，不重写感知机制。

---

## 1. 它到底做什么

外壳每次拿到一次「前台是什么类目」的判断，就调一次 `note({ category })`。本插件负责四件事：

1. **节流** —— 两次采样的最小间隔（默认 30 秒）。更密的采样只会把同一件事切成碎片，也更贵。
2. **抖动吸收** —— 一段类目存活不满抖动窗（默认 90 秒）就被换掉时，算「抖了一下」：
   不结束当前段，只把这次换手记进窗口。
3. **在场判定** —— 判出 `focused` / `wandering` / `scattered` / `idle` / `unknown` 五种状态之一。
4. **给一句或干脆不给** —— 只有「一件事持续做够久」且类目属于三类之一时才有一句台词。

九类目：`coding` `writing` `reading` `meeting` `media` `browsing` `gaming` `idle` `unknown`。

## 2. 五条硬纪律

1. **读不到 ≠ 人不在。** `unknown` 与 `idle` 是两个状态，判据也分开：
   只有「最近一次成功读数之后又来了一次读不到」才走 `unknown`。
   合成一个之后，没给权限的机器上她会永远以为自己被丢下了。
2. **读不到时 `dwellMs` 是 `null`，不是 `0`。** `0` 会被读成「刚切过来」，
   于是外壳会显示一份看起来很正常的「她刚坐下」。这是最难被发现的那类错误。
3. **抖动不切段。** 否则每次切窗口都换一次判断，她的观察永远慢一拍；
   更糟的是「散着」这个状态永远抓不到——因为每段都太短，短到没资格被判成任何东西。
4. **不认识的类目一律 `unknown`，不就近归并。** 就近归并会把「开会」并进「看东西」，
   于是会议中她照样开口——而那是最不该开口的场合。
5. **存档里没有一个字段能还原「主人在看什么」。** 只有时刻与计数。
   只要能还原画面，这个插件就已经不是在场感，而是监视器。

## 3. 服务键与契约

服务键：`ondra-screen-sense`（连字符，匹配 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。

```ts
interface ScreenSenseService {
  readonly available: boolean
  readonly reason?: 'disabled' | 'bad-request'
  readonly stored: boolean

  note(signal: ScreenSignal, at?: number): ScreenView   // 唯一写盘入口
  view(at?: number): ScreenView                          // 只读
  hint(at?: number): SenseHint                           // 只读
  reset(at?: number): ScreenView
  stats(): ScreenStats
}
```

`ScreenSignal`：

```ts
interface ScreenSignal {
  readonly category:
    | 'coding' | 'writing' | 'reading' | 'meeting' | 'media'
    | 'browsing' | 'gaming' | 'idle' | 'unknown'
  readonly at?: number
}
```

`SenseHint`（**`say` 里一个数字都没有**）：

```ts
interface SenseHint {
  readonly category: ScreenCategory
  readonly state: 'unknown' | 'idle' | 'scattered' | 'focused' | 'wandering'
  readonly confidence: 'read' | 'none'
  readonly say: string | null            // 只有 focused + 三个类目才非空
  readonly mustNot: readonly string[]    // 恒定四条
  readonly note: string                  // 为什么说 / 为什么不说
}
```

**只有这三个类目有台词**：`coding` / `writing` / `reading`。
`meeting` / `media` / `browsing` / `gaming` / `idle` / `unknown` 一律 `say: null`。

`confidence` 只有 `read` 与 `none` 两档，**刻意没有「猜的」**：
一旦允许猜，就一定会有一次猜错被当成知道。

### 与 O-110 的共享形状（§15.3 / §15.5）

`ScreenView` / `PresenceState` / `ScreenCategory` 的**唯一真源是本包的 `src/types.ts`**。
O-110 `ondra-dev-companion` 只做结构对位（字段同名、闭集同值），**不 import 本包源码**。
改一处要两边一起改。

## 4. 明确不负责

| 不负责的事 | 归谁 |
|---|---|
| 截屏、录屏、OCR、认画面内容 | 应用外壳（`desktop/`）与 O-126 `ondra-vision`；本插件真源里连图片字段都没有 |
| 连续使用时长、健康四档、提醒冷却 | O-105 `ondra-digital-health`（本插件只读它的 `sessionMinutes`） |
| 键鼠监听、辅助功能授权 | O-111 `ondra-ambient` |
| 什么时候开口、额度与静默时段 | O-042 / O-047 的六道闸 |
| 说什么话、什么语气 | O-020 人格 / O-037 九步过滤 |
| **渲染、三栏、设计令牌、主题、Toast、日志视图、成长面板、提示词预览** | **应用外壳（`desktop/`）**。L8 界面插件已整批下线并进废纸篓，永久不得再新建任何 `ondra-ui-*` 包 |
| 主动发消息 | O-042（本插件连一条能自己开口的路径都没有） |

## 5. 配置

| 字段 | 默认 | 区间 | 说明 |
|---|---|---|---|
| `enable` | `true` | — | 总开关。关掉后服务照常注册，`note()` 抛 `disabled`，`view()` 恒 `unknown` |
| `minIntervalSec` | `30` | 5–600 | 两次采样最小间隔 |
| `stabilitySec` | `90` | 10–900 | 抖动吸收窗 |
| `focusMin` | `12` | 1–240 | 判「在做一件事」的持续时长 |
| `idleMin` | `8` | 1–240 | 判「人不在」的空闲时长（**自动保持 > `focusMin`**） |
| `scatterSwitches` | `5` | 2–40 | 判「散着」所需的换手次数 |
| `scatterWindowMin` | `10` | 1–240 | 换手统计窗口 |
| `followSession` | `true` | — | 是否读 O-105 的时长；关掉则 `sessionMinutes` 恒 `null` |

> **这些数从哪来**：master-plan §9 参数速查里**没有**「屏幕感知」这一组，故全部是本插件的
> **工程取值**，依据写在 `src/settings.ts` 的 `FIELD_SPECS` 与文件头注释里。

`idleMin ≤ focusMin` 时**向下压**（压到 `focusMin + 1`）：如果「人不在」比「在做一件事」还短，
任何一段专注都会先被判成离开，于是她永远只有两句话——「你在忙」和「你走了」，中间那段没有。

## 6. 降级与缺席（一张表说清）

| 缺谁 | 表现 | 日志 |
|---|---|---|
| `ondra-identity` | 命名空间退回 `ondra.screen-sense` | 无（正常降级） |
| `ondra-clock` | 时间退回 `Date.now()` | 无（正常降级） |
| `ondra-path-layout` | **只在内存**，`stored=false`，重启后当成从没读到过 | 无（宁可安静，不谎称落盘） |
| `ondra-config-schema` | 只用插件实例配置，无四层合并与来源追溯 | `warn` 一行 |
| `ondra-digital-health` | `sessionMinutes` 恒 `null`（**不是 0**） | `warn` 一行（读取抛错时） |

## 7. 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。`hint()` 那一路消失，外壳拿不到 `say`，
   其余插件全部照常——本插件不 provide 任何别人依赖的东西。
2. **我的状态存在哪？** `user/screen-sense.json`（0600，临时文件 + `rename` 原子写）；
   缺路径服务时**仅在内存**。
3. **我崩了怎么知道是我崩了？** 日志命名空间 `ondra.screen-sense`（经 O-001 拼），
   `stats().lastIssue` 留一行中文原因，`stats().writeFailures` 单独计数。
4. **我依赖谁？缺席怎么降级？** 五项全软依赖，见 §6。
5. **我和同域的谁共享可变状态？** 没有。与 O-110 结构对位但零共享（不 import、不共用文件、不共用键）。

## 8. 已知限制（诚实清单）

- **类目由外壳给，本插件无法验证对不对。** 外壳把「开会」报成「看东西」，本插件照单全收。
  这是刻意的：能验证就必须看画面，那正是它拒绝做的事。
- **不认 `other`。** 外壳若发明新类目，`normalizeCategory` 会把它折成 `unknown`，
  于是她什么都不说。这是设计，不是 bug。
- **`handovers` 上限 64 条。** 连开三天的机器上，超限丢最早的——它们早已落在统计窗口外。
- **时钟回拨时**，`handoversWithin` 只数 `[now - 窗口, now]` 内的时刻，
  未来时刻不计，因此不会凭空判成「散着」；但回拨后的一小段时间内换手计数会偏低。
- **一次读不到会把之后的长沉默判成「读不到」而不是「人不在」。** 只要最近一次观测是失败读数，
  在下次成功读数之前状态就停在 `unknown`。这是刻意的保守：**不知道**比**猜错了**好，
  而「她不在」是最容易被猜错的那一个。
- **不写盘就等于没有历史。** 缺路径服务时每次重启都从 `unknown` 开始。
- **`say` 的三句台词写死在 `classify.ts` 的 `LINES` 里。** 外部 JSON 的第一件事
  就是被改松，而这里松一下，会议中就会说一句。

## 9. 技术来源

档位：**〔薄〕薄封装**。判断依据：机制（活动追踪 / 分类 / AFK 判定）在生态里已有成熟实现，
本项目不自研，只做接线、节流、抖动吸收与护栏；**不引入任何依赖、不复制任何代码**。

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 活动追踪的 watcher/bucket 结构与「本地优先、默认不上传」原则 | ActivityWatch | github.com/ActivityWatch/activitywatch | MPL-2.0 | 把「采集」与「归属」分开的分层思路；隐私默认值 | 自研 `classify.ts` 纯函数 + `store.ts` 本地 0600 存档 | 否 |
| AFK 判定（以「一段时间没有新读数」为离开，而不是以「关掉窗口」为离开） | ActivityWatch（`aw-watcher-afk`） | github.com/ActivityWatch/activitywatch | MPL-2.0 | 以时间差判定离开，而非事件驱动 | `presenceOf()` 用 `now - lastAt >= idleMs` 判定 | 否 |
| 前台窗口类目判定 | active-win | github.com/sindresorhus/active-win | MIT | 只取「前台是谁」，不取画面内容 | **不引入**：它是 Node 原生依赖、需编译，与「禁装依赖」冲突；类目改由外壳给 | 否 |

> MPL-2.0 的纪律：**只读思路，不复制代码**。本包没有一个函数是从上述仓库搬来的。
> `active-win` 的许可是 MIT（可引入），但**引入成本与禁用依赖冲突**，故只作参考。

## 10. 多方案分支（master-plan §12）

按 §12 的三条判定顺序，本插件走的是**第 1 条「融」**：

| 方案 | 能否融 | 处理 |
|---|---|---|
| 由外壳给类目枚举 | 能 | **采用**：唯一不碰画面的路 |
| 插件自己调视觉服务认屏幕 | 不能融 | **不做**：输入是图片地址，等于把画面落盘再外发（§17 未列，但违反「不截屏」这条定义性约束） |
| 插件自己截屏 + 本地分类 | 不能融 | **不做**：需系统权限与原生模块，属外壳；且插件无法承担权限说明义务 |

因为方案是互斥的「谁来看」问题，不是参数差异，故**不做 provider 分支**——
做成分支就等于允许把「插件也截屏」这条路重新打开。

## 11. 文件清单（13）

| 文件 | 作用 |
|---|---|
| `package.json` | 清单；含 `ondra.bundle.patch`（宿主读这个键，漏了永远不加载） |
| `tsconfig.json` | NodeNext + strict |
| `cordis.patch.yml` | 入口补丁（`insert` 无 id → 追加根入口） |
| `icon.svg` | 由 `tools/sync-plugin-icons.mjs` 从仓库根 `icon.svg` 复制，**不许手绘** |
| `README.md` | 本文 |
| `locale/en.json` / `locale/zh.json` | 元数据标题与描述 |
| `src/index.ts` | 入口：解析配置、建服务、`provide` |
| `src/types.ts` | **契约唯一真源**（服务键、类目闭集、视图、错误码、外部形状对位） |
| `src/settings.ts` | 配置唯一真源（`FIELD_SPECS` → 默认值 / 段声明 / 校验 / 口径换算） |
| `src/classify.ts` | 判定核心（纯函数，无 IO、无定时器） |
| `src/store.ts` | 读写存档（0600 + 原子替换） |
| `src/service.ts` | 服务实现（节流、落盘、读 O-105 时长） |

## 12. 快速上手

```yaml
# cordis.yml（节选）
- ondra-screen-sense:
    minIntervalSec: 30
    stabilitySec: 90
    focusMin: 12
```

```ts
// 外壳侧：拿到一次类目就报一次（不截屏、不传画面）
const sense = ctx.get('ondra-screen-sense')
sense?.note({ category: 'coding' })

const hint = sense?.hint()
if (hint?.say !== null && hint !== undefined) {
  // 交给 O-042 的六道闸，不在这里直接发
}
```

## 13. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（7 必需 + icon） | 过（13 文件） |
| 2 | 清单合法（JSON / `ondra-*` / `type: module` / 四字段 / `@ntars/cordis` 双处） | 过 |
| 3 | 编译配置（NodeNext / strict / rootDir / outDir / declaration） | 过 |
| 4 | 入口契约（`name` / `apply` / `Config` 每字段有默认） | 过（无 `inject`：全软依赖） |
| 5 | 服务键唯一（`ondra-screen-sense` 未被占用） | 过 |
| 6 | 依赖可解析（四个 `ctx.get` 键均有提供方） | 过 |
| 7 | 无越界 import（`from 'ondra-` 零命中） | 过 |
| 8 | 降级到位（每个 `ctx.get` 后均判 `undefined`） | 过 |
| 9 | 交付物齐全（技术来源表 / 多方案说明 / 隔离五问） | 过 |

语言五项：括号配平 · 无残留半句 · `import type` 正确 · 无 TODO · UTF-8 无 BOM —— 全过。
图标：与仓库根 `icon.svg` 逐字节一致（`sync-plugin-icons.mjs --check`）。
