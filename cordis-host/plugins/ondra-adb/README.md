# ondra-adb

> O-068 · L6 端侧 · 档位〔复〕 · 服务键 `ondra-adb`

手机短信的**只读轮询**。这一包窄到只有一件事：把未读短信读出来，能答就答一条。

---

## 一、职责

1. **读**：`adb shell content query --uri content://sms/inbox`（手册 §9.11 逐字），每 15 秒一次，单轮最多 20 条。
2. **去重**：按短信主键 `_id` 记「处理过」，上限 1000 条，超了裁到 500（§9.11 逐字）；**跨重启**（`user/adb-seen.json`，0600）。
3. **转交**：`autoReply` 打开时经 `ondra-channel-kit.callPersona()` 问人格，再经回复桥发出去。
4. **只读兜底**：`policy.ts` 是一道**结构白名单**，不是黑名单。
5. **降级**：执行器、公共段、回复桥、路径服务，任意一个缺席都能继续跑（或明确说清为什么不能跑）。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 投屏、点击、滑动、中文输入 | **scrcpy**（手册 §1.7：`O-068 adb \| scrcpy 能力更强（投屏+控制）`） |
| 真发短信 | **用户自备的 Intent 桥**（本包只把文本投给它，见「五、边界」） |
| 读联系人 / 通话记录 / 相册 | 不在本包（`--uri` 只认短信收件箱，`policy.ts` 拦掉别的 provider） |
| 判「这条该不该回」 | 本包不做路由判断：`autoReply` 是开关，不是策略 |
| 判「此刻该不该主动开口」 | `ondra-proactive-gate`（O-042） |
| 人格、提示词、分条 | `ondra-persona-*` / `ondra-dialogue` / `ondra-channel-kit` |

### 三条刻意的「不做」

1. **不把短信标成已读。** 标记已读是一次写操作，而本包的整个安全模型建立在只读上。代价是「设备上永远是未读」，所以**已答集合必须落盘**——否则每次启动都会把最近这批未读重答一遍。这不是缓存，是正确性的一部分。
2. **不猜 `content query` 之外的路。** `service call isms` 的 transaction code 因厂商而异，`am start -a SENDTO` 需要人点发送。两条都不算「发出去」，所以发短信这件事整体交出去。
3. **轮询不按「最新 20 条」取，但读取按「最近 N 条」取。** 这是两个相反的方向，各有理由：
   - `poll()`（要回答）：未读有 300 条时只取最新的，中间那 280 条永远轮不到 → 取**最早的未读**，队列才会被走完（代价：新短信要排一会儿队）；
   - `readSms()`（只是看）：问「最近有什么短信」却拿到三天前那几条，是错的 → 取**最近 N 条**。
   两者混成一个排序，必然有一边是错的。

## 三、服务键与方法

```
ondra-adb        ← 连字符，不是 ondra:adb
```

| 方法 | 说明 |
|---|---|
| `readSms({limit?, unreadOnly?})` | **只读查询，不改已答集合**（面板刷新不会吞消息）；返回**最近 N 条**（切片内升序） |
| `poll()` | 轮询一次：读 → 剔已答 → 升序取**最早的** N 条 → 逐条转交 |
| `reply(to, body)` | 经回复桥发一条（号码是接收方） |
| `start()` / `stop()` | 起停定时器；`stop()` 会先落一次盘 |
| `useRunner(runner \| null)` | 换执行器（`null` → 之后 `poll()` 返回 `no-runner`） |
| `usePush(push \| null)` | 换回复桥 |
| `status()` | `enabled / available / reason / runner / bridge / seen / lastPollAt / lastReason / serial` |
| `stats()` | `polls / rows / handled / answered / gaveUp / failures / worstPollMs` |
| `reloadSeen()` | 重读已答集合（手改过文件时） |

### 端口

```ts
interface AdbRunner {
  readonly id: string
  exec(argv: readonly string[], timeoutMs: number): Promise<ExecResult>   // 永不抛错
}
interface ReplyPush {
  readonly id: string
  send(input: { to: string; body: string }): Promise<ReplyOutcome>        // 永不抛错
}
```

