# ondra-adapter-dingtalk

> O-065 · L5 通道 · 档位〔复〕 · 服务键 `ondra-adapter-dingtalk`

钉钉 Outgoing 通道。**不自己 listen 端口**——回调地址挂在宿主的 `webServer` 上，卸载即撤。
两个最容易踩空的地方：**回答要走两条出口里合适的那条**（`sessionWebhook` 会过期），
以及 **`appKey` 不是多余字段**（旧项目表单让它白填，这里它是主动接口的必需项）。

---

## 一、职责

1. **接回调**：`ctx.webServer.register({kind:'exact', path})`，只收 POST。
2. **验签**：`timestamp + sign` 两个头，`sign = base64(HMAC-SHA256(timestamp + "\n" + appSecret, appSecret))`；时间戳超出容差（默认 1 小时）也拒。
3. **先回空体再异步**：`ingest()` 立刻回 **200 空体**（master-plan §9.11 原话「先回 empty」），回答在后台发。
4. **双出口**：`sessionWebhook`（这条消息自带、不用换 token、**会过期**）/ 机器人主动接口（要 `appKey` + `robotCode`、不会过期）。默认 `auto`：没过期走前者，过期换后者。
5. **去重**：`msgId` 为主键，窗口默认 **10 分钟**（真实重投档位仓内无依据，见第九节）。
6. **剥 @ 前缀**：群聊与「在 @ 名单里」的报文，正文开头那段 `" @机器人 "` 是平台加的记号，剥掉；**私聊不剥**——用户手打一句「@你 在吗」，那个「@你」是他说的话。中间与结尾的 `@名字` 一个都不动。
7. **切条**：平台实测上限 4000（master-plan §9.11），切法只认 O-056 的 `chunk()`。
8. **隔离**：凭据 `user/channels/dingtalk.json`（0600，读到即收紧）、状态 `…dingtalk.state.json`（0600）、日志命名空间 `channel.dingtalk`、独立探针、独立开关。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 端口监听、TLS、证书 | **宿主 `webServer`** |
| 公网可达、反代、域名 | 部署方（第五节给了填法） |
| 判「这条该不该回」 | `ondra-router`（O-055） |
| 分条算法 | `ondra-channel-kit`（O-056） |
| 人格、提示词、前缀冻结 | `ondra-persona-*` / `ondra-dialogue` |
| 记健康状态 | `ondra-channel-health`（O-057） |
| 图片/文件/卡片消息 | 刻意不做：一律 `unsupported`，不回「我看不懂」 |
| 「群里是否要 @」开关 | 刻意不做：那是平台行为，给开关就是假开关 |

## 三、服务键与方法

```
ondra-adapter-dingtalk      ← 连字符，不是 ondra:adapter-dingtalk
```

| 方法 | 作用 |
|---|---|
| `ingest(rawBody, headers, at?)` | 回调处理，返回 `{http, body, disposition, reason, answering}`；`body` 恒为空串 |
| `reply(conversationId, text)` | 主动发言（只能走主动接口，且这条会话必须来过消息） |
| `status()` | `registered` / `credential` / `activeReady` / `allowlist` / `inflight` / `queued` / `contacts` / `lastError` |
| `stats()` | `inbound` / `answering` / `sent` / `rejected` / `byExit` / `worstAnswerMs` |
| `tick()` / `flush()` | 清过期去重记录 + 节流落盘 + 探针心跳 |
| `markRegistered(v)` / `reload()` / `setPush()` | 路由挂载标记 / 换凭据后重读 / 换发信实现 |

## 四、四个必须说清楚的判断

### 1. 先回空体，连「我在呢」都不说

钉钉等的是**响应**，不是答案。在响应体里塞正文，意味着「问人格 + 切 4000 字 + 发出去」必须在那一次 HTTP 里跑完，超时它就重投。回一句垫场话看起来更亲切，但它会把一次回答拆成两条消息气泡。真正需要垫场的只有 O-060 那条 5 秒硬限的公众号链路——那里不垫就发不出去。

### 2. `sessionWebhook` 会过期，而**不猜过期错误码**

每条来信自带 `sessionWebhook` 与 `sessionWebhookExpiredTime`。过期判据只用这个时间戳（留 5 秒余量），**不靠 `errcode` 反推**：钉钉的过期错误码仓内查不到依据，猜错会把「发送失败」误判成「换出口重发」，结果是同一句话说两遍。

出口选择：

| `replyVia` | 行为 |
|---|---|
| `auto`（默认） | 没过期走 `sessionWebhook`，过期走主动接口 |
| `session` | 只走 `sessionWebhook`；过期即 `expired-session`（排查用） |
| `active` | 只走主动接口；缺 `appKey` 即 `no-app-key`（排查用） |

