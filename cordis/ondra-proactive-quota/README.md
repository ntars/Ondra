# ondra-proactive-quota

> O-044 · L4 主动（第 8 组第 3 项）· 档位〔研〕 · 服务键 `ondra-proactive-quota`

她此刻还想不想说、今天还剩几句、是不是该退场了。

---

## 一、职责

| 能力 | 方法 | 手册依据 |
|---|---|---|
| 额度档位（缓慢 1 / 标准 3 / 快速 6 条一日） | `quota()` / `patch()` | §9.3 `dailyQuota=3` |
| 两次主动之间的最小间隔 | `interval()` | 台账 O-044（手册未给数值） |
| 性格化沉默（放弃率） | `plan()` 的 `giveUp` | §9.3「放弃率」/ §5.2 `give_up` |
| 连续无回应 → 只说一句退场句 | `streak()` / `plan().action==='retreat'` | §9.3「退场规则」 |
| 一键静音（入口与状态） | `mute()` / `unmute()` | §5.7「节制红线」 |
| 记账（她真的说了） | `commit()` | — |
| 用户开口上报 | `noteUserSpoke()` | — |

**判定顺序（唯一真源：`rules.decide()`）**

```
policy（总开关 / 静音）→ quota（额度）→ interval（间隔）→ retreat（退场）→ give-up（抽签）→ send
```

| 结论 | 动作 | 为什么 |
|---|---|---|
| 额度用完 / 为 0 | `drop` | 今天是真到底了。重排只会在半小时后说同一件事 |
| 未到最小间隔 | `defer` | 时间到了自然该说，丢掉等于把她刚想说的事扔了 |
| 该退场且今天没说过 | `retreat`（**允许发**） | 形态压成一句，不是拒绝 |
| 今天的退场句已说过 | `drop` | 手册写「只说一句」 |
| 抽到性格化沉默 | `drop` | 这一次她把话咽回去；下一窗口重抽 |

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 判断「此刻能不能发」（静默时段 / 速率 / 冷却 / 内容 / 熔断） | `ondra-proactive-gate`（O-042） |
| 群聊不主动（§5.7 红线，无开关） | `ondra-proactive-gate` 的 `policy` 闸 |
| 额度衰减（`≥3 天减半 / ≥7 天归零`） | `ondra-proactive-gate` 的 `budgetOf()` |
| 生成退场句的正文 | 对话链（O-033）+ 话由池（O-043） |
| 挑「说什么」 | `ondra-proactive-reason`（O-043） |
| 排闹钟、投递 | `@ntars/ondra-schedule`（上游） |
| 「今天说了几句」的计数 | `ondra-proactive-gate` 的 `dayCount` |

四条**刻意不做**：

1. **不接 `kind` 参数、不做第二份群聊拦截。** 群聊红线在 O-042 里是硬性质、无开关。两处都判，就会出现「门控说不能发、节律说可以」这类谁也说不清的日志。
2. **不存日计数。** 只经 `peek()` 读 O-042 的 `dayCount`。第二份计数的症状是面板显示 2、判定用 3，且没有任何报错。
3. **不重算额度衰减。** 交给 O-042 的是**未衰减**的档位额度 + 更新过的沉默天数（`patch()`），衰减由它算一次。我们先衰减再传，会被它再减一次——症状是「选了快速档，实际只有 1 条」。
4. **不装定时器、不订阅事件。** 零常驻。所有时间从入参或 `now()` 取。

## 三、服务键与方法

```
ondra-proactive-quota      ← 连字符，不是 ondra:proactive-quota
```

