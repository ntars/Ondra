# ondra-adapter-wechat-kf

> O-061 · L5 通道 · 档位〔复〕 · 服务键 `ondra-adapter-wechat-kf` · 通道 id `wechat-kf`

微信客服通道。**拉取式**：每 5 秒自己 `sync_msg` 一次，靠 `next_cursor` 往前推。
不挂公网回调、不 listen 端口、不需要域名——这是它与公众号那一路（O-060）最大的区别。

---

## 一、职责

1. **拉取**：`pollMs` 默认 5000（手册 §9.11）。平台说 `has_more` 就继续拉，但一轮最多 `maxRounds` 批。
2. **游标去重**：`next_cursor` 是唯一主去重；另外存一张 `seen` 表（`msgid`）兜底重放，容量 500、时限 7 天。
3. **过闸**：来源码（默认只回 3 = 微信客户）→ 客服号白名单 → 人名单（拉黑优先）→ 只认文本 → 去重。
4. **回答**：经 O-055 `admit` → O-056 `callPersona` → 切条（800）→ `send_msg` 逐段发。
5. **串行**：同一个人连发三条按序回答；不同的人受 `maxConcurrent` 限制。两段并发会让用户看到「她同时在说两件不相干的事」。
6. **窗口**：`reply()` 主动发消息前先判 48 小时会话窗口，窗口外直接拒（`window-expired`），不等平台打脸。
7. **隔离**：凭据 `user/channels/wechat-kf.json`（0600）、状态 `…wechat-kf.state.json`（0600）、日志命名空间 `channel.wechat-kf`、独立探针上报。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 判「这条该不该回」 | `ondra-router`（O-055） |
| 分条算法 | `ondra-channel-kit`（O-056） |
| 人格、提示词、前缀冻结 | `ondra-persona-*` / `ondra-dialogue` |
| 记健康状态与「上次活到几时」 | `ondra-channel-health`（O-057） |
| 端口监听、TLS、域名 | 宿主的 `webServer`（本插件默认**根本不挂**路由） |
| 事件解析（`enter_session` 等） | 本版不处理，见「已知限制」第 4 条 |
| 把失败变成弹窗 | 本插件只写日志与 `status().lastError`，不打断对话 |

## 三、服务键与方法

```
ondra-adapter-wechat-kf      ← 连字符，不是 ondra:adapter-wechat-kf
```

| 方法 | 作用 |
|---|---|
| `pollOnce(at?)` | 立刻拉一轮，返回 `{ok, reason, rounds, fetched, answered, cursor}` |
| `start()` / `stop()` | 起停周期拉取（`stop()` 会先 flush） |
| `reply(conversationId, text, at?)` | 主动发一条（窗口外拒，理由 `window-expired`） |
| `verify(query)` | 回调验签（只有挂了回调才会被调用；未挂时回 `callback-off`） |
| `status()` | `polling` / `credential` / `cursor` / `windowEntries` / `allowlist` / `callbackMounted` / `lastError` |
| `stats()` | `polls` / `fetched` / `answered` / `sent` / `skipped`（按原因分桶） |
| `tick()` / `flush()` | 清过期记录 + 节流落盘 |
| `markCallbackMounted(bool)` | 路由挂上/撤掉时由 `index.ts` 调用，只为面板能说清现状 |

## 四、一轮拉取长什么样

```
t=0s    sync_msg(cursor)  → 一批消息 + next_cursor + has_more
        ├─ 逐条过闸（来源 / 白名单 / 只认文本 / 去重）
        ├─ admit → callPersona（预算 30s）→ 切条 800 → send_msg
        └─ release（把排队的那几条也答掉，最多 8 条）
t=?     整批处理完 → 推进游标 → persist
t=5s    下一轮
```

两条硬规矩：

1. **整批处理完才推进游标**。先推进再处理，崩一次就永远丢那几条，而且无声无息。
2. **平台给空游标就不推进**。空串不是「到头了」，把它写进状态等于把游标清空，下次从最早重拉。

## 五、配置（全部有默认值）

