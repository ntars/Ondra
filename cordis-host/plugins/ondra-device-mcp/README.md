# ondra-device-mcp

> O-069 · L6 端侧 · 档位〔研〕 · 服务键 `ondra-device-mcp`

手机上的五个**只读**能力。能力面与隐私闸门在本包，数据从端口来。

---

## 一、职责

1. **能力面**：发布五个只读工具（连字符名）：`device-notifications` / `device-sms` / `device-contacts` / `device-battery` / `device-foreground`。
2. **参数校验**：`limit` 越界**拒绝**（不夹紧），`query` 必填且 1–64 字，联系人上限 20。
3. **超时**：单次 8 秒（§9.11）。超时结果丢弃，迟到的计入 `stats().late`。
4. **隐私闸门**：号码打码、短信正文截断并标 `truncated`、通知默认不带正文、通讯录默认关。
5. **降级**：没有来源 → `no-bridge`；来源不支持 → `unsupported`（**不等 8 秒**）；设备不在 → `device-offline`。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 真正去读设备（`dumpsys` / `content query` 联系人 / `getprop`） | **`DeviceBridge` 的实现方**（见「六、已知限制」1） |
| 短信轮询、已答集合、回复桥 | `ondra-adb`（O-068）——本包只调它的 `readSms()` |
| 注册工具到模型（`ctx.tools.register`） | 宿主侧适配层，经 `useRegistrar()` 注入（见「六、已知限制」2） |
| 截屏、点击、输入 | `gui-agent`（O-072）/ scrcpy |
| 电脑侧能力（进程 / 窗口 / 剪贴板 / 文件） | `ondra-desktop-mcp`（O-070） |
| 判「该不该看这些数据」 | `ondra-privacy`（O-076）+ 配置 |

### 三条刻意的「不做」

1. **不返回空数组假装「没有数据」。** 来源不支持某个能力时回 `unsupported`，而不是 `items: []`。后者会让模型说「你手机上没有未读通知」，而真相是「这个来源根本不管通知」——这是最难被用户纠正的一类错。
2. **不夹紧越界参数。** `limit: 500` 若被悄悄改成 50，调用方会在「只有 50 条」的假事实上继续推理。宁可 `bad-arg` 并写清范围。
3. **不提供「列出全部联系人」。** 关键词必填是接口层面的取消，不是文档劝阻。通讯录是五个能力里唯一「一次能拿走一群人」的那一个。

## 三、服务键与方法

```
ondra-device-mcp        ← 连字符，不是 ondra:device-mcp
```

| 方法 | 说明 |
|---|---|
| `descriptors()` | 开着的工具描述（模型侧可见的那一份；含 `readOnly: true` 与 `timeoutMs`） |
| `invoke(tool, args?)` | 调一个工具，**永不抛错**；返回 `{ok, tool, reason, data, detail, elapsedMs, degraded}` |
| `useBridge(bridge \| null)` | 换数据来源 |
| `useRegistrar(fn \| null)` | 换注册器（`null` 会撤掉已注册的全部工具） |
| `status()` | `enabled / available / reason / bridge / supports / tools / registrar` |
| `stats()` | `calls / ok / timeouts / late / rejected / worstMs` |

### 数据来源端口

```ts
interface DeviceBridge {
  readonly id: string
  readonly supports: readonly ToolKey[]        // 先声明，才能在等 8 秒之前拒绝
  notifications(input: { limit: number }, timeoutMs: number): Promise<BridgeResult<readonly NotificationItem[]>>
  sms(input: { limit: number; unreadOnly: boolean }, timeoutMs: number): Promise<BridgeResult<readonly SmsItem[]>>
  contacts(input: { query: string; limit: number }, timeoutMs: number): Promise<BridgeResult<readonly ContactItem[]>>
  battery(timeoutMs: number): Promise<BridgeResult<BatteryInfo>>
  foreground(timeoutMs: number): Promise<BridgeResult<ForegroundInfo>>
}
```

**现成实现两个**：

- `AdbSmsBridge`：把 O-068 的 `readSms()` 接成 `device-sms`；`supports` 只有 `['sms']`。
- `CompositeBridge`：按能力分派给多个来源（先声明者优先，**不做合并**——合并两个来源的短信会同时带来顺序与去重问题）。

