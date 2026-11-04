# ondra-rhythm

> O-038 · L4 节奏与拟人 · 档位〔研〕 · 服务键 `ondra-rhythm`

一段话该分几条发、每条之间等多久，全在这里算完——**不发出去一个字**。

---

## 一、职责

**分条与停顿的纯计算**（手册 §9.2 + §3.3 第 396 行）。四件事：

| 能力 | 方法 | 手册依据 |
|---|---|---|
| 分几条、每条多少字 | `plan()` / `split()` | §9.2：`maxMessages 4`、`maxCharsPerMessage 40`、超限「保留前 3 条 + 尾部合并成第 4 条」 |
| 每条之前等多久 | `plan()` / `delayOf()` | §9.2：`charsPerSecond 6`、标点 300/500/150、`300–6000ms`、**先卡限→深夜 ×1.6→再卡限** |
| 首条延迟 | `firstDelay()` | §3.3：`800–2000ms` |
| 哪一条之前停顿 | `longPause()` | §3.3：概率 `0.20`、`3000–9000ms`、**整轮最多一次** |
| 要不要改口 | `selfCorrect()` | §3.3：概率 `0.05`、3 句模板、**默认不自动插入** |

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 计时、发送、可中断的执行 | `ondra-rhythm-typing`（O-039） |
| 六态判定、语速与句形系数表 | `ondra-emotion-express`（O-031） |
| 删句、改句、去客服腔 | `ondra-filter-chain`（O-037） |
| 「正在输入」与呼吸感动作（单日 ≤2） | `ondra-breath`（O-041） |
| 口头禅池、不完整句、标点习惯 | `ondra-oral`（O-040） |
| 刚醒缓冲（开头慢半拍） | `ondra-rhythm-typing`（O-039，见其 `wakeBufferMs`） |
| 生成正文 | `ondra-dialogue`（O-033） |

三条**刻意不做**：

1. **不 import `setTimeout`。** 一旦这里掺了计时，同一个输入两次跑出不同结果，就再也说不清「她为什么发了 5 条」。纯函数才可能被 O-125 预览与调试工具逐字复现。
2. **不删内容。** 超限只合并、不截断；合并后超过 40 字只标 `overflow`。丢一句话比多发几个字严重得多。
3. **不改正文。** 自我修正只做**形态**（在逗号处断开、补一句「不对，」再说完后半句），**不能真的改内容**——改内容需要知道「错在哪」，那是模型的事。

## 三、服务键与方法

```
ondra-rhythm        ← 连字符，不是 ondra:rhythm
```

| 方法 | 说明 |
|---|---|
| `plan(request)` | 出完整计划。**永不抛出**，异常退回一次性整段发出 |
| `split(text, cap?)` | 只分条（不套条数上限、不算延迟），返回 `{messages, innerSplits}` |
| `delayOf(text, at?, cps?)` | 单条打字时长（已卡限、已乘深夜系数） |
| `firstDelay(rng?)` | 首字延迟 800–2000ms |
| `longPause(rng?)` | 长停顿时长 3000–9000ms |
| `selfCorrect(text, rng?)` | 抽一次自我修正（不改入参）；关闭时恒 `undefined` |
| `stats()` | 见下 |
| `available` / `reason` | 只看配置开关；本插件**不依赖任何上游**，所以可用等于开着 |
| `maxMessages` | 恒为 4（硬上限，供调用方展示） |

`plan()` 入参：`text` / `at?` / `style?`（`speechRateDelta` / `tempo` / `sentenceShape`）/ `rng?`。

`RhythmPlan` 字段：`messages / totalMs / chars / cps / maxMessages / maxCharsPerMessage / night / longPauses / selfCorrected / mergedCount / overflowCount / notes`。

`RhythmMessage` 字段：`index / text / chars / delayMs / pauseMs / longPause / merged / overflow`。

`stats()`：`turns / messages / cappedTurns / overflowTurns / longPauses / selfCorrections / avgMessages / avgChars`

## 四、配置

