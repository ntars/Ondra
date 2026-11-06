# ondra-browser

> O-071 · L6 端侧 · 档位〔复〕 · 服务键 `ondra-browser`

浏览器自动化的**护栏与沙箱**。真正的浏览器不在这里——它在宿主已有的后端里。

---

## 一、职责

1. **后端可见性**：每次现取 `ctx.browserUse.providerName`，报出「当前是哪个浏览器后端」。**不缓存**（provider 可能在本插件之后才注册）。
2. **红线拦截**（`tools/pre-execute`）：默认拦 `browser_evaluate` / `browser_run_code` 这类「在页面里执行任意代码」的工具——它能读到用户已登录站点的数据、能发同源请求。
3. **目标策略**（同一个瀑布）：参数里任何长得像 URL 的字符串都要过一遍——协议只许 `http`/`https`，`127.0.0.1` / `localhost` / `*.local` / `10.x` / `192.168.x` 一律拒（SSRF 的入门形态就是「帮我看一眼路由器后台」）。
4. **结果沙箱**（`tools/post-execute`）：超长快照按 4000 字符 / 80 行预算砍尾巴，并写出「原有多大 / 下面没展开」。
5. **可单独调用的纯函数**：`check(url)` 与 `trim(text, kind)`——面板要显示「这个网址会不会被拦」、测试要逐条对拍，都靠这两个入口。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 启动/连接浏览器、导航、点击、截图 | **宿主 provider**：`ctx.browserUse` + `@ntars/ondra-experimental-browser-use-playwright-mcp`（或 chrome-devtools / stagehand） |
| 浏览器资源的生命周期与会话隔离 | provider 自己（`browser-use` 文档：provider 拥有浏览器资源并实施 Session 隔离） |
| 工具注册 | provider（它把工具直接交给模型） |
| 「读动作 / 写动作」分类拦截 | **刻意不做**，见下 |
| 桌面进程/窗口/剪贴板 | `ondra-desktop-mcp`（O-070） |
| 手机侧能力 | `ondra-device-mcp`（O-069） |
| 写操作逐条确认、三层安全网 | `ondra-gui-agent`（O-072） |

### 三条刻意的「不做」

1. **不实现浏览器驱动端口。** 本仓已有 Playwright MCP / Chrome DevTools MCP / Stagehand 三个后端。再写一个「`BrowserDriver` + `no-driver`」的假端口，等于把仓库里的上游重写一遍，还多出一个永远返回「没驱动」的开关（手册 §1.8：能复用却自研 = 违规）。
2. **不做「读/写」二分开关。** 拿不到工具注册表，只能按名字猜（含 `click` 算写、含 `snapshot` 算读）。猜错的两头都很糟：拦错一半 = 浏览器突然不能用；漏一半 = 用户以为「只读」其实能下单。改按**两类真能判准的边界**：红线（执行代码）与目标（协议/主机）。
3. **不在 `post-execute` 里改上游的裁决。** 先 `await next()`，只在它是 `accept` 且带正文时替换正文；它说 `block` 就原样返回。

## 三、服务键与方法

```
ondra-browser        ← 连字符，不是带冒号的写法
```

| 方法 / 属性 | 说明 |
|---|---|
| `available` | `enable && 有后端`。护栏装上了但没后端时为 `false` |
| `reason` | `disabled` / `no-provider` |
| `provider` | 当前后端名（空 = 没有） |
| `hooks` | `{pre, post}`：两个瀑布是否真的挂上了（**与 `available` 分开**） |
| `check(url)` | 纯函数：`allow` / `deny{code, reason}`，码为 `not-url` / `bad-scheme` / `private-host` / `denied-host` / `no-host` |
| `trim(text, kind)` | 纯函数：`{text, before, after, trimmed, droppedLines}` |
| `status()` | `enabled / available / reason / provider / hooks / prefixes / scriptTools` |
| `stats()` | `seen / allowed / denied / trimmed / trimmedChars` |
| `dispose()` | 撤除两个监听（插件卸载时由 `ctx.effect` 调） |

### 事件接线

```ts
// 结构对位（本包不 import 工具包，只用 unknown 收窄）
tools/pre-execute (exec, next)          → 判 browser_* 工具：红线 / URL 策略 → deny，否则 next()
tools/post-execute(exec, result, next)  → 先 await next()，再裁 accept 里的 text 块
```