| 键 | 默认 | 说明 |
|---|---|---|
| `enable` | `false` | 总开关。装上去就自动回外部联系人，那是事故不是功能 |
| `poll-ms` | `5000` | 手册实测值；下界 1000（再快是刷接口），上界 60000 |
| `chunk-max` | `800` | 平台硬上限，只能往下调 |
| `window-hours` | `48` | 会话窗口 |
| `allow-external-user-ids` | `[]` | 空 = 不限。客服号是对外入口，留空请确认 |
| `block-external-user-ids` | `[]` | 优先于白名单 |
| `allow-open-kf-ids` | `[]` | 一个企业多个客服号时限定接哪一个 |
| `respond-origins` | `[3]` | 只回微信客户；不过滤就会回答接待人员自己的回复 |
| `persona-timeout-ms` | `30000` | 人格调用预算（**本项目判断值**，手册未给） |
| `max-concurrent` | `3` | 同一批里同时跑几个回合（同一会话永远串行） |
| `page-limit` | `100` | 单批条数（平台上限 1000） |
| `max-rounds` | `5` | 一轮最多连拉几批 |
| `callback-path` | `''` | **空 = 不挂回调**，这是拉取式的正常状态 |
| `persist` / `persist-ms` | `true` / `5000` | 游标与窗口状态落盘 |

凭据（0600，`user/channels/wechat-kf.json`）：

```json
{"corpId": "<ww...>", "secret": "<应用 Secret>", "openKfId": "<wk...>",
 "token": "<仅挂回调时填>", "encodingAesKey": "<仅挂回调时填>"}
```

前三样是拉取与发送的必需项；后两样只在挂回调时用，缺失**不算**凭据不全。

## 六、边界与隔离（master-plan §16.2 六条）

| 条 | 落实 |
|---|---|
| 目录隔离 | 独立包 `ondra-adapter-wechat-kf/` |
| 配置隔离 | 自身 `Config`；凭据 `user/channels/wechat-kf.json`(0600)，不与公众号共用 |
| 日志隔离 | 命名空间 `channel.wechat-kf` |
| 状态隔离 | 游标 + seen + 窗口只在本包 `.state.json`；通道消息**不进主会话** |
| 失败隔离 | 拉取/发送/落盘的异常全部兜在包内；`pollOnce` 永不抛 |
| 风险隔离 | 合规通道（企业接口），不与 NapCat / 个人微信混排 |

三个定时器（拉取、心跳、落盘）全部在 `ctx.effect()` 里注册，卸载即停——
漏一个的后果不是「多跑一会儿」，是「卸载后她还在拉消息、还在回人」。

## 七、已知限制

1. **手册没有微信客服专章**。`Ondra-dev-handbook.md` 里 `客服` 零命中；唯一依据是
   master-plan §9.11 的一行实测：`wechat-kf | 拉取式 sync_msg 每 5s + cursor | sha1 验签 | 800 | 游标去重`。
   所以本插件**只承诺这一行的四件事**，其余全部按公开文档写并逐条登记在下面。
2. **三个接口路径不在仓内证据里**（`/cgi-bin/gettoken`、`/cgi-bin/kf/sync_msg`、`/cgi-bin/kf/send_msg`）。
   按企业微信 / 微信客服公开文档写，本仓无副本、本轮禁止实装运行。任何一处改名都会以 `errcode`
   原样进日志，不会静默产出「以为发了」。
3. **`origin` 的来源码表来自公开文档**（3 客户 / 4 系统 / 5 接待人员）。平台若新增来源码，
   改配置 `respond-origins` 即可，不用等发版。
4. **不解析事件正文**。挂了回调也只验签、回 200，`enter_session` 之类不做处理——
   事件不是「能回话」的前提，而伪造一个「已处理」比不处理更坏。
5. **只做明文回调（且默认不挂）**。`encodingAesKey` 本版不解密；挂回调若必须加密模式，请把
   `callback-path` 留空，只用拉取。
6. **`sync_msg` 只发三个字段**（`cursor` / `open_kfid` / `limit`）。公开文档里还有 `token`
   （按回调过滤）与 `voice_format`，本版刻意不传：传错一个语义不明的字段，症状是「拉了但永远是空的」。
7. **`persona-timeout-ms` 默认 30s 是本项目判断值**。手册与本仓都没有这个数。
8. **排队不等于丢弃，但只兜 8 条**（`MAX_DRAIN`）。一次积压超过 8 条时，剩下的会被丢弃并打 warn——
   拉取式没有第二次机会，这一点无法靠代码弥补，只能靠 `max-concurrent` 与 `persona-timeout-ms` 调优。
