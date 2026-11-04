# ondra-minecraft

> O-073 · L6 端侧 · 档位〔复〕 · 服务键 `ondra-minecraft` · 状态 **`skeleton`（骨架）**

Minecraft 接入的**能力入口**：闸门、整形、状态机在本包；连服协议归驱动端口。

---

## 一、职责

1. **话术闸门**（`policy.ts`，纯函数）：长度、频率、每分钟预算、指令白名单、指令形状。
2. **文本整形**（`sanitize.ts`，纯函数）：控制字符、空白折叠、颜色码、按码元截断（不切代理对）。
3. **连接状态机**（`service.ts`）：`idle → connecting → online → closing → offline`，**无自动重连**。
4. **状态整形**（`driver.ts`）：把驱动给的原始快照收成契约，缺字段就省字段（**不补默认值**）。
5. **工具面**：`minecraft-status`（只读）/ `minecraft-chat` / `minecraft-command`。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 真正连服务器、跑 Mineflayer | **`MinecraftDriver` 的实现方**（见「六、已知限制」1） |
| 移动、挖掘、战斗、合成 | **不做**。台账只写「Mineflayer 接入（占位）」，没有能力清单；这三类的风险面比「说一句话」大一个量级 |
| 正版账号认证（微软 OAuth） | 驱动实现方 |
| 决定「她该说什么」 | 表达层（O-031 / O-040 / O-052）+ L3 对话层 |
| 自动重连、后台保活 | **不做**。见「四」的裁决 |
| 沙箱 / 反作弊规避 | **不做**（master-plan §17「明确不做」） |

### 四条刻意的「不做」

1. **不假装在线**。无驱动时每个入口如实报 `no-driver`，且 `status().skeleton` 恒为 `true`。空壳插件最坏的行为不是「什么都不做」，而是「让模型以为她在游戏里」。
2. **不自动重连**。①账号在别人的服务器上反复上下线最容易被判异常；②重连窗口里收到什么、错过什么不可知。
3. **不给指令参数留选择器**。白名单只回答「指令名许不许」，不够——`/kill @a` 也能过白名单。所以第二条闸门看**形状**：含 `@ { } [ ] * ; | & $ \` \\` 或换行的一律拒。
4. **不在日志里打正文**。`verbose` 只记长度与结果码。游戏里说的话会涉及具体的人与事。

## 三、服务键与方法

```
ondra-minecraft        ← 连字符，不是带冒号的写法
```

| 方法 | 说明 |
|---|---|
| `descriptors()` | 开着的工具描述（`minecraft-status` 的 `mutates` 为 `false`） |
| `invoke(tool, args?)` | 调一个工具，**永不抛错** |
| `connect()` | 连接（无驱动时如实回 `no-driver`） |
| `disconnect()` | 断开（幂等） |
| `say(text)` | 发一条聊天（过闸门） |
| `run(command)` | 发一条指令（过闸门） |
| `snapshot()` | 读一眼状态 |
| `useDriver(driver \| null)` | 换驱动（`null` 装回 `MissingDriver`，并重置连接状态） |
| `useRegistrar(fn \| null)` | 换注册器（`null` 撤掉全部工具） |
| `status()` / `stats()` / `dispose()` | 现状 / 计数 / 撤工具 |

### 驱动端口

```ts
interface MinecraftDriver {
  readonly id: string
  connect(target: ServerTarget, timeoutMs: number): Promise<DriverResult<McSnapshot>>
  disconnect(): Promise<DriverResult<null>>
  chat(text: string): Promise<DriverResult<null>>      // 原样发，不许加前后缀、不许内部重试
  command(text: string): Promise<DriverResult<null>>
  snapshot(): Promise<DriverResult<McSnapshot>>
}
```

## 四、配置

| 字段 | 默认 | 出处 |
|---|---|---|
| `enable` | `false` | §16.3：端侧默认全关 |
| `enabledTools` | `['status']` | **出厂只读**：先能看见，再决定让不让她说话 |
| `server` | `''` | 只认 `host` 或 `host:port`，**不接受 URL** |
| `port` | `25565` | server 里写了端口则以 server 为准 |
| `username` | `''` | 离线模式用户名（`^[A-Za-z0-9_]{1,16}$`） |
| `version` | `auto` | 让驱动自己探测 |
| `commandAllowList` | `[]` | **空 = 一个指令都不许** |
| `minSendIntervalMs` | `1200` | 多数服务端把 1 秒内的连续消息判刷屏（**待裁决**） |
| `maxPerMinute` | `20` | 工程判断（**待裁决**） |
| `chatMax` | `256` | **协议上限**，超过即断连 |
| `connectTimeoutMs` | `10000` | 三段握手，宽松值（**待裁决**） |
| `recentChatKeep` | `20` | 状态里带多少条最近聊天 |
| `verbose` | `false` | 每次发送一行日志（**不含正文**） |

## 五、边界

- **工具名**：`minecraft-status` / `minecraft-chat` / `minecraft-command`，匹配 `^[a-z][a-z0-9_-]{1,63}$`（§8.4）。
- **聊天上限 256 是协议硬限制**，配置不许超过（`CHAT_CEIL = 256`）：超了不是报错是断连。
- **指令形状白名单**在 `policy.ts` 一处，`say` 与 `run` 不各写一份。
- **限频与预算只对真正发出去的消息计数**；被闸门拒掉的不消耗额度。
- **不进提示词**、**不碰会话**（master-plan §6 禁令 5）。
- **不装定时器**：没有轮询、没有心跳、没有重连循环，卸载即彻底消失。