| 方法 | 说明 |
|---|---|
| `plan(request?, at?)` | 判一次「此刻愿不愿意说」。**一个字节都不改状态** |
| `quota(at?)` | 今日额度视图 |
| `interval(at?)` | 间隔视图 |
| `streak(at?)` | 连续无回应视图 |
| `patch(at?)` | 交给 O-042 的两个覆盖值（`dailyQuota` / `silentDays`） |
| `commit(options?, at?)` | 记账：她真的发出去一条（`{retreat:true}` 表示退场句） |
| `noteUserSpoke(at?)` | 上报「用户开口了」：清零连续无回应 |
| `mute(ms, at?)` | 一键静音（在位时转发给 O-042） |
| `unmute()` | 取消静音（两边都清） |
| `flush()` | 强制落盘 |
| `stats()` | 见下 |
| `available` / `reason` | 只看配置开关 |
| `stored` | 状态是否真的落盘 |

**`QuotaPlan`**：`allow / action / gate / code / detail / deferMs / quota / streak / interval / giveUp / retreat / at`

`action`：`send` / `retreat` / `defer` / `drop`；`allow = send || retreat`

`code`（10 个）：`ok` / `disabled` / `muted` / `quota-zero` / `quota-exhausted` / `interval` / `retreat` / `retreat-sent` / `give-up` / `internal-error`

**`QuotaView`**：`profile / base / effective / used / remaining / source`

`source`：`gate`（读的是 O-042 的日计数与衰减，可信）/ `local`（O-042 缺席，`used`/`remaining` 是空转值，**额度闸停用**）

**`QuotaPatch`**：`{ dailyQuota, silentDays? }`——本插件与 O-042 之间**唯一的数值通道**

**`QuotaStats`**：`calls / allowed / retreats / deferred / dropped / gaveUp / byGate[6] / marks / userSpoke / writes / writeFailures / errors / stored / quota`

**典型接线**

```ts
const quotaPlan = quota.plan({ topicKey: candidate.topic })
if (!quotaPlan.allow) return                    // 她这次不想说
const verdict = gate.gate({ ...request, ...quota.patch() })
if (verdict.action !== 'send') return
await send(text)
quota.commit({ retreat: quotaPlan.action === 'retreat' })   // 发送成功后记账
```

`commit()` 必须在**发送成功之后**调：记账即事实，失败也记会让间隔与退场计数偏离真实。

## 四、配置

| 键（camelCase） | 段字段（kebab） | 默认 | 依据 |
|---|---|---|---|
| `enable` | `enable` | `true` | — |
| `profile` | `profile` | `standard` | §9.3 原值 3 条；`slow` 1 / `fast` 6 为推算 |
| `quotaOverride` | `quota-override` | `0` | 高级模式；`0` = 跟随档位，上限 20 |
| `minIntervalMinutes` | `min-interval-minutes` | `90` | 手册未给，自定 |
| `giveUpRate` | `give-up-rate` | `0.30` | §9.3 原值 30%（§5.2 写 35%，见待裁决 2） |
| `retreatAfterProactive` | `retreat-after-proactive` | `2` | §9.3「已主动说 2 次」 |
| `retreatSilentDays` | `retreat-silent-days` | `2` | §9.3「silentDays≥2」 |
| `retreatPerDay` | `retreat-per-day` | `1` | §9.3 只说「一句」；上限自定 |
| `verbose` | `verbose` | `true` | 只影响噪声 |

段键 `proactive-quota`。**「关闭」没有第四个档位**：`enable=false` 就是关闭。两个「关」并存的下场是用户关了一个、另一个还在工作，而面板只说「已关闭」。

## 五、关键裁决

