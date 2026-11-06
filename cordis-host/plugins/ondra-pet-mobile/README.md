# ondra-pet-mobile

> O-075 · L6 端侧 · 档位〔复〕 · 服务键 `ondra-pet-mobile` · 状态 **`skeleton`（骨架，能力入口）**

三端技术前提的**能力入口**：七条前提、四值判定、绑定簿、中继端口在本包；手机客户端与中继实现都不在。

---

## 一、职责

1. **前提清单**（`prereq.ts`）：七条，每条带出处与「该做什么」，可 `check()` 逐条判定。
2. **四值判定**：`pass` / `fail` / `unverifiable` / `unshipped`——**不用布尔**，见「四」。
3. **绑定簿**（`bindings.ts`）：三端 ↔ peer 的映射；同端换人、同人跨端**一律拒绝**。
4. **中继地址判据**（`bridge.ts`）：`ws`/`wss` + 显式端口；**跨设备必须 `wss`**。
5. **端口**：`PetMobileBridge`（`connect` / `disconnect`），缺实现时装 `MissingRelay`，如实回 `no-bridge`。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 手机客户端 / 移动端窗口 | **不做**。手册 §1.11-07：手机端「即将适配」 |
| 记忆本体 | O-010 `ondra-memory-core`（本包只判「在不在」） |
| 桌宠窗口 | O-074 `ondra-pet`（本包只读它的 `status().state`） |
| WS 中继实现与帧格式 | **桥的实现方**。本仓无中继、无帧依据（同 O-058 的处理） |
| QQ / 微信接入 | O-055 ~ O-067 通道层 |
| 本机 HTTP 服务 | 上游 `ctx.webServer`（`desktop/packages/host/webserver`） |

### 四条刻意的「不做」

1. **不做移动端窗口。** 一个还没发布的形态，插件里先做出来只会得到「装了但什么都没有」——比不做更差，因为它会让人以为已经支持了。
2. **不定义帧格式。** 手册只给端口（3000 / 3001），一个字节的协议依据都没有。端口只有 `connect` / `disconnect`，连帧的形状都不定，免得后来的人以为「这里已经有协议了」。
3. **不注册工具。** 三端互通是基础设施：让模型「连一下中继」没有任何意义，而它多一个工具就多一份误触面。
4. **不把「判不了」写成「没问题」。** 两侧 token 是否一致，本包只在一侧——它标 `unverifiable`，不阻塞也不假装通过。

## 三、服务键与方法

```
ondra-pet-mobile        ← 连字符，不是带冒号的写法
```

| 方法 | 说明 |
|---|---|
| `prerequisites()` | 七条前提（静态定义，含 `source` 出处与 `hint`） |
| `check()` | 逐条判定，返回 `PrereqReport`（`ready` / `passed` / `blockers` / `warnings` / `all`）。**永不抛错** |
| `bind(platform, peerId)` | 绑一个端（`pet` / `qq` / `wechat`） |
| `unbind(platform)` | 解绑 |
| `bindings()` / `bindingOf()` / `peers()` | 查绑定 / 查某个端 / 去重的 peer 集合 |
| `connect()` / `disconnect()` | 连 / 断中继。前提不齐时 `connect()` 回**具体**的闸门码（`disabled` / `memory-missing` / `bridge-unset` / `bridge-url` / `origin-unset` / `no-bridge`），不笼统回一个「未就绪」 |
| `status()` / `stats()` | 现状 / 计数 |
| `useBridge(bridge \| null)` | 换中继桥。**连着时拒绝换** |
| `dispose()` | 撤（幂等） |
| `available` / `reason` / `skeleton` | 三个只读属性 |

### 七条前提

| id | 必需 | 判定依据 | 出处 |
|---|---|---|---|
| `memory-single-source` | ✅ | `ctx.get('ondra-memory-core')` | 手册 §6.2 / 语料庚-7 |
| `pet-entry` | ✅ | `ctx.get('ondra-pet')` | 手册 §6.3 |
| `local-api` | ✅ | 上游 `webServer` 在位 + 端口不与中继冲突 | 语料庚-5/庚-7「HTTP 3000」 |
| `ws-bridge` | ✅ | 桥已注入 + `relayUrl` 已配 + 端口合法 | 语料「WS 3001」+ §9.2 |
| `origin-check` | ✅ | `allowedOrigins` 非空 | §9.2（CSWSH） |
| `token-consistency` | — | **`unverifiable`**（只在一侧） | 语料庚-7 三坑之三 |
| `mobile-client` | — | **`unshipped`**（恒 false） | §1.11-07「即将适配」 |

