# ondra-theater · 多角色剧场

> 一句话：**几个角色同场时，下一句该谁说？** 只给调度，不给台词。

**档位：〔研〕自研**（master-plan §3.8）。判据见 §4：机制本身简单到可以写完，但没有一个现成实现提供「硬上限 + 收束判据 + 零台词」这种产物形态，凑上去反而要引入一整套 LLM 调度循环。

---

## 1. 一句话定位

它是一场戏的**舞台监督**，不是编剧：

- 决定**谁在场上**（2–4 人，座位顺序即发言顺序）
- 决定**下一句轮到谁**（永远跳过刚说过的那一位）
- 决定**这一句是什么意图**（`open` / `respond` / `bridge` / `close`）
- 决定**最多几句**（默认 2；收尾句恒为 1）
- 决定**什么时候必须收场**（轮数到顶 / 冷场，任一命中即收）

**它一个字都不写。** 交付物 `TurnPlan` 里没有 `say` / `text` / `line` 字段——台词归 O-033 的对话编排与 O-037 的九步过滤链，本插件连一个能放句子的字段都不留。

四条硬裁决（写在类型与常量上，不做成配置）：

| # | 裁决 | 落到哪 |
|---|---|---|
| 1 | 同一角色不许连续两次发言 | `nextSpeakerOf()` 座位环 + 跳过上一句的人；座位数下限 2 使它结构性成立 |
| 2 | 角色数硬上限 4，超了当场拒绝 | `MAX_ROLES = 4`，`readRoles()` 抛 `too-many-roles`，**不排队** |
| 3 | 每场必须有收束条件 | `stopReasonOf()`：轮数上限（`maxRounds × 座位数`）+ 冷场（`disperseMs`） |
| 4 | 离场必须先收束 | **契约里没有 `leave()`**；换人只能 `close()` 后重新 `open()`，已有一场没散时 `open()` 抛 `scene-open` |

## 2. 服务键与契约方法表

服务键：`ondra-theater`（连字符，匹配 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。

| 方法 | 读/写 | 作用 | 失败时 |
|---|---|---|---|
| `open(request, at?)` | 写 | 开场：定座位、定场次 id | `too-few-roles` / `too-many-roles` / `duplicate-role` / `scene-open` / `bad-request` / `disabled` |
| `next(at?)` | **只读** | 出下一句的调度票 | `not-open` / `closed` / `disabled` |
| `advance(speakerId?, at?)` | 写 | 记一句「已说」并推进游标 | `not-open` / `closed` / `bad-request` / `disabled` |
| `close(at?)` | 写 | 收场（唯一能让座位上的人离开的方法） | `not-open` / `closed` / `disabled` |
| `snapshot(at?)` | **只读** | 场次快照；没有场为 `null` | 不抛（关掉总开关也能看） |
| `stats()` | 只读 | 累计统计（全内存） | 不抛 |

```ts
interface TheaterService {
  readonly available: boolean
  readonly reason?: TheaterErrorCode

  open(request: SceneRequest, at?: number): TheaterView
  next(at?: number): NextResult          // 纯读
  advance(speakerId?: string, at?: number): TheaterView
  close(at?: number): TheaterView
  snapshot(at?: number): TheaterView | null
  stats(): TheaterStats
}
```

```ts
type NextResult =
  | { kind: 'turn'; plan: TurnPlan }                     // 该谁说
  | { kind: 'should-close'; reason: CloseReason; note: string }  // 该散了，但**要调用方去 close**
  | { kind: 'closed'; reason: CloseReason; note: string }

interface TurnPlan {
  readonly sceneId: string
  readonly turn: number            // 本场第几句（1 起）
  readonly round: number           // 第几轮（1 起）
  readonly seat: number            // 座位号（0 起）
  readonly speakerId: string
  readonly speakerName: string
  readonly intent: 'open' | 'respond' | 'bridge' | 'close'
  readonly maxSentences: number    // 收尾句恒为 1
  readonly mustNot: readonly string[]   // 恒定四条
  readonly closesAfter: boolean
  readonly remainingTurns: number
  readonly note: string            // 一句中文说明，**不是台词**
}
```

`should-close` 与 `closed` 刻意分成两种：前者是「该散了但还没散」，**必须由调用方去 `close()`**。让一次读顺手把场收掉，就等于把「离场必须先收束」这条裁决交给一次轮询去执行。

`advance()` 的 `speakerId` 是**可选校验**：给了就必须是这一轮该说话的人，否则抛 `bad-request`。记错人会直接导致同一个人连说两句，而这种错只在三人以上时出现，很难在日志里发现。

`mustNot` 恒定四条：不复述上一位刚说过的话 / 不替场上其他角色发言 / 不把不在场的角色拉进来 / 不越过句数上限。

## 3. 明确不负责（逐条写归谁）