1. **退场排在抽签之前。** 退场句是纪律性的一句，不该被性格化沉默抽掉——抽掉的后果是她一声不响地消失，而 §9.3 那条规则的本意正相反：要体面地收尾。
2. **抽签用确定性哈希，不用 `Math.random()`。** 30% 的随机数**每重试一次就重抽一次**：一轮里试 5 次，实际放弃率会掉到 17%（`1−0.7⁵`），而日志每一行都写着「抽到放弃」。种子是 `(自然日, 话题键, 间隔窗口)`，同一件事同一窗口恒定，换窗口才重抽。实测 3000 次抽样放弃率 0.2997。
3. **种子里的「间隔窗口」是刻意加的。** 只按 `(日, 话题)` 抽的话，同一件事一整天只有一个结果——上午抽到放弃，下午她仍不说话，用户看到的是「她一整天没理我」而不是「她这次没想说」。
4. **额度衰减只算一次，且在 O-042 那边。** `patch()` 交出去的是**未衰减**的档位额度。反过来做会被再减一次，症状是「选快速档只有 1 条」，而且没有任何报错。
5. **`silentDays` 由本插件算、由 O-042 判。** 手册的 3 天/7 天阈值在 `budgetOf()` 一处；本插件只把**更新过的**天数交回去。理由：O-042 的 `lastUserAt` 只在「回话经过门控」时更新，用户说话了但她没回（静音/深夜）时它会一直以为自己还在被冷落，额度就永远压在减半档。
6. **`plan()` 不改状态。** 面板每几秒刷一次「她此刻愿不愿意说」，刷一次若记账，间隔闸会被面板刷满，而她永远没话说、原因还查不出来（§15-73）。
7. **内部错误「放行」，与 O-042 刻意相反。** 判定是纯算术，抛错说明本插件有 bug。拦下 → 一次 bug 让她从此不主动、且无界面提示（没人会去查一个叫 quota 的插件）；放行 → 最多多说一条，防封与内容硬闸仍在 O-042 手里。手册 §8.1 C3「异常转 degraded 返回空」，对一个**限制型**服务来说「返回空」就是「不施加限制」。
8. **`retreat` 是允许发，不是拒绝。** 把它当拒绝的调用方会得到「该收尾时反而不说话」——比不说更冷。
9. **静音是 `drop` 不是 `defer`。** `defer` 会在解除静音那一刻把攒下的话一次说出来（与 O-042 同一判断）。
10. **普通主动消息不吃「今天那句告别」。** `commit()` 只在 `{retreat:true}` 时递增当日退场计数；否则一条普通消息会把当天的退场额度用掉，而 `retreat` 从此永远发不出来。
11. **`available` 只看开关。** 没有 O-042 是「降级」不是「不可用」（§15-49）：报成不可用会让下游启用另一套兜底，两套兜底一撞，界面值来回跳。
12. **`mute()` 转发失败不当作成功。** 退回本地记录并 warn——「面板说已静音、判定说没静音」是最难查的一类不一致。
13. **状态与 O-042 分两个文件。** 两个写者共用一个 JSON 必然后写覆盖先写，症状是「计数偶尔回退」，两边都查不出原因。

## 六、多方案说明（§12）

本插件**没有分支**。三处曾考虑分支，都按「能融就融」合成一个：

| 方案 | 结论 |
|---|---|
| 抽签：`Math.random()` vs 确定性哈希 | ✅ 哈希。随机数会被重试刷低放弃率，且评估集无法复现 |
| 额度：本插件算衰减 vs O-042 算 | ✅ O-042 算。双份衰减的 bug 静默且难查；本插件只交**未衰减**值 |
| 一键静音：自己拦 vs 转发 O-042 | ✅ 转发 + 本地兜底。O-042 是唯一执行点，本插件只补入口 |

## 七、契约对位（不 import，只镜像）

| 上游 | 用到的成员 | 镜像位置 |
|---|---|---|
| O-042 `ondra-proactive-gate` | `peek(at?)` → `{ at, budget{dayKey,quota,used,remaining,silentDays}, mutedUntil }`；`mute(ms, at?)`；`unmute()` | `GateLike` / `GateSnapshotLike` / `BudgetViewLike` |
| O-003 `ondra-clock` | `dayKey(epoch?)` | `ClockLike` |
| O-002 `ondra-path-layout` | `fileIn('user', …)` / `prepareFile(path)` | `PathLike` |
| O-005 `ondra-config-schema` | `register` / `resolve` | `ConfigSchemaLike` / `SectionDeclLike` / `FieldSpecLike` |
| O-001 `ondra-identity` | `loggerName(feature)` | `IdentityLike` |