**每一段发之前重判一次**：4000 字切成三段，最后一段完全可能刚好跨过期限。

### 3. 超时**不**换出口

超时是「不知道发没发出去」。换出口重发拿到的是一个可能重复的结果：用户看到同一句话说两遍，而日志里两条都写着成功。只有「确定未送达」（`sessionWebhook` 已过期）才换出口。宁可让用户追问一次。

### 4. `appKey` 从「多余字段」变成「第二条出口的钥匙」

master-plan §9.12 记着旧项目的坑：表单让人填 `appKey`，源码只读 `appSecret` —— 填了也不生效。新体系里两者的关系是：

- `appSecret` —— **唯一必需项**，验签用它；
- `appKey` + `robotCode` —— 只给主动接口换 `accessToken`。

缺后者只关掉一条出口（日志会明说、面板 `activeReady` 为 false），不会关掉整条通道。这比「删掉字段」和「留着让人白填」都诚实。

## 五、部署

**顺序不能反**：本插件在开关关着时回 200 空体（而不是 4xx），所以「后台看到回调成功」不代表它真的在回话。正确顺序是 **①填凭据 → ②`enable: true` → ③再去后台填回调地址并打开「加签」**。

1. 钉钉开发者后台 → 应用 → 机器人 → **消息接收模式** 选 `HTTP 推送`，地址填 `https://<你的域名><routePath>`（默认 `/ondra/dingtalk`）。
2. **打开「加签」**：本插件按 HmacSHA256 校验；不开加签时 `timestamp`/`sign` 头不存在，会被 401 拒（`bad-sign`）。
3. 凭据写进 `user/channels/dingtalk.json`（0600）：

```json
{
  "appSecret": "应用的 AppSecret（必需）",
  "appKey": "应用的 AppKey（只走主动接口才需要）",
  "robotCode": "机器人的 robotCode（同上）"
}
```

4. 端口归宿主：master-plan §9.11 记的 3454 是旧项目本机端口。实际部署是「宿主 `webServer` 绑 443 或前置反代」。

## 六、边界与隔离（master-plan §16.2 六条）

| 条 | 本插件的落点 |
|---|---|
| 1 目录隔离 | 独立包 `ondra-adapter-dingtalk/` |
| 2 配置隔离 | 自身 `Config` 16 个字段；凭据落 `user/channels/dingtalk.json`（0600，读到即收紧） |
| 3 日志隔离 | 命名空间 `channel.dingtalk`（经 `ondra-identity` 取前缀，默认全名 `ondra.channel.dingtalk`） |
| 4 状态隔离 | 去重表与「学到的会话身份」本通道独有、仅内存 + 可选落盘；通道消息不进主会话 |
| 5 失败隔离 | 单条失败只影响自身；`ctx.effect` 返回 disposer，卸载即清定时器与路由 |
| 6 风险隔离 | 合规通道，与 NapCat / 个人微信分属不同包；无二次确认（不需要） |

## 七、已知限制

