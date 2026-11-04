# ondra-adapter-wechat-personal

> O-062 · L5 通道 · 档位〔复〕· **高危** · 服务键 `ondra-adapter-wechat-personal` · 通道 id `wechat-personal`

微信个人号通道。**本插件不操作微信。** 真正登录微信、点开发送框的是用户自备的
wxauto 桥接端（Windows 客户端 UI 自动化）；本插件只负责「桥接端 ↔ 她」之间的接线、
双闸门、白名单与语义。

---

## ⚠ 一、风险提示（独立区块，不与其他通道混排 · master-plan §16.2-6）

1. **违反平台用户协议**：微信个人号自动化属于客户端操作，不是官方接口。账号被限制或封禁是**现实后果**，不是理论风险。
2. **新号尤其危险**：手册 §6.2 原话「刚注册的小号基本秒风控，**只能用养过一段时间的号**」。
3. **本插件不降低以上风险**。它做的只是「别让它在你不清楚的情况下开起来」。
4. **不要用主号**。这条通道的价值是「她能在微信里跟你说话」，不是「替你跟客户谈事」。
5. **会话内容会经过一个你自备的本地进程**（wxauto）。它的安全边界由那个进程决定，不由本插件决定。

## 二、双闸门（缺一不可）

```
enable === true          ← 配置开关（字面量 true，字符串 "true" 不算）
confirmed === true       ← 配置里的确认位（同上）
user/channels/wechat-personal.confirm.json 里 confirmed === true
                         且 note ≥ 4 个字、带确认时间
```

**三道都过，才会回话。** 少一道就会在响应体里拿到具体原因（`disabled` / `not-confirmed` / `no-confirm-record`），
而不是「她不理我」。

为什么不是一个布尔：布尔回答不了「什么时候确认的、确认了什么」。出事时要能翻到一条
「2026-11-02 18:40，写了『知道会封号，用小号』」的记录。

- 确认入口只有一个：服务上的 `confirm(note)`。
- 撤销是**写**不是删：`revoke(note)` 把档案改成 `confirmed:false` 并留下撤销时刻，
  这样「确认过又撤回」与「从没确认过」在档案上留下区别。

## 三、职责

1. **接桥接端**：`ctx.webServer.register({kind:'exact', path})`，POST JSON 进来，GET 探活。
2. **仅回环**：handler 第一行判 `req.socket.remoteAddress`，非 `127.0.0.1 / 127/8 / ::1 / ::ffff:127.x` 一律 403。
   **这一条不可配置**——理由是宿主的 listen 地址由宿主配置决定，端口是不是只在本机不由本插件保证。
3. **过闸**：资格三条（开关 / 确认位 / 确认档案）→ 礼貌四条（群 / 拉黑 / 白名单 / 冷却）。
4. **回答**：经 O-055 `admit` → O-056 `callPersona` → 切条（1000）→ 两条出口之一。
5. **两条出口**：`reply-mode: sync`（写进 HTTP 响应，零配置）或 `webhook`（先 ack，再 POST 到 `outbound-webhook`）。
   同步等待超过 `reply-budget-ms` 时自动交棒给 webhook——那一轮**不取消**，只是不再等它。
6. **隔离**：确认档案 `user/channels/wechat-personal.confirm.json`（0600）、冷却表 `…wechat-personal.state.json`（0600）、
   日志命名空间 `channel.wechat-personal`、独立探针上报。

## 四、明确不负责

| 不做 | 归谁 |
|---|---|
| 登录微信、点按钮、读聊天窗 | **用户的 wxauto 桥接端**（Windows） |
| 判「这条该不该回」 | `ondra-router`（O-055） |
| 分条算法 | `ondra-channel-kit`（O-056） |
| 人格、提示词 | `ondra-persona-*` / `ondra-dialogue` |
| 端口、TLS、公网可达 | 宿主 `webServer`（本插件只注册一条路由） |
| 去重 | **不做**（手册 §9.11 写的就是「无去重」），见已知限制第 3 条 |
| 防封 | 不做限流式防封：真正的风险是封号，而那不是限流能解决的 |

## 五、桥接端契约（本插件定义的形状，写桥接脚本时照这个来）

```http
POST /ondra/wechat-personal
Content-Type: application/json

{"contact": "张三", "text": "在吗", "messageId": "可选", "at": 1730000000000, "group": false, "self": false}
```