**为什么执行器收 `argv` 数组而不是命令串**：白名单要逐 token 判。收字符串就只能靠正则猜边界，猜漏一次就是一次写操作。

## 四、配置

| 字段 | 默认 | 出处 |
|---|---|---|
| `enable` | `false` | 手册 §16.3：端侧默认全关 |
| `adbPath` | `adb` | §9.12：源码实际读的键（旧 UI 填的 `serial` 是错位项） |
| `serial` | `''` | 多设备必须指定，否则 adb 报 `more than one device` |
| `pollSeconds` | `15` | §9.11「15s 轮询」（5–300） |
| `batchLimit` | `20` | §9.11「未读 20 条」（1–20，**上限锁死**） |
| `execTimeoutMs` | `8000` | **必须小于轮询周期**，否则每轮撞 `busy`（构造时自动压到周期减 1 秒） |
| `autoReply` | `false` | 只读默认；**没有 `replyWebhook` 时自动降为 `false` 并报 drift** |
| `replyWebhook` | `''` | §9.11「靠 replyWebhook + 用户自备 Intent 桥」 |
| `allowRemoteBridge` | `false` | 默认只允许 127.0.0.1 / localhost / ::1 |
| `seenMax` | `1000` | §9.11「超 1000 裁到 500」；改上限时按比例减半 |
| `stateFile` | `''` | 留空由 `path-layout` 推出 `user/adb-seen.json` |
| `verbose` | `false` | 每次轮询打一行 |

## 五、边界

