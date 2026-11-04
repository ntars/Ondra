# ondra-failure-attrib

> O-139 · 〔研〕自研 · 手册 §8.6「上下文经济」 · P1 · 批次 B6（运行时治理）
> 服务键 **`ondra-failure-attrib`**（连字符，符合 §8.4）

## 一、职责

每次工具调用结束，把「失败了」拆成八类中的一类 → 开一个伤口 → 同一个工具下次成功时闭合 →
五分钟不闭合标 `chronic` 并停止空转。

手册原话：「**Ondra 现在只有『静默降级』，没有归因。**」
静默降级的后果不是难看，是**学不到东西**：同一个错犯一百次，每次都被吞掉，下次还是不知道为什么。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 不做重试的执行 | 上游 `tools/execute`（超时/重试包装）与本包的 `shouldRetry()` 判据 |
| 不改写工具结果（不做 `tools/post-execute` 的 `add context`） | 工具自己的输出契约 + O-036（注入） + CoT 锚 |
| 不给模型加「查失败」的工具 | 与本包省 token 的定位相反（B6 主题） |
| 不做提示词片段 | O-036 `ondra-prompt-inject` / O-132 的片段拼装 |
| 不做界面与 Toast 文案 | 应用外壳（原 O-089 `ondra-ui-toast` 已随 L8 下线，副本一并移除） |
| 不落盘 | 账本随进程生死：伤口是「现在好不好使」，重启后重算即可 |

### 三条刻意的「不做」

1. **不在 `tools/post-execute` 里把处方塞回模型眼前。** 那条路会撞上工具自己的
   输出契约（上游有 `finalizeContent` 的「仅限内容」不变式）。处方是给**调用方**的裁决，
   不是给模型的提示词。
2. **不装定时器。** chronic 的标记搭在「有工具结果发生」上（`handle()` 里顺手 sweep）。
   一个从不产生工具结果的进程，伤口本来也不会增长。
3. **不淘汰旧伤口。** 账本满了就拒绝新伤口并计 `refused`。淘汰最老的会让 chronic
   记录悄悄消失——那等于删证据，而报告上一切正常。

## 三、为什么它是**策略层**、以及为什么它是「喂食者」

`ondra-organ-host` 的门面只有十个成员，里面**没有**「订阅上游事件」。器官只能通过
`onToolResult` 收结果，而那个方法要有人**喂**。O-132 自己不装监听器（它连定时器都不装）。

所以本包承担一个明确角色：**上游 `tools/result` → 器官 ABI 的唯一接线点**。
它把每个结果转成 `ToolResultView` 推给 `host.toolResult()`。

把自己做成器官再喂自己，是闭环不是设计。所以本包按策略层实现，与上游
`timeout-policy` 同类；但 **C3 的精神照守**：整条处理链 try/catch，
异常降级、绝不传播（归因在工具返回的临界路径上）。

> 「唯一喂食者」是**约定**，不是结构保证。若将来出现第二个喂食者，器官会收到两份
> 同样的结果——所以给了 `feed-host` 开关。

## 四、八类与处方表

八类的名字是手册逐字给的，一个字不改。**`derived: false` 只有 `arg_error` 一行**
是手册原文，其余七行是本包推导，逐行标出依据。

| 类 | 裁决 | 动作 | 处方（一句话） | 手册原文？ |
|---|---|---|---|---|
| `tool_missing` | `manual` | `install` | 这个工具不存在：先确认它有没有装，再换一条能走的路 | 推导 |
| `arg_error` | **`never`** | `fix-args` | 参数不对，重试一百次还是同一个错：先看清要什么 | **原文** |
| `permission` | `never` | `escalate` | 没有权限，再试也不会突然有：要人授权 | 推导 |
| `timeout` | `retry` | `retry-later` | 这次没赶上，退一步再试一次 | 推导 |
| `network` | `retry` | `retry-later` | 网络这一下没通，退一步再试一次 | 推导 |
| `not_found` | `manual` | `supplement` | 要找的东西不在那儿：先确认它在哪 | 推导 |
| `conflict` | `manual` | `inspect` | 两边对不上：先看清哪一边是对的 | 推导 |
| `unknown` | `retry`（限 1 次） | `inspect` | 不知道为什么：只试一次，再不行交给人 | 推导 |

**八张处方里只有两张的方向是「再试一次」。** 其余六张全是「先补上缺的那一块」——
手册对这件事说得最重：「Agent 犯错是结构性的（脑子里缺信息）不是 bug」。

