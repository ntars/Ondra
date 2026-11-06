# ondra-adapter-qq-napcat

> O-059 · L5 通道 · 档位〔复〕 · 服务键 `ondra-adapter-qq-napcat` · **高危通道**

QQ 的 NapCat / OneBot v11 通道。**协议端不自己写**（§12.3：NapCat 禁止衍生开发，本仓只做外部进程对接），
**编解码也不自己猜**（仓内没有 OneBot 帧依据）。本插件负责它上面的那一层：双闸门、白名单、六道闸、隔离与探针。

---

## 一、职责

1. **接线**：真的注册 `ctx.webServer.registerUpgrade()` 的升级路由（反向 WS 的入口就在这里），把升级后的 socket 交给传输实现。
2. **双闸门**：`enable` 与 `confirmed` 必须同时为真，还要求一份**独立确认档案**（带说明文字与时刻）。缺一样都给出原因码，不静默。
3. **白名单**：QQ 号与群号**分开配**（§6.1），出厂为空 = **谁也不理**。
4. **触发**：私聊直接受理；群聊要 `@` 或命中关键词，再按 `groupReplyProbability` 防刷屏。
5. **六道闸**（§5.3）：内容闸 → 深夜静默（只拦主动）→ 重复去重 → 熔断 → 停发 → 令牌桶 20/200/1500 → 会话冷却 5s/3s，抖动 400ms。
6. **一问一答**：经 `ondra-channel-kit.callPersona()` 问人格，**半句话不发**；切条也只认 `chunk()`。
7. **隔离**：凭据 `user/channels/qq-napcat.json`、状态 `…qq-napcat.state.json`、确认档案 `…qq-napcat.confirm.json`（全部 0600）、日志命名空间 `channel.qq-napcat`、独立探针上报。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| WS 握手、帧编解码、OneBot 事件字段、action 名、心跳语义 | **`NapCatTransport` 的实现方**（见「已知限制」第 1 条） |
| QQ 登录、扫码、风控识别 | **NapCat 进程**（外部进程，本仓不引入其代码） |
| 判「这条该不该回 / 叫不叫醒」 | `ondra-router`（O-055） |
| 判「此刻该不该主动开口」 | `ondra-proactive-gate`（O-042） |
| 分条算法 | `ondra-channel-kit`（O-056） |
| 人格、提示词、前缀冻结 | `ondra-persona-*` / `ondra-dialogue` |
| 记健康状态与「上次活到几时」 | `ondra-channel-health`（O-057） |

## 三、服务键与方法

```
ondra-adapter-qq-napcat        ← 连字符，不是 ondra:adapter-qq-napcat
```

| 方法 | 作用 |
|---|---|
| `useTransport(t \| null)` | 注入/撤掉传输实现；运行中注入会立刻重新装配 |
| `start()` / `stop()` | 起停（`start()` 返回 `{ ok, reason?, detail }`，失败一定有原因码） |
| `ingest(event)` | 传输交来信（已归一化的 `NapCatEvent`） |
| `reply(conversationId, text, at?)` | 主动发一条（走同一套闸门，`trigger='active'`） |
| `acceptUpgrade(req, socket, head)` | 升级路由转交；未启用时直接回 503 并写中文原因 |
| `confirm(note)` | 写二次确认档案（`note` ≥ 4 字） |
| `status()` / `stats()` | 面板与自检读的现状与计数 |
| `tick()` / `flush()` | 心跳上报 + 状态落盘（节流） |

## 四、传输端口（这是唯一的阻断点）

```ts
interface NapCatTransport {
  readonly id: string
  readonly requiresUpgradeRoute: boolean   // 自带监听器的实现填 false
  configure?(options: { token: string }): void   // start() 读到 token 后交给实现
  attach(handlers: NapCatTransportHandlers): void
  detach(): void
  accept(request, socket, head): void      // 只在使用宿主升级路由时需要
  send(request: NapCatSendRequest): Promise<NapCatSendResult>
  close(): void
}
```

