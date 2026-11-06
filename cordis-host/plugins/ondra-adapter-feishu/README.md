# ondra-adapter-feishu

> O-064 · L5 通道 · 档位〔复〕 · 服务键 `ondra-adapter-feishu`

飞书事件订阅通道。**不自己 listen 端口**——请求地址挂在宿主的 `webServer` 上，卸载即撤。
两个最容易踩空的地方：**群里回复必须发到 `chat_id`**（发到 `open_id` 就变成私聊），
以及 **`content` 是「字符串里套 JSON」**（少一层序列化就被判参数错误）。

---

## 一、职责

1. **接回调**：`ctx.webServer.register({kind:'exact', path})`，只收 POST。
2. **验 token**：`header.token`（v2）或顶层 `token`（老形态），与凭据里的 `verificationToken` 逐字比对；`header.app_id` 与凭据不一致也拒。
3. **地址验证**：`{"type":"url_verification","challenge":"…"}` → **原样**回 `{"challenge":"…"}`。
4. **加密体明确拒**：请求体带 `encrypt` 字段 → **400 + 原因**。master-plan §9.11 明写「`encryptKey` 不支持加密体」；假装解了会把乱码当用户的话，静默接受会让她永远不回。
5. **先 200 再异步**：`ingest()` 立刻回 `{"code":0}`，回答走 `im/v1/messages` 在后台发。
6. **去重**：`header.event_id` 为主键，窗口默认 **65 分钟**（盖住飞书三档重投：约 15 秒 / 5 分钟 / 1 小时）。
7. **切条**：平台硬上限 4000（master-plan §9.11），切法只认 O-056 的 `chunk()`。
8. **隔离**：凭据 `user/channels/feishu.json`（0600）、状态 `…feishu.state.json`（0600）、日志命名空间 `channel.feishu`、独立探针、独立开关。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 端口监听、TLS、证书 | **宿主 `webServer`** |
| 公网可达、反代、域名 | 部署方（第五节给了填法） |
| 判「这条该不该回」 | `ondra-router`（O-055） |
| 分条算法 | `ondra-channel-kit`（O-056） |
| 人格、提示词、前缀冻结 | `ondra-persona-*` / `ondra-dialogue` |
| 记健康状态 | `ondra-channel-health`（O-057） |
| 解加密体 | 刻意不做：见上第 4 条 |
| 「群里是否要 @」开关 | 刻意不做：那是平台行为，给开关就是假开关 |

## 三、服务键与方法

```
ondra-adapter-feishu      ← 连字符，不是 ondra:adapter-feishu
```

| 方法 | 作用 |
|---|---|
| `verify(payload)` | 地址验证，回 `{http, body}`；`body` 是 `{"challenge":"…"}` |
| `ingest(rawBody, at?)` | 事件处理，返回 `{http, body, disposition, reason, answering}` |
| `reply(conversationId, text)` | 主动发消息（无窗口限制） |
| `status()` | `registered` / `credential` / `allowlist` / `inflight` / `queued` / `lastError` |
| `stats()` | `inbound` / `answering` / `sent` / `rejected` / `worstAnswerMs` |
| `tick()` / `flush()` | 清过期去重记录 + 节流落盘 + 探针心跳 |
| `markRegistered(v)` / `reload()` / `setPush()` | 路由挂载标记 / 换凭据后重读 / 换推送实现 |

## 四、三个必须说清楚的判断

### 1. 回复发到 `chat_id`，不是 `open_id`

群里被 @ 时，`sender.sender_id.open_id` 是**那个人**，`message.chat_id` 是**那个群**。
用 `open_id` 回复 = 给他发**私聊**：他会在另一个会话里看到回答，群里的人什么也看不到，
而插件日志每一条都写着成功。所以会话键与 `receive_id` 都取 `chat_id`
（`receive_id_type=chat_id`）。

### 2. `content` 要再序列化一层