## 六、已知限制

1. **没有 Mineflayer 驱动（这是骨架的全部原因）。** 三处查证全为空：手册无 `minecraft`/`Mineflayer`；`desktop/packages/**` 无该依赖、无可复用服务键；本仓禁装依赖。硬凑一版猜参数的实现在界面上与「没连」同形，且**连上之后什么也收不到**这种形态最难查。解除方式：写一个 `MinecraftDriver` 实现（`createBot` → 包四方法），`useDriver()` 接进来即可，**本包不用改一行**。
2. **台账写「占位」，本版实际比占位多做了一层。** 台账职责只有四个字。本包把「接上之后最危险的三处」（长度/选择器/刷屏）先做了闸门——这三件事不需要协议也能做对，且它们是**不可逆**的（封号、全服影响、掉线）。能力清单（移动/挖掘/战斗）刻意没做，见「二」。
3. **指令形状白名单会误伤一部分合法用法。** 例如 `/msg` 的参数里出现 `@` 会被拒。取舍：漏放一个正常用法（可改配置或换写法）比放进一个选择器（一次作用全服）便宜得多。
4. **离线模式用户名不做正版校验。** 驱动实现方负责认证；本包只校验形状。
5. **`recentChat` 每条在进正文时截到 120 字**，状态结构里保留原文——两处各截一次会让「显示长度」与「实际长度」对不上，所以只在 `describeSnapshot()` 一处截。
6. **三个工具名是本轮自定**（手册没给）。已登记待裁决。
7. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app；全部结论来自静态检查与纯逻辑对拍。

## 七、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 整体形态 | master-plan §9.11（旧项目 27 行占位） | — | — | 「开着就 warn 一句」这个反面教材 | 改成「闸门 + 端口 + 明确原因码」 | 否 |
| Mineflayer 接入思路 | `PrismarineJS/mineflayer` | github.com/PrismarineJS/mineflayer | MIT（**待核**） | 「一个 bot 对象挂四个动作」的接口形状 | 只借形状写成 `MinecraftDriver` 端口，**不引入代码**（本仓禁装依赖） | 否 |
| 聊天 256 字符上限 | Minecraft 协议（chat 包字符串上限） | — | — | 硬限制值 | `CHAT_MAX` / `CHAT_CEIL` | 否 |
| 指令选择器风险 | Minecraft 命令语法（`@a` / `@e` / NBT） | — | — | 「参数能作用到全服」这个事实 | `FORBIDDEN_RE` 形状白名单 | 否 |
| 只读默认 / 独立开关 | master-plan §16.3 | — | — | 端侧隔离三条 | `enabledTools` 出厂只有 `status` | 否 |
| 工具注册的 PENDING 风险 | 本项目 O-036 / O-069 / O-070 | 自有 | 自有 | 「不声明 inject、注册走注入」 | `useRegistrar()` | 是（自有资产） |

**档位判定〔复〕与实测的差异（必须写清）**：台账标〔复〕，思路是「复用 Mineflayer」。但**本仓没有 Mineflayer**（禁装依赖），且没有它的接口与许可证核对结论，所以「复用」在本轮只能落成「**端口形状借用 + 不引入代码**」。本包真正自写的部分（闸门、整形、状态机）不属于任何现成包。若主人裁定要真接，需新增一条依赖白名单——那超出本轮边界，故登记为待裁决而不是自己决定。

## 八、多方案分支说明

涉及 master-plan §14.3 的**无对应项**。本包内部两处：

| 能力 | 方案 A（默认） | 方案 B | 处理 |
|---|---|---|---|
| 协议实现 | 端口 + `MissingDriver`（默认） | 接 Mineflayer 驱动 | 能兼容就兼容：同一个 `MinecraftDriver` 接口，换驱动不改本包 |
| 指令防护 | 白名单（指令名） | 形状白名单（选择器/串联） | **两个都用**：白名单答「许不许这个指令」，形状答「参数能不能这么写」，缺一个都能过线 |

## 九、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「她能不能在 Minecraft 里」。`dispose()` 撤掉全部已注册工具；本包没有定时器、没有 socket、没有端口占用（驱动拔掉即无连接）。
2. **我的状态存在哪？** **只在内存**：驱动引用、连接状态、限频时刻、分钟窗口、最近一次快照、计数。**不落盘任何东西**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.minecraft`；`status().reason` 给 `disabled` / `no-driver` / `not-connected` 三值（**三值分开**，因为排查方向不同）；`status().skeleton` 恒 `true` 显式标骨架；`stats()` 按码分桶。
4. **我依赖谁？缺席时我怎么降级？** `ondra-config-schema`（缺→本地校验）、`ondra-clock`（缺→`Date.now`）、`ondra-identity`（缺→日志前缀兜底）、驱动与注册器（缺→`no-driver` / 服务可用但模型看不见工具）。六个全软，一个都不 `inject`。
5. **我和同域的谁共享了可变状态？** 没有。与 O-068（只读短信）、O-069（手机只读）、O-070（电脑只读）、O-071（浏览器护栏）、O-072（GUI）能力完全不重叠。