| 键（camelCase） | 段字段（kebab） | 默认 | 依据 |
|---|---|---|---|
| `enable` | `enable` | `true` | — |
| `maxMessages` | `max-messages` | `4` | 手册 §9.2（**上限也锁 4**） |
| `maxCharsPerMessage` | `max-chars-per-message` | `40` | 手册 §9.2 |
| `charsPerSecond` | `chars-per-second` | `6` | 手册 §9.2 |
| `minDelayMs` | `min-delay-ms` | `300` | 手册 §9.2 |
| `maxDelayMs` | `max-delay-ms` | `6000` | 手册 §9.2 |
| `firstDelayMinMs` | `first-delay-min-ms` | `800` | 手册 §3.3 |
| `firstDelayMaxMs` | `first-delay-max-ms` | `2000` | 手册 §3.3 |
| `longPauseP` | `long-pause-p` | `0.20` | 手册 §3.3 |
| `longPauseMinMs` | `long-pause-min-ms` | `3000` | 手册 §3.3 |
| `longPauseMaxMs` | `long-pause-max-ms` | `9000` | 手册 §3.3 |
| `selfCorrectEnabled` | `self-correct-enabled` | `false` | 手册原文「默认不自动插入」 |
| `selfCorrectP` | `self-correct-p` | `0.05` | 手册 §3.3 |
| `nightEnabled` | `night-enabled` | `true` | — |
| `nightFactor` | `night-factor` | `1.6` | 手册 §3.3 |
| `nightStart` | `night-start` | `23:00` | 手册 §9.2 |
| `nightEnd` | `night-end` | `06:00` | 手册 §9.2 |
| `pausePeriodMs` | `pause-period-ms` | `300` | 手册 §9.2（。！？） |
| `pauseEllipsisMs` | `pause-ellipsis-ms` | `500` | 手册 §9.2（……/——） |
| `pauseCommaMs` | `pause-comma-ms` | `150` | 手册 §9.2（，；） |
| `emotionAdjust` | `emotion-adjust` | `true` | 跟 O-031 的表达档 |
| `verbose` | `verbose` | `true` | 只影响噪声 |

三对上下限（`minDelay/maxDelay`、`firstDelayMin/Max`、`longPauseMin/Max`）写反时**静默交换**——写反的人想要的是「这个区间」，不是「报错」。

## 五、关键裁决

1. **`maxMessages = 4` 是防封余量，不是产品偏好。** 手册原文「官方 QQ 5 次留 1 次余量」。配置的 `max` 也锁 4：写 8 只认 4。调大不是「更活泼」，是吃掉余量——而症状是「号被封了」，没人会往分条参数上想。
2. **深夜系数乘在卡限之后，再卡一次限。** 顺序写反（先乘、只卡一次）会让 40 字的长消息在深夜**完全没有变化**：6667 → 10667 → 卡回 6000，与白天一模一样，系数形同虚设且日志里看不出。正确形状是「慢在犹豫上，不慢在长句上」：短消息 600→960，长消息仍是 6000。
3. **长停顿是独立分量 `pauseMs`，不并进 `delayMs`。** 3000–9000ms 大于 `maxDelayMs 6000`，并进去就会被上限压成 6000，长停顿永远发不出来。
4. **超限走尾部合并，不丢内容。** 合并后超过 40 字标 `overflow` 而不是截断。理由：40 字是「像人」的美学，平台上限远高于它；为了美学丢一句话，是拿内容换观感。
5. **自我修正放在套上限之前。** 它会**多出一条**，放后面会让条数先合规、再超标。
6. **自我修正只改形态。** 「我明天要去学校，下午才回来。」→「我明天要去学校，」+「不对，下午才回来。」能读出「改口」，但不编造新事实。真正的语义纠错要模型参与，本插件不做。
7. **有语速增量就不再用档位。** O-031 的雀跃档同时给了 `speechRateDelta 0.1` 与 `tempo 'brisk'`；两个都乘是 1.21 倍——一个参数不该同时表达两件事。
8. **句形档只能减条数，不能加。** `clipped` 压到 2 条、`long-single` 压到 1 条；任何一档都不会把上限顶过 4。
9. **首字延迟不乘深夜系数。** 那是「看到消息到开始打字」的反射，不是打字速度；深夜她更慢，但不该「更迟钝」。
10. **`……` 与 `——` 按一串算一次。** 「……」算 1000ms 是两倍的犹豫，不是四倍的。
11. **切句后必须带走收尾引号。** `「走吧。」` 的 `」` 不跟着走，下一条就会以 `」` 开头——一个很难查的「她说话总是多个引号」。
12. **`start === end` 判空窗口。** 手滑写成 `23:00–23:00` 不应该变成全天深夜（与 O-003 口径一致）。

## 六、多方案说明（§12）

本插件**没有分支**。三处曾考虑分支，最终按「能融就融」合成一个：

| 方案 | 结论 |
|---|---|
| 切句「按标点」vs「按字数」 | ✅ 先按标点、装不下再硬切。两套并存会让同一段话时而 3 条时而 5 条 |
| 超限「截断」vs「尾部合并」 | ✅ 尾部合并（见裁决 4）。截断会静默丢内容 |
| 深夜「乘系数」vs「整体加常数」 | ✅ 乘系数。加常数会让 300ms 的短消息与 6000ms 的长消息加同样多，形状不对 |

## 七、契约对位（不 import，只镜像）

| 上游 | 用到的成员 | 镜像位置 |
|---|---|---|
| O-031 `ondra-emotion-express` | `rhythm(at)` 的 `speechRateDelta` / `tempo` / `sentenceShape` | `ExpressLike` / `RhythmProfileLike` |
| O-003 `ondra-clock` | `withinWindow(start,end,at)` / `minuteOfDay(at)` | `ClockLike` |
| O-005 `ondra-config-schema` | `register(section, owner)` / `resolve(id, layers)` | `ConfigSchemaLike` / `SectionDeclLike` / `FieldSpecLike` |
| O-001 `ondra-identity` | `loggerName(feature)` | `IdentityLike` |

