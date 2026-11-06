# ondra-rhythm-typing

> O-039 · L4 节奏与拟人 · 档位〔研〕 · 服务键 `ondra-rhythm-typing`

分几条、每条等多久是算出来的；真等、真发、真能停下，是这里做的。

---

## 一、职责

把 O-038 的**计划**跑成**真实时间线**：

| 能力 | 方法 | 说明 |
|---|---|---|
| 排时间线 | `schedule(text, options?)` | 不执行，只出 `steps[]`（面板预览、调试用） |
| 执行 | `run(text, handlers, options?)` | 逐步「报阶段 → 等 → 发」。**永不抛出** |
| 取消 | `cancel(conversationId?)` | 省略则取消全部 |
| 读阶段 | `phaseOf(conversationId?)` | `idle / thinking / typing / paused` |
| 订阅阶段 | `subscribe(listener)` | 给 O-041 用，返回 disposer |
| 统计 | `stats()` | 见下 |
| `available` / `reason` | 只看配置开关（开着 ≠ 真能用） |
| `rhythmReady` | 节奏服务此刻是否在位；**每次现问不缓存** |

`steps[]` 的每一步：`index / text / waitMs / phase / longPause`。

`phase` 的三种非 idle 值：`thinking`（首条之前，她在看）、`typing`（两条之间）、`paused`（长停顿，走神了）。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 分条、算延迟、长停顿概率、自我修正 | `ondra-rhythm`（O-038） |
| 显示「正在输入」、呼吸感动作（单日 ≤2） | `ondra-breath`（O-041） |
| 限流、重试、平台错误码处理 | 各通道适配器 |
| 删句、改句、去客服腔 | `ondra-filter-chain`（O-037） |
| 生成正文 | `ondra-dialogue`（O-033） |
| 判断「刚醒」 | `ondra-life-rhythm`（O-049，尚未建） |

四条**刻意不做**：

1. **不复制 O-038 的任何参数。** 等待时长、条数、首字延迟全部来自 `plan()`。本插件里没有第二个「6000ms」——两边各存一份，漂移后的症状是「面板说 6 秒、实际等 9 秒」，而查的人会先怀疑时钟。
2. **降级不模拟打字。** 没有 O-038 就一次性整段发出。假装打字比直接发出更像骗人，而且没有计划就没有「该等多久」的依据。
3. **不做限流与重试。** 每个通道语义不同（QQ 被动回复要带 `msg_id`、微信客服有 48 小时窗口、飞书要先回 200 再异步）。放这里做，等于用一个策略套所有平台。
4. **不改正文。** `steps[].text` 逐字来自 O-038。

## 三、服务键与方法

```
ondra-rhythm-typing        ← 连字符，不是 ondra:rhythm-typing
```

`run()` 入参：`text` / `handlers`（`send(text, index)` 必需，`phase(event)` 可选）/ `options`（`conversationId?` / `at?` / `justWoke?` / `signal?` / `style?`）。

`TypingResult`：`conversationId / sent / total / aborted / superseded / degraded / elapsedMs / error?`。

`TypingSchedule`：`conversationId / steps / totalMs / source('rhythm'|'oneshot') / degraded / notes`。

`TypingEvent`：`conversationId / phase / index / total / at`。

`stats()`：`runs / sent / aborted / superseded / degraded / failed / active / avgElapsedMs`

## 四、配置

| 键（camelCase） | 段字段（kebab） | 默认 | 依据 |
|---|---|---|---|
| `enable` | `enable` | `true` | — |
| `conversationId` | `conversation-id` | `'default'` | 调用方没传时的兜底键 |
| `longPauseThresholdMs` | `long-pause-threshold-ms` | `2500` | 自定（手册未给「多长算停顿」） |
| `wakeBufferMs` | `wake-buffer-ms` | `0` | 手册第 1363 行的缺口，默认关 |
| `emitPhaseEvents` | `emit-phase-events` | `true` | O-041 靠它 |
| `verbose` | `verbose` | `true` | 只影响噪声 |

**这里没有等待时长。** 那是 O-038 的配置项——本插件只有三个真正属于自己的参数（阈值、刚醒缓冲、默认会话 id）。

## 五、关键裁决

1. **同会话新一轮顶掉旧一轮。** 旧回复在新回复之后到达，用户看到的是「她答非所问」；少发一条只是「她没说完」。前者更难解释，所以选顶掉。被顶掉的那轮结果里 `superseded: true`。
2. **每一步之间都查一次取消。** 只在开头查，会出现「已经取消，但第 3、4 条还是发出去了」——而日志里写着「已取消」。
3. **长停顿期间报 `paused`，不报 `typing`。** 走神时还显示「正在输入」，是这套拟人里最容易穿帮的一处：打字指示器亮 9 秒却一个字不来，比不亮更假。
4. **发送抛错就终止本轮。** 继续发剩下的只会把同一个错误放大 N 倍，而用户那边收到的是「半句话 + 沉默」。
5. **卸载时先停轮次、再撤服务。** 顺序反了，定时器回调会在服务已被撤掉之后触发，对着不存在的通道发消息。
6. **被顶掉的那一轮不报 `idle`。** 否则 O-041 会在新一轮的「正在输入」中途收到一次 idle，指示器闪一下。
7. **`emitPhaseEvents=false` 只关「对外订阅」，不关 `handlers.phase`。** 后者是调用方自己的回调，关掉它等于让调用方猜。
8. **`sleep()` 永不 reject。** 打断是正常路径（取消 / 顶掉 / 卸载），不是异常。写成 reject，调用方就得为「正常取消」写 try/catch。

