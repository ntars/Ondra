# ondra-organ-host

> O-132 · B6 运行时治理 · 档位〔研〕· 服务键 `ondra-organ-host` · **P0**
>
> 器官 ABI + 宿主：装载拓扑、能力白名单、能量会计、反馈仲裁、提示词拼装、遥测。
> **C1/C2/C3 三条不可让渡约束落在这里。这是 O-136~O-144 的地基。**

## 一、职责

| # | 做什么 | 在哪 |
|---|---|---|
| 1 | **装载拓扑**：注册 / 摘除 / 门面冻结 / 撤销器集中回收 | `src/service.ts` |
| 2 | **能力白名单 default-deny**：声明 ∩ 策略，没声明就抛 | `src/service.ts` + `src/types.ts` |
| 3 | **能量会计**：报价 → 四态回执，`shadow` / `additive` 双模式 | `src/energy.ts` |
| 4 | **反馈仲裁**：累加 → 夹步长 → 夹结果 → 每目标只 `apply` 一次 | `src/arbitrate.ts` |
| 5 | **提示词拼装**：`order` 排序 + `ttl` / `confidence` 过滤 + 疤痕保留区 | `src/prompt.ts` |
| 6 | **遥测**：全宿主 + 单器官双层计数，`snapshot()` 深冻结 | `src/service.ts` |
| 7 | **配置四层合并对接**：向 O-005 注册段、默认值只在 `FIELD_SPECS` | `src/settings.ts` |

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 情绪的计算、衰减、落盘 | O-026 `ondra-emotion-core`（只 `state()`，且**只读**） |
| 能量的产出与作息积分 | O-048 `ondra-life-rhythm`（只 `energy()` / `feed(−n)`） |
| 缺口池的张力与去重 | O-129 `ondra-drive-gap`（只 `open()`，三源闭合集） |
| 失败归因八类与处方表 | O-139 `ondra-failure-attrib`（本包只透传 `errorCode`） |
| 工具 schema 门控与意图路由 | O-138 `ondra-organ-gate` |
| 具体器官（视觉、检索、语法…） | O-126 / O-141 / O-144 等，本包只提供 ABI |
| 提示词的**最终**拼装与预算裁剪 | O-023 / O-036（本包只出**片段**，不碰 system prompt 结构） |
| 安装自检与入口树核对 | O-133 `ondra-install-doctor` |

### 三条刻意的「不做」

1. **不提供 `setState()`。** 手册 §8.2 反模式①就是它。给了它，C1 立刻退化成注释——
   而注释拦不住任何人。
2. **不装任何定时器。** `tick()` 由宿主调度。装了定时器，一个没人用的宿主也在偷偷烧
   CPU，而「零常驻」正是 B6 的主题。
3. **不做能力「临时授权」。** default-deny 一旦有例外通道，审计就无从谈起。
   要放开就改 `denied-capabilities` 配置——那是一次显式的、有记录的操作。

## 三、三条不可让渡约束（手册 §8.1 逐字）落在哪一行

### C1 器官永不直接写状态

| 环节 | 实现 | 文件 |
|---|---|---|
| 提议 | `feedback(organId, deltas)` **只入队**，不动任何状态 | `service.ts` |
| 仲裁 | `flush()` 按目标累加 → 夹步长 → 夹结果 → 每目标只调一次 `apply` | `arbitrate.ts` |
| 读状态 | `state()` 返回**浅拷贝 + 冻结**，器官拿不到持有者的对象引用 | `service.ts` |
| 写状态 | 唯一写者是持有者自己登记的 `apply()` | `arbitrate.ts` |

**为什么必须累加后一次性应用**：逐条 apply 会让结果取决于器官注册顺序。器官 A 先把
pleasure 推到 1.0，器官 B 再来 −0.3 时读到的已经是 A 的结果，账上变成「从 1.0 掉到 0.7」，
而正确结果是 `0.5 + A + B` 再夹紧。同一批提议、同样的值，换个装载顺序得出不同情绪——
排查时永远查不出，因为每个器官单独看都是对的。

**夹紧的三步顺序是唯一正确的顺序**：

1. **先按目标累加**：同一目标的多条 Δ 相加。
2. **再夹步长**：`maxStep` 限制的是「这一次 flush 能改多少」，所以夹在总和上。
   先夹每条再相加，N 条 −0.06 会变成 −0.6，步长闸形同虚设。