### `arg_error` 的铁律在哪一行

```ts
export function retryBudget(cause, maxRetries) {
  if (cause === 'arg_error') return 0   // ← 在查表之前。改表改不掉它。
  ...
}
```

**不在表里。** 表可以被配置覆盖、可以被后来的人改；铁律不行。要违反它必须删掉这行代码。

### 判定顺序

先看 `error.info.code`（协议码），再看 `error.message`（文本）。
这个顺序不能反：`UNKNOWN_TOOL` 那句 `unknown tool "foo"` 会被「not found」类抢走，
而这两类处方完全不同（缺件要装 vs 路径写错）。

**不读 `info.name`**：那是错误类名（`ToolNotFoundError`），随重构改名；
`info.code` 才是上游文档说的「给策略层用的那一层」。

## 五、伤口的三条判定

1. **按「工具」记，不按「工具×因」记。** 一个工具同时因两个原因失败，仍是
   「这个工具现在不好使」一件事。但**每个原因的次数分开记**（`byCause`）——
   O-144 的判据是「同工具 × 同因失败 3 次」，合并计数会把两个病因凑成 3 次。
2. **只在该工具下一次成功时闭合。** 不是超时闭合，不是「过了就好」，也不是别的工具成功了。
3. **5 分钟未闭合标 `chronic`**（`chronic-after-ms = 300000`，手册逐字），标了就**停止空转**。

## 六、配置

段键 `failure-attrib`（O-005 配置真源），字段键全连字符。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enable` | true | 关掉后服务仍注册（`available=false`），也不喂宿主 |
| `chronic-after-ms` | 300000 | **手册逐字 5 分钟** |
| `max-open-wounds` | 256 | 满了拒绝新伤口并计数，不淘汰旧的 |
| `max-healed-history` | 100 | 已闭合历史条数（只在内存） |
| `max-text-chars` | 500 | 喂宿主的正文上限 |
| `max-retries` | 2 | 只管超时 / 网络；`unknown` 恒 1，其余恒 0 |
| `feed-host` | true | 是否喂 O-132 宿主 |
| `verbose` | false | 每次归因一行日志 |

## 七、服务面

```ts
ctx.get('ondra-failure-attrib')
  .available / .reason
  .classify({ tool, code, message })   // 纯归因，不记账
  .prescription(cause)                 // 八张处方之一，永远取得到
  .shouldRetry(cause, attempts)        // arg_error 恒 false
  .noteFailure(input)                  // 归因 + 开伤口（供非工具路径调用）
  .noteSuccess(tool)                   // 闭合（供非工具路径调用）
  .wounds() / .woundOf(tool)           // 未闭合伤口
  .sweep(at?)                          // 手动推进 chronic 判定
  .healed(limit?)                      // 已闭合历史
  .report()                            // { wounds, byCause, healRate }
  .stats()                             // 含 results / failures / feeds / unnamed
  .dispose()
```

`failures` 与 `successes` 分开计，且 `results = failures + successes + unnamed` 恒成立
（`unnamed` = 没有工具名、或结果形状不可识别）。这样「没在记」与「在记但都成功」
才区分得开——一个恒为 0 的 `failures` 在两种情况下长得一模一样。

## 八、隔离五问（§16.4）

1. **关掉我，谁受影响？** 器官的 `onToolResult` 收不到东西（O-132 自己不会喂）；
   归因与处方查询返回空。**不影响任何工具的执行**——本包只读结果。
2. **我的状态存在哪？** 只在内存：伤口账本 + 已闭合历史（各带上限）。**不落盘**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.failure-attrib`；
   服务上 `available` / `stats().feedErrors` / `report().wounds.refused` 三个读数。
4. **我依赖谁？缺席时怎么降级？** `ondra-organ-host`（软：不在就只归因不喂）、
   `ondra-clock`（软）、`ondra-config-schema`（软）。**`tools` 事件全软**：
   没有事件就是 `results = 0`，不报错。
5. **我和同域的谁共享了可变状态？** 没有。账本独占；`handle()` 只读上游已冻结的结果。

## 九、多方案分支说明（§12）