```
收：{"message":{"message_type":"text","content":"{\"text\":\"你好\"}"}}   ← 字符串里套 JSON
发：{"msg_type":"text","content":"{\"text\":\"你好\"}"}                    ← 同样套一层
```

少一层会以 `code=230001`（参数错误）被拒，而错误信息不会告诉你「少了一层序列化」。

### 4. 并发与排队

- **同一会话同时只跑一轮**：群里两个人同时 @ 她，两条并发会得到两段互不知情的回答。
- **全局并发上限**默认 3（`maxConcurrent`）。被上限挤掉的事件进本地队列，**任意一轮收尾时都会补位**（`pump()`）——只补自己那条队列是不够的：被挤掉的很可能是**另一个会话**，它的队列只有在别人收尾时才可能被看见。
- 排队是安全的：飞书消息随时能补发，没有「响应窗口」这回事。

### 3. 群里正文带 `@_user_1` 占位符

它是给渲染器用的记号，不是用户说的话。`stripMentions()` 只剥 `@_user_N`，
**不剥用户真的打出来的 `@名字`**——「@小王 你看」里的「小王」是意思的一部分。
剥完为空（只发了一个 @）时不回答，标 `unsupported`：那不是一句话，回答什么都是猜。

## 五、部署

**顺序不能反**：`verify()` 在通道关闭时回 503，所以在开发者后台点「保存」之前必须先把开关打开。
正确顺序是 **①填凭据 → ②`enable: true` → ③再去后台填请求地址并点保存**。反过来做，
后台会一直显示「验证失败」，而原因只是「插件还关着」。

1. 飞书开放平台 → 应用 → 事件订阅 → **请求地址**填 `https://<你的域名><routePath>`（默认 `/ondra/feishu`）。
2. **关闭 Encrypt Key**：本插件不支持加密体，开着会被 400 拒。
3. 订阅事件 `im.message.receive_v1`；权限至少要有「接收消息」与「以应用身份发消息」。
4. 凭据写进 `user/channels/feishu.json`（0600）：

```json
{
  "appId": "cli_a1b2c3d4e5f6g7h8",
  "appSecret": "应用的 App Secret",
  "verificationToken": "事件订阅页面的 Verification Token"
}
```

5. 端口归宿主：master-plan §9.11 记的 3453 是旧项目本机端口。实际部署是「宿主 `webServer` 绑 443 或前置反代」。

## 六、边界与隔离（master-plan §16.2 六条）

| 条 | 本插件的落点 |
|---|---|
| 1 目录隔离 | 独立包 `ondra-adapter-feishu/` |
| 2 配置隔离 | 自身 `Config` 14 个字段；凭据落 `user/channels/feishu.json`（0600，读到即收紧） |
| 3 日志隔离 | 命名空间 `channel.feishu`（经 `ondra-identity` 取前缀） |
| 4 状态隔离 | 去重表本通道独有、仅内存 + 可选落盘；通道消息不进主会话 |
| 5 失败隔离 | 单条失败只影响自身；`ctx.effect` 返回 disposer，卸载即清定时器与路由 |
| 6 风险隔离 | 合规通道，与 NapCat / 个人微信分属不同包 |

## 七、已知限制