## 四、配置

| 字段 | 默认 | 出处 |
|---|---|---|
| `enable` | `false` | 手册 §16.3：端侧默认全关 |
| `enabledTools` | `notifications, sms, battery, foreground` | **不含 `contacts`**：见「五、边界」 |
| `callTimeoutMs` | `8000` | §9.11 `timeout 8s`（1000–30000） |
| `defaultLimit` | `10` | 不传 limit 时（1–50） |
| `smsBodyMax` | `120` | 正文截断长度（20–2000） |
| `maskPhones` | `true` | 号码打码（保留前 3 后 2） |
| `includeNotificationBody` | `false` | 通知正文里常有验证码与私信 |
| `useAdbForSms` | `true` | 关掉则只认注入的 `DeviceBridge` |
| `verbose` | `false` | 每次调用一行日志（不含号码与正文） |

**没有 `endpoint`**：§9.12 把它判成假字段（源码走本地命令，界面填了也不读）。

## 五、边界

- **工具名必须合规**：`^[a-z][a-z0-9_-]{1,63}$`（§8.4）。所以是 `device-notifications`，不是 §9.11 写的 `device.notifications`——**这是手册内部两条规则的冲突**，按 §8.4 优先（它明确给了「模型侧直接拒绝」的事故教训）。
- **只读是三层**：能力层（没有写方法）、参数层（没有 `package` / `action` 这类可写参数）、数据层（打码 / 截断 / 丢字段）。第三层最容易漏：能力只读不等于数据无害。
- **失败不带数据**：`data` 在失败时恒为 `null`。带半份数据的失败会被当成成功。
- **不进提示词**：本包不申报提示词片段。
- **不碰会话**：不创建 APP Session、不写 `app_session_log`（§6 禁令 5）。

## 六、已知限制

1. **没有自己读设备的能力（本轮最大的一条）。** 手册只给了五个能力名与 8 秒超时，**没给命令、没给权限声明、没给返回字段**；本仓 `cordis/` 与 `desktop/packages` 都没有可复用的设备信息服务键。硬凑一版只能猜 `dumpsys` / `content query` 的输出格式（随 Android 版本与厂商变化），猜错的表现是「工具能用但返回空」——与「没接」在界面上完全同形。故：来源做成端口，现成来源只有 adb 的短信一条路。解除方式：实现 `DeviceBridge` 后 `useBridge()`，不改本包。
2. **工具不自动进模型。** 注册标准写法是 `inject: ['tools']` + `defineTool()`；`inject` 会让上游缺席时整插件 PENDING（§8.3 静默失败），而 `@ntars/ondra-tools` 不在本仓任何插件的依赖里。故做成 `useRegistrar()` 注入：宿主侧把 `ctx.tools.register` 包一层传进来即可。**没有注册器时服务照常可用**，只是模型看不见这五个工具。
3. **`device-sms` 依赖 `ondra-adb`。** 它缺席或没开时，`device-sms` 回 `unsupported` / `device-offline`；其余四个能力**本来就没有来源**（不是「手机不支持」）。
4. **联系人上限 20 且关键词必填。** 这是接口层面的隐私设计，不是可调参数——想放宽请改代码并想清楚后果。
5. **通知不含正文、号码默认打码。** 这两项都会让「她说得出具体内容」的能力下降，这是**有意的**取舍（§9.4：刻意不暴露项）。
6. **`supports` 是「这个来源负责哪些能力」，不是「现在能不能用」。** `AdbSmsBridge.supports` 恒为 `['sms']`（它负责短信这件事），而「此刻能不能读」要看 `ondra-adb` 自己的 `available`——两者分开，`device-sms` 因此在 adb 缺席时会回 `unsupported` / `device-offline`，而不是从 `supports` 里悄悄消失。
7. **两道 8 秒闸会偶发「本包先超时」。** 本包的 `callTimeoutMs` 默认 8000，而 `ondra-adb` 的单条命令超时也默认 8000；两者同值时，命令刚好跑满 8 秒的那一次会由本包先判 `timeout`（adb 侧的结果稍后才回来，计入 `stats.late`）。想稳一点就把 `callTimeoutMs` 调大到 10000。
8. **档位〔研〕的依据与待核项。** 台账把本项记为〔研〕。生态里确有 Android 侧的 MCP 类项目（手册书签表只逐条核过 `CursorTouch/Windows-MCP` 这一个 Windows 件），但本仓**没有**它们的接口与许可证核对结论，且它们多以「adb + 常驻服务端」形态提供，与「插件包 + 端口」形态不合。故本包只借「五个只读能力 + 8 秒超时」这一层能力面，机制自研；**该核对项登记为待核**，不写成「已确认无生态」。
9. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app，全部结论来自静态检查与纯逻辑对拍。

