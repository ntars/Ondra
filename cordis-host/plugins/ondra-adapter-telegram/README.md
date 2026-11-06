# ondra-adapter-telegram

> O-066 · L5 通道 · 档位〔复〕 · 服务键 `ondra-adapter-telegram`

Telegram 长轮询通道。**拉取式**：不注册路由、不占端口，循环挂在 `ctx.effect` 的 disposer 上，卸载即停。
两个最容易踩空的地方：**token 只能放在 URL 里**（所以日志里出现 URL 就等于泄漏凭据），
以及 **HTTP 超时必须大于长轮询超时**（否则每一轮都被自己掐断）。

---

## 一、职责

1. **长轮询**：`getUpdates?offset=…&timeout=50&limit=100`，§9.11 原话 `timeout 50`。
2. **结构性去重**：`offset = 该批最大 update_id + 1`，**只增不减**；`seen` 表只做兜底。
3. **失败退避**：固定 3 秒（§9.11 原话），不做指数——指数会让一次抖动变成几分钟的沉默。
4. **切条**：平台实测上限 4000（§9.11），切法只认 O-056 的 `chunk()`。
5. **脱敏**：凡带 URL 的字符串（平台 `description`、`fetch` 抛的错、自拼诊断串）**一律先过 `redactToken()`** 再进日志。
6. **隔离**：凭据 `user/channels/telegram.json`（0600，读到即收紧）、状态 `…telegram.state.json`（0600）、日志命名空间 `channel.telegram`、独立探针、独立开关。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 入站端口、Webhook、TLS | 刻意不做：拉取式不需要，本插件一个端口都不开 |
| 判「这条该不该回」 | `ondra-router`（O-055） |
| 分条算法 | `ondra-channel-kit`（O-056） |
| 人格、提示词、前缀冻结 | `ondra-persona-*` / `ondra-dialogue` |
| 记健康状态 | `ondra-channel-health`（O-057） |
| 图片/语音/文件消息 | 刻意不做：一律丢弃（不回「我看不懂」） |
| 群隐私模式（privacy mode） | 平台侧 BotFather 开关，本插件不假装能控制 |

## 三、服务键与方法

```
ondra-adapter-telegram      ← 连字符，不是 ondra:adapter-telegram
```

| 方法 | 作用 |
|---|---|
| `start()` / `stop()` | 起停长轮询；`stop()` 会**中止在飞的那一轮**，不留定时器 |
| `pollOnce(at?)` | 手动拉一轮（与循环共用同一把「正在拉」的锁） |
| `reply(conversationId, text)` | 主动发一条（无窗口限制） |
| `probe()` | 调 `getMe` 确认 token（**显式**的只读动作，装载期不调） |
| `status()` | `running` / `credential` / `botUsername` / `offset` / `allowlist` / `inflight` / `queued` / `lastPollAt` / `lastError` |
| `stats()` | `polls` / `updates` / `answered` / `sent` / `rejected` / `worstAnswerMs` |
| `tick()` / `flush()` | 清过期兜底记录 + 节流落盘 + 探针心跳 |
| `reload()` / `setPush()` | 换凭据后重读（会先停一次循环）/ 换网络实现 |

## 四、五个必须说清楚的判断

### 1. `token 在 URL` → 脱敏是一等公民

鉴权方式是把 token 拼进路径：`/bot<token>/getUpdates`。泄漏路径有三条，都不是「手滑打日志」：

1. `fetch` 在 URL 非法时抛的错**会带整条 URL**（`Failed to parse URL from https://api.telegram.org/bot123:AA…/getUpdates`）；
2. 平台的 `description` 被原样拼进自己的错误串；
3. 面板上打印「正在请求 <url>」。

所以全包只有**一处**把异常折成字符串（`adapter.ts` 的 `errorOf()`），且它必须先过 `redactToken()`。两个地方各写一份「取错误消息」，迟早有一处忘了脱敏。

### 2. `offset` 是结构性去重，`seen` 表只是兜底

`offset` 的语义就是「`update_id` 小于它的我都收过了」。只要它推进正确，同一条更新不会第二次出现——**重启也不丢**。

`seen` 表只对付三件事：状态文件被删/坏了从头拉、崩在「处理完但没推进」之间、平台真的重投了同一 `update_id`。所以它有容量上限（500）与时间上限（24 小时），**不是账本**。

