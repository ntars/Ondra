# ondra-desktop-mcp

> O-070 · L6 端侧 · 档位〔研〕 · 服务键 `ondra-desktop-mcp`

电脑上的五个**只读**能力。能力面、隐私整形、限频与沙箱在本包，数据从端口来。

---

## 一、职责

1. **能力面**：发布五个只读工具（连字符名）：`desktop-processes` / `desktop-foreground` / `desktop-clipboard-meta` / `desktop-find-files` / `desktop-sysinfo`。
2. **隐私整形**：只挑白名单字段重建对象——端口多给什么，都进不来（不是「过滤掉」，是「只挑」）。
3. **限频**：单工具最小间隔 + 每分钟总预算（手册 §6.6「限频」）。
4. **超时**：单次 5 秒（§9.11）。超时结果丢弃，迟到的计入 `stats().late`。
5. **沙箱**：行数 30 / 字符 1200 双预算，超了跳过继续试，段尾写「另有 N 条未展开」（手册第九部分 §3-1）。
6. **指路**：每个失败都带 `hint`，告诉它该用什么替代（§6.6「拒绝提示从禁止改成指路」）。
7. **电量事件**：`sysinfo` 时顺带判档位变化并发 `battery` 事件（§14 那条缺口链的产出端）。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 真正去读进程 / 前台窗口 / 剪贴板 | **`DesktopBridge` 的实现方**（见「六、已知限制」1） |
| 读剪贴板内容 | **不做，也不打算做**：连长度都需要一个「会读内容」的来源，本包不提供那种来源 |
| 注册工具到模型（工具包标准注册） | 宿主侧适配层，经 `useRegistrar()` 注入（见「六、已知限制」2） |
| 截屏、点击、输入、窗口控制 | `ondra-gui-agent`（O-072） |
| 手机侧能力（通知 / 短信 / 通讯录 / 电量） | `ondra-device-mcp`（O-069） |
| 浏览器自动化 | `ondra-browser`（O-071） |
| 判断「该不该看这些数据」 | `ondra-privacy`（O-076）+ 配置 |
| 低电量时她**怎么反应** | 消费方（O-048 / L3）——本包只发事实，不做推断 |

### 三条刻意的「不做」

1. **不返回空数组假装「没有数据」。** 来源不负责某个能力时回 `unsupported`，而不是 `items: []`。后者会让模型说「你电脑上没开几个程序」，而真相是「这个来源根本不管进程」。
2. **不夹紧越界参数。** `limit: 500` 若被悄悄改成 50，调用方会在「只有 50 条」的假事实上继续推理。宁可 `bad-arg` 并写清范围。
3. **不装定时器轮询电量。** 那会把一个只读插件变成常驻后台服务（master-plan §12.4 禁止），收益只是「更早几秒知道」。事件在被调用时顺带产生。

## 三、服务键与方法

```
ondra-desktop-mcp        ← 连字符，不是带冒号的写法
```

| 方法 | 说明 |
|---|---|
| `descriptors()` | 开着的工具描述（模型侧可见的那一份；含 `readOnly: true` 与 `timeoutMs`） |
| `invoke(tool, args?)` | 调一个工具，**永不抛错**；返回 `{ok, tool, reason, data, text, detail, hint?, elapsedMs, degraded, omitted}` |
| `useBridge(bridge \| null)` | 换数据来源 |
| `useRegistrar(fn \| null)` | 换注册器（`null` 会撤掉已注册的全部工具） |
| `subscribe(fn)` | 订阅电量事件，返回退订函数 |
| `lastBattery()` | 最近一次电量读数（没读过为 `null`） |
| `status()` | `enabled / available / reason / bridge / supports / tools / registrar / roots` |
| `stats()` | `calls / ok / throttled / timeouts / late / rejected / worstMs / batteryEvents` |

### 数据来源端口

```ts
interface DesktopBridge {
  readonly id: string
  readonly supports: readonly ToolKey[]        // 先声明，才能在等 5 秒之前拒绝
  processes(input: { limit: number; sort: 'cpu' | 'mem' | 'name' }, timeoutMs: number): Promise<BridgeResult<readonly ProcessItem[]>>
  foreground(timeoutMs: number): Promise<BridgeResult<ForegroundInfo>>
  clipboardMeta(timeoutMs: number): Promise<BridgeResult<ClipboardMeta>>
  findFiles(input: { root: string; keyword: string; depth: number; limit: number }, timeoutMs: number): Promise<BridgeResult<FindOutcome>>
  sysinfo(timeoutMs: number): Promise<BridgeResult<SysInfo>>
}
```

**现成实现两个，都只用标准库**：

