# ondra-adapter-discord

> O-067 · 通道公共层之上 · 档位〔复〕 · 服务键 `ondra-adapter-discord`

Discord 通道。**帧层不自己写**——手册只给了协议轮廓，没给 op 码与握手载荷。

---

## 一、职责

1. **受理**：接住帧层端口交来的原始事件（判事件名、剔 bot 自己的、判私聊/群、判被 @）。
2. **一问一答**：经 `ondra-channel-kit.callPersona()` 问人格，**半句话不发**。
3. **分条**：平台上限 1900（手册 §9.11），切法复用 O-056，不自造第二套。
4. **回复**：`POST /channels/<id>/messages`，`allowed_mentions.parse: []`——她说的话不该触发 `@everyone`。
5. **连接治理**：`4004` 停止重连、其余固定 5 秒重连；断开只有**一个决定点**（`planOf()`）。
6. **隔离**：凭据 `user/channels/discord.json`（0600）、日志命名空间 `channel.discord`、独立探针上报（`ondra-channel-health`）、**不落盘任何消息状态**。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| WS 帧协议、IDENTIFY、心跳与 ACK、RESUME、zlib 分片 | **`DiscordSocket` 的实现方**（见「已知限制」第 1 条） |
| 判「这条该不该回 / 叫不叫醒」 | `ondra-router`（O-055） |
| 判「此刻该不该主动开口」 | `ondra-proactive-gate`（O-042） |
| 分条算法本身 | `ondra-channel-kit`（O-056） |
| 人格、提示词、前缀冻结 | `ondra-persona-*` / `ondra-dialogue` |
| 记健康状态、跨重启说明「上次活到几点」 | `ondra-channel-health`（O-057） |

### 三条刻意的「不做」

1. **不自己拼 WS 握手。** 手册 §9.11 一行给了五件事（`Gateway WS v10 自实现 IDENTIFY+心跳`、`Bot <token>`、`1900`、`4004 停止重连其余 5s`、**无去重**），**没给** op 码表、IDENTIFY 载荷字段、HELLO/心跳 ACK 规则、RESUME 序列号、intents 位。本仓 grep：`MESSAGE_CREATE` / `HELLO` / `RESUME` / `op_code` / `intents` / `gateway.discord` **全部 0 命中**，`IDENTIFY` 只在 master-plan 出现 1 次。拼一版的坏形态是「连上了、READY 来了、一条消息都收不到」（intents 算错），与「根本没接」同形。故帧层做成端口。
2. **不建跨时间的去重表。** 手册明写「无去重」。理由三条：①Discord 靠 `RESUME` + 序列号保证不重投，去重表无事可做；②用户**真的会**连发两遍同一句话，用文本做键会吞掉第二句；③落盘去重表要管容量与过期，而它保护的东西不存在。**只保留**「同一 `message.id` 在飞行中即丢」（容量 = 并发数、不落盘、答完即删）。
3. **不发半句话。** `callPersona` 超时前可能已吐半句而 `ok=false`。半句话比没话更糟：用户以为她说了一句没头没尾的话，真正原因是超时。

## 三、服务键与方法

```
ondra-adapter-discord        ← 连字符，不是 ondra:adapter-discord
```

| 方法 | 说明 |
|---|---|
| `useSocket(s)` | 注入帧层实现（同一时刻一个）；已在跑时返回 `false` |
| `setPush(p)` | 换 REST 实现（测试桩/内网网关） |
| `start()` | 开始连接；无端口时明确 warn「缺帧层实现」 |
| `stop()` | 停止：立旗 → 关端口 → 清定时器；幂等 |
| `ingest(raw)` | 端口把原始事件喂进来；返回 `accepted/not-message/self/empty/not-allowed/replayed/queued/ignored/bad-id` |
| `reply(conv, text)` | 分条 → 逐段发；返回 12 值结论 |
| `probe()` | `GET /users/@me`，只读确认 token |
| `status()` | 快照（`link` 四值 `closed/connecting/ready/stopped`、`lastCloseCode`、`nextRetryAt`） |
| `tick()` | 30 秒心跳：报探针 + 清过期排队（**不是 WS 心跳**） |
| `stats()` | events / messages / answered / sent / connects / reconnects / rejected / worstAnswerMs |
| `reload()` | 重读凭据（会先停连接） |

### 帧层端口