推进规则两条：

- **整批分派完才推进**（这里「接住 ≠ 答完」，见下一条）；
- **只增不减**：平台返回更小的值（重放旧批）一律忽略，写回去等于把自己送回过去。

### 3. 推进 `offset` = 「这批已经接住了」，不是「这批已经答完了」

回答是异步的（问人格要几秒）。等答完再推进，意味着一个卡住的模型调用会让整个通道停在那儿。

代价是「接住之后崩了」会漏答那几条。与「答两遍」相比：漏答是**可见的**（用户发现她没回，会再问一次），重复回答是人格层面的破坏。这个不对称在 O-061 里也用过，两处口径一致。

### 4. HTTP 超时 = 轮询超时 + 余量，**一处算出**

长轮询的请求会故意挂 50 秒。若 HTTP 超时写成独立的 8000（跟别的通道一样），每一轮都会在第 8 秒被自己掐断——面板上全是 `timeout`，看起来像「Telegram 挂了」。

所以配置里**没有** `requestTimeoutMs`，只有 `requestPaddingMs`：实际超时 = `pollTimeoutSec × 1000 + requestPaddingMs`，由 `requestTimeoutOf()` 唯一一处算出。两个数之间的关系写进类型，而不是写进文档。

### 5. 循环是 `setTimeout` 链，且 `stop()` 先立旗再中止

用 `setInterval` 的话，定时器到点就再发一次请求，而上一轮还挂着——**两轮同时推进同一个 offset，必然丢消息**。`setTimeout` 链保证「上一轮回来了才开始算下一轮」。

`stop()` 的顺序是 **立旗 → 代际 +1 → `AbortController.abort()` → 清定时器**。先清定时器再立旗，在飞的那一轮会在卸载之后再发几条消息出去——这是最难解释的一类 bug。

## 五、部署

1. 找 `@BotFather` 建 bot，拿到 token（形如 `123456789:AA…`）。
2. **群聊要决定隐私模式**：`/setprivacy` 关掉 → 群里能收到全部消息；开着 → 只有 `@bot` 与 `/命令` 能收到。**本插件如实登记 `mentionRequired: false`，不假装能控制它**（这一点与回调式通道不同：那边「必须 @」是平台投递规则）。
3. 凭据写进 `user/channels/telegram.json`（0600）：

```json
{
  "token": "123456789:AA…（BotFather 给的那串）",
  "username": "bot 用户名（可空，只用于日志）"
}
```

4. `enable: true`。**同一个 token 只能有一个消费者**：如果这个 bot 还挂着 Webhook，`getUpdates` 会一直回 `409 conflict`（本插件会把它单独报成 `conflict`，而不是笼统的 `http`）。

## 六、边界与隔离（master-plan §16.2 六条）

| 条 | 本插件的落点 |
|---|---|
| 1 目录隔离 | 独立包 `ondra-adapter-telegram/` |
| 2 配置隔离 | 自身 `Config` 14 个字段；凭据落 `user/channels/telegram.json`（0600，读到即收紧） |
| 3 日志隔离 | 命名空间 `channel.telegram`（经 `ondra-identity` 取前缀，默认全名 `ondra.channel.telegram`） |
| 4 状态隔离 | `offset` 与兜底去重表本通道独有；通道消息不进主会话 |
| 5 失败隔离 | 单条失败只影响自身；`ctx.effect` 的 disposer 会 `stop()` 循环并清两个定时器 |
| 6 风险隔离 | 合规通道，与 NapCat / 个人微信分属不同包；无二次确认（不需要） |

## 七、已知限制