1. **手册没有飞书专章**：`Ondra-dev-handbook.md` 检索「飞书」只有「通道全部复用」两处提及，唯一可核对的参数依据是 master-plan §9.11 的一行。本插件只承诺那一行的四件事（token / 4000 / 先 200 再异步 / 不支持加密体）。
2. **两个接口路径按公开文档写、仓内无副本、未实跑**：`/open-apis/auth/v3/tenant_access_token/internal`、`/open-apis/im/v1/messages`。任何一处改名都会以 `code` 原样带回日志。
3. **不支持加密体**（明确 400），**不支持卡片/富文本**（只发 `text`），只处理 `text` 类型的来信；`post` / `image` / `file` 一律 `unsupported`。
4. **群消息只在被 @ 时才有事件**：这是平台行为，本插件如实登记 `mentionRequired: true`，不设开关。
5. **token 失效码只认两个**（`99991661` / `99991663`）：其余错误原样带回，不猜着重试——猜会把一次配置错误变成一串重复请求。
6. **去重窗口 65 分钟**是「盖住第三档重投」的推断值；若平台改成更长的重投间隔，第三档之后的重复答需要调这个数。
7. **`worstAnswerMs` 是「从收到到回答完成」**，不是响应延迟（响应几乎是立刻的）。
8. **本包未实装运行**：全部结论来自静态检查与纯逻辑复刻（见第九节）。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 飞书事件订阅与消息发送 | 飞书开放平台公开文档（协议本身） | 公开文档，非仓库 | 不适用（协议编解码） | 事件体结构、`content` 双层序列化、`receive_id_type` 语义 | 自研 `src/wire.ts` + `src/transport.ts` | 否 |
| 通道适配器形状 | 旧项目九通道实测口径（master-plan §9.11） | 本仓 `cordis/ondra-master-plan.md` | 自有 | 「单条上限 + 先响应」两条硬约束 | 自研 `src/adapter.ts` | 是（自有资产，重写） |
| 回调路由注册 | 宿主 `ondra-host-webserver` | `desktop/packages/host/webserver` | 随仓 | `register(route)` 返回 disposer、重复 `(kind,path)` 抛错 | 直接调 `ctx.get('webServer').register()` | 否 |
| 分条 | `ondra-channel-kit`（O-056） | 本仓 | 自有 | `chunkText` 的切法 | 经服务键调用，不复制 | 否 |

**档位判定依据**：手册 §1.8 把「QQ/微信/飞书通道」列**复用档**（「通道全部复用，只写人格一致性与节制」）。本仓禁装依赖（§16.3），飞书官方 SDK 无法引入，故落到**只做接线、配置与降级**：HTTP 接线用全局 `fetch`，协议解析用 `JSON`，没有一行第三方代码。

## 九、多方案说明（master-plan §12）

| 决策点 | 方案 | 取舍 |
|---|---|---|
| 应答方式 | 在响应里带回复（飞书不支持）／先 200 再异步发 | **只能后者**：飞书的响应不是投递通道，且超时会重投 |
| 会话键 | `open_id`（人）／ `chat_id`（会话） | **选 chat_id**：群里发到 open_id 会变成私聊（见第四节） |
| 加密体 | 自实现解密／明确拒 | **明确拒**：master-plan §9.11 明写不支持；自实现等于新开一条没验证过的解密链路 |
| 重投去重 | 30 分钟（微信口径）／65 分钟 | **65 分钟**：飞书第三档重投在 1 小时，30 分钟会漏掉那一档 |
| 防封 | 抄 QQ 六道闸／平台频控 + 并发上限 | **后者**：§5.3 标题是「QQ 防封控」，飞书的瓶颈是频控不是封号 |

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。路由撤掉、服务键消失；其他通道与 L0–L4 全部照常。
2. **我的状态存在哪？** 去重表：内存 + `user/channels/feishu.state.json`（0600，原子写）；其余全是内存计数。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `channel.feishu`；探针按 `channelId='feishu'` 上报 `heartbeat` / `error`。
4. **我依赖谁？缺席时我怎么降级？** `webServer`（缺席 → 打 error 说「收不到消息」，服务照常注册）、`router`（缺席 → 照答）、`channel-kit`（缺席 → 这条不回答，留一句日志）、`channel-health`（缺席 → 静默）、`config-schema` / `path-layout` / `clock` / `identity`（全软）。**没有一条会阻断加载**。
5. **我和同域的谁共享了可变状态？** 没有。去重表、并发计数、排队表都是本包私有；与 O-055/O-056/O-057 只有单向调用。
