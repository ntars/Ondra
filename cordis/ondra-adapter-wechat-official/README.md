# ondra-adapter-wechat-official

> O-060 · L5 通道 · 档位〔复〕 · 服务键 `ondra-adapter-wechat-official`

微信公众号通道。**不自己 listen 端口**——回调路由挂在宿主的 `webServer` 上，卸载即撤。
真正的难点不是收消息，是**5 秒硬限之后怎么把话说完**。

---

## 一、职责

1. **接回调**：`ctx.webServer.register({kind:'exact', path})`，GET 走验签回 `echostr`，POST 走进信处理。
2. **验签**：`sha1(token, timestamp, nonce)` 三者**按字典序排序**后拼接取 sha1，与 `signature` 定长比较。
3. **去重**：微信在 5 秒内没收到响应会**重试三次**，所以先认 `MsgId`（事件消息退回「人 + 时间 + 正文指纹」）。
4. **5 秒预算**：`replyBudgetMs` 默认 4400（硬限 5000 留 600ms 写响应）。预算内答完 → 被动回复 XML；超时 → **立刻回降级话术**，那一轮继续跑。
5. **交棒**：超时后那一轮跑完走**客服消息**（48 小时窗口内有效）。不放弃、不重试、不换模型。
6. **切条**：平台硬上限 800（手册 §9.11），切法只认 O-056 的 `chunk()`；第一段走被动回复，其余走客服消息。
7. **隔离**：凭据 `user/channels/wechat-official.json`（0600）、状态 `…wechat-official.state.json`（0600）、日志命名空间 `channel.wechat-official`、独立探针上报。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 端口监听、TLS、证书 | **宿主 `webServer`**（本插件只注册一条路由） |
| 公网可达、反代、域名备案 | 部署方（README 第五节给了填法） |
| 判「这条该不该回」 | `ondra-router`（O-055） |
| 分条算法 | `ondra-channel-kit`（O-056） |
| 人格、提示词、前缀冻结 | `ondra-persona-*` / `ondra-dialogue` |
| 记健康状态与「上次活到几时」 | `ondra-channel-health`（O-057） |
| 把「5 秒没答完」变成错误码抛给用户 | 本插件不抛：用户只该看到一句人话 |

## 三、服务键与方法

```
ondra-adapter-wechat-official      ← 连字符，不是 ondra:adapter-wechat-official
```

| 方法 | 作用 |
|---|---|
| `verify(query)` | GET 验证，返回 `{http, body, contentType, reason}` |
| `ingest(rawBody, query, at?)` | POST 处理，返回 `{http, body, contentType, disposition, reason, deferred}` |
| `reply(conversationId, text, at?)` | 主动发客服消息（窗口外直接拒，理由 `window-expired`） |
| `status()` | `registered` / `credential` / `allowlist` / `windowOpen` / `lastError` |
| `stats()` | `inbound` / `replied` / `deferred` / `pushed` / `worstLatencyMs` |
| `tick()` / `flush()` | 清过期记录 + 节流落盘 |
| `reload()` / `setPush()` | 换凭据 / 换推送实现（测试桩、企业网关） |

## 四、五秒这条线怎么守

```
t=0        收到 POST（微信开始计时）
t≈50ms     验签 + 解析 + 去重（纯计算，不碰网络）
t=50ms     开始问人格（timeoutMs = replyBudgetMs）
t=4400ms   预算到 → 写降级话术的 XML，HTTP 200 回给微信
t>4400ms   那一轮继续跑 → 跑完走客服消息（48h 窗口）
```

`stats().worstLatencyMs` 是这条线唯一可信的证据：它记的是「从收到到写响应」的真实耗时。
超过 5000 就说明预算配错了，而不是「大概没事」。

## 五、部署（公众号后台只能填 80 / 443）

1. 宿主 `webServer` 绑到 `443`（或前置反代到 443）——**端口归宿主，本插件不碰**。
2. 公众号后台 → 服务器配置 → URL 填 `https://<你的域名><routePath>`（默认 `/ondra/wechat-official`）。
3. Token 填一个随机串，**与凭据文件里的 `token` 逐字一致**（差一个字符就是 401）。
4. 凭据文件（0600）：

```json
{"appId": "<AppID>", "appSecret": "<AppSecret>", "token": "<服务器配置里的 Token>"}
```

5. 把公众号后台的**IP 白名单**加上服务器出口 IP，否则换 access_token 会被拒。

## 六、边界与隔离（master-plan §16.2 六条）

| 条 | 落实 |
|---|---|
| 目录隔离 | 独立包 `ondra-adapter-wechat-official/` |
| 配置隔离 | 自身 `Config`；凭据 `user/channels/wechat-official.json`(0600)，不共用 |
| 日志隔离 | 命名空间 `channel.wechat-official` |
| 状态隔离 | 窗口 + 去重只在本包 `.state.json`；通道消息**不进主会话** |
| 失败隔离 | 路由处理里的任何异常都兜在本插件内（回 500，不冒泡到宿主） |
| 风险隔离 | 本通道**不是**高危通道（合规接口），不与 NapCat / 个人微信混排 |

