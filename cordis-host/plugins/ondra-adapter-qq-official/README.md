# ondra-adapter-qq-official

> O-058 · 通道公共层之上 · 档位〔复〕 · 服务键 `ondra-adapter-qq-official`

QQ 开放平台的官方机器人通道。**传输不自己写**——手册只给了协议轮廓，没给帧格式。

---

## 一、职责

1. **受理**：接住传输交来的来信（去重、防回声、空正文判定），交给 `ondra-router` 判定处置。
2. **一问一答**：经 `ondra-channel-kit.callPersona()` 问人格，**半句话不发**。
3. **被动回复**：`msgId` 必带（手册 §9.11：不带就被平台拒收）。
4. **切条**：平台硬上限 1200（手册 §9.11），切法复用 O-056，不自造第二套。
5. **六道闸**（手册 §5.3）：内容闸、深夜静默、重复去重、令牌桶 20/200/1500、会话冷却 5s/3s、抖动 400ms + 指数退避 + 熔断。
6. **隔离**：凭据 `user/channels/qq-official.json`（0600）、状态 `user/channels/qq-official.state.json`（0600）、日志命名空间 `channel.qq-official`、独立探针上报（`ondra-channel-health`）。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| WS 帧协议、token 刷新、重连、事件解析 | **`QqTransport` 的实现方**（见「已知限制」第 1 条） |
| 判「这条该不该回 / 叫不叫醒」 | `ondra-router`（O-055） |
| 判「此刻该不该主动开口」 | `ondra-proactive-gate`（O-042） |
| 分条算法本身 | `ondra-channel-kit`（O-056） |
| 人格、提示词、前缀冻结 | `ondra-persona-*` / `ondra-dialogue`（O-033 等） |
| 记健康状态、跨重启说明「上次活到几时」 | `ondra-channel-health`（O-057） |

### 三条刻意的「不做」

1. **不自己拼 WS 握手。** 手册 §9.11 只有四条事实（WS 长连、`/app/getAppAccessToken`、`QQBot <t>` 头、被动回复带 `msg_id`、单条 1200），**没有 op 码、identify 载荷、心跳应答、resume 序列号**；本仓 `desktop/docs`、`desktop/packages` 检索这些关键字**零命中**，且禁止装依赖。拼一版出来会「看起来能跑」：连上了收不到事件，或字段名猜错——两种都表现为「她不回话」，与「根本没接」同形。
2. **不把 `clientSecret` 放进 `Config`。** 配置会被导出、会被打进反馈、会出现在「当前配置」日志里。凭据只从 `user/channels/qq-official.json` 读，读完也不存在字段里（传输工厂自己拿着用）。
3. **不发半句话。** `callPersona` 超时前可能已经吐了半句，`ok=false`。半句话比没话更糟：用户以为她说了一句没头没尾的话，真正的原因是超时。

## 三、服务键与方法

```
ondra-adapter-qq-official        ← 连字符，不是 ondra:adapter-qq-official
```

| 方法 | 说明 |
|---|---|
| `useTransport(t)` | 注入传输实现（同一时刻一个）；已在跑时返回 `already-started` |
| `start()` | 启动；`disabled` / `no-credential` / `no-transport` 三类失败都带原因码 |
| `stop()` | 停止，幂等；不残留定时器与 socket；顺带落盘闸门状态 |
| `status()` | 状态快照（`state` 六值：`ready/connecting/disabled/no-credential/no-transport/closed`） |
| `ingest(event)` | 传输把已解析来信喂进来；返回 `accepted/duplicate/self/empty/disabled/bad-id` |
| `reply(input)` | 过闸 → 切条 → 逐段发；返回 `sent/partial/...` 八值结论 |
| `tick()` | 心跳节拍（宿主定时器 30 秒一次），向探针证明「还活着」 |
| `flush()` | 闸门状态落盘 |
| `stats()` | 收信 / 接住 / 重复 / 发出 / 拦下 / 失败 / 风控命中 |

