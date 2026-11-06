# ondra-dev-companion · 开发者陪伴

> 一句话：**主人正卡在一件事上，她该不该出声？出声说什么？**

**档位：〔研〕自研**（master-plan §3.8）。依据在 §9。

---

## 1. 它到底做什么

外壳报四个事实，它回一句话（或者一句静默）：

| 外壳说 | 它判什么 |
|---|---|
| `build-end` / `test-end`（带 `pass` / `fail` 与指纹） | 还在红？咬住了？红转绿了？ |
| `build-start` / `run-start` | 记个起点，不出声 |
| `run-end` | 五分钟内可以应一声 |
| `commit` | 记个数，不出声 |

四个调门：`quiet` / `companion` / `release` / `celebrate`。
**`quiet` 是正常结果，不是失败**，而且它带**六种可分辨的理由**。

## 2. 五条硬纪律

1. **失败后的安静期里一个字都不说。** 人在改代码，任何一句都是干扰。
2. **安静期跟着「还在红」这个状态，不跟着计时器。** 若按计时器算，一次二十秒就修好的失败
   会把随后那句「绿了呀」一并咽掉——而那正是最该说的。
3. **咬住了只说「先放下」，绝不说「再试一次」。** 催是索取，劝放下才是陪伴。
4. **只有红转绿才夸。** 从没红过的成功一句都不说：每跑一次测试都被夸一次，夸就贬值了。
5. **不报任何数字。** `DevCue` 里连一个数字字段都没有——不是「默认不报」，是**报不了**。

## 3. 服务键与契约

服务键：`ondra-dev-companion`（连字符，匹配 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。

```ts
interface DevCompanionService {
  readonly available: boolean
  readonly reason?: 'disabled' | 'bad-request'
  readonly stored: boolean

  note(event: DevEvent, at?: number): DevView   // 唯一会改判定的入口
  cue(at?: number): DevCue                      // 只读，不推进
  ack(tone: DevTone, at?: number): DevView      // 唯一会写台账的入口
  view(at?: number): DevView
  reset(at?: number): DevView
  stats(): DevStats
}
```

`DevEvent`：

```ts
interface DevEvent {
  readonly kind: 'build-start' | 'build-end' | 'test-end' | 'run-start' | 'run-end' | 'commit'
  readonly outcome?: 'pass' | 'fail' | 'unknown'
  readonly fingerprint?: string   // 不透明短哈希：判等用，不解释、不落盘、不打日志
  readonly at?: number
}
```

`DevCue`（**没有数字字段**）：

```ts
interface DevCue {
  readonly tone: 'quiet' | 'companion' | 'release' | 'celebrate'
  readonly say: string | null
  readonly mustNot: readonly string[]   // 恒定五条
  readonly suggestBreak: boolean        // 只在 release 为 true
  readonly reason: DevReason            // 十一种，安静也有六种
  readonly note: string
}
```

### 判定顺序（顺序本身就是纪律）

```
开关 → 在场门（会议 / 不在 / 读不到）→ 有没有事件
     → 还在红且未过安静期 → 咬住了 → 红转绿 → 长任务刚结束 → 什么都不说
```

### 与 O-109 的共享形状（§15.3 / §15.5）

`state` 的取值闭集与 O-109 `PresenceState` **完全一致**，但本包**不 import 它的源码**：
任一方单独卸载，另一方不该编译失败。`category` 只当一个字符串用，只跟 `'meeting'` 比——
枚举一份别人的类目，就是多一个会走样的真源。

## 4. 明确不负责

| 不负责的事 | 归谁 |
|---|---|
| 读代码、看 diff、点评实现、code review | 谁都不是——本插件不做，也不该有插件顺手做 |
| 编译 / 测试本身 | 外壳与 CI |
| 什么时候发、发给谁、额度与静默时段 | O-042 / O-047 的六道闸 |
| 说什么话、什么语气 | O-020 人格 / O-037 九步过滤 |
| 工作在不在开、人在不在 | O-109 `ondra-screen-sense`（本插件只读它的 `view()`） |
| 工时统计、连续使用时长、健康四档 | O-105 `ondra-digital-health` |
| **渲染、三栏、设计令牌、主题、Toast、日志视图、成长面板、提示词预览** | **应用外壳（`desktop/`）**。L8 界面插件已整批下线并进废纸篓，永久不得再新建任何 `ondra-ui-*` 包 |