注入方式：`ctx.get('ondra-adapter-qq-napcat')?.useTransport(实现)`。

`accept()` 的实现方**必须自己校验 token**（query 里的 `access_token` 或 `Authorization` 头）：
本插件把已升级的 socket 原样交出去，不在握手层替实现方鉴权。

**为什么是端口**：手册 §6.1 给了链路与方向（NapCat 主动连入、OneBot v11），但**没有给事件字段、动作名与帧格式**；
`desktop/docs` 与 `desktop/packages` 检索 `onebot` / `OneBot` **0 命中**，本仓又禁装依赖。
自己拼一版会「看起来能跑」：握手成功、事件收不到，或字段名收错——两种都表现为「她不回话」，与「根本没接」同形。

## 五、配置（默认值真源：`src/settings.ts` 的 `FIELD_SPECS`）

| 组 | 字段 | 默认 |
|---|---|---|
| 闸门 | `enable` / `confirmed` / `requireConfirmRecord` | `false` / `false` / `true` |
| 监听 | `listHost` / `port` / `path` | `127.0.0.1` / `3001` / `/onebot/v11/ws` |
| 白名单 | `allowUsers` / `allowGroups` / `groupKeyword` / `groupReplyProbability` | `[]` / `[]` / `''` / `1` |
| 分条 | `chunkMax` | `1200`（200–2000） |
| 内容 | `contentMaxLen` / `blockPatterns` | `1800` / `[]` |
| 静默 | `quietEnabled` / `quietStart` / `quietEnd` | `true` / `00:30` / `07:30` |
| 去重 | `dedupeWindowMs` / `dedupeMinLen` | `1800000` / `4` |
| 限速 | `perMinute` / `perHour` / `perDay` | `20` / `200` / `1500` |
| 冷却 | `cooldownGroupMs` / `cooldownPrivateMs` | `5000` / `3000` |
| 风控 | `jitterMs` / `circuitStrikes` / `circuitCooldownMs` / `failureStopMs` | `400` / `3` / `1800000` / `300000` |
| 其它 | `replyTimeoutMs` / `persist` / `persistMs` / `verbose` | `60000` / `true` / `5000` / `false` |

**NapCat 侧要填的是**：`ws://<listHost>:<port><path>`。
`wsUrl` 不是本插件的字段——master-plan §9.12 记着旧项目正是把这两端写反了（表单填 `wsUrl`、源码读 `port`），症状是「界面填了、通道连不上」。

## 六、边界与隔离（master-plan §16.2 六条）

| 条 | 落实 |
|---|---|
| 目录隔离 | 独立包 `ondra-adapter-qq-napcat/`，不与其他通道共用源码 |
| 配置隔离 | 自身 `Config`；凭据 `user/channels/qq-napcat.json`(0600)，不共用 |
| 日志隔离 | 命名空间 `channel.qq-napcat`（`identity.loggerName('adapter.qq-napcat')`） |
| 状态隔离 | `PeerHistory` 不归本插件；防封状态只在本包自己的 `.state.json`，**不进主会话** |
| 失败隔离 | `stop()` 撤定时器与连接；单通道失败只影响自己 |
| 风险隔离 | `RISK_NOTICE_ZH` 独立成块；确认档案独立存档（§16.2-6） |

## 七、已知限制