### 传输端口

```ts
interface QqTransport {
  readonly name: string
  open(handlers: QqTransportHandlers): Promise<void>   // onReady/onInbound/onHeartbeat/onError/onClosed
  close(): void
  send(request: QqSendRequest): Promise<QqSendResult>  // 永不抛错
}
```

实现方负责：**WS 帧协议、token 刷新、重连、事件解析**。
本插件负责：它上面那一层（去重、判定、问人格、六道闸、分条、被动回复、日志、隔离）。

## 四、配置

| 字段 | 默认 | 出处 |
|---|---|---|
| `enable` | `false` | 手册 §9.11：九个适配器默认全关 |
| `chunkMax` | `1200` | §9.11 单条上限（200–1200，只能往下调） |
| `contentMaxLen` | `1800` | §5.3-1 内容闸 |
| `blockPatterns` | `[]` | §5.3-1 三类正则（**手册未给原文，出厂为空，不编造**） |
| `quietEnabled` / `quietStart` / `quietEnd` | `true` / `00:30` / `07:30` | §5.3-2，只拦主动发言 |
| `dedupeWindowMs` / `dedupeMinLen` | `1800000` / `4` | §5.3-3 |
| `perMinute` / `perHour` / `perDay` | `20` / `200` / `1500` | §5.3-4 |
| `cooldownGroupMs` / `cooldownPrivateMs` | `5000` / `3000` | §5.3-5 |
| `jitterMs` | `400` | §5.3-6 |
| `circuitStrikes` / `circuitCooldownMs` | `3` / `1800000` | §5.3-6 熔断 30 分钟 |
| `failureStopMs` | `300000` | §5.3-6 连续失败 3 次停 5 分钟 |
| `persist` / `persistMs` | `true` / `5000` | §5.3-7 状态必须持久化 |
| `credentialFile` / `stateFile` | `''` | 留空则由 `path-layout` 推出 |

## 五、边界

- **只在 `cordis/` 下、只写自己的目录**：凭据与状态都在 `user/channels/` 下，0600。
- **不进提示词**：通道不发提示词片段，人格由 `ondra-persona-*` 拥有。
- **不注册工具**：模型不该能直接调「发 QQ 消息」——那等于给它一个绕过所有闸门的入口。
- **失败只影响自己**：`ingest()` / `reply()` 全包 try/catch，异常折成结果对象，绝不冒泡到传输层。

## 六、已知限制

1. **没有传输实现（本轮唯一的阻断点）。** 手册 §9.11 给了协议轮廓，但**没有给 WS 帧格式**（op 码、identify 载荷、心跳应答、resume 序列号），本仓检索 `getAppAccessToken` / `QQBot` / `msg_id` / `qqbot` **零命中**，且本轮禁装依赖。因此：
   - `start()` 在端口为空时**明确返回 `no-transport`**，并在日志里写清缺什么；
   - 凭据、分条、被动回复的 `msg_id`、六道闸、状态落盘、日志隔离、探针上报**全部已实现**；
   - 解除方式：提供真实 `QqTransport`（官方 SDK、已验证的客户端，或后续轮次补上的协议依据），调 `useTransport()` 即可，无需改本插件。
   - 台账状态标 `blocked`，原因写在这里，不写成「已实现但连不上」。
2. **内容闸正则出厂为空。** 手册写了三类（赌博 / 诈骗代办 / 色情）但没给正则原文；编三条正则出来会让「看起来拦住了」。当前只拦「空正文」与「超 1800 字」。
3. **错误码的「文本正则兜底」未实现。** §5.3-6 提到「错误码 + 文本正则兜底」，文本形态手册未给；只按 `[100,1200,1201,1202,1500]` 判风控。
4. **令牌桶是固定窗口，不是滑动窗口。** 边界处可能双倍突发；默认值只用了上限的一半，且落盘后跨重启连续。要严格「任意 60 秒 ≤ 20」需改滑动窗口（多存时刻数组，内存与落盘都涨一个量级）。
5. **群里只做「被点名」的回**：平台只在 @ 时投递群消息，本插件再把 `mentionRequired` 设为 `true`，不做关键词回复。
6. **只发文字。** 图 / 语音 / 贴纸 / 文件的协议未验证，能力表 `features: []`（不说「能发」）。
7. **`stop()` 不清凭据文件**：凭据是用户的资产，插件只读与收紧权限，绝不删。