响应：

```json
{"ok": true,  "reason": "ok",       "reply": "在的呀", "pieces": 1}
{"ok": true,  "reason": "deferred"}                                  // 202，回复稍后推到 webhook
{"ok": false, "reason": "not-confirmed"}                             // 200，别重试：本通道无去重
{"ok": false, "reason": "loopback-only"}                             // 403
```

- `self: true` 的消息会被忽略（wxauto 会把「自己发出的」也当新消息推上来）。
- 未知字段一律忽略；`contact` 与 `text` 缺失即 `bad-body`。
- **拒绝也回 200**：4xx 会让桥接端重试，而重试的代价是同一句话被答两遍。

出站（`reply-mode=webhook` 或超预算时）：

```http
POST <outbound-webhook>
{"contact": "张三", "text": "在的呀", "messageId": "可选"}
```

**只有 2xx 才算发出去**。3xx 不算（重定向到登录页也意味着没到人手里）。

## 六、配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enable` | `false` | 第一道闸 |
| `confirmed` | `false` | 第二道闸（只认字面量 `true`） |
| `route-path` | `/ondra/wechat-personal` | 入站路径（无尾斜杠） |
| `chunk-max` | `1000` | 手册 §9.11 实测值 |
| `cooldown-ms` | `1200` | 同会话最小间隔。**推断值**（手册未给个人号频控数字） |
| `reply-budget-ms` | `4000` | 同步等待预算，超了交棒 |
| `max-concurrent` | `2` | 同时跑几个回合 |
| `allow-contacts` | `[]` | **空 = 全拒**（手册 §6.2：白名单外不发信息） |
| `block-contacts` | `[]` | 优先于白名单 |
| `allow-groups` | `false` | 群消息默认不回 |
| `reply-mode` | `sync` | `sync` / `webhook` |
| `outbound-webhook` | `''` | 出站地址，只接受 http/https |
| `confirm-file` / `state-file` | `''` | 留空则由 `path-layout` 推出 |

## 七、边界与隔离（master-plan §16.2 六条）

| 条 | 落实 |
|---|---|
| 目录隔离 | 独立包 `ondra-adapter-wechat-personal/` |
| 配置隔离 | 自身 `Config`；确认档案与状态文件都在 `user/channels/`，不与其他通道共用 |
| 日志隔离 | 命名空间 `channel.wechat-personal` |
| 状态隔离 | 冷却表只在本包 `.state.json`；通道消息**不进主会话** |
| 失败隔离 | 请求处理里的任何异常兜在包内（回 500，不冒泡）；出站失败只记日志 |
| **风险隔离** | **单独风险区块**（本文第一节）+ 双闸门 + 独立确认档案，不与合规通道混在一张开关列表里 |

## 八、已知限制

1. **本插件不能在 macOS 上跑通整条链路**。wxauto 是 Windows 客户端自动化，仓内没有任何一行实现；
   本插件只做到「接线 + 双闸门 + 语义」。这不是缺功能，是边界：`desktop/` 与外部进程都不由本插件托管。
2. **入站端口归宿主**。手册 §9.11 记的是 3457，但宿主的 `webServer` 自己配置监听地址与端口；
   本插件只注册一条**路径**，并在日志里把这个区别讲清。
3. **不做去重**（手册 §9.11 明写「无去重」）。桥接端若重试，同一句话会被答两遍。
   这是照规范执行的结果，不是遗漏；要改需要先改手册并过评估集。
4. **`cooldown-ms` 默认 1200 是推断值**。手册只给了 QQ 的六道闸数值，个人号没有。
5. **群聊只做「不回」**，不做「@ 才回」。后者需要解析平台的 @ 语义，而 wxauto 侧的 @ 文本形态未验证。
6. **只处理文本**。图片/表情/语音的空正文一律 `unsupported`，没有 OCR / ASR 接线。
7. **白名单按微信显示名匹配**，不是按 wxid。改名即失效——这是 wxauto 侧只给显示名的代价。
8. **确认档案的 4 字下限是防「手滑」，不是防「恶意」**。能改文件的人就能改配置；
   双闸门的价值在于「不知情地开起来」这件事变得不可能，而不是防住本机管理员。
9. 本包**未实装运行**（本轮只做插件 + 静态自检）。