- `NodeSysBridge`（`node:os`）：负责 `sysinfo`。内存 / 核数 / 负载 / 开机时长都是确定的；**电池恒为 `null`**（标准库没有电池读数）。
- `FsFindBridge`（`node:fs/promises`）：负责 `find-files`。只在用户主目录下、跳过隐藏项与符号链接、条目预算 2000。
- `CompositeBridge`：按能力分派，先声明者优先，**不做合并**（合并两个来源会造出一份谁也没测过的读数）。

## 四、配置

| 字段 | 默认 | 出处 |
|---|---|---|
| `enable` | `false` | 手册 §16.3：端侧默认全关 |
| `enabledTools` | `processes, foreground, clipboard, sysinfo` | **不含 `findFiles`**：唯一会遍历磁盘的能力 |
| `callTimeoutMs` | `5000` | §9.11 `timeout 5s`（1000–20000） |
| `defaultLimit` | `10` | 不传 limit 时（1–50） |
| `sort` | `cpu` | 进程排序 |
| `findRoots` | `Desktop, Documents, Downloads` | **相对用户主目录**，拒绝对路径与 `..` |
| `findDepth` | `1` | §9.11 上限 2 |
| `findLimit` | `20` | §9.11 上限 30 |
| `minIntervalMs` | `2000` | 限频（工程判断，**待裁决**） |
| `sysinfoIntervalMs` | `5000` | sysinfo 单独放宽（最常被轮询） |
| `callsPerMinute` | `30` | 每分钟总预算 |
| `includeWindowTitle` | `true` | 标题里常有文档名与网址 |
| `maskPaths` | `true` | 只给相对路径（不带用户名） |
| `batteryEvents` | `true` | §14 缺口链的产出端 |
| `verbose` | `false` | 每次调用一行日志（不含标题与路径） |

**没有 `endpoint`**：§9.12 把它判成假字段（源码走本地命令，界面填了也不读）。

## 五、边界

- **工具名必须合规**：`^[a-z][a-z0-9_-]{1,63}$`（§8.4）。所以是 `desktop-processes`，不是 §9.11 写的点号形式——**这是手册内部两条规则的冲突**，按 §8.4 优先（它明确给了「模型侧直接拒绝」的事故教训）。
- **只读是三层**：能力层（没有写方法）、参数层（没有 `action` / `command` / `includeCommandLine`）、类型层（`ProcessItem` 没有命令行列、`ClipboardMeta` 没有内容字段）。第三层最硬：端口想给也给不出来。
- **失败不带数据**：`data` 在失败时恒为 `null`。带半份数据的失败会被当成成功。
- **不进提示词**：本包不申报提示词片段。
- **不碰会话**：不创建 APP Session、不写 `app_session_log`（§6 禁令 5）。

## 六、已知限制

1. **进程 / 前台窗口 / 剪贴板没有实现（本轮最大的一条）。** 手册只给了五个能力名与 5 秒超时，**没给命令、没给参数、没给输出格式**；本仓也没有可复用的系统信息服务键（`desktop/packages` 里 `totalmem` 只出现在一个内部统计模块，不是服务）。硬凑一版 `ps aux` 解析的坏形态是「工具能用、但字段随系统版本变化」——与「没接」在界面上完全同形。故：来源做成端口，现成来源只覆盖 `sysinfo` 与 `find-files`。解除方式：实现 `DesktopBridge` 后 `useBridge()`，不改本包。
2. **工具不自动进模型。** 标准注册要 `inject: ['tools']` + `defineTool()`；`inject` 会让上游缺席时整插件 PENDING（§8.3 静默失败），而工具包不在本仓任何插件的依赖里。故做成 `useRegistrar()` 注入：宿主侧把注册能力包一层传进来即可。**没有注册器时服务照常可用**，只是模型看不见这五个工具。
3. **电池恒为 `null`。** `node:os` 没有电池读数，本包不跑 `pmset` 之类的外部命令（输出格式本仓无依据）。后果：`battery` 事件在默认配置下**永不发出**——那条链（低电量 → 她该有反应）的产出端已在位，但要先接一个能给 `battery` 的来源。
4. **文件检索只给名字与大小，不读内容。** 也不会跟随符号链接（会跑出主目录、也容易成环），跳过隐藏项（`.ssh`、`.config` 都在里面）。
5. **窗口标题默认返回。** 标题里常有文档名、网址、邮件主题。介意就关 `includeWindowTitle`——关掉只给应用名。
6. **限频数值是工程判断。** 手册原话只有「限频」两个字，`2000 / 5000 / 30` 三个数没有出处，已登记待裁决。
7. **两道 5 秒闸可能偶发「本包先超时」。** 本包 `callTimeoutMs` 与某些平台桥接的内部超时可能同值；同值时刚好跑满的那一次会由本包先判 `timeout`。想稳一点就调到 8000。
8. **档位〔研〕的依据与待核项。** 台账把本项记为〔研〕。生态里确有桌面 MCP 类项目（手册书签表只逐条核过 `CursorTouch/Windows-MCP` 这一个 Windows 件），但本仓**没有**它们的接口与许可证核对结论，且它们多以「常驻服务端」形态提供，与「插件包 + 端口」形态不合。故本包只借「一组只读工具 + 统一超时」这一层形状，机制自研；**该核对项登记为待核**，不写成「已确认无生态」。
9. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app，全部结论来自静态检查与纯逻辑对拍。

