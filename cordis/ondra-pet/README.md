# ondra-pet

> O-074 · L6 端侧 · 档位〔复〕 · 服务键 `ondra-pet` · 状态 **`skeleton`（骨架，能力入口）**

桌宠的**能力入口**：许可证闸门、桥接安全、单实例状态机、渲染档降级在本包；窗口与立绘归上游。

---

## 一、职责

1. **许可证闸门**（`adapters.ts`）：`MIT` / `Apache-2.0` 可接；`AGPL-3.0`（Coopanion）与未知许可一律拒。
2. **桥接安全**（`bridge.ts`，纯函数）：回环地址、`ws`/`wss`、显式端口、URL 内不许夹 token、来源清单不许为空。
3. **单实例状态机**（`state.ts`）：`idle → starting → running → stopping → stopped`，另有 `failed`。
   **`failed` 也允许 `dismiss()`**：`failed` 有两种来源——「还没开窗口就失败了」与「窗口已开但 spawn 返回失败」，后者若不收就成孤儿窗口。
4. **渲染档降级**：`live2d` 如实回 `render-unsupported`，不黑屏。
5. **端口**：`PetBridge`（`spawn` / `stop`），缺实现时装 `MissingBridge`，如实回 `no-bridge`。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 画窗口、画立绘、播动作 | **上游桌宠实现**（`ondra-pet` / `agentpet`，MIT），本包只接线（手册 §6.3「不自研」） |
| Live2D | **1.0 阶段不做**（§6.3：Cubism Core 专有、不可再分发） |
| 语音合成 | O-051 `ondra-tts`；手册 §6.3 说的「语音对话」是她的能力，不是桌宠的 |
| 屏幕检测 | O-070 `ondra-desktop-mcp` / O-072 `ondra-gui-agent`；桌宠只负责「被看见」 |
| 人物可视化面板（9 view） | UI 层（§6.3 末条 → §7.5） |
| 决定「什么时候她该出现」 | **不做**。见下面第 2 条 |

### 四条刻意的「不做」

1. **不注册任何工具。** 「叫出桌宠」是**用户**的动作。给模型一个 `pet-summon`，等于允许它在你屏幕上弹一个窗口，而它会觉得「这时候她出现一下挺好」。器官的边界是「只能提议，不能改世界」（§8.1 C1），开窗口是改世界。所以召唤只在服务对象上，由界面在用户点击后调用。
2. **不做「自动出现」。** 顺带也避开了「工具名手册没给」的编造问题——一个都不注册，就没有名字要编。
3. **不假装她在桌面上。** 没有桥时 `summon()` 回 `no-bridge`，`status().skeleton` 恒 `true`。空壳插件最坏的行为不是「什么都不做」，而是让用户以为她在那儿。
4. **不替调用方关窗口。** `dispose()` 是同步的（`ctx.effect()` 的清理函数），`bridge.stop()` 是异步的。在这里 `void stop()` 会得到一个「看起来收起了、其实还在」的窗口，所以只丢引用并留一条 warn——与第 3 条同一条原则的镜像：不假装收起。

## 三、服务键与方法

```
ondra-pet        ← 连字符，不是带冒号的写法
```

| 方法 | 说明 |
|---|---|
| `summon({ token })` | 叫出（过六道闸）。**永不抛错** |
| `dismiss()` | 收起。没在跑时回 `not-running`（幂等语义，不当错误） |
| `markExited(detail?)` | 外部告知「窗口已关」（用户直接关、或上游崩了），返回状态是否改变 |
| `status()` | 现状（含 `reason` / `state` / `license` / `verified` / `bridge` / `originCount` / `skeleton`） |
| `stats()` | 计数（叫出 / 成功 / 收起 / 被拒 / 无桥 / 已在跑 / 失败 / 外部退出 / 桥调用） |
| `adapters()` | 四个生态实现的登记表（**含不能接的**，理由在 `note` 里） |
| `useBridge(bridge \| null)` | 换桥。**运行中拒绝换**（会丢窗口引用，之后收不掉） |
| `dispose()` | 撤（幂等），不代关窗口 |
| `available` / `reason` / `skeleton` | 三个只读属性 |

### 桥端口

```ts
interface PetBridge {
  readonly id: string
  readonly renders: readonly RenderMode[]        // 本版只应含 'static'
  spawn(options: PetSpawnOptions): Promise<BridgeResult<null>>   // 成功即代表窗口已起
  stop(): Promise<BridgeResult<null>>            // 幂等
}
```

`PetSpawnOptions` 带 `render / bridgeUrl / token / allowedOrigins / tokenTtlMs / alwaysOnTop / scale`。
**`token` 只在这一次调用里存在**：不存字段、不进 `status()`、不打日志。

