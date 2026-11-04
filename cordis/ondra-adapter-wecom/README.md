# ondra-adapter-wecom

> O-063 · L5 通道 · 档位〔复〕 · 服务键 `ondra-adapter-wecom`

企业微信自建应用通道。**不自己 listen 端口**——回调路由挂在宿主的 `webServer` 上，卸载即撤。
真正的难点不是收消息，是**把加密回调解对**：WXBizMsgCrypt 写错一个字节，现象只有一句
「回调地址验证失败」，没有任何线索。

---

## 一、职责

1. **接回调**：`ctx.webServer.register({kind:'exact', path})`，GET 走验证回 `echostr` 明文，POST 走进信处理。
2. **解包**：自实现 WXBizMsgCrypt 的**只解不封**版（`src/crypt.ts`）。签名 = `sha1(sort([token, timestamp, nonce, encrypt]).join(''))`；正文 = `AES-256-CBC`（key = `base64(EncodingAESKey + '=')`，iv = key 前 16 字节），帧 = `随机 16 字节 ‖ 4 字节大端长度 ‖ 正文 ‖ receiveid`，填充 = **PKCS#7 / 32 字节块**。
3. **先回 `success`**：`ingest()` 在纯计算（验签 + 解密 + 解析 + 去重）之后**立刻**返回 `success`，企业微信收到即停止重试；回答在后台跑。
4. **异步回答**：走**应用消息**（`message/send`）。这条通道与回调请求无关，想什么时候发都行——所以这里**没有降级话术、没有 5 秒预算、没有交棒**。
5. **切条**：平台硬上限 2000（master-plan §9.11），切法只认 O-056 的 `chunk()`；上游给的段若超限，再请 O-056 切一次，绝不自己写第二套。
6. **隔离**：凭据 `user/channels/wecom.json`（0600）、状态 `…wecom.state.json`（0600）、日志命名空间 `channel.wecom`、独立探针上报、独立开关。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 端口监听、TLS、证书 | **宿主 `webServer`**（本插件只注册一条路由） |
| 公网可达、反代、域名备案 | 部署方（第五节给了填法） |
| 判「这条该不该回」 | `ondra-router`（O-055） |
| 分条算法 | `ondra-channel-kit`（O-056） |
| 人格、提示词、前缀冻结 | `ondra-persona-*` / `ondra-dialogue` |
| 记健康状态与「上次活到几时」 | `ondra-channel-health`（O-057） |
| 被动回复（加密 XML） | 本插件刻意不做：`success` 已经足够（见第四节） |
| 群聊 | 群里 @ 应用属于「智能机器人」产品，不走自建应用回调 |

## 三、服务键与方法

```
ondra-adapter-wecom      ← 连字符，不是 ondra:adapter-wecom
```

| 方法 | 作用 |
|---|---|
| `verify(query)` | GET 验证，返回 `{ok, http, body, reason}`；`body` 是 `echostr` 的**明文** |
| `ingest(rawBody, query, at?)` | POST 处理，返回 `{http, body, disposition, reason, answering}` |
| `reply(conversationId, text)` | 主动发应用消息（无窗口限制，随时可发） |
| `status()` | `registered` / `credential` / `allowlist` / `inflight` / `queued` / `lastError` |
| `stats()` | `inbound` / `answering` / `sent` / `rejected` / `worstAnswerMs` |
| `tick()` / `flush()` | 清过期去重记录 + 节流落盘 + 探针心跳 |
| `markRegistered(v)` / `reload()` / `setPush()` | 路由挂载标记 / 换凭据后重读 / 换推送实现（测试桩、企业网关） |

## 四、为什么是「先回 success」，而不是抄公众号的降级话术

```
t=0        收到 POST
t≈10ms     验签 + AES 解密 + 解析 + 去重（纯计算）
t=10ms     回 "success"（企业微信停止重试）
t=10ms+    问人格 → 走应用消息把话发出去
```

`success` 在企业微信里的语义是「**我收到了，不需要被动回复**」，不是「我说完了」。
真正的回答走应用消息，那条通道想什么时候发都行。所以：