3. **最后夹结果**：`before + delta` 夹到 `[min, max]`，把**差值**交给持有者。
   持有者收到的永远是「合法的一步」。

### C2 器官为自己付能量，且允许被拒绝

| 环节 | 实现 | 文件 |
|---|---|---|
| 唯一入口 | `consume()` 是拿到读状态权限的唯一门 | `service.ts` |
| 四态 | `full` / `partial` / `starved` / `shadow` | `energy.ts` |
| 拒绝 | `denied=true` → `state()` 抛 `PerceptionDeniedError` | `service.ts` |
| 过期 | 回执超过 `receipt-ttl-ms` → `state()` 抛 `ReceiptRequiredError('expired')` | `service.ts` |

**手册摘要有一处没说清，本包的选择**：§8.1 写「`denied=true` 时必须立刻放弃本次感知」，
但没说**谁来保证**。本包让「不放弃的那条路走不通」——不是只给一个布尔让器官自己记得检查，
而是 `state()` 直接抛错。**布尔提醒靠自觉，抛错靠机制。**

**四态的判定表**（每条都对应一次真实事故形态）：

| 情形 | 状态 | `denied` | 理由码 |
|---|---|---|---|
| `chargeMode='shadow'` | `shadow` | false | `shadow-mode` |
| 没有能量源（O-048 缺席） | `shadow` | false | `no-source` |
| 剩余 ≤ 0 | `starved` | **true** | `insufficient` |
| 0 < 剩余 < 报价 | `partial` | false | `partial` |
| 剩余 ≥ 报价 | `full` | false | `paid` |
| 报价为 0（免票） | `full` | false | `free` |
| 真扣时能量源抛错 | `starved` | **true** | `charge-failed` |

两个刻意的「不」：

- **没有能量源时不报 `starved`。** 报饥饿会让所有器官在「只装了宿主、没装生活层」的
  最小安装上集体装死——那不是饥饿降级，那是整机停摆。如实报 `shadow + no-source`，
  让面板能说清「能量会计没接线」。
- **`partial` 不置 `denied`。** 「只付得起一半」与「付不起」是两件事：前者可以缩小
  范围继续看（看一帧而不是看一段视频），后者必须放弃。合成一个布尔等于删掉「省着用」。

### C3 器官错误不得传播

`tick()` / `toolResult()` / `prompt()` 三处的处理器全部**逐个** try/catch，
抛错 → 计数 + 转 `degraded` + 打一条 warn，宿主继续跑。

`prompt()` 里取片段抛错还会额外记一条 `provider-error` 去重记录——否则界面上看到的
是「这个器官什么都没提」，与「它提了但全被过滤掉」同形。

## 四、能力白名单（default-deny）

| 能力 | 允许做什么 |
|---|---|
| `state.read` | `state()` |
| `emit` | `emit()` 向宿主发信号 |
| `gap.propose` | `proposeGap()` |
| `tool.result` | `onToolResult()` |
| `tick` | `onTick()` |
| `tool.register` | `registerTool()` |
| `prompt.fragment` | `onPrompt()` |
| `kv` | 自己的键值空间 |
| `log` | 自己的日志命名空间 |

**刻意不含 `energy.consume`**：付能量是义务不是权限。能选「不付」的付费机制等于没有。
所以 `consume()` 永远可用，而 `state()` 反过来要求先拿到有效回执。

调用未声明能力 → 抛 `CapabilityDeniedError`（带 `organId` + `capability`），**不静默忽略**。
静默忽略会让器官作者以为「这次没生效」，而不是「我没资格」。

## 五、门面只有十个成员

`state / consume / emit / proposeGap / onToolResult / onTick / registerTool / onPrompt / kv / log`

*手册 §8.1 逐字，一个不多。* 裸 ctx 能 `on('llm/stream')`、能全量 `tools.register`、
能 `ctx.get` 别人的服务——那样 ABI 就形同虚设。

**门面在注册时造一次并冻结**：器官在自己 `apply()` 里闭包住的门面，必须是
「宿主当前看到的那个」。每次 `facade()` 都造新的，会让器官手里那个在 `unregister`
之后还能用——那是最难查的泄漏。失效靠 `alive` 标记：摘掉之后任何调用都抛「已卸载」。