## 七、技术来源

| 能力 | 参考项目 | 许可证 | 借鉴了什么 | 引入代码 |
|---|---|---|---|---|
| 通道协议链与分条上限 | 手册 §9.11 实测表 | — | `qq-official`：WS 长连、`/app/getAppAccessToken`、`QQBot <t>`、被动回复带 `msg_id`、单条 1200 | 否 |
| 六道防封闸的数值与顺序 | 手册 §5.3（实测 12 拦截 0 误伤） | — | 1800 字、00:30–07:30、30min/4 字、20/200/1500、5s/3s、400ms、`[30,60,120,300,600,1800]s`、熔断 3 次停 30 分钟 | 否（自研实现） |
| 字段错位教训（`token` vs `appId`+`clientSecret`） | master-plan §9.12 | — | 把字段名写进错误提示，填错一次就看见 | 否 |
| 通道隔离六条 | master-plan §16.2 / 手册 §16.2 | — | 一通道一目录 / 一凭据 / 一命名空间 / 一探针 / 一启停 | 否 |
| 传输端口化（不写未验证的握手） | 本项目 O-054 `avatar` 的 `registerRenderer()` 经验 | 自有 | 「没有运行时依据就只做接线，并显式降级」 | 是（自有资产） |

**档位判定〔复〕**：QQ 生态已有 ≥5 个成熟通道实现（手册 §1.7 明确「QQ 这一路完全不自己写」），故本插件只做接线、配置、护栏与降级，不重写传输。
**偏离说明**：手册期望「直接用现成通道包」，但本仓禁装依赖、且现成包不在 `desktop/packages` 里，故接线对象改为端口。这是**环境限制导致的降级**，不是把〔复〕改成了〔研〕。

## 八、多方案分支说明

涉及 master-plan §14.3 的「通道唤醒」一项，但该项的分支（`wakeProbability` / 全量 / 关键词）**落在 `ondra-router`**，本插件只调用 `admit()`，故不设分支。传输的多方案（官方 SDK / 自实现 WS / 桥接）由**端口注入**表达：同一服务键、一个接口、每分支独立文件由实现方持有，本插件不感知。

## 九、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有 QQ 这一个通道。其他通道、记忆、人格、界面均不受影响（`stop()` 幂等、无全局状态）。
2. **我的状态存在哪？** `user/channels/qq-official.state.json`（0600，原子写，5 秒节流）；凭据在 `user/channels/qq-official.json`（0600，只读）。消息去重表与 `msgId` 表**仅在内存**，重启即清（去重窗口 5 分钟，重启丢它不会导致重复发送）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `channel.qq-official`；`ondra-channel-health` 的 `channel.qq-official` 探针会因心跳超期报 `stale`；`status()` 的 `state`/`detail` 直接给原因。
4. **我依赖谁？缺席时我怎么降级？** `ondra-router`（缺席→接住但明确 warn「这一条不会得到处置」）、`ondra-channel-kit`（缺席→短文本照发，超长拒发并报 `no-kit`）、`ondra-channel-health`（缺席→不上报，收发照常）、`ondra-path-layout`（缺席→凭据路径为空，`start()` 报 `no-credential`）、`ondra-clock`（缺席→系统时钟）、`ondra-config-schema`（缺席→本地校验）。六个全软。
5. **我和同域的谁共享了可变状态？** 没有。去重表、`msgId` 表、闸门状态都是本插件私有；能力表登记进 router 的是**只读声明**（`registerChannel` 返回自己的 disposer）。