## 四、配置

| 字段 | 默认 | 出处 |
|---|---|---|
| `enable` | `false` | 端侧默认全关（master-plan §16.3） |
| `adapter` | `ondra-pet` | §6.3 / §1.8 点名首选；`agentpet` 为备选 |
| `render` | `static` | §6.3「Live2D 1.0 阶段不做」→ `live2d` 是**会被拒的值** |
| `bridgeUrl` | `''` | **空 = 不启动**。手册没给任何桥地址，不编默认值 |
| `allowedOrigins` | `[]` | **空 = 全拒**（§9.2） |
| `tokenTtlMs` | `120000` | 一次性 token 的有效期（**工程判断，待裁决**） |
| `allowTokenInUrl` | `false` | 默关闭：URL 会进日志/崩溃报告/浏览器历史 |
| `alwaysOnTop` | `false` | 默认不置顶：盖住用户正在做的事，第一周就会被关掉 |
| `scale` | `1` | 0.5–2。上游各实现「1 倍」口径不一，这是跨实现中立值 |
| `verbose` | `false` | 每次操作一行日志（**不含 token、不回显地址**） |

## 五、边界

- **服务键 / 配置键 / 段键**：`ondra-pet` / kebab 字段名 / 段 `pet`，全部匹配 `^[a-z][a-z0-9_-]{1,63}$`（§8.4）。
- **六道闸只判一次**（`gate()` 一处），`summon()` 与 `status()` 共用：两处各判一遍迟早分叉，而分叉的表现是「面板说可用、一点就失败」。
- **状态迁移只有一张表**（`PET_TRANSITIONS`）：业务代码里不许出现隐式的 `if (state === 'running')` 式改状态。
- **不吃配置里的 token**：`summon` 只认参数。
- **不装定时器**：状态靠上游**推**（`markExited`），没有轮询、没有心跳、没有重连。
- **不进提示词**、**不碰会话**（master-plan §6 禁令 5）。

## 六、已知限制

1. **没有桌宠桥（这是骨架的全部原因）。** 按**能力**查 `desktop/packages/**`（`package.json` 的 name + description 搜 `pet|live2d|sprite`）**0 命中**；本仓禁装依赖，`ondra-pet` / `agentpet` 都不在任何 `dependencies` 里。解除方式：写一个 `PetBridge`（`spawn` 开窗口、`stop` 关窗口），`useBridge()` 接进来即可，**本包不用改一行**。
2. **两个 MIT 实现的 LICENSE 未逐字核对。** 手册 §9.1 写「新仓库 LICENSE 许可需正式确认」，本轮禁联网，所以 `verified: false`，面板显示「MIT（未核对）」。**这不是「许可证友好」，只是「手册这么说的」。**
3. **`tokenTtlMs` 默认 120 秒、`scale` 范围 0.5–2 都无出处**，属工程判断（待裁决）。
4. **「来源清单为空 = 全拒」会让首次启动必然起不来。** 这是刻意的：不填就启动等于不校验 Origin，而 CSWSH 的后果是「随便一个网页都能拿到她的说话通道」。代价是 onboard 多一步（手册 §6.3 也提到「大量用户卡在接扩展」，本包选择宁可卡住也不静默放开）。
5. **`allowTokenInUrl` 打开后会在日志里留下 token。** 那条路径是给「只支持 query 传 token 的桥」的兼容口，打开即接受这个风险；本包仍然不主动打 URL。
6. **`allowedOrigins` 不收 `file:`。** Electron 的 `file://` 页面发出的 `Origin` 是字符串 `null`，不是 `file://`——把 `file:` 放进白名单只会得到一条「填了却永远匹配不上」的配置。`null` 来源要不要放行是**桥**的决定（它才是校验方），本包不替它假装。若你的桌宠是 Electron 包壳，请让桥自己处理 `Origin: null`。
7. **`scale` 只交给桥，本包不做任何换算。** 上游若把 scale 理解成「像素高度」而非倍数，观感会不对——本包无从判断，这是「跨实现中立值」的固有代价。
8. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app；全部结论来自静态检查与纯逻辑对拍。