下游（本插件不调用，只被调用）：

| 消费方 | 用到的成员 |
|---|---|
| O-039 `ondra-rhythm-typing` | `plan()` 的 `messages[].text/delayMs/pauseMs` |
| O-033 `ondra-dialogue` | `plan()`（只读，不写） |
| O-125 提示词预览 | `plan()` 与 `split()` 的只读快照 |

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 分条与停顿参数 | 旧项目 `rhythm`（336 行，纯函数 272 行） | 手册 §9.2 实读；原件在旧项目包内 | **AGPL-3.0** | 只读**参数取值与边界取舍**（4 条 / 40 字 / 6 字每秒 / 300·500·150 / 300–6000 / 1.6 / 800–2000 / 0.20 × 3000–9000 / 0.05） | 自研 `text.ts` + `delay.ts` + `service.ts`，切句/装箱/合并全部重写 | 否 |
| 「5 次留 1 次余量」 | 手册 §5.3 防封控（实测 12 拦截 0 误伤） | — | — | 「上限要留余量」这条纪律本身 | 配置 `maxMessages` 的 `max` 锁在 4 | 否 |
| 打字机效果（前端逐字显示） | 生态常见实现（如各类 chat UI 的 typewriter） | — | — | **只作反例**：那是渲染，不是行为。本插件不采用 | 不采用 | 否 |

档位说明：手册 §1.8 把「节奏参数」列为**旧项目已实现的纯函数资产**（不是外部生态），§1.9 待迁清单里也没有它；社区里的打字机效果解决的是「怎么显示」，不是「发几条、等多久」。故〔研〕。

## 九、隔离五问

1. **关掉我，谁受影响？** 只有「分几条、等多久」。O-039 会退回一次性整段发出（`degraded: 'no-rhythm'`），对话照常。
2. **我的状态存在哪？** 仅在内存：`stats()` 的七个计数器。**不落盘、不建表、不注册定时器**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.rhythm`；`stats()` 的 `cappedTurns / overflowTurns` 是探针；计算异常会打 `分条计算异常（已退回一次性整段发出）`。
4. **我依赖谁？缺席时怎么降级？** 见第七节。两个上游全部可缺席：缺 O-031 用默认语速与句形，缺 O-003 用本机时区算深夜。
5. **我和同域的谁共享了可变状态？** 没有。O-031 只读，O-003 只读。

## 十、已知限制

1. **硬切会切在词中间。** 一句 60 字且没有逗号时只能按字数切。中文没有词边界，这是唯一选择——但确实会出现「她一句话说到一半就断在半个词上」。
2. **英文句点不算句末。** `.` 不参与切句（怕把 `3.14`、网址、`e.g.` 切断）。纯英文长句会退化成硬切。
3. **`、` 与 `：` 没有标点附加。** 手册只列了 `。！？` / `……——` / `，；` 三类，没有它们。加进去就是「自定的第四类」，故登记待裁决。
4. **自我修正不是语义纠错。** 它只能把一句话在逗号处断开再补一句「不对，」。真改内容需要模型知道错在哪。
5. **长停顿只插在消息之间。** 单条消息（`messages.length === 1`）不会触发长停顿——没有「之间」可插。
6. **合并后的第 4 条可能很长。** 极端情况下（原文 200 字、句句 40 字）第 4 条会有 80+ 字，只标 `overflow` 不截断。
7. **深夜判定依赖本机时区。** 没有 O-003 时用 `Date.getHours()`；跨时区部署会差几小时。
8. **`……` 会被当作句末。** 「我……我不知道」会切成两条（随后装箱又会并回去，所以多数情况无感；但当总字数接近 40 时会多分一条）。

## 十一、待裁决

1. **合并后超 40 字怎么办**：本插件选「保内容、标 overflow」。若主人要「严格 40 字」，需要决定超出部分怎么处理（截断 / 再分一条 / 拒绝）。
2. **`、` `：` 是否也该有标点附加**（150ms）。手册没列。
3. **长停顿插在哪一条**：本插件在第 2 条及以后均匀随机。手册只说「整轮最多一次」。
4. **自我修正的 3 句模板**：手册只写「3 句模板」，没给句子。当前是「不对，」/「啊，说错了，」/「等等，」。
5. **句形档的系数**（burst 0.75 / clipped 0.5 / long-single 1.5）：手册只说「短句多 2-3 条」「极短常单字」「长句一条说完」，没给数字。
6. **文档级冲突（已登记，未改手册）**：手册第 70 行与第 396 行写「节奏域 272 行纯函数」，master-plan §9.2 写「rhythm，336 行」。**行数口径不一致，参数逐条一致**；本插件按参数执行，行数不影响实现。
