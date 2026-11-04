# ondra-gui-agent

> O-072 · L6 端侧 · 档位〔研〕 · 服务键 `ondra-gui-agent`

图形界面的**单步决策环**：判一步、发一票、执行一下、记一笔。它不自己截屏，也不自己点鼠标。

---

## 一、职责

1. **单步判定**：`plan()` 一次只接一个动作（`observe` / `click` / `type` / `key`），没有批量入口。
2. **三层安全网**（缺一层等于没有）：

   | 层 | 闸门 | 手册/主纲依据 |
   |---|---|---|
   | 一 | 危险区黑名单（归一化矩形 0–1） | master-plan §5「检测到已填表单立即收手」同段的「写操作逐条确认」 |
   | 二 | App 白名单（**空 = 一个都不许**） | master-plan §16.3「独立权限声明、默认全关」 |
   | 三 | 确认阈值 + 每日预算 + 限频 | master-plan §9.11（旧实现的 `dailyBudget` 只有注释） |

3. **表单红线**：`formState='filled'` 直接拦；`unknown` 时**只把 `type` 升级为需确认**。
4. **风险四级**：`readonly` / `low` / `high` / `blocked`。`observe` 恒为 `readonly` 且不进确认阈值。
5. **票务**：确认票**一次即焚**，票里锁着那一条请求（批准的是「那一下点击（x,y）」，不是「点击」这个能力）。
6. **审计**：JSONL 落 `user/gui-audit.jsonl`（0600，超 2MB 轮转一份），内存另留一份环形缓冲。
7. **审计脱敏做成类型**：`AuditEntry` 没有正文字段，只有 `textChars`；坐标量化到 10 像素网格。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 截屏、合成鼠标/键盘事件 | **`GuiRunner` 的实现方**（见「六、已知限制」1） |
| 批准确认票 | **宿主 / 界面**（模型侧没有 `gui-approve` 工具，见限制 2） |
| 决定「该不该让 AI 操作这台电脑」的全局策略 | `ondra-privacy`（O-076）+ 分级自动审批三档（手册 §8.7，全局配置） |
| 看懂屏幕内容、找到按钮在哪 | 视觉通道 / 上层模型；本包只收坐标 |
| 读电脑进程 / 前台窗口 / 剪贴板 | `ondra-desktop-mcp`（O-070，只读） |
| 浏览器页面里的操作 | `ondra-browser`（O-071，护栏 + 宿主 provider） |
| 手机端 | `ondra-adb`（O-068）/ `ondra-device-mcp`（O-069） |
| 常驻观察、定时轮询屏幕 | **不做**。那会把只读插件变成常驻后台服务（master-plan §12.4），且截屏是最贵的隐私动作 |

### 四条刻意的「不做」

1. **不做批量规划**。`plan()` 没有 `steps[]`。批量入口一定会被用来「一次规划十步再连着执行」——那就不是单步了。
2. **失败不退票**。退票会让「点失败→再点一次」成为绕过限频与预算的通道；而失败往往比成功更密集。
3. **不做「自动批准低风险」的开关**。三档审批是全局配置（手册 §8.7），本包只提供 `confirmThreshold` 一个阈值，不自己发明第二套档位。
4. **不把截图路径交出去**。路径里带用户名与项目名，而观察正文会进模型上下文。

## 三、服务键与方法

```
ondra-gui-agent        ← 连字符，不是带冒号的写法
```

| 方法 | 说明 |
|---|---|
| `descriptors()` | 开着的工具描述（`gui-observe` 的 `mutates` 为 `false`，其余为 `true`） |
| `invoke(tool, args?)` | 调一个工具，**永不抛错** |
| `observe(timeoutMs?)` | 看一眼，返回 `ObserveResult`（会更新「最近一次观察」） |
| `plan(request)` | 规划一步，返回 `{ decision, ticket }` |
| `approve(ticketId)` | **只给宿主/界面**：批准一张待确认票 |
| `deny(ticketId)` | 否决一张票（销毁） |
| `act(ticketId)` | 执行一张票，**一次即焚** |
| `lastObservation()` | 最近一次观察（没有为 `null`） |
| `audit(limit?)` | 审计（倒序） |
| `useRunner(runner \| null)` | 换后端（`null` 装回 `NoRunner`） |
| `useRegistrar(fn \| null)` | 换注册器（`null` 会撤掉全部已注册工具） |
| `useAuditSink(sink \| null)` | 换审计出口 |
| `status()` / `stats()` | 现状 / 计数 |

### 后端端口