| 不负责的事 | 归谁 |
|---|---|
| 人格装配（她是谁、什么语气、什么称呼） | O-021 `ondra-persona-core`（本插件只读一个人设 id 当座位标签） |
| 生成台词、选词、断句 | O-033 `ondra-dialogue` 生成、O-037 `ondra-filter-chain` 发出前九步过滤（本插件只给 `intent` 与 `maxSentences`） |
| 驱动对话、调模型、排队、重试 | O-033 `ondra-dialogue`（本插件不调用任何模型） |
| 什么时候开口、额度、静默时段 | O-042 `ondra-proactive-gate` 的静默与额度（投递前的闸门） |
| 时间与时区（含「现在几点」） | O-003 `ondra-clock`（本插件只读 `now()`，不重写日历） |
| 配置四层合并与来源追溯 | O-005 `ondra-config-schema`（本插件只声明段） |
| 日志命名空间 | O-001 `ondra-identity`（缺它退回 `ondra.theater`） |
| 开场与退场的仪式（第一句怎么接、隔了很久怎么开口） | O-107 `ondra-first-meet` / O-108 `ondra-absence`（本插件只管「轮到谁」） |
| 渲染、舞台视图、角色卡、时间轴 | 应用外壳（`desktop/`）。L8 界面插件已整批下线，永久不得再新建 `ondra-ui-*` |
| 角色正文（人设文本、台词存档、角色档案） | O-021 `ondra-persona-core` 与人设包；本插件只留一个 id 与显示名 |
| 定时推进、到点自动换人、常驻调度 | **没有人**：本插件不装 `setInterval` / `setTimeout`，只在被调用时按时刻现算 |
| 场次存档与跨重启续演 | **没有人**：本插件明确不落盘，见 §6 |

## 4. 技术来源表（档位 · 依据 · 生态检索结论）

**档位：〔研〕自研。**

判据：机制本身是「确定性的发言权轮转 + 两条收束判据」，代码量在一个文件里就能写完（`src/stage.ts`，纯函数、无 IO）。之所以不判〔薄〕，是因为生态里**没有一个现成实现提供的正是这个产物形态**——现成的多角色调度都属于「框架内的一环」，它们的目标是让模型把话说完，而本插件的目标是**不让它说下去**（硬上限、冷场即散、零台词）。把框架接进来，等于为了一个三十行的座位环引入一整套 LLM 调度循环。

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 多角色轮流发言的「发言选择」概念（`round_robin` 等选择方式） | Microsoft AutoGen（GroupChat） | github.com/microsoft/autogen | MIT | 「发言权需要被单独选择」这一分层；把选择与生成分开 | `nextSpeakerOf()` 用座位环取模，确定性、无随机、无投票 | 否 |
| 顺序流程 vs 层级流程的分工 | CrewAI | github.com/crewAIInc/crewAI | MIT | 「顺序」与「谁来决定下一个」是两件事，不能混在一个循环里 | 顺序固定为座位环；「什么时候停」独立成 `stopReasonOf()` | 否 |
| 议事规则里的发言令牌（token）与动议终止 | Robert's Rules of Order（议事规则，非软件） | — | — | 「终止必须有明确条件，且由主持人宣布」 | 两条收束判据 + `close()` 由调用方宣布，一次读不代劳 | 否 |
| 对话系统中的轮次交接（turn-taking） | 会话分析（Sacks/Schegloff）的「话轮转换」概念 | — | — | 「一次只有一个人说话」「交接点可预测」 | 结构上保证：游标只有一个，`advance()` 唯一推进 | 否 |

**生态检索结论**：多角色发言调度在生态里只有三种形态——①框架内建的发言选择（AutoGen 的 `speaker_selection_method`、CrewAI 的 `Process`）②议事规则类的人工流程 ③对话分析里的理论模型。三者都要么绑定 LLM 调用循环、要么以「说完就轮到下一个」为核心而没有上限与收束，**没有一种提供「4 人硬上限 + 冷场判据 + 零台词」的产物**。故本插件只借概念名，**不引入任何依赖、不复制任何代码**（`package.json` 里除了 `@ntars/cordis` 没有第三方依赖）。

## 5. 配置项表

| 字段 | 默认 | 区间 | 说明 |
|---|---|---|---|
| `enable` | `true` | — | 总开关。关掉后服务照常注册，`open()` / `next()` / `advance()` 一律抛 `disabled`，`snapshot()` 仍可读 |
| `maxRoles` | `4` | 2–4 | 角色数上限。**天花板就是 4**，写 8 会被夹回 4，配置层面也越不过 `MAX_ROLES` |
| `maxRounds` | `6` | 1–12 | 轮数上限。`maxRounds × 座位数` 即本场总句数上限（第一条收束条件） |
| `maxSentences` | `2` | 1–4 | 每句句数上限。收尾句恒夹到 1 |
| `disperseSec` | `120` | 30–1800 | 冷场判据：距上一句（或开场）超过它即「该散了」（第二条收束条件） |