## 九、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| wxauto 个人号自动化 | 手册 §1.7 / §6.2 的结论 | —（手册正文，未给仓库） | — | 「有成熟实现但风险更高」「只能用养过一段时间的号」「白名单外不发信息」「最后必须点重启微信并应用」 | **不引入**：插件只做接线与闸门，操作微信由用户自备进程完成 | 否 |
| 入站/出站形态 | 手册 §9.11 的实测结论 | — | — | 「入站 3457 + 出站用户 webhook」「仅回环」「confirmed===true 硬闸门」「1000」「无去重」 | 自写 `src/adapter.ts` + `src/gate.ts` | 否 |
| 双闸门与确认档案 | 本仓 O-059（NapCat）的已 done 口径 | 同仓 `cordis/ondra-adapter-qq-napcat` | AGPL-3.0 | 「独立确认档案 + 说明 ≥4 字 + 唯一写入口」这一机制 | **按口径重写**（不 import 对方源码，§15.5）：`src/confirm.ts` | 否 |
| 路由注册与 host 语义 | 宿主 `ondra-host-webserver` 文档 | `desktop/docs/subsystems/web-server.zh.md` | 宿主自身许可 | `register({kind,path,handler})` 的真实签名；`host` 只能是具体地址、未指定地址会被拒绝 → 「仅回环」必须在请求层判 | 直接调用该扩展点 + `req.socket.remoteAddress` 判定 | 否 |
| 通道受理 / 切条 / 探针 | 本仓 O-055 / O-056 / O-057 的已 done 契约 | 同仓 | AGPL-3.0 | 只按契约调用（`admit` / `release` / `chunk` / `callPersona` / `report`） | 结构对位声明在 `src/types.ts`，不 import 对方源码 | 否 |

**档位判定：〔复〕。** 手册 §1.7 明确「wxauto 有成熟实现」，所以本插件不重写任何自动化机制；
自写部分只有「双闸门 + 白名单 + 冷却 + 两条出口」。**能复用却自研 = 违规**，这里没有越线。

## 十、多方案说明（§12）

按 §14.1「能融就融」处理**回复出口**：一个实现、两个参数化分支。

| 出口 | 何时用 | 代价 |
|---|---|---|
| `sync`（默认） | 桥接端愿意等一会儿，读响应最省事 | 需要桥接端容忍 4 秒的等待 |
| `webhook` | 桥接端只想 fire-and-forget，或者回复常常很慢 | 需要再配一个地址；配错就静默丢消息（会打 warn） |

超预算时自动从 `sync` 交棒到 `webhook`（两个分支都可用时）。
按 §14.2 落实：接口唯一（`PersonalPush`）、实现隔离（`src/transport.ts`）、
默认最稳（`sync` 零配置）、独立降级（没 webhook → `no-webhook`，不假装发了）、可观测（`status()` + `stats()`）。

## 十一、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有个人号这一路。公众号、客服、QQ 与整条对话链照跑。
2. **我的状态存在哪？** 确认档案 `user/channels/wechat-personal.confirm.json`（0600）、
   冷却表 `…wechat-personal.state.json`（0600，临时文件 + rename 原子写）。桥接端凭据**不由本插件持有**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `channel.wechat-personal` + 探针 `error` 事件 +
   `status().lastError`（没资格时这里直接写「缺哪一道闸」）；路由挂不上时 `status().mounted=false`。
4. **我依赖谁？缺席时我怎么降级？** `webServer`（缺 → 收不到，明确报错）、`router`（缺 → 跳过受理直接回）、
   `channel-kit`（缺 → 不答，记 `no-kit`）、`channel-health`（缺 → 静默）、`path-layout`（缺 → 档案路径算不出来）、
   `config-schema`（缺 → 本地校验）。**全部软依赖，`inject` 不声明。**
5. **我和同域的谁共享了可变状态？** 没有。确认档案、冷却表、并发位、定时器全部本包私有；
   与 O-059（NapCat）只是共享同一套**口径**（双闸门机制），没有共享任何运行期对象。

## 十二、契约冲突

本轮**无新增**。确认档案机制按 O-059 的已 done 口径**重写**而非引用（§15.5 禁止同轮互相 import），
字段（`confirmed` / `at` / `note`）与语义（唯一写入口、≥4 字、撤销留痕）一致；
消费 O-055 / O-056 / O-057 的契约字段逐条核对，无缺失。