## 七、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 五个只读能力与 5 秒超时 | 手册 §9.11 端侧实证 | — | — | 能力清单与超时值 | `tools.ts` 描述表 + `service.ts` 超时 | 否 |
| 只读 / 限频 / 不做推断；拒绝改「指路」 | 手册 §6.6、§14 | — | — | 三条设计取舍与提示口径 | `service.ts` 限频 + `hintOf()` | 否 |
| 进程不取命令行、剪贴板只返回长度 | 手册 §9.4 隐私、§14 | — | — | 「刻意不暴露项」的口径 | 类型层去掉字段（`types.ts`） | 否 |
| 工具输出沙箱（315KB→5.4KB） | `mksglu/context-mode`（手册第九部分 §3-1） | github.com/mksglu/context-mode | 未核（**待核**） | 「原始数据不进上下文」+ 双预算裁剪 | `sandbox.ts` 行/字符双预算，跳过继续试 | 否 |
| 桌面 MCP 的能力分层 | `CursorTouch/Windows-MCP`（手册书签表） | github.com/CursorTouch/Windows-MCP | 未核（**待核**） | 只借「一组只读工具 + 统一超时」的形状 | 自研能力面与端口，未读其源码 | 否 |
| 工具注册的 PENDING 风险 | 本项目 O-036 / O-069 | 自有 | 自有 | 「不声明 inject、注册走注入」的取舍 | `useRegistrar()` | 是（自有资产） |
| 超时后仍要接住落下的 Promise | 本项目 O-067 / O-069 | 自有 | 自有 | 「超时不是结束，是另一条路径的开始」 | `withTimeout()` + `stats().late` | 是（自有资产） |

**档位判定〔研〕**：五个能力的数据通路在生态里没有可直接复用的**插件形态**实现（详见限制 8），且本包的核心价值是「能力面 + 隐私整形 + 限频 + 沙箱」这一层——它不属于任何现成包。故按台账〔研〕执行；自研范围严格限制在「能力面与治理」，系统读数与目录列举本身用的是标准库，**没有**自研协议。

## 八、多方案分支说明

涉及 master-plan §14.3 的**无直接对应项**。但本包内部有两处真实的多方案，按 §12 的判定顺序处理：

| 方案 | 处理方式 |
|---|---|
| 系统状态来源 A：`node:os` | 已实现（`NodeSysBridge`） |
| 系统状态来源 B：平台桥接（`pmset` / `system_profiler` / Win32 API） | 已留口，未实现（见限制 1） |
| 文件检索来源 A：`node:fs` | 已实现（`FsFindBridge`） |
| 文件检索来源 B：平台索引（Spotlight / Everything） | 已留口，未实现 |

同一能力有多个来源时**能融就融**：`CompositeBridge` 按能力分派，同一服务键、一个接口、每个来源一个文件、各自独立降级、不共享缓存。**不做合并**——两个来源的读数取平均会造出一份谁也没测过的数。

## 九、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「模型能看这台电脑」这一件事。`useRegistrar(null)` 会撤掉全部已注册工具，不留幽灵注册；本包没有定时器、没有连接、没有端口占用。
2. **我的状态存在哪？** **只在内存**：来源引用、注册撤除函数、限频时间表、计数、最近一次电量读数。本包**不落盘任何东西**——机器状态一条都不缓存。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.desktop.mcp`；`status().reason` 给闭集原因码；`stats().rejected` 按码分桶；`stats().late` 单列「来源很慢」。
4. **我依赖谁？缺席时我怎么降级？** `ondra-config-schema`（缺→本地校验）、`ondra-clock`（缺→`Date.now`）、`ondra-identity`（缺→日志前缀兜底）、注册器（缺→服务可用但模型看不见）。四个全软，一个都不 `inject`。
5. **我和同域的谁共享了可变状态？** 没有。与 O-069 的能力不重叠（它读手机、本包读电脑）；`battery` 事件走本包自己的订阅表，不写别人的状态。