```ts
interface GuiRunner {
  readonly id: string
  readonly supports: readonly ActionKind[]      // 必须含 'observe'，否则判 no-runner
  observe(timeoutMs: number): Promise<RunnerResult<Observation>>
  act(input: RunnerActInput, timeoutMs: number): Promise<RunnerResult<RunnerOutcome>>
}
```

实现方三条硬要求：`act()` **只做一下**（不许内部重试、不许连点）、失败回 `ok:false` 不抛错、坐标是**整屏像素左上原点**。

## 四、配置

| 字段 | 默认 | 出处 |
|---|---|---|
| `enable` | `false` | §16.3：端侧默认全关 |
| `enabledTools` | `['observe']` | **出厂只许看**：先让它看见，再决定给不给手 |
| `maxRisk` | `high` | 允许的最高风险 |
| `confirmThreshold` | `high` | 打字、按键必须人点头 |
| `appAllowList` | `[]` | **空 = 全集拒**，不是忘配 |
| `dangerZones` | 菜单栏 / 窗口红绿灯 / Dock 三条 | 归一化 0–1，换分辨率不错位 |
| `formRedLine` | `true` | 「检测到已填表单立即收手」 |
| `observationTtlMs` | `30000` | 工程判断（**待裁决**） |
| `stepIntervalMs` | `1500` | 工程判断（**待裁决**） |
| `dailyBudget` | `200` | 工程判断（**待裁决**） |
| `confirmTtlMs` | `120000` | 工程判断（**待裁决**） |
| `observeTimeoutMs` | `5000` | 本地操作，够用 |
| `actTimeoutMs` | `10000` | 留首次「辅助功能」授权弹窗的余量 |
| `textMax` | `500` | 再长的内容该走粘贴 |
| `auditKeep` | `200` | 内存环条数 |
| `auditFile` | `true` | 落 `user/gui-audit.jsonl` |
| `verbose` | `false` | 每次判定一行日志（不含坐标与正文） |

## 五、边界

- **工具名**：`gui-observe` / `gui-click` / `gui-type` / `gui-key`，全部匹配 `^[a-z][a-z0-9_-]{1,63}$`（§8.4）。
- **按键名形状白名单**：`^[a-z][a-z0-9-]{0,23}$`。这个形状同时满足「人读得懂」与「不可能被拼成脚本注入」（没有引号、分号、空格、反斜杠）。
- **只调一次 `decide()`**：`plan()` 与「执行前复查」共用 `policy.decide()`，不各写一份（O-028 的教训）。
- **不进提示词**：本包不申报提示词片段。
- **不碰会话**：不创建 APP Session、不写 `app_session_log`（master-plan §6 禁令 5）。
- **不装定时器**：全程无 `setInterval`；限频与过期都是「查询时现算」，卸载即彻底消失。

## 六、已知限制

1. **没有截屏与合成事件的实现（本轮最大的一条）。** 手册与 master-plan 只说了旧项目**用了** `screencapture` 与 `osascript`，**没给**具体命令、参数、权限声明与返回格式；本仓仅有 `@ntars/ondra-native-command` 这个**库**（提供无 shell 跑原生命令），它没有服务键、且本仓禁止跨包 import 与装依赖。硬凑一版的坏形态是「能截屏、能点，但点击永远落空」——与「没接」同形。故 `NoRunner` 如实报 `no-runner`。解除方式：实现 `GuiRunner` 后 `useRunner()`，不改本包。
2. **`approve()` 只给宿主/界面。** 模型侧没有对应工具，也没有任何一个工具会调它。若宿主把 `approve` 也接成了工具，分级审批会退化成自问自答（纪律 31）。**这是本包最需要下游遵守的一条约定。**
3. **时钟不给 `dayKey` 时预算按进程算。** 本包不自己算自然日（时区与跨零点会错），而是把口径退化成 `session` 并由 `status().budgetScope` 如实报出去。装载时会 warn 一次。
4. **`formState` 依赖后端检测。** 多数后端拿不到「表单是否已填」，只能报 `unknown`。此时 `type` 全部需要确认——比拦错安全，但会让首次使用显得很啰嗦。
5. **出厂危险区是「屏幕边缘」三条**，与窗口内容无关，所以不会误伤正常按钮，但也拦不到「网页里的删除按钮」。要更细的拦截请按自己的布局加 `dangerZones`（归一化坐标），或靠 App 白名单把危险 App 整个排掉。
6. **`confirmThreshold` 与手册 §8.7 的三档不是一回事。** §8.7 的「监督 / 自动 / 全自动、`organ_*` 算自己人」被点名归 `ondra-privacy` / `ondra-startup-check` 一级的**全局配置**。本包只实现「一个动作要不要确认」这一层判定；若要接三档，由全局策略把档位换算成 `maxRisk` + `confirmThreshold` 传进来，**不要在本包加第二个档位字段**。
7. **四个工具名是本轮自定。** 手册与 master-plan 都没有给 gui-agent 的工具名（旧项目是壳内部调用）。已登记待裁决。
8. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app；全部结论来自静态检查与纯逻辑对拍。