9. **状态文件损坏会从空游标重拉**（打 warn）。重放会答一段历史——`seen` 表能挡一部分，但表有容量上限。
10. **只处理文本**。图/语音/文件一律按 `type.<msgtype>` 跳过并计数，没有 OCR / ASR 接线。
11. 本包**未实装运行**（本轮只做插件 + 静态自检）。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 拉取式通道 + 游标去重 | 手册 §9.11 的实测结论 | —（手册正文） | — | 「每 5s 拉一次」「游标去重」「单条 800」 | 自写 `src/adapter.ts` + `src/cursor.ts`（纯函数状态机） | 否 |
| 客服消息接口 | 企业微信 / 微信客服公开文档 | —（仓内无副本） | — | `access_token` 缓存 + `40001/40014/42001` 刷新一次的口径 | 自写 `src/transport.ts`（全局 `fetch`，不引依赖） | 否 |
| 回调验签 | 同一平台的公开文档 + O-060 已验证的拼法 | — | — | `sha1(sort([token,timestamp,nonce]))`，定长比较 | 自写 `src/wire.ts`（纯函数） | 否 |
| 通道受理 / 切条 / 探针 | 本仓 O-055 / O-056 / O-057 的已 done 契约 | 同仓 `cordis/ondra-router` 等 | AGPL-3.0 | 只按契约调用（`admit` / `release` / `chunk` / `callPersona` / `report`），字段逐条核对 | 结构对位声明在 `src/types.ts`，**不 import 对方源码**（§15.5） | 否 |
| 路由注册 | 宿主 `ondra-host-webserver` | `desktop/packages/host/webserver` | 宿主自身许可 | `register({kind, path, handler})` 的真实签名 | 只在 `callback-path` 非空时调用；拉取式不需要它 | 否 |

**档位判定：〔复〕。** 手册 §1.8 把「微信/飞书等通道」列入复用档。本插件没有一行协议编解码、
没有一行 HTTP 服务器：接口是平台的、切条是 O-056 的、受理是 O-055 的，
自写部分只有「游标推进 + 四种闸 + 串行链」——都是接线与护栏。

## 九、多方案说明（§12）

本插件**不涉及 §14.3 的多方案能力**。唯一可替换的部件是**传输实现**（`KfTransport` 端口）：

- 默认 `HttpKfTransport` 直连官方域名；
- 需要走企业网关、代理或测试桩时注入实现，适配器一行不改。

按 §14.2 落实：接口唯一（`KfTransport`）、实现隔离（`src/transport.ts`）、默认最稳（直连官方域名）、
独立降级（没 `fetch` → `no-fetch`）、可观测（`status().credential` + `stats()`）。

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有客服这一路。公众号、QQ、其他适配器与整条对话链照跑。
2. **我的状态存在哪？** 游标 + seen + 窗口在 `user/channels/wechat-kf.state.json`（0600，临时文件 + rename 原子写）；
   凭据在 `…/wechat-kf.json`（0600）。`access_token` **只在内存里，不落盘**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `channel.wechat-kf` + 探针 `error` 事件 +
   `status().lastError`；拉取停止时 `status().polling=false`；凭据缺失时 `status().credential.missing` 指名道姓。
4. **我依赖谁？缺席时我怎么降级？** `router`（缺 → 跳过受理直接回）、`channel-kit`（缺 → 不答，记 `no-kit`）、
   `channel-health`（缺 → 静默）、`path-layout`（缺 → 凭据路径算不出来）、`config-schema`（缺 → 本地校验）、
   `webServer`（缺 → 只在挂了回调时才是问题，拉取照跑）。**全部软依赖，`inject` 不声明。**
5. **我和同域的谁共享了可变状态？** 没有。游标、seen、窗口、串行链、token 缓存、定时器全部本包私有。

## 十一、契约冲突

**本轮无新增。** 与 O-060（公众号）是同一平台的两条接入方式：阈值同源手册（800 / 48h），
状态各自私有，未改 O-060 一个字段；消费 O-055 / O-056 / O-057 的已 done 契约
（`admit` / `release` / `chunk` / `callPersona` / `report`），字段无缺。