| 能力 | 方案 | 处理 |
|---|---|---|
| 归因来源 | A `info.code` 优先（本包） / B 只看文本 / C 调小模型分类 | **A**。B 会把结构化信息丢掉；C 在工具临界路径上（反模式④），且不可解释 |
| 伤口键 | A 按工具（本包） / B 按「工具×因」 | **A**。手册主体是「器官下次成功才闭合」；分因计数由 `byCause` 承担 |
| chronic 的触发 | A 搭在「有结果发生」上（本包） / B 定时器 | **A**。B 与「零常驻」冲突；没事件就不会有新伤口 |
| 喂宿主 | A 由本包喂（本包） / B 由 O-132 自己装监听 | **A**。B 要改已 `done` 的 O-132（§16.3 禁止） |

## 十、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 八类失败归因 + 处方 | agent-body | `github.com/1420079678-ctrl/agent-body` | MIT | 八个类名的划分、每类有处方、`arg_error` 不重试、伤口下次成功才闭合、5 分钟 chronic（21 伤口 100% 愈合、0 chronic 的实测口径） | 自研 `classify.ts` + `prescribe.ts` + `wounds.ts` | 否 |
| 工具结果观测点 | DSH 上游 `@ntars/ondra-tools` | 本仓 `desktop/packages/core/tools` | 随仓 | `tools/result` 是「冻结、可无损 JSON 表示」的最终结果且监听器抛错被隔离 | 直接订阅该事件（复用，不是自研） | 否（只订阅事件） |
| 重试裁决的分级 | DSH 生态 .ondra.answer-reviewer` / 通用重试策略 | — | — | 「永不重试 / 要人动手 / 可退避重试」三档比布尔更少误判 | `RetryVerdict` 三档，取值与 O-089 逐字一致 | 否 |

档位判定：**〔研〕自研**。生态里的重试库都是**通用 HTTP/SDK 重试**（按状态码退避），
没有一个是「按 agent 的失败归因给处方、并维护伤口闭合状态」的。
但**观测点与数据结构完全复用上游**，自研的只有品类划分、处方与账本。

## 十一、已知限制

1. **曾有重复真源，现已收敛。** 原 `ondra-ui-toast`（O-089）内嵌过一份八类裁决表
   （`RETRY_RULES`）。本包是真源，它是副本；两份 `verdict` 取值刻意保持一致，
   今天不会给出矛盾建议。按 §16.3 本轮不改已 `done` 的 O-089，
   **建议后续把它改为消费 `prescription()`**。
2. **文本归因是启发式。** 一条消息同时像两类时按固定顺序取第一个；顺序是取舍不是真理。
   `classify.ts` 的 TEXT_RULES 注释里逐条写了为什么这么排。
3. **`arg_error` 与 `not_found` 的边界是模糊的。** 「参数里的路径不存在」本包归
   `not_found`（改路径），不归 `arg_error`（改参数）。两类都不重试，所以行为一致，
   但报告里的分布会受影响。
4. **取消（`ABORTED`）归 `unknown`。** 八类是手册逐字给的，不许加第九类；
   而取消不是故障。处方里 `unknown` 只试一次，且 `detail` 明写「调用被取消」。
5. **`unnamed` 结果不归因。** 拿不到工具名就不猜——猜错会污染整本账。计数露出来。
6. **伤口不跨进程。** 重启后账本清空，一个长期坏着的工具会重新从「第一次失败」算起。
   手册没要求持久化，本包按「零落盘」处理。
7. **`feed-host` 的「唯一喂食者」是约定。** 第二个喂食者出现时器官会收到两份，
   本包无法检测（上游没有投递序号）。
8. **不使用 `durationMs`。** 上游 `tools/result` 不带耗时，本包不自己掐表
   （掐出来的叫做「监听器耗时」，不叫「工具耗时」）。

## 十二、待裁决

1. `max-open-wounds 256` / `max-healed-history 100` / `max-text-chars 500` / `max-retries 2`
   **四个数手册没有出处**，是本包补的工程取值。只有 `chronic-after-ms 300000` 是手册原文。
2. **七张处方的内容需要主人过目。** 手册只给了类名与 `arg_error` 那条铁律，
   处方文字是本包按「补信息而非催重试」的方向写的。
3. **要不要把处方推给模型？** 本包不做（理由见第二节）。若主人要求「失败了要告诉她
   下次怎么做」，正确落点是 O-036 的注入或 CoT 锚，不是本包。

## 十三、自查

见 `ondra-plugin-index.md` 的「产出登记（第 73 轮）」。本包首轮静态自检 9 项 + 语言 5 项
全过；交叉扫描 0 环、0 越界、服务键 0 冲突。