**本插件只调 O-042 的 `peek()` 与 `mute()`，绝不调 `gate()`**：调它会消耗额度与冷却，等于本插件替她发了一条。

下游（本插件不调用，只被调用）：

| 消费方 | 用到的成员 |
|---|---|
| 主动编排（上层调度 / O-042 的调用方） | `plan()` → `patch()` → `gate()` → 发送 → `commit()` |
| 界面层 | `quota()` / `interval()` / `streak()` / `stats().byGate` |
| 通道层 | 发送成功后 `commit()`；用户说话时 `noteUserSpoke()` |

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 主动三闸门 | 手册 §5.2（旧项目 proactive 562 行实读） | — | — | 「时机 / 话由 / 分寸」三分；节奏参数 `idle 25 / quota 3 / give_up 0.35 / quiet [23,8] / 3 天减半 7 天停` | 只取「分寸」里最软的一半，硬闸留给 O-042 | 否 |
| 主动参数表 | 手册 §9.3 | — | — | `dailyQuota=3`、退场规则（`silentDays≥2` 或「已主动说 2 次」）、状态落盘（0600 + 原子写） | 落成 `PROFILE_QUOTA` 与 `retreatOf()` | 否 |
| 节制红线 | 手册 §5.7 | — | — | proactive 频率上限、群聊不主动、一键静音 | 频率上限 = 档位 + 间隔；群聊归 O-042；静音转发 O-042 | 否 |
| 定额与节流 | `@ntars/ondra-schedule`（宿主体内） | 仓内 `desktop/packages` | Apache-2.0 | 只确认「定时与投递已有上游」，故本插件不做任何定时 | 零常驻，`plan()` 由调用方驱动 | 否（不 import） |
| 确定性抽签 | FNV-1a 32 位（公开算法，无实现依赖） | — | 公有领域 | 哈希算法本身 | `rules.drawOf()` 手写 8 行 | 否 |
| 额度衰减 | O-042 `ondra-proactive-gate` | 仓内 | 本项目 | **复用**：`budgetOf()` 的减半/归零规则 | 只消费，不重算 | 否（经服务键调用） |

**档位说明：〔研〕。** 手册 §1.8 的复用档里没有「主动节律」：生态里的主动消息实现都是「定时 + 模板」，没有「她今天还想不想说」这一层；而「节制设计」在 §1.8 里被明确列在**自研**档。厚度仍然很薄：一张六行判定表 + 一张三行档位表 + 一个 8 行哈希。

**生态核对结论（§1.8 判定纪律）。** 本仓 `desktop/packages` 下与「主动」相关且可复用的只有 `@ntars/ondra-schedule`（定时与冷会话唤醒，已读源码），它是**上游触发层**，不含额度/放弃率/退场的任何语义。故本插件不与它竞争，也不重写它。

## 九、隔离五问