## 5. 配置

| 字段 | 默认 | 区间 | 说明 |
|---|---|---|---|
| `enable` | `true` | — | 总开关。关掉后 `note()` 抛 `disabled`，`cue()` 恒 `quiet(disabled)` |
| `quietAfterFailSec` | `90` | 10–600 | 失败后的安静期 |
| `stuckFails` | `3` | 2–10 | 判「咬住了」所需的连续失败次数 |
| `stuckSpanMin` | `20` | 1–240 | 判「咬久了」所需的最短跨度 |
| `celebrateCooldownMin` | `30` | 1–240 | 「绿了」的冷却 |
| `cueCooldownMin` | `10` | 1–240 | 两次非静默出声的最小间隔（**自动 ≤ 上一个**） |
| `respectPresence` | `true` | — | 是否参考 O-109 的在场状态 |

> **这些数从哪来**：master-plan §9 没有「开发者陪伴」这一组，故全部是**工程取值**，
> 依据写在 `src/settings.ts` 的文件头与 `FIELD_SPECS` 的 `doc` 里。

`cueCooldownMin > celebrateCooldownMin` 时**向下压**：出声冷却比「绿了」的冷却还长，
一次真正的转绿会被冷却吞掉，于是一整段修复之后她仍然一声不吭。

## 6. 降级与缺席（一张表说清）

| 缺谁 | 表现 | 日志 |
|---|---|---|
| `ondra-identity` | 命名空间退回 `ondra.dev-companion` | 无（正常降级） |
| `ondra-clock` | 时间退回 `Date.now()` | 无（正常降级） |
| `ondra-path-layout` | **台账只在内存**，`stored=false`，重启后可能重复说同一句 | 无（宁可重复一次，不谎称落盘） |
| `ondra-config-schema` | 只用插件实例配置 | `warn` 一行 |
| `ondra-screen-sense` | **少了在场门**，会议中也可能说话 | `info` 一行（启动时报一次） |
| O-109 抛错 / 返回畸形值 | 本次不作门（`null`），不静默失败 | `warn` 一行 |

> **服务缺席不算「读不到」。** 单装本插件时必须能说话——否则「没装感知插件」就等于
> 「永远闭嘴」，那是把可选依赖做成了硬开关。

## 7. 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。`cue()` 那一路消失，没人依赖本插件提供的任何东西。
2. **我的状态存在哪？** 判定在内存；台账 `user/dev-companion.json`（0600，原子写）；
   缺路径服务时全部在内存。
3. **我崩了怎么知道是我崩了？** 日志命名空间 `ondra.dev-companion`，
   `stats().lastIssue` 留一行中文原因，`writeFailures` 单独计数。
4. **我依赖谁？缺席怎么降级？** 五项全软依赖，见 §6。
5. **我和同域的谁共享可变状态？** 没有。读 O-109 的 `view()` 是只读，且不 import 源码。

## 8. 已知限制（诚实清单）

- **判定状态（`streak` / `firstFailAt`）不落盘。** 重启后重新数：宁可少说一句，
  也不能对着一个不相干的旧错误劝人放下。
- **指纹由外壳给，本插件无法验证。** 外壳乱给指纹，就会把「同一个错」判错。
  没给指纹时按连败算——「分不清」时宁可早点劝放下，也不能在同一条错误上催第四次。
- **`run-end` 只在五分钟内补一句。** 更晚就当作没发生过：一次跑的什么早就忘了。
- **一次 `cue()` 不推进任何东西。** 所以外壳必须调 `ack()` 才算「真的说了」。
  `ack('celebrate')` 会关掉「红转绿」标记、`ack('release')` 会记下「已经劝过」，
  否则冷却一过同一件事会被再说一遍——而第二遍就成了敷衍与唠叨。
- **忘了调 `ack()` 的后果**：同一句「绿了呀」会在冷却到期后重说一次；
  同一句「先放下」会在出声冷却到期后重说一次（直到下一个事件进来才算新一轮）。
- **不做「连续几天在加班」这类跨日统计。** 那是 O-105 的活，这里再做一份就是两个真源。
- **三句台词写死在 `rules.ts` 的 `SAY` 里。**

## 9. 技术来源