## 六、多方案说明（§12）

本插件**没有分支**。两处曾考虑分支，最终按「能融就融」合成一个：

| 方案 | 结论 |
|---|---|
| 并发策略「排队」vs「顶掉」 | ✅ 顶掉（见裁决 1）。排队会让两轮回复交错到达 |
| 取消机制「轮询标志」vs「AbortSignal」 | ✅ AbortSignal + 定时器双通道。纯轮询会让 9 秒长停顿取消后仍等满 9 秒 |

## 七、契约对位（不 import，只镜像）

| 上游 | 用到的成员 | 镜像位置 |
|---|---|---|
| O-038 `ondra-rhythm` | `available` / `plan({text, at?, style?})` 的 `messages[].{text,delayMs,pauseMs}` | `RhythmServiceLike` / `RhythmPlanLike` / `RhythmMessageLike` |
| O-005 `ondra-config-schema` | `register` / `resolve` | `ConfigSchemaLike` / `SectionDeclLike` / `FieldSpecLike` |
| O-001 `ondra-identity` | `loggerName(feature)` | `IdentityLike` |

下游（本插件不调用，只被调用）：

| 消费方 | 用到的成员 |
|---|---|
| O-041 `ondra-breath` | `subscribe()` / `phaseOf()` |
| O-033 `ondra-dialogue` / 各通道适配器 | `run(text, {send})` |

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 打字时序执行 | 旧项目 `rhythm`（336 行） | 手册 §9.2 实读；原件在旧项目包内 | **AGPL-3.0** | 只读**「先延迟再发、逐条推进」的流程形状** | 自研 `service.ts` + `runner.ts`：AbortSignal + 定时器双通道、每步检查取消 | 否 |
| 「正在输入」指示器 | 生态常见 chat UI（typewriter / typing indicator） | — | — | **只作反例**：那是渲染层，本插件只发阶段事件 | 不采用 | 否 |
| 可中断等待 | Node `AbortSignal` + `setTimeout` | Node 官方文档 | MIT（Node 本身） | 标准 API 用法 | 自研 `sleep()`，永不 reject | 否 |

档位说明：手册 §1.8 的「节奏参数」属旧项目已实现资产，生态里的打字机效果解决的是「怎么显示」，不是「怎么等、怎么停」。故〔研〕。

## 九、隔离五问

1. **关掉我，谁受影响？** 只有「她打字的速度感」。调用方拿到 `degraded: 'disabled'` 后一次性发出，对话照常。
2. **我的状态存在哪？** 仅在内存：`active`（在跑的轮次）、`listeners`（阶段订阅）、`counters`。**不落盘、不建表**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.rhythm-typing`；`stats()` 的 `aborted / superseded / failed / active` 是探针；发送失败会打 `第 N 条发送失败（本轮终止，已发 M 条）`。
4. **我依赖谁？缺席时怎么降级？** 只依赖 O-038。缺席 → `no-rhythm` → 一次性整段发出。
5. **我和同域的谁共享了可变状态？** 没有。O-038 只读。

## 十、已知限制

1. **发送没有超时。** `handlers.send` 返回的 Promise 若永不 resolve，本轮会挂住。超时归适配器——放这里会与各平台自己的超时打架，出现「双重超时」。
2. **取消不能撤回已发出的那一条。** `send()` 已经开始执行就无法中断，只能保证「不再发下一条」。
3. **阶段事件不持久。** 进程重启后 `phaseOf()` 一律 `idle`；这是对的——重启后没有「正在输入」这回事。
4. **只按会话 id 隔离。** 同一 id 在两个通道同时用会被互相顶掉。会话 id 的唯一性归 `ondra-channel-kit`（O-056）。
5. **长停顿的「不显示正在输入」只是报 `paused`。** 真要不要熄灭指示器由 O-041 决定，本插件不碰 UI。
6. **`justWoke` 需要调用方判断。** 本插件不知道她是不是刚醒——那是 O-049 的事。传了才生效。

## 十一、待裁决

1. **长停顿阈值 2500ms**：手册没给「多长算停顿」，只给了长停顿区间 3000–9000。取 2500 是为了让 3000 的长停顿稳定落进 `paused`。
2. **刚醒缓冲默认 0，且信号源缺失。** 手册第 1363 行把它列为缺口并建议并入本插件；参数已就位，但「她刚醒」这件事要等 O-049 `ondra-life-rhythm`。
3. **顶掉 vs 排队**：本插件选顶掉（裁决 1）。若主人希望「说完再听新的」，需要改成排队，并接受两轮回复交错。
4. **取消后是否补一句「等下」**：本插件什么都不说。要不要留一句话术，属于 O-033 的编排判断。