```ts
interface DiscordSocket {
  readonly id: string
  open(handlers: DiscordSocketHandlers): Promise<DiscordOpenResult>  // 永不抛错
  close(): void                                                     // 幂等，不得再回调 onClosed
}
interface DiscordSocketHandlers {
  onReady(info: { sessionId?: string; botUserId?: string }): void
  onEvent(raw: Record<string, unknown>): void
  onClosed(closeCode: number, reason?: string): void
  onError(detail: string): void
}
```

**实现方负责**：帧 op 码、IDENTIFY 载荷、心跳与 ACK、RESUME、zlib 分片。
**实现方禁止**：自行重连。断开只能 `onClosed(code)` 上报——两边都重连就会有两条 WS 收同一批事件，而 Discord 没有去重，重复回答不可逆。

## 四、配置

| 字段 | 默认 | 出处 |
|---|---|---|
| `enable` | `false` | 手册 §9.11：九个适配器默认全关 |
| `chunkMax` | `1900` | §9.11 单条上限（100–1900，只能往下调） |
| `apiBase` | `https://discord.com/api/v10` | 公开文档；仓内无副本 |
| `requestTimeoutMs` | `15000` | **不派生**：Discord REST 不会故意挂住（与 Telegram 长轮询相反） |
| `reconnectMs` | `5000` | §9.11 原话「其余 5s」；固定值不做指数 |
| `stopOnCodes` | `[]` | 除 4004 外的「不重连」码。**手册只点名 4004，其余无依据故出厂空** |
| `maxConcurrent` | `3` | 1–16 |
| `allowSenderIds` / `blockSenderIds` | `[]` | 白名单为空 = 任何能给 bot 私信的人都能触发她，装载期会 warn |
| `queueTtlMs` | `300000` | 五分钟后才答的那句话已经不是回答 |
| `credentialFile` | `''` | 留空由 `path-layout` 推出 |

**不落盘**：本包没有 `stateFile`。Discord 不重投已 ACK 事件，没有需要跨重启记住的东西；写一个文件却没人读，就会变成「每次心跳白改写」的老坑（O-066 记过一次）。

## 五、边界

- **不进提示词**：通道不发提示词片段，人格由 `ondra-persona-*` 拥有。
- **不注册工具**：模型不该能直接调「发 Discord 消息」——那等于给它一个绕过所有闸门的入口。
- **失败只影响自己**：`ingest()` / `reply()` / 端口回调全包 try/catch，异常折成结果或日志，绝不冒泡（手册 §8.1-C3）。

## 六、已知限制

1. **没有帧层实现（本轮唯一的阻断点）。** 手册无 Discord 专章（全文检索 `discord` 只有 2 处社群邀请链接），master-plan §9.11 只有一行，且本仓 `MESSAGE_CREATE` / `HELLO` / `RESUME` / `op_code` / `intents` **零命中**；宿主 `desktop/packages` 的 `ws` 只出现在 `api/gateway` 等包的私有依赖里，**不是插件可调用的服务键**，本轮又禁装依赖。因此：
   - 帧层做成 `DiscordSocket` 端口，`start()` 在端口为空时**明确 warn**并只注册服务与能力；
   - 凭据校验、分条 1900、`allowed_mentions`、关闭码处置、探针上报、幂等占位、并发与队列**全部已实现**；
   - 解除方式：实现 `DiscordSocket` 后调 `useSocket()`，**无需改本包任何代码**。
   - 这就是「网关事件形状按公开文档写、未实跑」的部位：`wire.ts` 的字段名（`t` / `d` / `content` / `mentions` / `timestamp`）若与真实帧有差，症状是「一条都不回」，改 `wire.ts` 一处即可。
2. **`4004` 之外的「不重连」码未内置。** 平台还有 4010–4014 一组同样不可重连的码，仓内无依据，故做成 `stopOnCodes` 名单，出厂为空。填错的症状是「一次正常断开被当成终止码，通道再也不连」。
3. **`stopOnCodes` 与「指数退避」都是刻意不做。** 持续被拒时是 5 秒一次无限重连——刻意接受：一次 WS 握手不构成风暴，而「连不上就悄悄停下」更难查。`stats().reconnects` 与 `status().lastCloseCode` 能直接看出。
4. **只发文字。** 图 / 语音 / 贴纸 / 文件协议未验证，能力表 `features: []`（不说「能发」）。
5. **群里能否收到非 @ 消息不由本包决定**：取决于 intents 与频道设置（帧层实现方与平台侧），故如实登记 `mentionRequired: false`，不假装能控制。
6. **不解析附件与 embeds**：`content` 为空且只有附件的消息按 `empty` 丢弃（本包只做文字）。
7. **`429` 的 `retry_after` 只上报不使用**：单列为 `rate-limited` 让调用方能看见，但本包不自动重试——重试策略归闸门层，通道不该自己决定「再发一次」。
8. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app，全部结论来自静态检查与纯逻辑对拍。