## 六、提示词拼装规则

| 规则 | 值 | 依据 |
|---|---|---|
| 疤痕（`kind:'scar'`） | `order` 恒 **−1e4**，**不看申报值** | §8.1 逐字 |
| 器官申报下限 | **−1000**，低于它**拒收**（`order-reserved`） | §8.1 逐字 |
| 申报上限 | 10000，超过拒收（`order-out-of-range`） | 工程取值 |
| 置信度门槛 | 默认 **0.2** | 工程取值（手册只说「过滤低置信度」） |
| 片段数上限 | 默认 **64** | 工程取值 |
| 单片字数上限 | 默认 **2000** 码位 | 工程取值 |
| 相同 `order` 的次序 | 按 `id` **码位比较** | 见下 |

**为什么疤痕要强制改写 `order`**：疤痕是「她被怎样对待过」的沉淀，位置必须在最前。
让器官自己申报，等于让「谁先注册」决定「谁的伤口更疼」。`forced:true` 记下这次改写，
界面上能看见「这一段被改过序」。

**为什么低于 −1000 要拒收而不是夹紧**：夹紧会让作者以为「我设的 −5000 生效了，只是被调成
−1000」，而实际位置差一个数量级。拒收 + 明确理由才有办法修。

**为什么用码位比较而不是 `localeCompare`**：后者依赖运行环境 locale，同一份片段在两台
机器上可能排出不同顺序，而顺序变化会让前缀缓存整段失效（§8.5）。

**为什么超长整片拒收而不是截断**：截断出来的半句话比整片不要更难查——语义断了，
但看起来像正常内容。

**丢弃全部可数**：9 个原因码（`empty-text` / `too-long` / `duplicate` / `order-reserved` /
`order-out-of-range` / `expired` / `low-confidence` / `over-limit` / `provider-error`），
每条带一句「能拿去修」的 detail。「没注入」与「没申报」在界面上同形，但一个是器官的问题、
一个是配置的问题。

## 七、配置

字段与默认值只在 `src/settings.ts` 的 `FIELD_SPECS` 里出现一次。

| 键（段字段） | 默认 | 说明 |
|---|---|---|
| `enable` | `true` | 关掉后所有注册申请被拒（`reason:'disabled'`） |
| `charge-mode` | `shadow` | `shadow` 只记账 / `additive` 真扣 |
| `min-confidence` | `0.2` | 片段最低置信度 |
| `receipt-ttl-ms` | `30000` | 回执有效期 |
| `max-fragments` | `64` | 一次拼装最多采纳几片 |
| `max-chars-per-fragment` | `2000` | 单片最大码位数 |
| `kv-limit` | `200` | 每器官键值上限（到顶不淘汰） |
| `max-pending` | `512` | 待提交队列上限 |
| `denied-capabilities` | `[]` | 全局拒绝的能力（叠加在清单声明之上） |
| `enforce-receipt` | `true` | 是否强制「先 consume 再 state」——**C2 唯一的牙齿** |
| `verbose` | `false` | 每次拼装一行日志 |

`chargeMode` 默认 `shadow` 的理由：默认真扣的后果是「第一次装上，所有器官一起抢能量，
她当场蔫掉」。而 shadow 跑一周能拿到真实成本分布，再逐个器官翻 `additive`——
**任何一步都能回滚，且永远不存在双重计费窗口**（§8.2）。

## 八、服务键与依赖

**provide**：`ondra-organ-host`（全仓唯一归属）

**consume（全部软依赖，`inject` 不声明）**：

| 键 | 用在哪 | 缺席怎么办 |
|---|---|---|
| `ondra-identity` | 日志命名空间 | 退回 `ondra.organ-host` |
| `ondra-config-schema` | 配置四层合并 | 退回插件实例配置 |
| `ondra-clock` | `now()` | 退回 `Date.now()` |
| `ondra-emotion-core` | `state().emotion` | 省略 `emotion`（省略 = 不知道，不是「没有情绪」） |
| `ondra-life-rhythm` | 能量读 / 扣 | 报 `shadow + no-source`，**不报饥饿** |
| `ondra-drive-gap` | `proposeGap()` | 返回 `{accepted:false, reason:'no-service'}` |
| `tools`（宿主键） | `registerTool()` | 只跳过那一个工具，插件照跑 |