> **这些数从哪来**：master-plan §9 参数速查里**没有**「多角色剧场」这一组，故全部是本插件的工程取值，依据写在 `src/settings.ts` 的文件头：6 轮 ≈ 三人场 18 句（再长就是同一话题说三遍）；2 句/人（超过就变成「一段独白 + 一句回应」）；120 秒冷场（正常停顿是秒级到十几秒）；4 人见 `MAX_ROLES`。

刻意**没有**的配置项：允许同一人连说（那是裁决不是偏好）、离场开关（契约里没有 `leave()`）、台词长度（本插件不出台词）。

## 多方案分支（master-plan §12）

不涉及 §14 的十四项裁决，也不做「宽松 / 严格」双轨调度：

- 场次调度只有一套规则（同角色不连续、上限 4、必须收束）。做成可配置的「宽松模式」等于让「剧场会不会退化成独白」取决于某次配置，而不是取决于设计。
- 角色来源只有一个入口（`open()` 传入的角色列表）。上游是 O-020 人设包还是别的来源，本插件不选边、不分支——取到的名字只用于排班，不参与任何装配。
- 若将来需要「跨场连贯」这种真正不同的语义，按 §12 第三档处理：一个接口、每分支独立文件、默认选最稳的那支，且不共享缓存。当前**没有**这样的第二分支。

## 6. 已知限制

- **不落盘，重启即散场。** 场次是一次性的。这是刻意的：存档会诱导「跨重启续演」，而续演时观众早换了人，角色却还停在上一场的语境里。代价是进程重启后必须重新 `open()`。
- **冷场判据只在被调用时才算。** 没有定时器，所以「该散了」不会自己发生——它要等下一次 `next()` / `advance()` / `snapshot()` 被调用才会显现。这不是缺陷：真正让场次散掉的是**没人再调用它**，而那种情况下也不该有谁去收场。
- **角色名大概率就是角色 id。** O-021 的 `KernelView` 只有 `personaId`，没有 `displayName`，所以三级回退是「调用方给的 `name` → 人设 id → 角色 id」。**不猜名字、不拿槽位正文当名字**——那是第二份人格。想要好看的名字，请在 `open()` 时传 `name`。
- **轮转是纯确定性的。** 没有「谁更该说」的判断，也不看话题。当场上有沉默型角色时，它照样按座位轮到——「该不该让他说」是内容判断，本插件不碰内容。
- **收场后不能回到同一场。** `closedReason` 一旦写上就不再清除，只能重新 `open()`。这保证「已散的场」不会被一句迟到的 `advance()` 复活。
- **迟到的 `advance()` 会先收场再报错。** 调用方拿不到那次推进的视图（抛异常），只能从 `snapshot()` 读到已收场状态。这是刻意的：冷场之后续上一句，比丢一次记账更糟。
- **4 人是硬顶，不是建议。** 五个角色同场没有降级路径，只有拒绝。排队会让多出来的人在若干轮之后突然开口，而那时场上早没人记得他为什么在场。
- **`mustNot` 是写死的四条中文。** 它不做成配置、不随意图变化：外部化的第一件事就是被改松，而这里松一条，第二个角色就会开始替别人说话。

## 7. 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。`ondra-theater` 这个服务消失，下游拿不到调度票（`ctx.get('ondra-theater')` 为 `undefined`，需自行判空），其余插件全部照常——本插件不 provide 任何别人依赖的东西，也不写任何共享文件。
2. **我的状态存在哪？** **只在内存**（`Stage` 与四个计数器）。没有存档文件、没有路径依赖，因此也没有 `0600`、原子写、写失败计数这些问题。代价见 §6 第一条。
3. **我崩了怎么知道是我崩了？** 日志命名空间 `ondra.theater`（经 O-001 拼成 `ondra.theater`）；所有拒绝都带稳定错误码（`TheaterError.code`），`stats()` 里 `refusals` / `autoCloses` / `lastCloseReason` 三个计数能直接看出「一直在被拒」或「场次总是自动散掉」。降级只报一次（`warnOnce`），避免每秒轮询把日志刷没。
4. **我依赖谁？缺席怎么降级？**

   | 缺谁 | 表现 | 日志 |
   |---|---|---|
   | `ondra-identity` | 命名空间退回 `ondra.theater` | 无（正常降级） |
   | `ondra-clock` | 时间退回 `Date.now()` | `warn` 一次（仅在读取抛错时） |
   | `ondra-persona-core` | 角色名退回角色 id | `warn` 一次 |
   | `ondra-config-schema` | 只用插件实例配置，无四层合并与来源追溯 | `warn` 一行 |

   四项全软依赖，故不声明插件级 `inject`；每个 `ctx.get` 之后都判 `undefined` 并降级。

5. **我和同域的谁共享可变状态？** 没有。与 O-107 / O-108 的 `mustNot` / `maxSentences` 只是**结构同形**，按 §18.5 不 import 对方源码、不共用文件、不共用键；与 `desktop/` 无共享（不做界面）；与 O-033 无调用关系（不驱动对话）。