- **不需要降级话术**：抄过来只会「先说一句我在呢，紧跟着再说真话」，两句都到，用户看到的是在原地重复自己的人。
- **不需要 5 秒预算与交棒**：那是「必须在一个响应里说完」的产物（O-060）。这里没有那个约束。
- **不需要被动回复**：要做被动回复就得写加密（`encrypt()`）。本插件永远回 `success`，那条路径不存在，写了就是死代码——而死代码最坏的地方是让人以为「被动回复这条路已经支持了」。

**唯一的例外是「配置错了」**：验签失败 / 解包失败 / 报文里没有 `<Encrypt>` 时回 **401**，因为那种情况必须让对方在后台配置页上**当场看见**「回调失败」。回 200 会让消息静默消失，而用户只会觉得「她不回我」。

### 并发与排队

- **同一会话同时只跑一轮**：连发两条会得到两段互不知情的回答，用户看到的是「她同时在说两件不相干的事」。
- **全局并发上限**默认 3（`maxConcurrent`）。被上限挤掉的来信进本地队列，**任意一轮收尾时都会补位**（`pump()`）——只补自己那条队列是不够的：被挤掉的很可能是**另一个会话**，它的队列只有在别人收尾时才可能被看见。
- 排队在这里是安全的：应用消息随时能发，不存在「排久了就发不出去」。

## 五、部署（回调只能填一个能公网访问的地址）

**顺序不能反**：`verify()` 在通道关闭时回 503，所以在后台点「保存」之前必须先把开关打开。
正确顺序是 **①填凭据 → ②`enable: true` → ③再去后台填回调地址**。反过来做的话，
后台会一直显示「验证失败」，而原因只是「插件还关着」。

1. 企业微信管理后台 → 应用管理 → 自建应用 → 接收消息 → **设置 API 接收**。
2. 回调地址填 `https://<你的域名><routePath>`（默认 `/ondra/wecom`）。
3. **必须填 EncodingAESKey**：本插件只接受加密回调。明文回调没有 `msg_signature`，等于「谁知道地址谁就能伪造一条来信」，所以明文报文一律 401 拒掉并写日志。
4. Token、EncodingAESKey、CorpID、AgentId、Secret 全部写进 `user/channels/wecom.json`（0600）：

```json
{
  "corpId": "ww1234567890abcdef",
  "agentId": 1000002,
  "secret": "自建应用的 Secret",
  "token": "接收消息服务器配置里的 Token",
  "encodingAESKey": "43 个字符的 EncodingAESKey"
}
```

5. 端口归宿主：master-plan §9.11 记的 3455 是旧项目本机端口。实际部署是「宿主 `webServer` 绑 443 或前置反代」，插件不改端口。

## 六、边界与隔离（master-plan §16.2 六条）

| 条 | 本插件的落点 |
|---|---|
| 1 目录隔离 | 独立包 `ondra-adapter-wecom/`，不与其他通道共用源码 |
| 2 配置隔离 | 自身 `Config` 14 个字段；凭据落 `user/channels/wecom.json`（0600，读到即收紧） |
| 3 日志隔离 | 命名空间 `channel.wecom`（经 `ondra-identity` 取前缀） |
| 4 状态隔离 | 去重表本通道独有、仅内存 + 可选落盘；通道消息不进主会话 |
| 5 失败隔离 | 单条失败只影响自身；`ctx.effect` 返回 disposer，卸载即清定时器与路由 |
| 6 风险隔离 | 合规通道（非高危），与 NapCat / 个人微信分属不同包，不共用确认档案 |

## 七、已知限制