## 七、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 单步决策环、写操作逐条确认、表单红线 | 手册 §5 L6 边界铁律 | — | — | 三句职责 | `policy.ts` 十一级判定 + `loop.ts` 票务 | 否 |
| 风险分级必须能返回 `readonly` | master-plan §9.11（旧实现缺陷） | — | — | 「观察被当成写」这个具体缺陷 | `baseRiskOf()` 让 `observe` 恒 `readonly`，且不进确认阈值 | 否 |
| `dailyBudget` 真计量 | master-plan §9.11（旧实现只有注释） | — | — | 「注释不等于实现」 | `loop.ts` `budget()` + `noteAct()` | 否 |
| 分级自动审批三档（监督/自动/全自动） | `digital-life-core`（手册第 12 部分 §13 转述） | — | 未核（**待核**） | 「高风险弹确认、低风险直接执行」的分层直觉 | 只取「阈值」这一层（`confirmThreshold`），三档归全局配置 | 否 |
| 审批卡要显示真实目标、授权一次性 | 手册第三部分「危险操作的审批闸门」 | — | — | 「授权每次都是一次性」 | 票一次即焚 + 票里锁请求 | 否 |
| 工具名与参数名必须能进 Function Calling | 手册 §8.4（v0.9.2 事故） | — | — | 命名正则与「本地先拦」 | `NAME_RE` / `KEY_RE` 形状白名单 | 否 |
| 工具注册的 PENDING 风险 | 本项目 O-036 / O-069 / O-070 | 自有 | 自有 | 「不声明 inject、注册走注入」 | `useRegistrar()` | 是（自有资产） |
| 超时后仍要接住落下的 Promise | 本项目 O-060 / O-067 | 自有 | 自有 | 「交棒」而非「race 后不管」 | `runWithTimeout()` 先挂 catch 再赛跑 | 是（自有资产） |

**档位判定〔研〕**：生态里有 GUI 自动化类项目（`pyautogui` 系、AppleScript 封装、各家的 computer-use 框架），但**本仓没有**它们的接口与许可证核对结论；且它们都以「常驻服务 / 库调用」形态提供，与「插件包 + 端口 + 治理层」形态不合。本包的核心价值是**单步环 + 三层安全网 + 审计**这一层治理逻辑，任何现成包都不提供。故按台账〔研〕执行；读屏与合成事件本身不实现（端口化），**没有**自研协议或渲染。

## 八、多方案分支说明

涉及 master-plan §14.3 的**无直接对应项**。本包内部三处多来源，按 §12 处理：

| 能力 | 方案 A（默认） | 方案 B | 处理 |
|---|---|---|---|
| 截屏 | `GuiRunner.observe()`（端口） | — | 只有端口一个形态；不自研 |
| 合成事件 | `GuiRunner.act()`（端口） | — | 同上 |
| 表单检测 | 后端报 `formState` | 后端不报（→ `unknown`） | 能融就融：一个字段三态，`unknown` 走独立分支（只升级 `type`） |
| 审计出口 | 内存环 + JSONL（默认） | `useAuditSink()` 外送 | 能兼容就兼容：两个出口同时生效，不互斥 |

## 九、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「模型能不能操作这台电脑」。`dispose()` 会撤掉全部已注册工具；本包没有定时器、没有连接、没有端口占用，不落任何运行态状态（审计文件是留痕，不是状态）。
2. **我的状态存在哪？** 内存：待确认票、限频时刻、预算计数、最近一次观察、内存审计环。磁盘：`user/gui-audit.jsonl`（0600，仅留痕）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.gui.agent`；`status().reason` 给 `disabled` / `no-runner`；`stats()` 按码分桶（`blocked` / `throttled` / `budgetHit` / `timeouts` / `noRunner` / `auditFailed`）。
4. **我依赖谁？缺席时我怎么降级？** `ondra-config-schema`（缺→本地校验）、`ondra-clock`（缺→`Date.now`，且预算退成 `session` 口径）、`ondra-path-layout`（缺→审计只留内存）、`ondra-identity`（缺→日志前缀兜底）、注册器与后端（缺→服务可用但模型看不见工具 / 判 `no-runner`）。六个全软，一个都不 `inject`。
5. **我和同域的谁共享了可变状态？** 没有。与 O-070（只读电脑能力）、O-071（浏览器护栏）能力不重叠：那两者不产生写动作，本包不读系统信息。