## 四、配置

| 字段 | 默认 | 出处 / 理由 |
|---|---|---|
| `enable` | `false` | 默认关：关着时**不拦不裁**，浏览器按宿主配置照常工作 |
| `allowScriptExecution` | `false` | 手册 §16.3 端侧默认只读；`browser_evaluate` 是任意代码执行入口 |
| `allowedSchemes` | `http, https` | `file:` / `javascript:` / `data:` / `chrome:` 一律拒 |
| `allowPrivateHosts` | `false` | `127.0.0.1` / `localhost` / `*.local` 是用户自己的内网 |
| `hostDenyList` | 空 | 整名或后缀，补「知道名字但不在私有网段」的目标 |
| `toolPrefixes` | `browser_, browser-` | 覆盖两种命名习惯；认不出来只是不拦不裁，不影响浏览器 |
| `scriptTools` | 5 个 evaluate/run_code 变体 | 比对时把 `-` 与 `_` 归一 |
| `trimChars` | `4000` | 手册 §10.1：快照 315KB → 5.4KB（400–40000） |
| `trimLines` | `80` | 行预算（10–500） |
| `verbose` | `false` | 每次拦截/裁剪一行日志（不含 URL 原文） |

**没有 `headless` / `endpoint` / `executablePath`**：那些归宿主 provider，本包再存一份就是双真源。

## 五、边界

- **不碰浏览器进程**：本包没有任何 spawn / 端口 / 定时器。它只读一个服务属性、挂两个事件。
- **判定是纯函数**：`check` / `trim` / `judgeTool` 不读 ctx、不写日志、不计数，可以逐条单测。
- **失败方向：护栏出错时放行。** 拦错的代价（浏览器突然不能用、用户以为插件坏了）比漏一次更贵；红线那一条不依赖任何外部状态，所以它在最前面判，出错也拦得住。
- **不进提示词**：不申报提示词片段。
- **不碰会话**：不创建 APP Session、不写 `app_session_log`（§6 禁令 5）。

## 六、已知限制

1. **不提供任何浏览器动作。** `open` / `navigate` / `click` 都不在本包。想用浏览器必须装宿主 provider（`@ntars/ondra-browser-use` + 任一 provider；Playwright 那一路的上游包是 `@playwright/mcp`，宿主钉在 `0.0.80`）。本包的价值是「让这些动作别出事」，不是「让动作发生」。
2. **两个瀑布的签名是结构对位，不是类型导入。** `tools/pre-execute` 的签名由 `@ntars/ondra-tools` 通过模块增强提供，而本仓没有任何插件依赖那个包（禁装依赖）。所以本包用 `ctx.on` 加一次显式窄化转换，参数按 `unknown` 收窄。**上游若改签名，本包不会编译报错，只会静默不生效**——症状是 `status().hooks` 显示已挂上、但拦不住。核对方法：看 `stats().seen` 是否随浏览器调用增长。
3. **工具名靠前缀认。** `browser_` / `browser-` 覆盖 Playwright MCP 与常见的连字符封装。若某个后端用 `browser.evaluate`（点号），本包认不出来——按前缀硬认会误伤别的工具。改法：把该前缀加进 `toolPrefixes`，同时把点号名的工具加进 `scriptTools`（但 `scriptTools` 的比对只归一闪 `-`/`_`，点号仍需整名匹配）。
4. **`not-url` 在批量扫描里不算拒绝。** `browser_type` 的 `text` 是「你好」，它不是 URL。`scanArgs()` 只检查「长得像 URL」的字符串；只有单独调 `check()` 时「不是 URL」才算拒绝（那时意图明确是「去某个地址」）。
5. **URL 只判到「能不能去」，不判「去了能看到什么」。** 登录态、Cookie、页面里的个人信息都不在本包视野内——那是 provider 与 `ondra-privacy`（O-076）的事。
6. **裁剪是「砍尾巴」，不是「摘要」。** 页面快照是一棵树，中间抽条会让父子关系错位。所以只保头；要看被砍掉的部分，请让模型用更具体的选择器再取一次。
7. **`trimChars` 的出厂 4000 是工程判断。** 手册给的是实测结果（315KB → 5.4KB），没有给「该留多少」。4000 字符约 2.5K token，够放一个中等页面的可交互元素；已登记待裁决。
8. **档位〔复〕的依据与待核项。** 手册 §1.8 把「浏览器自动化」归入生态成熟档，§9.11 又记着旧项目的 `browser` 只有 27 行占位。本仓的真实可复用物是宿主那三个 provider（未装依赖、**未实跑**）。故本包抄的是「接线 + 治理」这条路线，不是抄某个仓库的代码；**provider 的实际行为未实证**，登记为待核。
9. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app，全部结论来自静态检查与纯逻辑对拍。