档位：**〔研〕自研**。依据：「事件到了先想该不该响」的判据在开源生态里**没有成熟实现可参考**——
现有的开发陪伴类工具（番茄钟、CI 通知、编辑器鼓励插件）几乎都是「事件到了就响」，
而这里最要紧的恰好相反。故判定表由本项目独立设计；只有两个机制借鉴了成熟项目。

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 事件流折叠成会话状态（而不是存一条条流水） | ActivityWatch | github.com/ActivityWatch/activitywatch | MPL-2.0 | 「原始事件 → 桶 → 聚合」的分层；本地优先、默认不上传 | 自研 `rules.ts`：`applyEvent()` 把事件折进 `DevMemory` | 否 |
| 事件去抖与冷却（连续触发只认一次） | watchexec | github.com/watchexec/watchexec | Apache-2.0 / MIT（双许可） | 「去抖窗口 + 冷却」两个独立量，不合并成一个 | `quietAfterFailMs`（去抖）与 `cueCooldownMs`（冷却）分开 | 否 |
| 陪伴话术的「不催」原则 | —（无上游，见下） | — | — | — | 自研：`@/§2` 五条硬纪律与 `MUST_NOT` 五条禁令 | 否 |

> 第三行故意留空：**「不催」这条不是从哪个项目抄来的，是本项目自己的取舍**，
> 所以没有可填的仓库。宁可空着，也不编一个来源。

## 10. 多方案分支（master-plan §12）

按 §12 的判定顺序，本插件走**第 1 条「融」**：

| 方案 | 判定 | 处理 |
|---|---|---|
| 外壳自己判断该不该说 | 能融 | 融进本插件：外壳只报事实，判定集中一处 |
| 复用通知库（去抖 + 冷却） | 能融 | 只借机制（见 §9），不引依赖：库只管「发」，不管「该不该」 |
| 给每个调门做一个 provider 分支 | 不能融 | **不做**：几个调门不是互斥实现，是同一判定的不同出口；做成分支就会出现两套「咬住了」的判据 |

故只有**一个实现 + 七个参数**，没有 `provider` 开关。

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
| `src/types.ts` | 契约（服务键、事件闭集、调门、视图、错误码、外部形状对位、O-109 结构对位） |
| `src/settings.ts` | 配置唯一真源（`FIELD_SPECS` → 默认值 / 段声明 / 校验 / 口径换算） |
| `src/rules.ts` | 判定核心（纯函数：事件折叠、出声判定、视图） |
| `src/store.ts` | 台账读写（0600 + 原子替换，**只存水位与计数**） |
| `src/service.ts` | 服务实现（读 O-109 在场、落盘、降级） |

## 12. 快速上手

```yaml
# cordis.yml（节选）
- ondra-dev-companion:
    quietAfterFailSec: 90
    stuckFails: 3
    respectPresence: true
```

```ts
// 外壳侧：只报事实，不判断
const dev = ctx.get('ondra-dev-companion')
dev?.note({ kind: 'build-end', outcome: 'fail', fingerprint: 'a1b2c3' })

const cue = dev?.cue()
if (cue !== undefined && cue.say !== null) {
  // 交给 O-042 的六道闸，不在这里直接发
  dev?.ack(cue.tone)
}
```

## 13. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（7 必需 + icon） | 过（13 文件） |
| 2 | 清单合法（JSON / `ondra-*` / `type: module` / 四字段 / `@ntars/cordis` 双处） | 过 |
| 3 | 编译配置（NodeNext / strict / rootDir / outDir / declaration） | 过 |
| 4 | 入口契约（`name` / `apply` / `Config` 每字段有默认） | 过（无 `inject`：全软依赖） |
| 5 | 服务键唯一（`ondra-dev-companion` 未被占用） | 过 |
| 6 | 依赖可解析（五个 `ctx.get` 键均有提供方） | 过 |
| 7 | 无越界 import（`from 'ondra-` 零命中） | 过 |
| 8 | 降级到位（每个 `ctx.get` 后均判 `undefined`） | 过 |
| 9 | 交付物齐全（技术来源表 / 多方案说明 / 隔离五问） | 过 |

语言五项：括号配平 · 无残留半句 · `import type` 正确 · 无 TODO · UTF-8 无 BOM —— 全过。
图标：与仓库根 `icon.svg` 逐字节一致（`sync-plugin-icons.mjs --check`）。