- **只读是结构性的**：`policy.ts` 要求 `argv` 完全长成 `['shell','content','query','--uri','content://sms/inbox',…]`；`projection` 只允许 `_id / address / body / date` 四列；任何 token 里出现 `; & | > < \` $ \` 或换行 → `denied`，**连试都不试**。
  > 原因：`adb shell` 会把 argv 用空格拼起来、交给设备侧 sh **再解析一遍**，本机转义在设备侧会失效。所以只能在调用前拦形状，不能靠转义。
- **不进提示词**：本包不发提示词片段。
- **不注册工具**：模型不该能直接调「读手机短信」——那等于绕开所有闸门。要给它看，由上层决定。
- **日志不落隐私**：号码与正文从不进日志，只记条数与原因码。
- **失败只影响自己**：`poll()` / `readSms()` / `reply()` 全包 try/catch，异常折成原因码（手册 §8.1-C3）。

## 六、已知限制

1. **`content query` 的命令行与输出格式未在真机验证。** 手册只给了 URI、条数、周期、集合上限，**没给命令行**；仓内 `adb` 也没有任何真实调用可对拍。argv 按 Android 公开用法写。症状与改法：
   - `ok:true` 但 `read:0` 且 `badRows:0` → 改 `sms.ts` 的 `queryArgv()`；
   - `exit` 非零并带 usage → 同上；
   - 正文被截断 → `content query` 的输出没有转义约定，`splitPairs()` 在「逗号+空格+字母+=」处会误切。
2. **只读的代价是设备上永远未读。** 于是已答集合必须落盘；缺 `ondra-path-layout` 且未配 `stateFile` 时只在内存，**重启会把最近这批未读再答一遍**（装载期会 warn）。
3. **裁剪会丢最旧的已答记录。** 手册给的就是 1000→500。理论上可能让一条仍悬着的旧未读重新排队；只在「同时悬着上千条未读」时才可能撞上。
4. **失败重试最多 3 次。** 转交失败（缺 kit / 人格空回答 / 桥投递失败）**不**标记已答，只累加计数；3 次后放弃并记入集合 + warn。这样「暂时不可用」能自愈，「永久不可用」会停手。
5. **回复桥的载荷是本项目定义的契约**：`POST {"to":…,"body":…}`，不是任何平台的既有协议。桥接端需按此形状接收。
6. **`serial` 与旧 UI 的关系**：§9.12 说旧表单的 `serial` 是错位字段（源码读 `adbPath`/`pollSeconds`/`replyWebhook`）。本包把 `serial` **保留为 `adbPath` 的伴生项**（多设备必需），不是恢复旧表单。
7. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app，全部结论来自静态检查与纯逻辑对拍。

## 七、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 只读短信轮询的参数 | 手册 §9.11 端侧实证 | — | — | URI、未读 20 条、15s、`seen` 1000→500 | `sms.ts` + `service.ts` 照参数实现 | 否 |
| 投屏/控制能力选型 | `Genymobile/scrcpy` | github.com/Genymobile/scrcpy | Apache-2.0 | 「adb 之上有更强的封装」这一判断 | **不引入**：本包只读短信，投屏归 scrcpy | 否 |
| Android `content` 工具用法 | Android 公开文档 | — | — | `content query --uri --projection --where` 的形状 | `sms.ts` 一处组合，未实跑（见限制 1） | 否 |
| 只读白名单（结构判定） | 本项目 O-067 `stopOnCodes` 的「名单优于猜」 | 自有 | 自有 | 「宁可漏连，不可错连」→ 换成「宁可拒跑，不可错跑」 | `policy.ts` 结构白名单 + 元字符拒绝 | 是（自有资产） |
| 命令执行端口化 | 本项目 O-058 `QqTransport` / O-067 `DiscordSocket` | 自有 | 自有 | 「没有运行时依据就只做接线并显式降级」 | `AdbRunner` 端口 + 默认 `SpawnAdbRunner` | 是（自有资产） |
| 幂等占位与尝试计数 | 本项目纪律 142（幂等必须覆盖它保护的全部窗口） | 自有 | 自有 | 「谁加、谁删、哪条路径绕过删除」三问 | 成功才 `seen.add`，失败只累加计数，3 次放弃 | 是（自有资产） |

**档位判定〔复〕**：adb 本身是生态成熟工具（platform-tools），本包**不重写任何协议**，只做命令组合、结构白名单、去重与降级——这正是〔复〕的责任边界（只接线、配置与降级）。
**偏离说明**：手册期望「复用 scrcpy 那一层」，但 scrcpy 是**投屏与控制**，与「读短信」不是同一件事；台账把 O-068 记在 DEV 域且职责写「插件做封装与只读默认」。故本包只承接短信这一片，投屏能力留给后续 `O-071 browser` / `O-072 gui-agent` 那一类，不在本包假装能做。

## 八、多方案分支说明

涉及 master-plan §14.3 的**持久化后端**一项：本包的已答集合是「一份小 JSON + 原子 rename」，没有做 provider 分支。理由：它只有一种用法（跨重启记住 id 列表）、体量上限 1000 条，套 SQLite 会把一个 40 行的类变成一次迁移与一次快照义务。若将来需要与 `ondra-store-sqlite` 共用，改动点只在 `store.ts` 一个文件，接口（`has / add / flush / reload`）不变——这就是「接口唯一、分支各自成文件」的预留位。

其余多方案项（检索、情绪、界面渲染…）与本包无关。

## 九、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有手机短信这一路。`stop()` 幂等，定时器 `unref`，不碰别人的缓存与连接。
2. **我的状态存在哪？** 已答集合在 `user/adb-seen.json`（0600，原子写）；其余（轮询状态、尝试计数、统计）**只在内存**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.adb`；`status().reason` 给闭集原因码（`no-adb` / `device-offline` / `timeout` / `denied` / `no-runner` / `busy` / `bad-output`），`stats().failures` 按码分桶。
4. **我依赖谁？缺席时我怎么降级？** `ondra-path-layout`（缺→集合只在内存并 warn）、`ondra-config-schema`（缺→本地校验）、`ondra-clock`（缺→`Date.now`）、`ondra-channel-kit`（缺→不转交，记 warn，下轮再试）、`ondra-identity`（缺→日志前缀兜底）。五个全软，一个都不 `inject`。
5. **我和同域的谁共享了可变状态？** 没有。已答集合、尝试计数、统计、定时器全是本插件私有。`O-069 device-mcp` 只会**调用** `readSms()`，不持有本包的内部结构。