## 七、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 浏览器后端（Playwright MCP） | `microsoft/playwright-mcp`（经宿主 `experimental/browser-use-playwright-mcp` 接线，`@playwright/mcp` 钉在 **0.0.80**） | github.com/microsoft/playwright-mcp | Apache-2.0 | 直接复用：不写一行浏览器协议 | 只读 `ctx.browserUse.providerName` + 挂两个事件 | 否 |
| 浏览器后端（CDP / Stagehand） | 宿主 `experimental/browser-use-chrome-devtools-mcp` / `-stagehand-native` | 仓内 | 见各包 | 同上 | 同上 | 否 |
| 瀑布扩展点 | 宿主 `desktop/packages/core/tools`（`events.ts` / `contracts.ts`） | 仓内 | 见仓库 | `tools/pre-execute` / `tools/post-execute` 的语义与决策形状 | `hooks.ts` 结构对位 | 否 |
| 快照裁剪（315KB → 5.4KB） | `mksglu/context-mode`（手册第九部分 §3-1） | github.com/mksglu/context-mode | 未核（**待核**） | 「原始数据不进上下文」+ 头部保留 | `trim.ts` 行/字符双预算 + 尾部说明 | 否 |
| 用真实已登录浏览器 | `Tencent/BrowserSkill`（手册书签表） | 未给 | 未核（**待核**） | 「后端自带登录态」这件事不该由插件管 | 不接管登录态，交 provider | 否 |
| 工具名硬正则会拒绝 | 手册 §8.4 / §15 | — | — | 名字必须匹配 `^[a-z][a-z0-9_-]{1,63}$` | 服务键、配置键、前缀全部合规 | 否 |

**档位判定〔复〕**：浏览器引擎与协议**一行没写**——Playwright / CDP / Stagehand 全在宿主里，本包只接 `browserUse` 与两个事件。真正自研的只有「红线 + 目标策略 + 裁剪」这三段判定（约 250 行纯函数），它们不属于任何现成包，也不构成「重写浏览器」。

## 八、多方案分支说明

涉及 master-plan §14.3 的**无直接对应项**。本包内部有一处真实的多方案，按 §12 的判定顺序处理：

| 方案 | 处理方式 |
|---|---|
| 后端 A：Playwright MCP | 宿主提供，本包不管 |
| 后端 B：Chrome DevTools MCP | 宿主提供，本包不管 |
| 后端 C：Stagehand | 宿主提供，本包不管 |
| 方案 D：本包自研驱动端口 | **刻意不做**（见限制 1） |

**能融就融**：三个后端对本包而言是同一件事（都是 `browser_*` 工具），所以本包**不做分支**——判定只看「名字前缀 + 参数里的 URL」，与后端是谁无关。这正是「一个接口」的最省形态：不写后端适配层，就不需要为每个后端单独降级。

## 九、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「浏览器动作会不会被拦/被裁」这一件事。`dispose()` 会撤掉两个监听，浏览器本身照常工作；本包没有进程、没有连接、没有定时器。
2. **我的状态存在哪？** **只在内存**：两个监听句柄、五个计数。不落盘任何东西（浏览器上下文一条都不缓存）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.browser`；`status().hooks` 说「挂上了没有」、`status().provider` 说「后端是哪个」；`stats().denied` 按码分桶、`stats().trimmedChars` 说「一共省了多少字」。
4. **我依赖谁？缺席时我怎么降级？** `browserUse`（缺→`no-provider`，护栏空转但服务可用）、`ondra-config-schema`（缺→本地校验）、`ondra-identity`（缺→日志前缀兜底）。三个全软，一个都不 `inject`。
5. **我和同域的谁共享了可变状态？** 没有。O-070 管桌面读数、O-069 管手机，与本包零交集；两个瀑布上本包只处理 `browser_*` 名字，其余一律 `next()` 放行，不碰别人的决策。