`ready = 五条必需项全 pass`。**手机端不计入 `ready`**：若计入，这个值会永远为 `false`，面板上就是一句没人能执行的「不可用」——那正是 §17-6 说的假开关。手机端单独用 `status().mobileShipped`（恒 `false`）表示。

### 中继端口

```ts
interface PetMobileBridge {
  readonly id: string
  connect(options: RelayOptions): Promise<BridgeResult<null>>    // RelayOptions: relayUrl / allowedOrigins / apiPort
  disconnect(): Promise<BridgeResult<null>>                      // 幂等
}
```

**没有 `send()`**：帧形状无依据，定了就是编。

## 四、为什么判定是四值

| 值 | 含义 | 阻塞 `ready` | 面板怎么显示 |
|---|---|---|---|
| `pass` | 本包能确认成立 | — | 通过 |
| `fail` | 本包能确认不成立 | ✅（仅必需项） | 阻塞 + 指路 |
| `unverifiable` | **结构上判不了** | ❌ | 提醒「你需要自己确认」 |
| `unshipped` | 东西还没发布 | ❌ | 提醒「等发布」 |

把 `unverifiable` 压成 `false`：用户会去修一个本来没坏的东西（改 token、重装中继），而真正的问题在另一侧。
压成 `true`：用户以为配好了，然后在三端看到三份记忆。两种都比「说出来」差。

## 五、配置

| 字段 | 默认 | 出处 |
|---|---|---|
| `enable` | `false` | 端侧默认全关（master-plan §16.3） |
| `platforms` | `[]` | **空 = 一个端都不接**（不是「全接」） |
| `apiPort` | `3000` | 手册语料的链路原文「HTTP API 监听 3000 端口」 |
| `relayUrl` | `''` | 空 = 不连。地址由用户的中继提供，不编 |
| `allowedOrigins` | `[]` | **空 = 全拒**（§9.2） |
| `verbose` | `false` | 每次操作一行日志（不回显地址） |

## 六、边界

- **服务键 / 配置键 / 段键**：`ondra-pet-mobile` / kebab 字段名 / 段 `pet-mobile`，全部匹配 `^[a-z][a-z0-9_-]{1,63}$`（§8.4）。
- **前提判定只有一处**（`prereq.ts` 的纯函数）：`check()` 与 `index.ts` 的启动日志共用，不各写一份。
- **上游探测每次现取**（四个闭包注入）：缓存会让「刚装好的 O-010」一直显示缺。
- **不落盘**：绑定关系、连接状态、计数全在内存。
- **不装定时器**：没有轮询、没有重连；`check()` 是调用方显式触发。
- **不进提示词**、**不碰会话**（master-plan §6 禁令 5）。

## 七、已知限制

1. **没有 WS 中继实现（这是骨架的一半原因）。** 本仓无三端中继、无帧格式依据、禁装依赖。解除方式：写一个 `PetMobileBridge`，`useBridge()` 接进来，**本包不用改一行**。
2. **手机客户端不存在（另一半原因）。** 手册 §1.11-07 原话「手机标『即将适配』」。`mobileShipped` 恒 `false`，`mobile-client` 恒 `unshipped`。
3. **`token-consistency` 永远判不了。** 这是设计而非缺陷：本包只在一侧，比对两侧 token 需要两侧都开口。它标 `unverifiable` 并给出「别点重新生成」的动作。
4. **`LOOPBACK_HOSTS` 与 O-074 各有一份。** §18.5 禁止同轮互相 import，所以是**逐字镜像**而非共享；一处改动要手工同步两处（本条即为同步检查点）。
5. **`PetLike` / `WebServerLike` 是结构对位，不是真类型。** 上游改签名后要手工同步；代价是换掉「因缺类型而 import 宿主包」的风险（本仓禁装依赖）。
6. **`apiPort` 是否真被 `webServer` 监听，本包不知道。** 上游 `webServer` 的端口由宿主决定，本包只判「它存在」与「不与中继撞号」。真实端口可能不是 3000——这时 `apiPort` 只是一个**给用户看的约定值**。
7. **`allowedOrigins` 只判非空，不判格式。** Origin 匹配是桥侧行为，本包判「有没有配」这一件它能判的事；格式错会在桥那边失败。
8. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app；全部结论来自静态检查与纯逻辑对拍。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 三端记忆互通方案 | 手册语料庚-7（surfcore 模式：读本地日志 + 记忆卡） | — | — | 「三端各是插件、记忆不共享」的痛点与链路形状 | 只把链路**前提**钉成清单，不做同步机制 | 否 |
| 本地 HTTP 出口 | 上游 `desktop/packages/host/webserver` | 本仓 | 自有 | `ctx.webServer: WebServer` 唯一提供方 | 只判存在（`hasWebServer()`），不注册路由 | 否（同仓只读） |
| WS 桥接安全 | 手册 §9.2（`coopanion-connector-ondra <0.2.9` CSWSH） | — | — | 「Origin + 一次性 token」 | 来源清单非空 + 跨设备强制 `wss` | 否 |
| 端口冲突判据 | 手册语料「3000 / 3001」两个端口 | — | — | 「两个服务不能抢同一个监听口」 | `portConflict` 事实 + `local-api` 阻断 | 否 |
| 配置段注册 / KEY_PAIRS | 本项目 O-005 / O-035 / O-057 / O-074 | 自有 | 自有 | camel 与 kebab 双向唯一映射 | 照抄 `KEY_PAIRS` 模式 | 是（自有资产） |
| 四值判定（判不了就说判不了） | 本项目 O-136 的 `MatchKind` / O-072 的 `unknown` 表单态 | 自有 | 自有 | 「不把不确定压成确定的」 | `PrereqVerdict` 四值 | 是（自有资产） |