1. **关掉我，谁受影响？** 只剩 O-042 的硬闸，主动消息会按它的 `dailyQuota` 全量发出——没有间隔、没有性格化沉默、没有退场句。回话完全不受影响（本插件只服务主动）。`enable=false` 时服务仍注册，`plan()` 返回 `drop/disabled`。
2. **我的状态存在哪？** `user/proactive-quota.json`（0600、临时文件 + rename）。内容只有六个字段：`lastProactiveAt` / `proactiveSinceUser` / `lastUserAt` / `retreatDayKey` / `retreatDayCount` / `mutedUntil`。**不建表、不装定时器、不订阅事件**。与 O-042 的 `proactive-state.json` 是两个文件。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.proactive-quota`；探针是 `stats().errors`（判定抛错，且此时是**放行**）、`stats().byGate`（哪一道在拒）、`stats().gaveUp`（性格化沉默占比）、`stats().writeFailures` 与 `stored`（写盘是否掉队）、`quota().source`（O-042 在不在位）。
4. **我依赖谁？缺席时怎么降级？** 见第七节。缺 O-042 → `quota().source='local'`、额度闸停用、静音只在本插件生效（一条 warn）；缺 O-002 → 纯内存 + 一条 warn；缺 O-003 → 自然日键退回本机时区；缺 O-005 → 插件实例配置；缺 O-001 → 固定日志前缀。**没有一个依赖会让插件停在 PENDING。**
5. **我和同域的谁共享了可变状态？** 没有。O-042 只经 `peek()` 与 `mute()` 调用（前者只读、后者是用户按的开关，不是共享内存）；两个插件各写各的文件。

## 十、已知限制

1. **没有 O-042 时额度闸停用。** 本插件不存日计数（那是 O-042 的 `dayCount`），拿不到就只剩间隔 + 退场 + 抽签。`quota().source='local'` 时 `used` / `remaining` 只是空转值，**不可当作真实额度**。这个降级是刻意的：编一个 0 出来会让她在没装门控的部署里无限说下去。
2. **`silentDays` 依赖调用方上报 `noteUserSpoke()`。** 若通道层不上报，就只能退回 O-042 的 `silentDays`（它只在「回话过闸」时更新），于是用户回来了但额度仍停在减半档。
3. **退场句的正文不在这里。** `plan()` 只给 `action='retreat'`，文案归 O-043 的台词池或 O-033 的装配。代价：调用方若不认 `retreat`，退场会退化成一条普通消息。
4. **`retreatPerDay` 的上限是自定的。** 手册只写「只说一句」。当前默认每天一条；跨日靠 `dayKey`，故跨时区部署时「每天」的边界随 O-003 的时区走。
5. **放弃率是「条」维度的，不是「天」维度的。** 抽签以间隔窗口为粒度：90 分钟一抽。一天 3 条额度、每 90 分钟一次尝试，理论上一天最多 10 次抽签——但额度闸先挡住，实际不会超过 3 条。
6. **`draw` 入参可绕过抽签。** 它是给评估集复现与面板演示用的；正常路径不传。传了就等于关掉「重试不能改抽签结果」这条保护。
7. **不做「跨会话累计的连续无回应」。** `proactiveSinceUser` 是全局一个计数，不按会话分。多会话并行时，A 会话的沉默会让 B 会话也进退场——手册没有多会话口径，这里选最简。

## 十一、待裁决

1. **`slow` / `fast` 的数值。** 手册只给 `dailyQuota=3`。`slow=1`（一半）、`fast=6`（两倍）是推算，且都远低于上限 20。改一处：`types.PROFILE_QUOTA`。
2. **放弃率 30% 还是 35%。** §9.3 写 30%，§5.2 写 `give_up 0.35`。按「§9.3 是参数表、§5.2 是概述」取 **30%**，两处都保留在文档里。改默认值只需一行。
3. **`minIntervalMinutes=90` 没有出处。** 手册没给「两次主动之间至少隔多久」。90 分钟的依据是「3 条额度摊在 15 小时清醒窗口里约 5 小时一条」，取 90 分钟作硬下限——远小于自然间隔，只挡「一分钟一条」。
4. **`retreatPerDay=1`。** 手册只说「一句」。若主人认为「一天说过一次退场后，用户又开口、又沉默两天」该再给一次，把它调大即可（当前逻辑天然支持）。
5. **退场句要不要受额度约束。** 当前受（额度为 0 时不发退场句，`quota-zero` 优先）。另一条路是「退场句不占额度」——但那会让「额度用完之后再补一句告别」变成绕过额度的缺口。
6. **`quotaOverride` 是否该存在。** §3.3-2 要求「高级模式才露具体数值」，故保留。代价：它与 O-042 的 `dailyQuota` 是同一件事的两个旋钮，本插件在位时以它为准（启动日志会明说）。若主人认为只该有一个旋钮，删掉 `quotaOverride` 并把档位表直接写进 O-042 的配置即可。