**依赖每次现取**，不在 `apply()` 里存一份。存一份会在「后装载」时永远拿到 `undefined`，
而装载顺序由用户配置决定，不由本插件决定。代价是一次 Map 查找。

## 九、隔离五问（§16.4）

1. **关掉我，谁受影响？** 所有器官的注册申请被拒（`reason:'disabled'`），
   已注册器官的门面因服务撤销而不可达。**只有器官类插件受影响**，对话、记忆、界面照跑。
2. **我的状态存在哪？** **仅在内存**。器官键值空间、待提交队列、计数器、信号订阅表
   全在 `OrganHost` 实例里，不落盘。重启即空——这是刻意的：ABI 宿主不该持有业务数据。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.organ-host`（前缀由 O-001 给）。
   单器官的哑火由 `snapshot()[i].state === 'degraded'` 单独可见，不是混在总数里。
4. **我依赖谁？缺席时我怎么降级？** 见第八节表格，七个依赖全部软降级，无一抛错。
5. **我和同域的谁共享了可变状态？** **没有**。与 O-133 同批但互不 import，
   它只读本包的入口树，绝不调本包的 `register()`。

## 十、多方案分支说明（§12）

| 能力 | 方案 A（默认） | 方案 B | 处理方式 |
|---|---|---|---|
| 能量会计 | `shadow`（只记账） | `additive`（真扣） | **参数化**（`charge-mode`），同一实现，不分支 |
| 回执强制 | `enforce-receipt=true` | `false`（迁移期） | **参数化**，但关掉时仍要求「申请过」——免扣钱不免登记 |
| 能力策略 | 清单声明 | +全局黑名单 | **叠加**，不相斥 |
| 状态源 | O-026 情绪 | 任意 `useStateSource` 登记 | **并存**，`values` 里按源 id 分开 |

**稳定优先**：`shadow` 是默认分支，因为它出错时最多是「账不准」，而 `additive` 出错时
是「她当场没力气」。这正是 §12「默认选最稳，不选最省」。

## 十一、自查找出并修掉的问题

纯逻辑对拍（Python 复刻四个纯函数做核对，**非实装运行**）当场抓出两个真问题：

1. **`FeedbackDelta.target` 的示例写成 `emotion.pleasure`，过不了自己的 `KEY_RE`。**
   §8.4 的键字符集里没有点号，`enqueue()` 会把它判 `bad-target` 静默丢弃——于是
   按文档写的器官会「提了但永远不生效」，且日志里只有一条 warn。已改成
   `emotion-pleasure` 并在字段注释里写明原因。**这是「我建议别人用的接口，得先被
   自己的检查器认识」那条纪律（长期纪律 193）在本轮的实证。**
2. **`partial` 回执的 `remaining` 报的是扣前值。** 先算 `quote` 再 `feed(−charged)`，
   若直接把 `remaining` 抄进回执，下一个器官会看到「还有原来那么多」——两个器官
   同时按同一个余额报价，能量会被超扣。已改为扣后重算。
※ 另修掉三处未使用代码：`countDegraded()`（改成 `stats()` 里现数）、
`counters.degraded` 与 `counters.droppedTargets`（无读者，删）。
※ 对拍脚本自身也修了两轮：首轮未用 `math.isfinite`（NaN 增量本应被拒）、
`apply` 未包 try/catch（F 组「一个目标抛错不拖累其它」本应通过却因异常外冒报错），
以及三个用例用了单字符键 `x`/`a`/`b`（`KEY_RE` 要求 ≥2 字符）。
**对拍脚本也是代码，绿灯笼只对它真跑到的那条路径有效（长期纪律 199）。**

## 十二、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 器官化运行时 / 神经脉冲 | `1420079678-ctrl/agent-body` | github.com/1420079678-ctrl/agent-body | MIT | 「器官先于模型推理被支配」的分层、26 器官 8 系统的责任切面 | 自研 `OrganHost`：门面 + 白名单 + 三约束 | 否（只读思路） |
| 能力沙箱 / default-deny | `digital-life-core` v0.9.x（手册语料·第一编 2.8 引用） | 手册未给仓库地址 | 未给 | 「调了没声明的东西抛错而不是静默忽略」 | 自研 `CapabilityDeniedError` + 声明∩策略 | 否 |
| 能量会计双模式 | `life-os-architecture.md` §3（手册语料·第一编 4.7） | 手册未给仓库地址 | 未给 | `chargeMode = shadow \| additive` 与「先 shadow 一周」的迁移路线 | 自研 `energy.ts` 纯函数四态机 | 否 |
| 失败归因与饥饿降级 | `agent-body`（同上）+ 手册语料 4.8 | 同上一行 | MIT | 「`starved` 是累了不是挂了」「降级要有可感知的表现」 | `starved` 回执 + 可感知日志 + `degraded` 态 | 否 |
| 补丁入口语义 | `desktop/vendor/include` 的 `applyEntryPatches` | 仓内 vendored 包（`@ntars/cordis-plugin-include`） | MIT | 入口字段只有六个、`insert` 两种语义 | 只在本包 `cordis.patch.yml` 里按语义写，不移植代码 | 否 |
| 前缀缓存三原则 | `Tianshu-harness` 实测（手册 §8.5） | 手册未给仓库地址 | 未给 | 「同一份片段在两台机器上排出不同顺序会让缓存整段失效」 | 排序用码位比较，不用 `localeCompare` | 否 |

**档位判定：〔研〕。** 依据：手册 §1.8 把「器官 ABI 运行时」明确列进自研档（「生态没有
或只有雏形，完全自写，允许写厚」），且 §3.9 九条 P0 的第 26 条就是器官 ABI。
`agent-body` 提供的是**机制思路**（脉冲、突触、归因），其运行时形状（26 器官预置、
`synapses.json` 持久化）与本项目「器官由第三方插件注册、宿主不持有业务状态」的定位不同，
故只借鉴责任切面，不引入代码。

## 十三、已知限制

1. **四个上游依赖是「结构对位」而非 `import type`**（§15.5 禁止同轮互相 import）。
   代价：上游改字段名时本包不会在编译期报错。已把四份子集集中在 `src/types.ts`
   末尾（`EmotionSourceLike` / `EnergySourceLike` / `GapPoolLike` / `ToolsRegistryLike`），
   改名只改一处。**建议交主人裁决 master-plan 是否给 §18.3 补「跨轮才准 `import type`」。**
2. **`enforce-receipt=false` 时 C2 只是纸面约束**。允许这么跑（迁移期），但代码里
   仍要求「先 consume 过一次」——免扣钱，不免登记。日志会打一条 warn 提醒。
3. **`partial` 回执不强制器官缩小范围**。ABI 无法替器官决定「看一帧还是看一段」，
   只能给出 `charged / requested` 让它自己判断。若某个器官无视 `partial` 继续全量感知，
   本包不会拦——**这是 ABI 的边界，不是漏洞**，但需要在器官侧的自检里补。
4. **`kv` 是内存不落盘**。器官需要跨重启的状态必须自己走 O-006 / O-007。
   这条刻意的：宿主不该变成第二个数据库。
5. **没有「同目标并发写」的锁**。`flush()` 是同步的，Node 单线程下不存在真正并发；
   但若持有者的 `apply()` 内部 `await`（不可能是同步签名），本包管不到。
6. **`order` 上限 10000 是工程取值**。手册只给下限（−1000）与疤痕值（−1e4）。
7. **`min-confidence 0.2` / `max-fragments 64` / `max-chars-per-fragment 2000` 三个数字
   手册无出处**，属工程取值，待裁决。
8. **`prompt()` 不拼 system prompt**。它只给片段，最终结构与预算裁剪归 O-023 / O-036。
   本包不越界，但也因此**无法保证**「片段被真的用上了」——那要 O-125 提示词预览才看得见。

## 十四、待裁决

1. `min-confidence` / `max-fragments` / `max-chars-per-fragment` 三个数字无手册出处。
2. `order` 上限 10000 无手册出处（手册只给下限与疤痕值）。
3. §18.3「`import type` 契约」与 §18.5「禁止同轮互相 import」互斥，本包按 §18.5 执行，
   四份结构对位子集人工同步。建议 master-plan 补一句「跨轮才准 `import type`」。
4. 手册 §8.1 说「`denied=true` 时必须立刻放弃本次感知」，**没说谁来保证**。
   本包的选择（`state()` 直接抛错）比摘要更严，若主人认为应当只给布尔提醒，改 `state()`
   一处即可。