**档位判定〔复〕与实测的差异**：台账标〔复〕（复用生态），但「三端互通」在生态里的实现（surfcore 记忆卡）是**另一套产品**，本仓既无其代码也无许可核对，不能引入。所以「复用」在本轮落到「**复用上游 `webServer` 能力 + 前提清单化**」，真正自写的是判定与绑定簿。若主人裁定要真接中继，需新增依赖或新增一个外部进程对接方案——超出本轮边界，**未自行决定**。

## 九、多方案分支说明

master-plan §14.3 的已知多方案项**无对应项**。本包内部一处真分支：

| 能力 | 方案 A（默认） | 方案 B | 处理 |
|---|---|---|---|
| 中继传输 | 端口 + `MissingRelay`（默认） | 接一个 WS 中继实现 | **能兼容就兼容**：同一 `PetMobileBridge` 接口，换实现不改本包；帧格式归实现方 |

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「三端能不能共享同一份记忆」。`dispose()` 清空绑定簿、丢掉桥引用；没有定时器、没有 socket、不监听端口。
2. **我的状态存在哪？** **只在内存**：绑定簿、连接标志、计数。**不落盘任何东西**（token 从不经过本包）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.pet-mobile`；`status().reason` 区分 `disabled` / `memory-missing` / `bridge-unset` / `bridge-url` / `origin-unset` / `no-bridge`——**六值分开**，排查方向各不相同；`skeleton` 恒 `true`；`check()` 给出逐条阻塞。
4. **我依赖谁？缺席时我怎么降级？** `ondra-memory-core`（缺→`memory-missing`）、`ondra-pet`（缺→`pet-entry` 不通过，但**仍可 check**）、`webServer`（缺→`local-api` 不通过）、`ondra-config-schema`（缺→本地校验）、`ondra-clock`（缺→`Date.now`）、`ondra-identity`（缺→日志前缀兜底）、中继桥（缺→`no-bridge`）。七个全软，一个都不 `inject`。
5. **我和同域的谁共享了可变状态？** 没有。与 O-074 的分工是「桌宠窗口」对「三端映射」：本包只读 O-074 的状态串，不调它的任何动作、不共享任何可变对象；与 O-068 ~ O-073 能力完全不重叠。

## 十一、与文档的口径差异（必须留痕）

1. **台账九个字里没有参数。** 「占位，钉住三端技术前提」——七条前提全部从手册 §6.2 / §6.3 / §9.2 / §1.11-07 与语料庚-5/庚-7 推出，逐条写在 `PREREQUISITES.source` 里；**推不出来的不编**（例：中继鉴权方式、帧格式、手机端形态）。
2. **`apiPort` 默认 3000 是「链路约定」而非「已核实事实」。** 上游 `webServer` 的真实端口由宿主决定，本包无从读取（`WebServerLike` 刻意不声明成员）。这条写进「六」第 6 条。
3. **master-plan §17 第 2 条仍写「桌宠砍掉」**，手册正文已改成「保留为能力入口」。本包按手册做能力入口，**未改 master-plan**。
