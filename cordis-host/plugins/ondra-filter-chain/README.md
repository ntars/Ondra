# ondra-filter-chain

> O-037 · 表达层 · 档位〔研〕 · 服务键 `ondra-filter-chain`

一句话在发出去之前，要过九道手。

---

## 一、职责

**九步过滤链**（手册 §4.1，P0）+ **锚点检测**（§4.6）+ **事后评审回环**（§1.7）。

九步与手册逐字对照：

| # | 本插件 id | 手册原名 | 中文 | 动作 | 靠什么判 |
|---|---|---|---|---|---|
| 0 | `strip-draft` | `strip_draft` | 草稿腔 | 删整句 | 内置句式表 |
| 1 | `ai-self-expose` | `ai_self_expose` | AI 自我暴露 | 删整句 | 内置句式表 |
| 2 | `hard-redline` | `hard_redline` | 硬红线 | 删整句 | O-021 `boundaries(hard)` 抽字面 + 配置补充 |
| 3 | `relation-redline` | `relation_redline` | 关系越线 | 删整句 | O-021 `variant().cautions` 抽字面 + 配置补充 |
| 4 | `stage-redline` | `stage_redline` | 阶段越线 | 删整句 | O-028 阶序 + 内置 7 条表 |
| 5 | `narration-trim` | `narration_trim` | 旁白叙述 | 删整句 | 内置句式表（短的第一人称动作保留） |
| 6 | `repeat-4gram` | `repeat_4gram` | 4-gram 复读 | 删整句 | 段内重合 + 最近 3 条她说过的话 |
| 7 | `service-tone` | `service_tone` | 客服腔 | 删整句 + `您→你` | 内置句式表 |
| 8 | `length-fallback` | `length_fallback` | 长度兜底 | 尾部整句删 | 配置上限（困 ×0.6 / 炸毛 ×0.7） |

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 生成正文、重写整段 | `ondra-dialogue`（O-033） |
| 六态判定、语速与句长系数 | `ondra-emotion-express`（O-031） |
| 内感受投影文本（禁报数） | `ondra-emotion-project`（O-032） |
| 提示词拼装、把纠偏塞进下一轮 | `ondra-dialogue` / `ondra-prompt-inject`（O-033 / O-036） |
| 分条、停顿、打字速度 | `ondra-rhythm`（O-038） |
| 语感统计（中位句长等） | `ondra-lexicon`（O-137） |

四条**刻意不做**：

1. **不生成正文。** 只删、只拒收。让她「重说一句」是 O-033 的事——本插件一旦会生成，就会出现两份正文对不上的问题。
2. **不做需要第二个模型的语义判定。** 「这句是不是违反了第 3 条红线」要理解语义；本插件只做字面与句式的确定性判定。**误杀比漏拦危险得多**。
3. **不在句中切。** 只有两处例外，且都在报告里可见：①旁白摘掉**成对的括号片段**（`（低头看了一眼手机）我不累。` 在文本上是一句，按整句摘会把「我不累」一起删）；②长度兜底在「第一句本身就超长」时硬切（`hardCut` 点名）。
4. **不把纠偏写进提示词。** `anchors()` 只出那句话，注入归 O-033 / O-036。

## 三、服务键与方法

```
ondra-filter-chain        ← 连字符，不是 ondra:filter-chain
```

| 方法 | 说明 |
|---|---|
| `steps()` | 九步声明（顺序固定，含手册原名） |
| `run(input)` | 跑九步，返回 `ChainResult`。**永不抛出** |
| `anchors(input)` | 锚点检测（词汇 / 策略），返回命中 + 纠偏句 |
| `review(input)` | 事后评审（异步）。`turnId` 是「每轮最多 2 次」的计数键 |
| `resetTurn(turnId)` | 新一轮开始时清计数 |
| `stats()` | 见下 |
| `available` / `reason` | 只看配置开关（降级 ≠ 不可用） |

`run()` 的入参：`text` / `userText?` / `relation?` / `stageOrder?` / `recent?` / `at?` / `maxChars?`。

`ChainResult` 字段：`ok / text / originalChars / finalChars / steps / hits / blockedBy? / needsRegenerate / hardCut / maxChars / elapsedMs`。

`ReviewOutcome`：`ok / score? / verdict / feedback / round / reason?`；
`verdict` 四值：`pass`（达标）/ `steer`（带反馈回去重写）/ `degraded`（评审不可用，**放行**）/ `round-limit`（本轮已评 2 次）。