1. **手册里没有企业微信专章**：`Ondra-dev-handbook.md` 检索「企业微信」**零命中**，唯一依据是 master-plan §9.11 的一行（`Webhook 3455 · 自实现 WXBizMsgCrypt（AES-256-CBC）· 2000 · 先回 success`）。本插件只承诺那一行能推出的四件事。
2. **两个接口路径按公开文档写、仓内无副本、未实跑**：`/cgi-bin/gettoken`、`/cgi-bin/message/send`。任何一处改名都会以 `errcode` 原样带回日志，不会静默「以为发了」。
3. **只接受加密回调**：明文模式被明确拒掉（理由见第五节第 3 条）。
4. **只处理文本**：`image` / `voice` / `file` / `event` 一律 `unsupported`（事件应答属人设层决定，通道层不偷偷写）。
5. **没有群聊**：自建应用回调只有成员与应用的私聊。
6. **签名排序按 UTF-16 码元**：JS 的 `Array.prototype.sort()` 与逐字节序在 ASCII 下一致；Token 若含非 ASCII 字符，可能与三方实现的排序不同。**Token 请只用 ASCII**。
7. **不判时间偏差（skew）**：企业微信的重试与网络抖动都会让 `timestamp` 偏移，判时间窗会把正常重试拒掉。防重放靠 `MsgId` 去重（默认窗口 30 分钟）。
8. **`worstAnswerMs` 是「从收到到回答完成」**：它不是「响应延迟」——响应几乎是立刻的，这个数只用来发现「模型那侧慢到用户以为掉线」。
9. **信封里的 `AgentID` 只告警、不拒**：信封是明文且未签名，里面的字段是对方写的字；真正证明「这条消息是给本企业的」只有解密后帧尾的 `receiveid`（签名保护过）。AgentID 不一致只写一条 warn，用来帮人早点发现「回调地址被多个应用共用」。
10. **本包未实装运行**：全部结论来自静态检查与纯逻辑复刻（见第九节）。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 企业微信回调与 WXBizMsgCrypt | 企业微信公开文档（协议本身） | 公开文档，非仓库 | 不适用（协议编解码） | 帧格式、签名拼法、PKCS#7/32、`receiveid` 校验 | 自研 `src/crypt.ts`，只用 `node:crypto`（内建，不算新增依赖） | 否 |
| 通道适配器形状 | 旧项目九通道实测口径（master-plan §9.11） | 本仓 `cordis/ondra-master-plan.md` | 自有 | 「单条上限 + 先响应」这两条硬约束 | 自研 `src/adapter.ts` | 是（自有资产，重写） |
| 回调路由注册 | 宿主 `ondra-host-webserver` | `desktop/packages/host/webserver` | 随仓 | `register(route)` 返回 disposer、重复 `(kind,path)` 抛错 | 直接调 `ctx.get('webServer').register()` | 否 |
| 分条 | `ondra-channel-kit`（O-056） | 本仓 | 自有 | `chunkText` 的切法 | 经服务键调用，不复制 | 否 |

**档位判定依据**：手册 §1.8 把「QQ/微信/飞书通道」列**复用档**——复用指的是「有成熟生态就不重写机制」。本仓禁装依赖（§16.3），企业微信的生态实现（各语言 SDK）无法直接引入，故落到**只做接线、配置与降级**：协议编解码按 §12.1 第 3 条（协议编解码属允许自写的情形）用内建 `node:crypto` 实现，其余全是接线。

## 九、多方案说明（master-plan §12）

| 决策点 | 方案 | 取舍 |
|---|---|---|
| 应答方式 | 被动回复（加密 XML）／ 先回 `success` + 应用消息 | **选后者**：手册原文就是「先回 success」；且省掉一整条加密实现（无消费者的加密函数是死代码） |
| 解包位置 | 本包自实现／等第三方 SDK | **自实现**：本仓禁装依赖，且 `node:crypto` 是内建 |
| 群聊 | 自建应用回调／智能机器人产品 | **不做**：智能机器人是另一个产品线，混进来会让「群消息从哪来」有两个答案 |
| 防封 | 抄 QQ 六道闸／平台频控 + 并发上限 | **选后者**：§5.3 标题就是「QQ 防封控」，搬过来只会得到「莫名被限流」 |

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。回调路由撤掉、服务键消失；其他通道与 L0–L4 全部照常。
2. **我的状态存在哪？** 去重表：内存 + `user/channels/wecom.state.json`（0600，原子写）；其余全是内存计数。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `channel.wecom`；探针按 `channelId='wecom'` 上报 `heartbeat` / `error`（O-057 的 `probe()` 会据此判 `stale` / `degraded`）。
4. **我依赖谁？缺席时我怎么降级？** `webServer`（缺席 → 打 error 说「收不到消息」，服务照常注册）、`router`（缺席 → 照答）、`channel-kit`（缺席 → 这条不回答，留一句日志）、`channel-health`（缺席 → 静默）、`config-schema` / `path-layout` / `clock` / `identity`（全软）。**没有一条会阻断加载**。
5. **我和同域的谁共享了可变状态？** 没有。去重表、并发计数、排队表都是本包私有；与 O-055/O-056/O-057 只有单向调用。