1. **手册没有钉钉专章**：`Ondra-dev-handbook.md` 检索「钉钉」只命中一处（设置页通道清单）。唯一可核对的参数依据是 master-plan §9.11 的一行 + §9.12 的一条字段修正。本插件只承诺那一行能推出的四件事（验签 / 4000 / 先回 empty 再异步 / webhook 回调）。
2. **`sessionWebhook` 的报文形状、主动接口的三个路径**（`/v1.0/oauth2/accessToken`、`/v1.0/robot/oToMessages/batchSend`、`/v1.0/robot/groupMessages/send`）按公开文档写、**仓内无副本、未实跑**。任何一处改名都会以 `code` 原样带回日志。
3. **加签公式的细节按公开文档口径实现**：`stringToSign = timestamp + "\n" + appSecret`，密钥也是 `appSecret`。若真实实现与文档有差，症状是「永远 `bad-sign`」——那时先改 `src/sign.ts` 的 `signOf()` 一处。
4. **去重窗口 10 分钟是保守值**，不是查到的档位；若平台重投更长，改 `dedupeWindowMs`。
5. **只处理文本**：`msgtype !== 'text'` 一律 `unsupported`，不回答。
6. **主动发言要求「这条会话之前来过消息」**：私聊要 `staffId`、群要 `openConversationId`，两者都从报文里学。没学过就 `no-sender`，不猜。
7. **不判重放**：验签带时间戳容差（防重放的主要手段），但没有 `nonce` 表——同一签名的重复请求在窗口内会靠 `msgId` 去重接住。
8. **排队有时间成本**：一条消息若排到 `sessionWebhook` 过期之后才被回答，就只能走主动接口（要 `appKey` + `robotCode`），两者都没有就标 `expired-session` 不发。并发上限（默认 3）与白名单共同决定队列会不会长到那一步。
9. **路由归还的积压正文不复读**：`router.release()` 交出的是**用户说的话**，本包只当「占位已归还」的信号，真正回答走本地队列（那里带着原始的 `sessionWebhook`）。已 done 的 O-060 / O-063 / O-064 把 `item.text` 直接发了出去，见台账「契约冲突」登记——本轮不改别人的包。
10. **本包未实装运行**：全部结论来自静态检查与纯逻辑复刻（见第八、九节）。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 钉钉 Outgoing 回调与消息发送 | 钉钉开放平台公开文档（协议本身） | 公开文档，非仓库 | 不适用（协议编解码） | 报文结构、`msgParam` 双层序列化、`sessionWebhook` 语义 | 自研 `src/wire.ts` + `src/transport.ts` | 否 |
| HmacSHA256 加签 | 钉钉加签公开口径 | 公开文档，非仓库 | 不适用（算法） | `timestamp + "\n" + appSecret` 与 base64 | 自研 `src/sign.ts`（只用 `node:crypto`） | 否 |
| 通道适配器形状 | 旧项目九通道实测口径（master-plan §9.11/§9.12） | 本仓 `cordis/ondra-master-plan.md` | 自有 | 「单条上限 + 先响应」两条硬约束、`appKey` 字段坑 | 自研 `src/adapter.ts` | 是（自有资产，重写） |
| 回调路由注册 | 宿主 `ondra-host-webserver` | `desktop/packages/host/webserver` | 随仓 | `register(route)` 返回 disposer、重复 `(kind,path)` 抛错 | 直接调 `ctx.get('webServer').register()` | 否 |
| 分条 | `ondra-channel-kit`（O-056） | 本仓 | 自有 | `chunkText` 的切法 | 经服务键调用，不复制 | 否 |

**档位判定依据**：手册 §1.8 把「QQ/微信/飞书通道」列**复用档**（「通道全部复用，只写人格一致性与节制」），钉钉同属通道层。本仓禁装依赖（§16.3），钉钉官方 SDK 无法引入，故落到**只做接线、配置与降级**：HTTP 用全局 `fetch`，签名用 `node:crypto`，没有一行第三方代码。

## 九、多方案说明（master-plan §12）

| 决策点 | 方案 | 取舍 |
|---|---|---|
| 应答方式 | 在响应体里带回复（钉钉 Outgoing 支持）／先回空体再异步 | **后者**：手册 §9.11 原话，且 4000 字切条 + 人格调用不适合塞进一次 HTTP |
| 回信出口 | 只用 `sessionWebhook`／只用主动接口／`auto` 两条 | **`auto`**（§14.1「能融就融」）：两个都要，按过期时刻选；两个显式值留给排查 |
| 过期判定 | 看 `errcode`／看报文时间戳 | **看时间戳**：错误码无依据，猜错会重复发 |
| 失败重试 | 超时也换出口重发／只换「确定未送达」 | **后者**：超时重发的代价是同一句话说两遍 |
| 去重窗口 | 30 分钟（QQ 口径）／65 分钟（飞书口径）／10 分钟 | **10 分钟**：本通道回 200 空体后重投极罕见，窗口再大只是让 `seen` 表变胖 |
| 会话键 | `senderId`（人）／`conversationId`（会话） | **`conversationId`**：用人的 id 会把同群十个人当成十个会话 |

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。路由撤掉、服务键消失；其他通道与 L0–L4 全部照常。
2. **我的状态存在哪？** 去重表与「学到的会话身份」：内存 + `user/channels/dingtalk.state.json`（0600，原子写，只存去重表）；其余全是内存计数。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.channel.dingtalk`；探针按 `channelId='dingtalk'` 上报 `heartbeat` / `error`。
4. **我依赖谁？缺席时我怎么降级？** `webServer`（缺席 → 打 error 说「收不到消息」，服务照常注册）、`router`（缺席 → 照答）、`channel-kit`（缺席 → 这条不回答，留一句日志）、`channel-health`（缺席 → 静默）、`config-schema` / `path-layout` / `clock` / `identity`（全软）。**没有一条会阻断加载**。
5. **我和同域的谁共享了可变状态？** 没有。去重表、会话身份表、并发计数、排队表都是本包私有；与 O-055/O-056/O-057 只有单向调用。