`stats()`：`available / reason? / runs / lastRemoved / lastNeedsRegenerate / reviews / steers / roundLimited / sources{persona,stage,express,gateway}`

## 四、配置

| 键（camelCase） | 段字段（kebab） | 默认 | 依据 |
|---|---|---|---|
| `enable` | `enable` | `true` | — |
| `maxChars` | `max-chars` | `400` | 手册未给（自定） |
| `minChars` | `min-chars` | `2` | 少于它就判「说没了」 |
| `repeatNgram` | `repeat-ngram` | `4` | 手册原文叫 4-gram |
| `repeatThreshold` | `repeat-threshold` | `0.6` | 自定 |
| `repeatRecentCount` | `repeat-recent-count` | `3` | 自定 |
| `hardRedline` | `hard-redline` | `true` | — |
| `relationGuard` | `relation-guard` | `true` | — |
| `stageGuard` | `stage-guard` | `true` | — |
| `stripParenthetical` | `strip-parenthetical` | `true` | 短的第一人称动作始终保留 |
| `youFormal` | `you-formal` | `true` | 「您」是客服腔最明显的一个字 |
| `redlinePatterns` | `redline-patterns` | `[]` | 作者补充 |
| `relationPatterns` | `relation-patterns` | `[]` | 作者补充 |
| `emotionShrink` | `emotion-shrink` | `true` | 系数自定（0.6 / 0.7） |
| `reviewEnabled` | `review-enabled` | `true` | — |
| `reviewThreshold` | `review-threshold` | `70` | 自定 |
| `reviewMaxRounds` | `review-max-rounds` | `2` | 手册 §1.7 逐字 |
| `reviewSource` | `review-source` | `''` | 空 = 按网关优先级 |
| `reviewTemperature` | `review-temperature` | `0.2` | 打分要稳 |
| `verbose` | `verbose` | `true` | 只影响噪声 |

## 五、关键裁决

1. **只删整句，绝不切字。** 被切掉半句的「不行」会变成「不」，被截断的「我有点难过」会变成「我有点难」。切出来的半句读起来仍然通顺，只是意思变了——这类错没人会归因到过滤链。
2. **越线类不靠删词修。** 关系/阶段越线的句子删掉半截就是病句，所以只做「整句摘除」；摘完一句不剩就整段拒收（`needsRegenerate`）。
3. **关系分寸是数据，不是表。** 从 O-021 的 `cautions` 里抽**引号字面**与「不得…」短语；抽不出就不命中。替人设作者决定「什么关系不能说什么」比漏拦危险。
4. **阶段越线用 7 条小表，只拦表内句式。** 表是产品判断（手册只写「阶段越线」四个字），登记待裁决。表外一律放行。
5. **旁白只摘第三人称。** 判据两条：括号里以「她/他」开头，或长于 12 字。「（伸了个懒腰）」这种短的第一人称动作是呼吸感（§4.2，归 O-041），摘掉等于把「像人」的那一点削平了。括号**先按成对片段摘**，再按整句判——否则「（…）我不累。」会连正文一起没。
6. **复读用「被包含比例」而不是 Jaccard。** 一句 20 字的话与一段 200 字的话，Jaccard 天生很低，但它可能整句都是复读；分母取「这一句」才是对的问题。
7. **评审失败一律放行。** 超时、乱码、网关缺席都归 `degraded`。评审是增强，不是闸门——让它能把一句话拦死，等于把可用性押在第二个模型上。
8. **及格线用 `>=`。** 写成 `>` 会让「刚好 70 分」反复重写，而模型每次重写都可能在 69/71 之间跳——那就是一个停不下来的回环。
9. **长度上限只有一个解析点。** 情绪收紧（困 ×0.6 / 炸毛 ×0.7）也在 `effectiveMaxChars()` 里，散到两步去算就会出现「报告说 400、实际裁到 240」。
10. **删空不编话。** `ok=false` + `needsRegenerate=true`。编一句「嗯…」顶上，就是本插件在替她说话。
11. **`hardCut` 必须可见。** 唯一会切在句中的情况，写进 `ChainResult`，面板与日志都能看见。

## 六、多方案说明（§12）

本插件**没有分支**。一处曾考虑分支，最终按「能融就融」合成一个：

| 方案 | 结论 |
|---|---|
| 评审「同步阻塞」vs「异步放行」 | ✅ 异步放行。同步会让「评审超时」直接变成「她这轮不说话」 |
| 复读判定「Jaccard」vs「被包含比例」 | ✅ 被包含比例（见裁决 6）。两套并存会让同一对句子时而判复读时而判不复读 |