1. **无 OneBot 编解码实现**（唯一阻断点，见第四节）。`start()` 会返回 `no-transport`，升级路由对来信回 503 并写明原因——**没有假监听**。
2. **`chunkMax` 默认 1200 是推断值**。手册的实测表里没有 napcat 这一行（它是协议端），这里取 QQ 官方的 1200（同一客户端渲染管线）。可调，属待裁决。
3. **端口 3001 也是推断值**：取自手册容器链路「HTTP 3000 / WS 3001」这一对常用值，且不落在 L7 的 9060–9079 端口池内。
4. **内容闸正则出厂为空**。手册写了三类（赌博 / 诈骗代办 / 色情）但没给原文，编三条出来只是「看起来拦住了」。
5. **令牌桶是固定窗口**，边界处可能双倍突发；默认值只用上限的一半，属已知取舍。
6. **`listHost` 为 `127.0.0.1` 时，容器里的 NapCat 连不进来**（§23：NapCat 常在容器/另一台机器）。此时必须填宿主可达地址，并在 NapCat 侧做端口映射。
7. **只在私聊「唤醒」**，群里只 reply：§5.4/§5.6 的唤醒身份纪律压在这一层，与 O-055 的口径一致。
8. **群内允许 ≠ 群内任何人都能私聊**：`allowUsers` 非空时，群发信人还要在 users 名单里，否则 `not-whitelisted`。
9. 本包**未实装运行**（本轮只做插件 + 静态自检）。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| QQ 协议端（OneBot v11） | NapCat | github.com/NapNeko/NapCatQQ | 禁止衍生开发（§12.3） | 只取「反向 WS、NapCat 主动连入」这一条链路事实 | **只做外部进程对接**，端口化，不引入任何代码 | 否 |
| QQ 通道生态（4 个成熟实现） | `cheems135/ondra-qq-bridge`、`cheesewoo/ondra-qqbot-dafeiyu`、`Applepinea/ondra-qq-access`、`accomplish07zrh-eng/ondra-aurabot-qq` | 见上 | 各自仓库声明（本仓未逐字核对） | 「每 peer 独立会话」「群 @ 与关键词触发」「白名单」三点产品结构 | 自写 `src/adapter.ts`（会话隔离、触发判定、白名单） | 否 |
| 防封六道闸 | 手册 §5.3 的实测结论 | —（手册正文） | — | 顺序原则「最便宜/最可能拒绝的放最前」、令牌桶三层、指数退避、熔断 | 自写纯函数 `src/gate.ts` | 否 |
| 反向 WS 升级入口 | 宿主 `ondra-host-webserver` | `desktop/packages/host/webserver` | 宿主自身许可 | `registerUpgrade({path, handler(req, socket, head)})` 的真实签名 | 直接调用该扩展点（已读源码核对） | 否 |

**档位判定：〔复〕。** 手册 §1.7 明确「QQ 这一路完全不自己写（≥5 个成熟 QQ 通道）」。本插件没有一行 QQ 协议、
没有一行 WS 编解码；自写部分只有闸门算术、白名单与触发判定——这三样是「节制」，正是手册允许自研的两件事之一。

## 九、多方案说明（§14）

本插件**不涉及 §14.3 的多方案能力**（它不是检索/情绪/关系那类有多个学派的机制）。唯一的分支形态是**传输实现**，
按 §14.2 落实：接口唯一（`NapCatTransport`）、实现隔离（每个实现在自己的文件/包里）、默认最稳（没有实现就明确不启动，
不退回「假装在听」）、独立降级（一个实现挂了不影响本插件注册服务与报原因）、可观测（`status().transport` 给出实现 id）。

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有 QQ（NapCat）这一路。其他通道、对话链、记忆域全部照跑。
2. **我的状态存在哪？** `user/channels/qq-napcat.state.json`（0600，原子写）；凭据在 `…/qq-napcat.json`（0600）；确认档案在 `…/qq-napcat.confirm.json`（0600）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `channel.qq-napcat` + 探针 `channel.qq-napcat` 的 `error` 事件 + `status().lastError`。
4. **我依赖谁？缺席时我怎么降级？** `webServer`（缺 → `no-web-server`）、`router`（缺 → 直接回，不排队）、`channel-kit`（缺 → 这一条不发，不自己切条）、`channel-health`（缺 → 静默）、`path-layout`（缺 → 三个路径算不出来，`no-credential`）、`config-schema`（缺 → 本地校验）。**全部软依赖，`inject` 不声明。**
5. **我和同域的谁共享了可变状态？** 没有。闸门状态、连接、定时器、去重表全部本包私有；与 O-058 只共享「手册里的数值」，不共享任何运行期对象。