## 七、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 五个只读能力与 8 秒超时 | 手册 §9.11 端侧实证 | — | — | 能力清单与超时值 | `tools.ts` 描述表 + `service.ts` 超时 | 否 |
| 「剪贴板只返回长度」的克制 | 手册 §9.4 / §9.11（desktop-mcp） | — | — | 「感观能力刻意少给」的口径 | `privacy.ts` 打码 / 截断 / 丢字段 | 否 |
| 桌面/安卓 MCP 的能力分层 | `CursorTouch/Windows-MCP`（手册书签表） | github.com/CursorTouch/Windows-MCP | 未核（**待核**） | 只借「一组只读工具 + 统一超时」的形状 | 自研能力面与端口，未读其源码 | 否 |
| 工具注册的 PENDING 风险 | 本项目 O-036 / O-037 | 自有 | 自有 | 「不声明 inject、注册走注入」的取舍 | `useRegistrar()` | 是（自有资产） |
| 超时后仍要接住落下的 Promise | 本项目 O-067（迟到结果处置） | 自有 | 自有 | 「超时不是结束，是另一条路径的开始」 | `withTimeout()` + `stats().late` | 是（自有资产） |

**档位判定〔研〕**：五个能力的数据通路在生态里没有可直接复用的插件形态实现（详见限制 6），且本包的核心价值是**能力面 + 隐私闸门 + 超时治理**这一层——它不属于任何现成包。故按台账〔研〕执行，自研范围严格限制在「能力面与治理」，数据读取本身**没有**自研（做成端口，交给实现方）。

## 八、多方案分支说明

涉及 master-plan §14.3 的**无直接对应项**（检索 / 情绪 / 界面渲染等都与本包无关）。但本包内部有一处真实的多方案，按 §12 的判定顺序处理：

| 方案 | 处理方式 |
|---|---|
| 来源 A：`ondra-adb`（短信） | 已实现（`AdbSmsBridge`） |
| 来源 B：用户自备桥（通知 / 联系人 / 电量 / 前台） | 已留口（`DeviceBridge`），未实现 |
| 来源 C：本包自己读设备 | **刻意不做**（见限制 1） |

A 与 B **能融就融**：`CompositeBridge` 按能力分派，同一服务键、一个接口、每个来源一个文件、各自独立降级、不共享缓存。默认选最稳的（A，因为它是唯一有依据的）。

## 九、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「模型能看手机」这一件事。`useRegistrar(null)` 会撤掉全部已注册工具，不留幽灵注册；本包没有定时器、没有连接、没有端口占用。
2. **我的状态存在哪？** **只在内存**：来源引用、注册撤除函数、计数。本包**不落盘任何东西**——手机数据一条都不缓存（缓存才是隐私事故的源头）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.device.mcp`；`status().reason` 给闭集原因码；`stats().rejected` 按码分桶；`stats().late` 单列「来源很慢」。
4. **我依赖谁？缺席时我怎么降级？** `ondra-adb`（缺→`device-sms` 报 `unsupported`，其余四个本来无来源）、`ondra-config-schema`（缺→本地校验）、`ondra-clock`（缺→`Date.now`）、`ondra-identity`（缺→日志前缀兜底）、注册器（缺→服务可用但模型看不见）。五个全软，一个都不 `inject`。
5. **我和同域的谁共享了可变状态？** 没有。`ondra-adb` 只被**调用** `readSms()`（只读、无副作用、不改它的已答集合）；来源引用、注册表、计数都是本插件私有。