## 七、已知限制

1. **两个 HTTP 接口路径不在仓内证据里**。手册 §9.11 只写「真回复走客服消息 48h」，没给
   `/cgi-bin/token` 与 `/cgi-bin/message/custom/send`。这两个路径与字段（`touser` / `msgtype` / `text.content`）
   按公众号公开文档写，本仓无副本、本轮禁止实装运行。任何一处改名都会以 `errcode` 原样进日志，不会静默「以为发了」。
2. **只做明文模式**。公众号「安全模式」的报文是 AES 加密的（`msg_signature` + `encrypt_type`），
   需要 AES-256-CBC 解密与 PKCS#7 去填充；手册没给这套参数，本仓也没有可复用的实现（O-063 企业微信才有 WXBizMsgCrypt 的需求）。
   遇到加密报文会以 `bad-body` 静默应答 —— 表现为「她不回」，所以**部署时请把公众号设为明文模式**。
3. **只处理文本**。图片/语音/视频/位置一律 `unsupported`（静默 200）。没有 OCR、没有 ASR 接线。
4. **不处理「关注/取关」事件**。`MsgType=event` 一律 `unsupported`；欢迎语属于人设层的决定，不该由通道层偷偷写一句。
5. **验签拼法**按公众号服务器配置的通行做法（排序后拼接）。若上游改了拼法，只需改 `signatureOf()` 一个函数。
6. **`replyBudgetMs` 默认 4400ms 是自定值**：手册只给「5 秒硬限」，没给「留多少给写响应」。600ms 是本轮的估计。
7. **去重表不设 TTL 副作用**：只按窗口清（默认 30 分钟），重启后从状态文件恢复；状态文件损坏时按空处理并留日志。
8. **第一段超 800 字不会自动拆**：`callPersona` 已按 `maxChars=800` 切好；若上游返回的 `pieces` 长度异常，本插件仍然发第一段并把它余下的部分走客服消息。
9. 本包**未实装运行**（本轮只做插件 + 静态自检）。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 公众号回调与验签 | 手册 §9.11 的实测结论 | —（手册正文） | — | 「sha1 验签」「单条 800」「5 秒硬限 → 先回降级话术，真回复走客服消息 48h」 | 自写 `src/wire.ts`（纯函数）+ `src/window.ts`（预算/窗口） | 否 |
| 客服消息接口 | 微信公众号公开文档 | —（仓内无副本） | — | `access_token` 缓存与 `40001/42001` 刷新一次的口径 | 自写 `src/transport.ts`（全局 `fetch`，不引依赖） | 否 |
| 路由注册 | 宿主 `ondra-host-webserver` | `desktop/packages/host/webserver` | 宿主自身许可 | `register({kind, path, handler})` 的真实签名、`kind` 精确匹配、重复注册抛错 | 直接调用该扩展点（已读源码与文档核对） | 否 |
| 企业微信加解密（未采用） | 手册 §9.11 提到 wecom 自实现 WXBizMsgCrypt | — | — | 「同一类 AES-256-CBC 方案存在」这一事实 | **未采用**：公众号加密模式的参数手册未给，见「已知限制」第 2 条 | 否 |

**档位判定：〔复〕。** 手册 §1.8 把「微信通道」列入复用档。本插件没有一行加密算法、没有一行 HTTP 服务器：
服务器是宿主的，接口是平台的，自写部分只有验签拼串、XML 取值/回包、预算与窗口判定——都是「接线 + 护栏」。

## 九、多方案说明（§12）

本插件**不涉及 §14.3 的多方案能力**。唯一可替换的部件是**推送实现**（`WechatPush` 端口）：
默认 `HttpWechatPush` 直连公众号接口；需要走企业网关或测试桩时注入实现，本插件其余部分不改。
按 §14.2 落实：接口唯一、实现隔离（`src/transport.ts`）、默认最稳（直连官方域名）、独立降级（没 `fetch` 就 `no-fetch`）、
可观测（`status().credential` + `stats()`）。

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有公众号这一路。其他通道与整条对话链照跑。
2. **我的状态存在哪？** `user/channels/wechat-official.state.json`（0600，原子写）；凭据在 `…/wechat-official.json`（0600）。access_token 只在内存里，**不落盘**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `channel.wechat-official` + 探针 `error` 事件 + `status().lastError`；路由挂不上时 `status().registered=false`。
4. **我依赖谁？缺席时我怎么降级？** `webServer`（缺 → 收不到消息，明确报错）、`router`（缺 → 直接回）、`channel-kit`（缺 → 只回降级话术）、`channel-health`（缺 → 静默）、`path-layout`（缺 → 凭据路径算不出来）、`config-schema`（缺 → 本地校验）。**全部软依赖，`inject` 不声明。**
5. **我和同域的谁共享了可变状态？** 没有。窗口表、去重表、token 缓存、定时器全部本包私有。