1. **手册没有 Telegram 专章**：`Ondra-dev-handbook.md` 检索「telegram」零命中。唯一可核对的参数依据是 master-plan §9.11 的一行（长轮询 / timeout 50 / token 在 URL / 4000 / offset 去重 + 3s 退避）。
2. **`Update` / `sendMessage` / `getMe` 的形状**按 Bot API 公开文档写、**仓内无副本、未实跑**。改名会以 `error_code` + `description` 原样带回日志（已脱敏）。
3. **不处理 `edited_message`**：只认 `message`。编辑一条已答过的消息不该触发第二次回答。
4. **频道（`channel`）消息直接丢弃**：频道里「回一句」这件事不成立，把它当群会让一个只读频道突然开口。
5. **`409 conflict` 单独成码**：同 token 上还有 webhook 或另一个轮询时会一直撞它。不区分就得靠「一直失败」去猜。
6. **`seen` 表 500 条 / 24 小时**是兜底容量，不是账本；主去重永远是 `offset`。
7. **`probe()` 会写 `botUsername`**：这是它能给面板带来的唯一附加信息，其余状态一个都不动。
8. **路由归还的积压正文不复读**：`router.release()` 交出的是**用户说的话**，本包只当「占位已归还」的信号，真正回答走本地队列。已 done 的 O-060 / O-063 / O-064 把 `item.text` 直接发了出去，见台账「契约冲突」登记——本轮不改别人的包。
9. **本包未实装运行**：全部结论来自静态检查与纯逻辑复刻（见第八、九节）。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| Telegram 长轮询与发送 | Telegram Bot API 公开文档（协议本身） | 公开文档，非仓库 | 不适用（协议编解码） | `getUpdates` 的 `offset`/`timeout` 语义、`sendMessage` 请求体、`entities` 的 `mention`/`bot_command` | 自研 `src/transport.ts` + `src/wire.ts` | 否 |
| 游标去重 | `ondra-adapter-wechat-kf`（O-061）的游标纪律 | 本仓 `cordis/ondra-adapter-wechat-kf` | 自有 | 「整批处理完才推进」「空游标不推进」「seen 只兜底」 | 自研 `src/cursor.ts`（按 Telegram 语义重写，不 import） | 是（自有资产，重写） |
| 通道适配器形状 | 旧项目九通道实测口径（master-plan §9.11） | 本仓 `cordis/ondra-master-plan.md` | 自有 | 「单条上限 + 失败退避」两条硬约束 | 自研 `src/adapter.ts` | 是（自有资产，重写） |
| 分条 | `ondra-channel-kit`（O-056） | 本仓 | 自有 | `chunkText` 的切法 | 经服务键调用，不复制 | 否 |

**档位判定依据**：手册 §1.8 把「QQ/微信/飞书/Telegram 通道」列**复用档**。本仓禁装依赖（§16.3），`grammY` / `node-telegram-bot-api` 都无法引入，故落到**只做接线、配置与降级**：HTTP 用全局 `fetch`，没有一行第三方代码。

## 九、多方案说明（master-plan §12）

| 决策点 | 方案 | 取舍 |
|---|---|---|
| 收信方式 | Webhook（要公网 + 证书）／`getUpdates` 长轮询 | **长轮询**：§9.11 口径，且它不需要公网——这是本通道相对回调式的最大优势 |
| 超时表达 | 独立 `requestTimeoutMs`／`轮询超时 + 余量` | **后者**：独立值必然会被填得比轮询超时小，症状是「每轮都超时」 |
| 退避 | 指数退避／固定 3 秒 | **固定 3 秒**：§9.11 原话；指数会让一次抖动变成几分钟沉默 |
| 去重 | `seen` 表／`offset` | **`offset` 为主 + `seen` 兜底**：前者重启不丢，后者只补异常 |
| 群消息 | 一律 `mention` 触发／按 `entities` 判 | **按 `entities` 判**：`mention` 与 `bot_command` 都算，同时 `mentionRequired:false`（privacy mode 不归我们） |

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。循环停、服务键消失；其他通道与 L0–L4 全部照常。
2. **我的状态存在哪？** `offset` 与兜底去重表：内存 + `user/channels/telegram.state.json`（0600，原子写）；其余全是内存计数。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.channel.telegram`；探针按 `channelId='telegram'` 上报 `heartbeat` / `error`，错误带原因码（`unauthorized` / `conflict` / …）。
4. **我依赖谁？缺席时我怎么降级？** `router`（缺席 → 照答）、`channel-kit`（缺席 → 这条不回答，留一句日志）、`channel-health`（缺席 → 静默）、`config-schema` / `path-layout` / `clock` / `identity`（全软）。**没有 `webServer` 依赖**（拉取式），也没有一条会阻断加载。
5. **我和同域的谁共享了可变状态？** 没有。`offset`、兜底表、并发计数、排队表都是本包私有；与 O-055/O-056/O-057 只有单向调用。