## 七、契约对位（不 import，只镜像）

| 上游 | 用到的成员 | 镜像位置 |
|---|---|---|
| O-021 `ondra-persona-core` | `boundaries()`（`text/hard`）、`variant(id).cautions` | `PersonaLike` / `BoundaryLike` / `VariantLike` |
| O-028 `ondra-emotion-stage` | `view(at).spec.order` | `StageLike` / `StageViewLike` |
| O-031 `ondra-emotion-express` | `profileOf(at).rhythm.{silenceBias,proactivePaused}` | `ExpressLike` / `ExpressProfileLike` |
| O-035 `ondra-llm-gateway` | `complete({messages,temperature,maxTokens,purpose,source?})` | `GatewayLike` / `GatewayRequestLike` |

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 输出评审打分 | ondra-answer-reviewer | 手册 §1.8 记载 | — | 「独立模型打分 + 阈值 + 反馈回环」的流程形状（**未读源码**） | 自研 `review.ts`：固定两行输出协议 + 严格解析 | 否 |
| 角色崩坏对策 | 手册 §4.6 自身 | — | — | 词汇/语义/策略/历史四类锚点与「连续 3 轮附和」阈值 | 自研 `anchors.ts`（只做可确定性判定的两类） | 否 |
| 九步过滤链 | 旧项目参考实现（627 行 + 12 测试） | 手册 §1.9 待迁资产 | **AGPL-3.0** | **只读思路与参数口径，绝不复制代码**（§9.1 许可红线） | 自研 `passes.ts`：句式表 + 句级摘除 | 否 |

档位说明：手册 §1.8 把「输出过滤九步——复读/旁白/客服腔逐条剥离」明确列进自研档（P0），理由原文是「社区做评审打分，不做逐条剥离」。故〔研〕。

## 九、隔离五问

1. **关掉我，谁受影响？** 只有「发出去之前那一道手」。对话照常进行，只是草稿腔与旁白会漏出去。
2. **我的状态存在哪？** 仅在内存：计数与「每轮评审次数」的 Map（`resetTurn()` 可清）。**不落盘、不建表**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.filter-chain`；`stats()` 的 `lastRemoved / lastNeedsRegenerate / sources` 是探针；单步异常会打 `过滤第 X 步异常（已跳过）`。
4. **我依赖谁？缺席时怎么降级？** 见第一节。四个上游全部可缺席：缺 persona 少两步、缺 stage 少一步、缺 express 用默认上限、缺 gateway 评审放行。
5. **我和同域的谁共享了可变状态？** 没有。所有上游只读。

## 十、已知限制

1. **两种锚点没实现。** 语义锚点（「你不懂」→ 把整轮理解成被否定）与历史锚点（早期设定压过后来 20 轮证据）需要理解语义，靠词表判必然误杀。面板只会看到词汇与策略两种。
2. **越线检测只认字面。** 换一种说法就拦不住（「你只能是我一个人的」不含表内任何一条）。这是刻意的：宁可漏拦，不做语义猜测。
3. **阶段越线表只有 7 条。** 手册只写「阶段越线」四个字，这七条是产品判断。
4. **删句可能留下不平衡的引号。** 若一句引号内的台词被整句摘掉，剩下的收引号可能没有配对。当前不做配对修复——修复要猜「这句本来该由谁来说」。
   括号片段不会：`stripParentheticalSpans()` 只摘**成对**的，没闭合就原样留着（不猜它到哪儿结束）。
5. **`hardCut` 会切在句中。** 只有「第一句本身就超过上限」这一种情况，且会在结果里标出来。
6. **复读判定对短句不敏感。** 少于 `repeatNgram` 字的句子（「嗯」「好呀」）不参与，它们本来就不是复读。
7. **评审不校验「反馈是否可执行」。** 模型给一句「再自然一点」，steer 回去也没用；本插件只负责把话带到。

## 十一、待裁决

1. **所有阈值**（`maxChars 400` / `repeatThreshold 0.6` / `reviewThreshold 70`）手册都没给，全是自定。改配置即改口径。
2. **阶段越线 7 条表**：句式与最低阶序都是产品判断。
3. **情绪收紧系数 0.6 / 0.7**：手册只说困与炸毛「话少」，没给数字。
4. **「长度兜底」的语义**：本插件读作「超长从尾部整句删 + 删空则拒收」。若主人的原意是「太短就补一句」，那与本插件「不生成正文」的红线冲突，需要另议。