## 七、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 桌宠本体 | `PC2005-cloud/ondra-pet`（大肥鱼） | github.com/PC2005-cloud/ondra-pet | MIT（**手册转述，未逐字核对**） | 手册 §6.3 / §1.8 点名为首选；「省 token + 语音对话 + 屏幕检测」 | 只做 `PetBridge` 端口接线，不引入代码 | 否 |
| 桌宠本体（备选） | `ntd4996/agentpet` | github.com/ntd4996/agentpet | MIT（同上） | 同上 | 同上 | 否 |
| 桌宠（禁止） | `Pal-AI-Lab/Coopanion` | github.com/Pal-AI-Lab/Coopanion | **AGPL-3.0** | **只读思路** | `adapters.ts` 里标 `reusable:false`，`summon()` 直接拒 | 否 |
| 桌宠（许可未明） | `airi` | 手册 §6.3 只给名字与星数 | **未知** | — | 按 §9.1「核实前按只读思路」，标 `reusable:false` | 否 |
| 桥接安全 | 手册 §9.2（CSWSH：`coopanion-connector-ondra <0.2.9` 漏洞） | — | — | 「Origin + 一次性 token」两条 | `checkBridgeUrl` / `checkOrigins` / `checkToken` 三个纯函数 | 否 |
| Live2D 边界 | 手册 §6.3（Cubism Core 不可再分发） | — | — | 「1.0 阶段不做，静态降级」 | `render` 枚举 + `render-unsupported` 拒绝 | 否 |
| 三端「不是同一只鱼」痛点 | 手册 §6.2 与语料庚-7 | — | — | 「多端各是一只，用户分不清」 | 引申为**单实例**规则（桌面上只允许一只） | 否 |
| 配置段注册 / KEY_PAIRS | 本项目 O-005 / O-035 / O-057 | 自有 | 自有 | 「camel 与 kebab 双向唯一映射」 | 照抄 `KEY_PAIRS` 模式 | 是（自有资产） |

**档位判定〔复〕与实测的差异**：台账标〔复〕，思路是「复用 ondra-pet / agentpet」。但本仓既没有它们的代码、也禁装依赖，所以「复用」在本轮只能落到「**端口形状 + 许可证与安全闸门**」，真正自写的部分是闸门与状态机（不属于任何现成包）。若主人裁定要真接，需新增一条依赖白名单——超出本轮边界，**未自行决定**。

## 八、多方案分支说明

master-plan §14.3 的已知多方案项**无对应项**。本包内部两处差异，都按「能融就融」处理：

| 能力 | 方案 A（默认） | 方案 B | 处理 |
|---|---|---|---|
| 桌宠实现 | `ondra-pet`（手册首选） | `agentpet` | **融合**：同一个 `PetBridge` 接口，`adapter` 只换配置不改代码 |
| token 传递 | 参数传入（`summon({token})`） | URL query | **兼容层**：默认参数传入；`allowTokenInUrl` 显式打开才接受 query，并明确告知「会进日志」 |

## 九、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「她能不能出现在桌面上」。`dispose()` 丢掉桥引用；本包没有定时器、没有 socket、没有监听端口（端口归桥）。
2. **我的状态存在哪？** **只在内存**：状态、桥引用、计数。**不落盘任何东西**，包括 token（用完即弃）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.pet`；`status().reason` 区分 `disabled`（用户关的）/ `adapter-unusable`（许可证不让接）/ `render-unsupported` / `bridge-unset` / `bridge-url` / `origin-unset` / `no-bridge`（缺施工件）——**七值分开**，因为它们的排查方向完全不同；`skeleton` 恒 `true`。
4. **我依赖谁？缺席时我怎么降级？** `ondra-config-schema`（缺→本地校验）、`ondra-identity`（缺→日志前缀兜底）、桌宠桥（缺→`no-bridge`）、上游桌宠进程（缺→起不来，如实报）。四个全软，一个都不 `inject`。
5. **我和同域的谁共享了可变状态？** 没有。与 O-068（读短信）、O-069（手机只读）、O-070（电脑只读）、O-071（浏览器护栏）、O-072（GUI）、O-073（Minecraft）能力完全不重叠；与 O-054 `ondra-avatar` 的分工是「立绘图片」对「桌面窗口进程」，本包不读 `ondra-avatar` 的任何数据。

## 十、与文档的口径差异（必须留痕）

1. **master-plan §17 第 2 条写「桌宠砍掉」，手册正文已改。** 手册的修订表把它改成「保留为能力入口，按需启用 / 复用生态桌宠（ondra-pet、agentpet，MIT）」，理由在手册 §5-11：B 站「桌宠」词频 38 > 「记忆」32，且本地桌宠已能省 token。按「手册优先」，本包按**能力入口**做，未按「砍掉」做。**未改 master-plan**（不动其他文档）。
2. **台账职责列只有「复用 ondra-pet / agentpet（MIT），不自研」一句**，没有参数、没有安全口径。本包的六道闸与三个纯函数都是按手册 §9.2 / §9.1 / §6.3 推出的施工要求，出处逐条写在代码注释里；**推不出来的一律标「待裁决」**（见「六」第 3 条）。