## 七、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 通道协议链与分条上限 | 手册 §9.11 实测表 | — | — | `discord`：Gateway WS v10、`Bot <token>`、1900、4004 停止重连其余 5s、**无去重** | 照该行实现判定与降级；帧层留端口 | 否 |
| 重连策略（鉴权失败即停） | 手册 §9.11 那一行 | — | — | 「4004 停止重连」的取舍：重试不会让错的 token 变对 | `link.ts` 的 `planOf()` 唯一判定点 | 否 |
| 风险控制码与退避表 | 手册 §5.3（实测 12 拦截 0 误伤） | — | — | 退避保持固定值、不叠加指数 | 只取「固定间隔」这一条，闸门本身归 O-042 | 否 |
| 通道隔离六条 | master-plan §16.2 | — | — | 一通道一目录 / 一凭据 / 一命名空间 / 一探针 / 一启停 | 目录与命名空间按此落地 | 否 |
| 传输端口化（不写未验证握手） | 本项目 O-058 `QqTransport` / O-054 `registerRenderer()` | 自有 | 自有 | 「没有运行时依据就只做接线，并显式降级」 | 同形设计，命名与回调面按 Discord 语义重排 | 是（自有资产） |
| 超时该不该派生 | 本项目 O-066（长轮询）+ 本包（REST） | 自有 | 自有 | 「请求会不会故意挂住」这一条判定规则 | `settings.ts` 文件头写清两个方向的反例 | 是（自有资产） |

**档位判定〔复〕**：Discord 生态有成熟的网关实现（discord.js 等），手册把它归入「通道复用」。本仓禁装依赖、且没有可供插件调用的 WS 服务键，故复用对象落在**端口**上，而不是直接引包。这是**环境限制导致的接线目标变化**，不是把〔复〕改成了〔研〕。
**偏离说明**：手册期望「直接用现成通道包」，本轮做不到（原因见上）。本包不含任何重写的协议机制，只做判定/护栏/降级，符合〔复〕的责任边界。

## 八、多方案分支说明

涉及 master-plan §14.3 的「通道唤醒」一项，但该项分支（`wakeProbability` / 全量 / 关键词）**落在 `ondra-router`**，本包只调 `admit()`，故不设分支。

传输的多方案（官方 SDK / 自实现 WS / 桥接网关）由**端口注入**表达：同一服务键、一个接口、每分支独立文件由实现方持有，本包不感知、不共享任何状态。

## 九、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有 Discord 这一个通道。`stop()` 幂等、无全局状态、不碰别人的缓存与连接。
2. **我的状态存在哪？** **只在内存**：连接状态机、在飞集合、排队表、计数。凭据在 `user/channels/discord.json`（0600，只读 + 权限收紧）。**刻意不落盘**：Discord 不重投已 ACK 事件，没有需要跨重启记住的东西（见「四、配置」末段）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `channel.discord`；`ondra-channel-health` 的 `channel.discord` 探针在心跳超期后报 `stale`；WS 断开时本包报 `disconnected` + 关闭码；`status().link` 与 `lastError` 直接给原因。
4. **我依赖谁？缺席时我怎么降级？** `DiscordSocket`（缺→只注册服务，明确 warn）、`ondra-router`（缺→直接回，不排队不唤醒）、`ondra-channel-kit`（缺→不回答并记一句「缺的是问人格的能力」）、`ondra-channel-health`（缺→不上报，收发照常）、`ondra-path-layout`（缺→凭据路径空，装载期 error）、`ondra-clock`（缺→系统时钟）、`ondra-config-schema`（缺→本地校验）。七个全软。
5. **我和同域的谁共享了可变状态？** 没有。在飞集合、排队表、连接状态机、计数都是本插件私有；登记进 router 的是**只读声明**（`registerChannel` 返回自己的 disposer）。
