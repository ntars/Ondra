# 插件健康巡检台账

> 单实例锁：`.workbuddy/locks/plugin-health.lock`（90 分钟自动失效）。
> 每轮巡检结束必须删除，不留下会影响下一轮的残留。
> 判定口径见 `automation` 约定：停用项只有 **设计关闭** 与 **待修** 两种结论，
> 后者必须当轮写清理由与下一步。

## 轮次记录

| 轮次时间 | 仓库包数 | 已装载 | 停用段 | 自检 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 2026-11-12 02:13 | 78 | 45 | 26 | 23/23 绿（其中 9 条需 `CODEBUDDY_SAFE_DELETE_ENABLED=0`） | 达标 |
| 2026-11-12 03:11 | 78 | 45 | 26 | 23/23 绿 | 达标（修 TTS 死链 1 处） |
| 2026-11-12 04:37 | 78 | 45 | 26 | 24/24 绿（新增 `check:voice`） | 达标（修语音归因 1 处，新增回归网） |
| 2026-11-12 05:56 | 78 | 45 | 26 | 未跑完 | **中断**（06:05 半成品退出，未写记录、未删锁） |
| 2026-11-12 08:16 | 78 | 45 | 26 | 25/25 绿 | 达标（修 `turnEmotive` 残留 + C 段假绿） |
| 2026-11-12 09:41 | 78 | **48** | 26 | 27/27 绿（新增 `check:plugins`、`check:intake-switch`） | 达标（修 3 处：插件状态谎报、兜底后端未装载、记忆开关失效） |
| 2026-11-12 11:02 | 78 | **48** | 26 | 26/26 绿（新增 `check:no-reason`；`check:plugins` 扩 D 段） | 达标（修 4 处：兜底常量撞去重、两处假开关、装载数三处不一） |
| 2026-11-12 13:20 | 78 | **48** | 26 | 29/29 绿（新增 `check:order`；`check:plugins` 扩 E 段） | 达标（修 3 处：开关空响、备用存储取不到、无标点长句静默） |
| 2026-11-12 14:18 | 78 | 48 | 26 | 31/31 绿（`check:plugins` 扩 F 段） | 达标（修 1 处：唯一未登记配置段的插件；新增回归网） |
| 2026-11-12 15:16 | 78 | 48 | **27** | 29/29 绿（新增 `check:logfmt`；`check:plugins` 扩 G 段） | 达标（修 7 类：两个「出厂关闭却没有开关」的包、`maxFacts` 恒覆盖、10 处精度占位符、6 处 `after` 缺声明、1 处假红） |
| 2026-11-12 16:15 | 78 | 48 | **27**（`store-json` 进清单，第 11 轮实机首现） | **31/31 绿**（新增 `check:stale`） | 达标（修 3 处：语音闸门两行假告警、`proactive-quota` 日志说反话、`ondra-core` 注释把 75 写成 134；**首次出包并让修复真正上机**） |
| 2026-11-12 19:50 | 78 | **75 + 常驻 3 = 78** | **0**（用户 17:26 手动打开 30 个包） | 29 项 pnpm + `check-ui` + `check-acceptance` + `check-contrast` 全绿（新增 `check:defaults`；`check:order` 扩 D 段） | 达标（修 4 处：两个默认值过不了自己的 pattern、四处 `after` 漏声明、装配器开关空响；**修复未上机**，前端正在编辑故未出包） |
| 2026-11-12 20:51 | 78 | **78**（全部 enabled + loaded） | **0** | 30 项 pnpm + `check-ui` + `check-acceptance`(90/90) + `check-contrast`(66/66) 全绿（新增 `check:filter`；`check:order` D 段扩到 7 条） | 达标（修 3 处：深色第二真源、三条假告警、**删句链压平段落**；出包 2 次并上机复核） |
| 2026-11-12 22:25 | 78 | **78** | **0** | 32 项 pnpm + `check-ui`（✗ 0）+ `check-acceptance`(90/90) + `check-contrast`(66/66) 全绿（`check:order` D 段 7 → **16 条**） | 达标（修 9 处 `after` 与装配期同步取值不一致，含 1 处假开关、1 处可真发作的顺序反转；出包 3 次上机复核，启动告警 8 → 7） |

### 第 1 轮（2026-11-12 02:13）

**基线对照**：78 − 45 = 33 未装载；26 个停用段与首轮采集完全一致，无新增。
`plugins.json` 的 `disabled` 仅 `desktop-bridge` 一项，属设计如此（Tauri 壳直连，
宿主内桥接不参与；`/api/plugins` 对该项如实返回 `loaded:false`）。

**当轮唯一红项**：`check:e2e`（主动开口端到端）第 3 段「判定放行」被
`code=quiet-hours` 拦下。根因不在测试，也不在门控逻辑，而在**用户层配置
从未进入插件**：

1. `settings.json` 存的是段字段键（kebab，如 `quiet-start`）；
2. cordis 装载插件时先用插件导出的 `Config['~standard'].validate(config)` 过一遍；
3. 各插件的 `validate` 就是 `completeConfig(value)`，而 `completeConfig` 只读
   camel 键（`quietStart`）——64 个 `settings.ts` 逐个查过，**没有一个读 kebab**；
4. 于是整份用户配置被静默打回出厂默认，`apply()` 收到的已是默认值。

症状形态是最难查的一类：设置页滑杆能拨、能存、重启能读回，插件行为永远停在
默认值，两侧都不报错。

**修复**：在注入这一处一次性归一（`cordis-host/index.ts` 的
`buildMemberConfigs` → 新增 `camelizeKeys`），而不是改 70 多个插件的
`settings.ts`。一处改动覆盖全部插件，且不动任何公共接口。

**顺带修的测试不确定性**：`tools/check-e2e-proactive.mjs` 起宿主前把两道静默窗
钉成空窗（起止同分钟即空窗，见插件 `window.ts` 的 `inWindow`）。这条测试验的是
「由头能不能出来」，与此刻几点无关；不钉死的话它只在 08:00–23:00 之间通过。

**核心链路验证（同一轮内）**

| 能力 | 证据 |
| --- | --- |
| 记忆写入 → 召回 | `check:e2e-memory` 全绿；真机 `/api/memory` 读到 3 条真实记忆 |
| 主动消息判定 | `check:e2e` 第 3 段 `allow=true, code=ok`，由头为「你交代过的事」 |
| TTS 合成 | 隔离探针 `synth('自检，玖玖在这里。')` → `reason=ok`，通道 `macos-say`，3.3s |
| 应用可用 | `phase: ready`；`node tools/ondra.mjs say "自检"` 拿到回复 |

### 第 2 轮（2026-11-12 03:11）

**基线对照**：78 包 / 45 装载 / 26 停用段，与第 1 轮逐项一致，**无新增停用项**。
日志 3000 行内无 `not registered` / `service not found` / 未捕获异常。

**当轮红项：TTS 整条链在实际运行中恒不出声。** 这是第 1 轮没看到的一条，
因为第 1 轮只验了「隔离探针能合成」，没验「宿主这一侧能不能走到合成」。

现场读数（真实会话，未改任何配置）：

```
gateStats  { decisions: 4, spoken: 0, blocked: { too-long: 2, flat: 2 } }
ttsStats   { calls: 0, ok: 0, played: 0 }
缓存 wav   最后写入 11-10，本轮 0 次合成
```

根因是一条**调用约定错配**，两侧都各自正确、都不报错：

1. `ondra-tts-gate` 的句长闸口径是**单句 6–30 字**（`min-chars`/`max-chars`），
   其 README 与配置说明都写着「超过就该拆条，不该硬念」——**拆条是调用方的活**；
2. 宿主 `src/voice.ts` 的 `speakReply()` 把**整段多句回复**一次性交给 `admit()`；
3. 于是一段 40 字的正常回复必然 `too-long`。**只要回复超过 30 字就念不出来**，
   与情绪、频控、连读全无关。这不是偶发，是一条静默的死规则：不报错、
   不影响文字、探针上只看到 `too-long` 一直涨。

**修复**（只动 `cordis-host/src/voice.ts`，不改公共接口、不加依赖）：

| 位置 | 改动 |
| --- | --- |
| `GatePort` | 增加可选的 `decide(text)`（纯判定，不记账） |
| 新增 `clausesOf()` | 按 `。！？…；，、` 与换行切分句（逗号也切：中文长句常只用逗号） |
| 新增 `pickUtterance()` | 从前往后把分句往后拼，取**第一段能念的**（最多拼 4 段） |
| `speakReply()` | 整段被判 `too-long` 时才退让到分句；**仍只 `admit()` 一次**，记账口径不变 |

关键设计取舍：只在 `too-long` 这一种理由上退让。`flat`／`harsh`／`cooldown`
是「这一轮就是不该出声」，换一句也一样，不该绕过——所以 `intensity-min`
这条用户门槛没有被这次修复削弱。

**过程中自己踩的坑（已修，留作路标）**：第一版把 `gate.decide` 取成局部变量
`const decide = gate.decide`，`this` 丢失，抛
`Cannot read properties of undefined (reading 'shape')`，被外层 `catch`
降级成「本轮不出声」——一个空指针变成了一次静默沉默。改为 `gate.decide(...)`
方法调用。另外发现：**宿主里的 `process.stderr` 不进 `debug.log`**，
插件那套 stderr 留痕在宿主侧读不到，诊断必须走 `ctx.logger`。

**验证（同一轮内，含受控 A/B）**：

| 步骤 | 证据 |
| --- | --- |
| 受控 A/B：`intensity-min` 临时置 0（已备份、已逐键还原） | 短回复 → `spoken=1 / calls=1 / ok=1 / played=1`，新增 248 KB wav |
| 分句修复本身 | 日志 `整段 99 字念不了，改念其中 15 字那句` → `spoken=1`、`played=1` |
| 记忆写入 → 召回 | 写「工位靠窗」→ 问「工位在哪」→ 答「我这儿只记了『靠窗』」；`/api/memory` 有 `用户的工位靠窗。` |
| 主动消息判定 | `check:e2e` 第 3 段 `allow=true, code=ok`，由头「你交代过的事」 |
| 应用可用 | `phase: ready`、`busy=false`，`say` 稳定拿回回复 |

**配置卫生**：A/B 用的 `tts-gate.intensity-min` 已 `config reset`，
`settings.json` 与备份逐键比对**完全一致**；备份在
`~/Library/Application Support/com.ntars.ondra/backups/settings-20261112T031944.json`。

**顺带清掉的老债**：第 1 轮遗留的「打包应用仍是旧 bundle」本轮已通过
`build:app` 解决，`releases/macos/空谷 Ondra.app` 就是当前代码；
实机验证跑的就是这个包。

### 第 3 轮（2026-11-12 04:37）

**基线对照**：78 包 / 45 装载 / 26 停用段，与第 2 轮**逐项一致**（26 段名逐字
比对过，无新增）。`phase: ready`、`busy: false`，日志 300 行内无 `error` /
`not registered` / `service not found`。24 条自检全绿。

本轮没有发现新的装载/协作缺陷——前两轮修的那两处仍然成立。本轮做的是
**把「已经修好」变成「以后坏了一定会红」**，以及**修掉一处归因错误**。

#### 一、新增 `check:voice`（`tools/check-voice.mjs` + `package.json` 一行）

第 2 轮的遗留第一条就是它。那个缺陷的形态是「装上、注册、探针全绿，
但一次都没出声」，23 条自检没有一条抓得到——因为它们验的是「服务能工作」
（直接调 `admit()` / `speak()`），不是「应用会不会用它」。

脚本分两段，共 17 条断言：

| 段 | 锁的是什么 |
| --- | --- |
| A | 整段 60 字 → 闸门判 `too-long` → 挑出一句 → 只 `admit()` 一次 → 合成一次 |
| A 第 4 段 | 反证：3 字短句必须被 `too-short` 拦下（闸门不是摆设） |
| A 第 5 段 | 归因：长而平铺的回复必须记 `flat`，不得错记 `too-long` |
| B | 用户层 `min-chars: 2` 真的进了插件 |

判据一律用**派生量**（`gateStats.spoken > 0`、`ttsStats.ok > 0`），不用
`ttsLoaded === true`——后者在第 2 轮那个缺陷下是绿的。也不断言 `played`：
它要过 `afplay`，依赖输出设备，无人值守机器上必然 0，而那不是被测能力坏了。
脚本主动把 `tts.playback` 设成 `off`，既不等播放也不制造噪音。

**四处受控 A/B**（每一处都改一行、跑一次、还原、核对产物与备份逐字节相同）：

| 临时改动 | 期望 | 实测 |
| --- | --- | --- |
| 停用 `pickUtterance`（退回「整段一次 admit」） | A 段红 | `spoken=0 / calls=0`，3 条红 |
| 切断 `buildMemberConfigs` 的用户层注入 | B 段红 | `blocked` 从 `{flat:1}` 变回 `{too-short:1}` |
| 停用 `camelizeKeys` | 预期 B 段红 | **仍然绿**——见下 |
| 撤回归因修复 | A 第 5 段红 | `too-long:1`，2 条红 |

第三条要老实写下来：**B 段锁不到 `camelizeKeys` 那一步。** 原因是
`ondra-tts-gate` 自己的 `completeConfig()` 用 `pick(raw, camel, kebab)`
两种键名都认（63 个插件里唯一这么做的一个），所以宿主不做归一它也读得到。
这条不是推测，是 A/B 跑出来的结果，已写进脚本注释与下方遗留。

#### 二、修掉一处归因错误（`cordis-host/src/voice.ts`）

实机日志里有一对相邻行，两行说的是两件事：

```
ondra.voice     整段过长，且分句后仍无可念句（flat）
ondra.tts-gate  语音未放行（too-long，72 字）
```

整段超长时会挑句；一句都挑不出来时，此前是拿**整段**去 `admit()`，闸门于是
记住 `too-long`。而真因是每一句都 `flat`。设置页读的正是 `blocked` 这个桶，
于是它告诉主人「你的话太长」——真正该看的是「她太平了」。**归因错了，修法就全错。**

改法：`pickUtterance()` 返回 `{ picked, fallback }`，`fallback` 是被拦下的那个
候选原文；`speakReply()` 在挑不出时用它去 `admit()`。**只换记账口径，不换行为**：
候选本来就是从这段回复里切的，仍然只判一次、只记一次，出不出声的结论完全不变。

实机验证（重启新包后一句长回复）：`blocked: {"flat": 1}`、`lastReason: "flat"`。
改之前同一句话记的是 `too-long`。

#### 三、新发现：语音在生产会话里实际**永不出声**（待裁决，未改）

这是本轮最重要的发现，也是前两轮都漏掉的一层。实机读数（重启前，未改任何配置）：

```json
{"decisions": 6, "spoken": 0, "blocked": {"flat": 3, "too-long": 3},
 "lastSpokenAt": 0, "ttsStats": {"calls": 0, "ok": 0}}
```

六次判定，零次出声，零次合成调用。机制是通的（`check:voice` 里真的合成成功过），
但产品里一次都没用上。根因不是接线，是**两条产品参数互相打架**：

| 参数 | 值 | 出处 |
| --- | --- | --- |
| 语音闸门情绪门槛 | `intensityMin = 0.15` | `ondra-tts-gate/src/settings.ts:89` |
| 单条消息情绪位移上限 | `MAX_STEP = 0.12` | `ondra-emotion-core/src/pad.ts:40` |
| 弥散保留比例 | `0.4 × (1 − familiarity × 0.5)` | `ondra-emotion-diffuse/src/diffuse.ts:63` |
| 实机心情读数 | 恒定 `0.50`（日志 6 条采样全 0.50–0.52） | `debug.log` |
| 实机情绪事件密度 | `feelings: 1` / `settles: 41` | `/api/diagnostics/emotion` |

`intensityOf = max(|mood−0.5|, (energy−0.5)×0.5)`。单条最多动 0.12，下个边界
只留四成，而实机 `mood` 一直贴着 0.50——**强度分支在当前读数下到不了 0.15**。
剩下唯一能开门的是「回复里含 40 词表内的情绪词」，而她的回复平铺直叙，极少含。

所以用户看到的是：开关是开的、通道可用、探针无 `note`，**就是没有声音**。
这正是第 2 轮记下的那种「最难查的静默失效」换了一层皮。

**没有改阈值**——这是产品口径（手册 §9.4），不是代码 bug，两个方向各有代价：

1. 把 `intensity-min` 从 0.15 降到 0.05：一句话就能开门，代价是「平铺直叙也念」；
2. 给情绪词表补常用词：治标，且词表本身已在 README 标为「待裁决」；
3. 抬高 `MAX_STEP`：影响的是**全部**下游（六态、应激倍率、冲突锁），风险最大。

请主人裁决。在那之前，把这一条记为**待裁决**，不算本轮未达标——判定口径第 5 条
要的是「验证过一次 TTS 调用」，`check:voice` 已用真实 `say` 合成验过。

## 停用段判定（26 段，全部为「设计关闭」）

### 先算清那笔差额

前五轮反复核「26 个停用段合不合理」，却没人算过 **78 − 45 − 26 = 7**。
那 7 个包**没有设置段**，所以既不在停用清单里、也不在任何核对表里——
逻辑盲区。第 6 轮把它们逐个判完：

| 包 | 第 6 轮处置 | 依据 |
| --- | --- | --- |
| `desktop-bridge` | **已装载**（并标为不可停用） | 宿主 `index.ts:250` 无条件挂载；原先报「未装载」是显示层缺陷 |
| `dsh-client` | **已装载**（并标为不可停用） | 同上，`index.ts:256`；日志每轮都有「dsh 内核就绪」 |
| `ondra-store-memory` | **已装载** | 21 处消费方写 `sqlite ?? memory`，右半边原先永远为空 |
| `ondra-core` | 设计关闭 | 装配表本体，自己装自己没有意义 |
| `ondra-store-json` | 设计关闭 | 它自带双门禁（`sqlite.state !== 'unavailable'` 就退出），且**21 处消费方没有为它留位置**——装了也不会被选中，属「多一个永不触发的分支」 |
| `ondra-log-zh` | **设计关闭**（第 7 轮定论） | 它提供的 `ondra-log-zh` 服务键在全仓**零运行期消费方**（唯一引用是装配表 `ondra-core/src/index.ts:189`）。`debug.log` 里的中文由 `debug.ts` 自己写，与本插件无关。属「额外的落盘层」，没有人读它 |
| `ondra-data-migrate` | **设计关闭**（第 7 轮定论，缺口另有其人） | 插件本身只注册 `MigrationRunner` 服务，而**仓里没有任何一条 `Migration` 被 `register()`**（全仓搜 `register({` / `registerAll` 零命中）；`user/ondra.db` 的 `PRAGMA user_version = 0`、无迁移历史表。真正缺的是**没人写迁移脚本**，不是「没装载」——开它只会多一个空服务 |

判据：逐个提取该插件提供的 service key，全仓搜 `ctx.get('<key>')` 的消费方，
再与「本次实际装载的 48 个」取交集。**27 段里没有一个存在已装载的消费方**——
消费方只有两类：装配表本身（`ondra-core`，不是运行期消费）和同样处于停用的插件。

> 这里原先并排躺着两段一样的话，一段写 48、一段写 45。两个数都曾经对过（不同的轮次），
> 并排放着就成了「同一件事两个说法」。**任何会被复制的计数都只留一处**，其余引用它。

| 段 | 判定 | 理由 |
| --- | --- | --- |
| `installer` | 设计关闭 | 安装期一次性，ready 之后无消费方 |
| `install-doctor` | 设计关闭 | 安装期自检，同上 |
| `first-meet` | 设计关闭 | 初见剧本，首启一次性 |
| `onboarding` | 设计关闭 | 首启引导，同上 |
| `startup-check` | 设计关闭 | 启动自检，安装期 |
| `port-picker` | 设计关闭 | 只在装配期挑端口；宿主 `server` 自己顺延端口 |
| `window` | 设计关闭 | 窗口归 Tauri 壳；宿主内无消费方 |
| `forget-right` | 设计关闭 | 仅装配表与 `lexicon`（未装载）引用 |
| `lexicon` | 设计关闭 | 唯一运行期消费方是 `forget-right`，未装载 |
| `expression-decide` | 设计关闭 | 表情判定由 `emotion-express` 自带；未装载无影响 |
| `dialogue-protocol` | 设计关闭（第 9 轮修正理由） | **增强件**，不是对话前提：缺席时 `dialogue` 走 `PlainSink` 兜底（保留 seq 与终态，丢帧校验与「被截断」的区分）。原写「dialogue 未装载」是**错的**——`ondra-dialogue` 一直在装载。要不要补上这件增强，见第 9 轮待裁决 |
| `worldbook` | 设计关闭（第 11 轮修正理由） | 背景知识插件，**没有内置语料**：要它有用，得先有人写一份 `user/worldbook.json`，而界面上没有登记条目的入口（设置页会照常渲染这 10 个字段，但那只是参数，不是内容）。开着也是空转，故出厂关闭；需要时在扩展抽屉打开即可，`apply()` 全程防御，缺席路径不抛错。原写「无设置页」是**假前提**——设置页由 `/api/config` 动态生成，读了就有。另：`ondra-dialogue` 的 `includeWorldbook` 默认 `true`，取不到时按空处理且不告警，属刻意降级（与 `dialogue-protocol` 的 `PlainSink` 同性质），不是缺陷 |
| `multimodal-memory` | 设计关闭 | 依赖 `vision` / `asr`，两者均停用 |
| `vision` | 设计关闭 | 按需能力；消费方 `multimodal-memory` 未装载 |
| `asr` | 设计关闭 | 按需能力；消费方 `multimodal-memory` 未装载 |
| `evidence-gate` | 设计关闭 | 消费方 `multimodal-memory` 未装载 |
| `privacy` | 设计关闭 | 消费方 `asr` / `vision` 均未装载 |
| `organ-gate` | 设计关闭 | 器官链整组未启（与 `organ-host`、`sandbox` 同组） |
| `organ-host` | 设计关闭 | 同上 |
| `sandbox` | 设计关闭 | 能力分级沙箱，器官链未启 |
| `process-host` | 设计关闭 | 进程托管按需启用 |
| `absence` | 设计关闭 | 空窗期礼仪，仅装配表引用 |
| `live` | 设计关闭 | 日期事实，仅装配表引用 |
| `life-rhythm` | 设计关闭 | 消费方 `organ-host` 未装载 |
| `crisis` | 设计关闭 | 危机干预，仅装配表引用；宿主内无调用点 |
| `inject-dedupe` | 设计关闭 | 注入去重，仅装配表引用 |
| `store-json` | 设计关闭（第 11 轮补登） | JSONL 备用存储。第 10 轮给它补了 `settings.ts` 之后它才第一次出现在这份清单里——**出厂关闭且用户层 `enabled` 进不来**曾经是它的病，补完仍然是关闭（默认后端是 SQLite），但「关得掉也开得起来」。21 处消费方写 `sqlite ?? memory`，没有一处写 `?? store-json`，开了也不会被选中 |

### 第 4 轮（2026-11-12 05:56 → 06:05 中断）

在改「整轮情绪词结论下传给 `admit()`」时中途退出：`src` 改了、`tools/check-voice.mjs`
补了 C 段、但**没有重新构建 `lib`、没写记录、没删锁**。锁在下一轮（07:06）
因 90 分钟未到而被闸门拦下，那一轮因此没做任何改动。

中断现场留下的两处隐患，在第 5 轮才被查清：

1. `cordis-host/src/voice.ts` 里留着一行 `turnEmotive = undefined // A/B 临时切断`。
   这不是注释笔误，是 A/B 试验的临时开关，收尾时忘了还原。
2. `cordis-host/lib/index.js` 仍是 04:46（第 3 轮）的产物。所以第 4 轮那次
   `check:voice` 是**新脚本跑旧产物**——C 段绿了，但它测的代码里根本没有
   被测逻辑。

### 第 5 轮（2026-11-12 08:16）

**现场**：78 包 / 45 装载 / 26 停用段（与第 3 轮逐项一致，无新增）；
`phase: ready`、`busy: false`；日志 300 行内无 `error` / `失败` / `reject` /
`not registered` / `service not found`；25 条自检全绿。

**修的两处**（都在语音链，第 4 轮的残局）：

1. **`cordis-host/src/voice.ts`**：`turnEmotive = undefined` → `whole.emotive`。
   整段回复是否含情绪词，这一项必须由知道整段的那一侧给出；置成 `undefined`
   等于把「旁路按整轮算」这条实现整个摘掉。
2. **`tools/check-voice.mjs` 的 C 段**：从「起宿主 + 黑盒断言」改为
   「真 `Gate` + 假 TTS + 直接调 `speakReply()`」。

**为什么要动 C 段的写法**（这是本轮最值钱的一条）：

黑盒版 C 段绿过两次，两次都是假的。根因在闸门：

```ts
// ondra-tts-gate/src/gate.ts:75
if (intensity === undefined) return undefined   // 缺数据不拦
```

情绪服务在本轮还没有情绪事件时给不出 mood / energy，`intensity` 就是
`undefined`，于是**任何**分句都放行——「旁路生效」与「根本没判」在探针上
完全同形。实测同一段文本连跑两次，一次 `flat`、一次 `ok`，差别只在情绪服务
那一刻有没有数据。

改成确定性构造后：情绪钉成 `mood=0.5 / energy=0.5`（`intensity=0 < 0.15`），
情绪闸必拦，唯一能救它的只剩情绪词旁路。实验组与对照组文本**逐字相同，
只删掉末尾的「开心。」**，并给 `decide` / `admit` 各包一层探针直接读入参。

反向验证（把 `turnEmotive` 改回 `undefined` 重跑）结果：

```
✗ C1 念的是第一句长度合格的分句，不是整段（"性能没问题开心"）
✗ C1 整轮结论真的传进了 admit（emotive=true）（admit 次数=1 / emotive=undefined）
```

注意那个念出来的字符串——不打旁路时，前四句全部 `flat`，一直拼到
「性能没问题」+「开心」才因自身含情绪词放行。**旧代码下她不是不出声，
而是念一句自己拼出来的怪话**。这个形态比「不出声」更难被发现。

**构建产物滞后的教训**：`check:voice` 起宿主用的是 `cordis-host/lib/index.js`
（编译产物）。本轮因此显式做了 `build:plugins` + `tsc -b --force`，
并确认 `lib/src/voice.js` 里出现 `turnEmotive = whole.emotive` 之后才跑断言。
**改 `src/` 不重建就验，等于没验。**

### 第 6 轮（2026-11-12 09:41）

> 本轮换了一个角度：前五轮都在核「26 个停用段合不合理」，而
> **78 − 45 − 26 = 7** 这个差额从来没人算过。那 7 个包没有设置段，
> 于是既不在停用清单里、也不在任何核对表里——**逻辑上的盲区**。
> 本轮三处修复全部出自这个盲区。

#### 一、`/api/plugins` 对宿主级常驻插件谎报「未装载」（已修）

| 事实 | 证据 |
| --- | --- |
| `dsh-client` 每次启动都在跑 | `debug.log` 每轮都有 `dsh-client dsh 内核就绪：2.1.2` |
| 同一时刻接口说它没装载 | `GET /api/plugins` → `loaded:false` |
| `desktop-bridge` 被写进 `plugins.json` 的 `disabled` | 文件里就一条 |
| 而它仍然被无条件挂载 | `cordis-host/index.ts:250` 的 `await ctx.plugin(desktopBridgePlugin, …)` 不读开关 |

根因：扩展抽屉的 `loaded` 判据只有 `enabledPlugins` 一处，而这两个包在
**装载核心链之前**就挂好了，根本不在那份名单里。用户看到「已关」、
进程里照跑——**关闭动作无效与状态谎报互相盖章**。

修复（`cordis-host/index.ts`）：新增 `RESIDENT_PLUGINS`，派生出
`loadedPlugins` / `protectedPlugins` 两个展示集合；`enabled` 计算改为
**`core` 优先于 `disabled`**——不可停用的东西不该显示成已停用。
toggle 接口本来就有 409，两处口径现在一致。

回归网：`tools/check-plugins.mjs`（`check:plugins`）。A 段验默认数据、
B 段把它们写进 `disabled` 再验一遍（最坏用户数据）、C 段反向判据
「没有任何一行 loaded=true 而 enabled=false」。**反向验证做过**：
撤掉修复后红 11 条，且精确指到 `loaded=false`。

#### 二、`ondra-store-memory` 是兜底基础设施，却不在装载名单（已修）

21 处消费方写的是 `ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')`，
而那个 `??` 的右半边**从来没有过东西**。SQLite 正常时看不出差别；
一旦库打不开，记忆域 / 情绪域 / 人格域同时拿 `undefined`，
`ondra-memory-core` 的 `ctx.inject` 等不到端口就整包不起——症状是
「她失忆了，而且什么都不说」，日志一行错都没有。

判它是「本该装载」而非「按需功能」的依据：插件自己的 `apply()` 写明
**即使 SQLite 在位也照常注册**，只在日志里说「本后端仅作备用，不会被选中」，
选谁由消费方的 `??` 顺序决定。代价是一个空对象加一行日志。

顺带补 `after`：`ondra-core` 里 store-memory 的 `after` 补上 `ondra-identity`
（`apply` 第一段同步读它拿日志命名空间），与既有纪律一致。

装载数 45 → **48**（+ store-memory + 两个宿主常驻项如实计入）。
`check:e2e-memory` 复跑仍全绿，说明 SQLite 仍是主选、兜底没有抢路。

#### 三、「收对话进记忆」关掉之后，库里照写（已修）

字段说明是「关掉后服务照常注册，但**一轮都不收**」，而 `flush()` 里
没有这一判断——只有 `service.available` 用到它。而轮次结束那次
`void flush(...)` 是**直接调的，不经过 `available`**。于是三处各自自洽：
设置页写着关了、右栏写着「暂无记忆」、`memory_raw` 一直在长。

修复：`ondra-memory-intake/src/index.ts` 的 `flush()` 开头判 `settings.enable`，
关了就 `stats.skipped += 1` 并返回 `reason: 'disabled'`。手动的 `ingest()`
（补录）一并拦——服务已对外宣称 `available=false`，再偷偷写就是两套说法。

回归网：`tools/check-intake-switch.mjs`（`check:intake-switch`）。
判据落在**库里的行数**而不是自报的 `stats().skipped`；A/B 两段只差这一个
开关，同一句输入。**反向验证做过**：去掉判断后 B 段 2 行 → 红。

#### 四、`check:voice` 补上产物新鲜度前置（第 5 轮遗留 #2，已修）

26 个被本脚本依赖的产物（`lib/` 与源码逐对）任一新于源码即失败，
并直接给出 `pnpm run build:plugins && pnpm run build:host`。
改成动态 `import()`，让闸门先于模块求值跑完——静态 import 会在任何顶层
语句之前求值，那样闸门就退化成「加载完旧代码再告诉你它旧」。

**反向验证做过**：把 `lib/src/voice.js` 的 mtime 推回过去 → 立刻红并指名
`cordis-host/src/voice.ts 比产物新 …秒`。

#### 五、五组并行分诊的结论摘要

| 组 | 判为缺陷 | 说明 |
| --- | --- | --- |
| A 存储 | 2 | store-memory 未装载（已修）；`store-json` README 键名写错（文档级） |
| B 记忆 | 2 | intake 开关失效（已修）；`memory-vector` 默认关且无设置段（设计关闭，但 `index.ts:1150` 的注释与事实不符） |
| C 人格情绪 | 0 | 确认「写入太稀疏」是**阈值口径**（四信号要求同时命中三类），非接线缺陷 |
| D 工具门控 | 2 | quota 的 `patch()` 无条件覆盖 `gate.daily-quota`（滑杆失效）；`'想找你聊聊：还有什么要说的吗'` 固定兜底撞去重黑名单 |
| E 通信界面 | 1 | 我修的那处谎报被独立复现；另报单句超长仍静默（`clausesOf` 不切超长分句） |

#### 六、本轮**没有**做的事（诚实清单）

- **没有改 TTS 阈值**（第 3 轮起就挂着「待主人裁决」）。C 组把账算清了：
  `MAX_STEP=0.12` + 弥散留四成 → 有效 0.048，而门槛 0.15 ——
  **不是差一点，是差三倍**，唯一出口是情绪词表。
- **没有改 `intensityOf` 的能量基线偏置**（C 组 B-8）：`emotion-core` 的
  中性能量是 0.6，而公式拿 0.5 当前提，于是强度恒有 +0.05 假底噪。
  这是参数错，但一旦去掉，TTS 会更难开门——与上一条纠缠，留给同一轮裁决。
- **没有为「A 组报的迁移钩子永不上挂」动 `snapshot` 的 `after`**：
  `data-migrate` 不装载是明确设计（注释写了两处），钩子空转属已知代价。

## 遗留问题（下一轮优先）

### 第 7 轮（2026-11-12 11:02）

> 本轮的主线：第 6 轮把「谁在骗人」修了一部分，本轮把**剩下的三处谎报与两处假开关**清掉。
> 判据一律走「用户照做之后实际会怎样」，不看代码里写了什么。

#### 一、没由头时编兜底句（已修）

| 事实 | 证据 |
| --- | --- |
| 代码注释写「拿不到话由时不编兜底句」 | `cordis-host/index.ts:2447` |
| 下一行就是兜底句 `'想找你聊聊'` | 同文件 `const text = taken?.text ?? (… : '想找你聊聊')` |
| 门控台账里真的躺着它 | `user/proactive-state.json` → `sent: [{"text":"想找你聊聊"}, {"text":"想找你聊聊"}]` |

危害不是「多说一句废话」：那句是**常量**，去重闸（30 分钟窗口 / 最短 4 字）
会把它当同一句话，于是半小时内第二次主动开口一律 `duplicate`——正是
`checkProactive()` 注释里警告的「她只主动说过一次」。它还会被 `nudgeFor()`
拼进模型上下文，让她照着这句空话组织语言。

修法：没有由头且调用方也没给正文时，正文就是**空串**，交给门控自己判
`content-empty`。额度、剩余、冷却这些真实数值照常回给界面。

回归网：`tools/check-proactive-noreason.mjs`（`check:no-reason`）。四段：
① 池空 → `allow:false` / `code=content-empty`；② 连问第二次仍是 `content-empty`
而不是 `duplicate`；③ 台账零条；④ **反向**——调用方给正文时必须照常放行
（防「把整条路焊死」这种更坏的修法）。
反向验证做过：改回兜底句 → 6 条红。

#### 二、设置页教用户去关一个关不掉的开关（已修）

| 事实 | 证据 |
| --- | --- |
| 场景层提示「想让她完全不主动，去关 proactive-quota 的 enable」 | `src/lib/scenes.ts:124`（原文） |
| 照做之后她照样开口 | 受控探针：`proactive-quota.enable=false` → `/api/proactive/check` 返回 `allow:true`、`quota:3` |
| 真开关在门控 | 同探针：`proactive-gate.enable=false` → `allow:false` / `code=gate-missing` |

根因：节律插件的服务面只有 `patch()` / `commit()` / `surrender()`，三个都不看
`enable`；而它的 `enable` 说明写着「关掉后 plan() 一律 drop/disabled」——
本插件根本没有 `plan()`，那句是从话由插件抄过来的。**抄错了一个服务**。

修法（`src/lib/scenes.ts` / `ondra-proactive-quota/src/settings.ts` / README 三处）：
把提示指向真正的开关，并把「关掉后额度仍照算」写进字段说明。

#### 三、场景层有一个拖了完全没反应的滑杆（已修）

| 事实 | 证据 |
| --- | --- |
| 「主动的安全阀」绑 `proactive-gate.daily-quota` | `src/lib/scenes.ts:136` |
| 该键在装节律的机器上恒定被覆盖 | `gate.ts` `budgetOf()`：`fromCaller ? override : settings.dailyQuota` |
| 用户拖到底，她每天说的条数一个不变 | 一次 `check` 就能看出 `quota` 恒等于档位值 |

危害属最隐蔽一类：滑杆能拖、能落盘、界面写着「已改」，**没有任何插件读那个值**。

修法：改绑 `idle-minutes`（会话安静多久她才开口），这是门控自己读、不被谁
覆盖的字段，拖一下立刻能感觉到。`daily-quota` 的字段说明同时改成「兜底值」。

#### 四、装载数三个地方各报各的（已修）

| 出处 | 改前 | 改后 |
| --- | --- | --- |
| 启动日志 `空谷核心：…装载 N 项` | 46 | 46（核心链）+ 2（常驻）= 48，括号里写明 |
| `ondra status` 的「N 个已装载」 | 46 | 48 |
| 插件抽屉 `/api/plugins` | 48 | 48 |

第 6 轮把 `/api/plugins` 修对了，漏了 `/api/debug/status` 与那行日志。
三个数都「不算错」，差别只是「算不算常驻包」；但同一个人在三处看到不同答案，
只会得出「有一个在骗我」。

回归网：`check:plugins` 新增 D 段，比较两个接口的**实测值**（不断言具体数字，
包数会随版本变，相等关系不会）。反向验证：把修复改回去 → 4 条红
（`status=46 / plugins=48`）。

#### 五、本轮自检

| 项 | 结果 |
| --- | --- |
| 仓库插件包 | 78 |
| `/api/plugins` 装载 | **48**（46 核心链 + 2 宿主常驻） |
| 未装载 | 30（26 个有设置段的停用项 + 4 个无设置段的：`ondra-core` / `store-json` / `log-zh` / `data-migrate`） |
| `[插件停用]` 段 | **26**，与第 6 轮逐项 `diff` 一致，**无新增** |
| 自检 | 26 条全绿（23 条 pnpm 脚本 + `check-ui` / `check-acceptance` 90/90 / `check-contrast` 66/66） |
| 实机 | `phase: ready`、`busy: false`、`say` 正常回话 |
| 核心链路 | 记忆写入→召回（`check:e2e-memory` 全绿）、主动判定（`budget-exhausted`，额度真实用尽 3/3）、TTS（`check:voice` 全绿，`spoken=1/ok=1`） |

新增回归网一条：`check:no-reason`（`tools/check-proactive-noreason.mjs`）；
扩充一条：`check:plugins` D 段。

#### 六、本轮**没有**做的事（诚实清单）

- **没有为了凑数开启任何停用段。** 26 段与上一轮逐项一致，判定不变。
- **没有开 `ondra-data-migrate`。** 本轮把它读透了：插件本身只注册
  `MigrationRunner` 服务，**仓里没有任何一条 `Migration` 被 `register()`**，
  而 `user/ondra.db` 的 `PRAGMA user_version = 0`、无迁移历史表。
  也就是说「开了它也没有迁移可跑」——真正的缺口是**没人写迁移脚本**，
  不是「没装载」。开它只会多一个空服务，故不动，把结论记在这里。
- **没有开 `ondra-log-zh`。** 它提供的 `ondra-log-zh` 服务键在全仓**零运行期
  消费方**（唯一引用是装配表）。`debug.log` 里的中文由 `debug.ts` 自己写，
  与本插件无关。属「设计关闭」，但 README 里它没有单列停用原因，下轮可补。
- **没有改 TTS 阈值**（第 3 轮起挂着「待主人裁决」，`MAX_STEP=0.12` vs 门槛
  `0.15` 差三倍，唯一出口是情绪词表）。
- **没有动 `memory-vector` 的死支路**（第 6 轮 B 组，仍待裁决补设置段还是改注释）。

---

### 第 8 轮（2026-11-12 13:20）

- 采集：78 包 / **48 装载**（核心链 46 + 常驻 2）/ 26 停用段（与第 7 轮逐项一致，无新增）/
  `phase: ready`、`busy: false`、`say "自检"` 正常回话。
- 自检：**29 项全绿**（23 条 pnpm 静态 + `check:voice` / `check:plugins` /
  `check:intake-switch` / `check:no-reason` / `check:order`，外加 `check-ui`、
  `check-acceptance`、`check-contrast`）。日志 300 行内零 error / 失败 / reject。
- 实机：`build:app` 出包后 `pkill` → `open` 重启，新 pid 3 秒内到 `ready`，
  装载数 48 与界面一致。

**修 1 · 扩展开关是空响，而且两边说法相反。**

`cordis-host/index.ts:1158` 原来把**默认名单** `enableList` 传给 `loadCore`，
而 `enableList` 只有两个来源：代码常量与环境变量。用户在抽屉里点「启用」写的是
`plugins.json` 的 `extra`、点「停用」写的是 `disabled`，这两份只合进了
`enabledPlugins`（展示集合）。于是同一次启动里出现两套事实：

| 谁 | 依据 | 说法 |
| --- | --- | --- |
| `/api/plugins` 的 `loaded` | `enabledPlugins` | 已装载 |
| 实际装没装 | `loadCore` 收到的名单 | 没装 |

用户打开一个出厂关闭的包、重启，界面翻成「已启用」，能力一个都没有；
两层都不报错。改为 `enable: [...enabledPlugins]`。
判据不能取 `loaded`（坏掉时它照样是 `true`），只能取日志里装载链自己报的
「核心链装载 N 项」——实测 46 → 47，换回旧写法则钉在 46 而 `loaded` 仍是 `true`。
新增 `check:plugins` E 段锁它（比差值，不写死数字）。

**修 2 · 备用存储后端在每一个消费方那里都是 `undefined`。**

三个存储端口按 `sqlite ?? memory` 取用，右半边是 SQLite 失守时的备用。
`ondra-store-memory` 的 `after` 里有 `ondra-store-sqlite`（它要读 SQLite 状态判断
「我在不在用」），排序后落到第 47 位；而 17 个消费方只写了
`after: ['ondra-store-sqlite']`，全部排在它前面。SQLite 正常时这条断线完全不显形，
但日志还在打印「本后端仅作备用」——备用后端确实存在，只是没人看得见。
修法：给 17 个消费方（含 `data-migrate`）的 `after` 补 `'ondra-store-memory'`。
排序复验：`store-memory` 47 位，17 个消费方全部在其后，无环（`unresolved` 为空）。
新增 `check:order` 锁它：把清单交给真的 `orderMembers()` 排一次，再逐个成员比对
源码里的 `ctx.get('<存储键>')` 与排序位置；反向验证删掉任意一个消费方的声明，
脚本精确报出那一个 id（首次反向验证选 `memory-graph` 未变红——它还能经
`memory-core` 传递依赖，换 `emotion-core` 才单调，这个坑记在脚本注释里）。

**修 3 · 无标点长句静默，一行诊断都不留。**

`voice.ts` 的 `clausesOf()` 靠标点切句。整段没有标点时只切出一段，候选**自己**
就超长 → `too-long` 立即 `break` → `firstBlock` 永远填不上 → 返回空对象 →
调用方既没有可念的句子，也拿不到任何理由。探针上只看到 `blocked.too-long` 涨一格，
与「她这轮不想说话」完全同形。
修法：加 `sawTooLong` 标记，落空时写一行
「整段 N 字无标点可切，单句超长不硬切（会念出半截话）」。**不硬切是刻意的**——
按字数拦腰截断会念出半截话，比沉默更糟；这一处补的是可观测性，不是行为。
`check:voice` 新增 D 段（不出声 + 必须留痕），反向验证去掉诊断后 D 段 1 条红、
`notes=[]` 证实旧代码确实是纯静默。

**没做的事（都要说明理由）**

- **没有为凑数强开任何停用段。** 26 段逐条复核仍为「设计关闭」：它们的 service key
  在全仓没有已装载的消费方。`ondra-live` 之所以被用作 E 段的测试对象，正因为它
  出厂关闭且无副作用——在**临时数据目录**里打开，不写用户数据。
- **没有改 TTS 阈值**（`MAX_STEP=0.12` vs 门槛 `0.15`，第 3 轮起挂「待主人裁决」）。
- **没有动 `memory-vector` 的死支路**（仍待裁决：补设置段还是改注释）。
- **没有改 `ondra-data-migrate` 的空钩子**：真正缺的是没人写迁移脚本，不是没装载。


## 遗留问题（更早各轮）

**第 6 轮新增的两条（影响面最大，排最前）**

A. **主动开关节律的两处失效（D 组）**
   ① `ondra-proactive-quota` 的 `patch()` 无条件覆盖 `gate.daily-quota`，
   用户把「她多主动」拨到哪一档都没有最终话语权（`index.ts:270-282` 函数头
   自己写着「enable 决定是否出 patch」，`service.ts:340` 却无条件覆盖）；
   ② 意图「想找你聊聊」恒定产出 `'想找你聊聊：还有什么要说的吗'`，
   撞上去重黑名单里那句「还有什么要说的吗」→ 永久 dedupe。
   **下一轮先修 ②（改动小、症状明确）**，①要定「谁优先」后再动。

B. **`memory-vector` 的注释与事实不符（B 组）**
   `cordis-host/index.ts:1150` 注释称「用户能在设置页看到这一段、能自己打开」，
   实际它没有 `settings.ts`、`SETTINGS_SECTIONS` 里也没有它 →
   用户无处可开，向量召回永远是死支路。要么补设置段，要么改注释说清
   「2-gram 倒排独自承担召回，向量是预留」。

C. **单句超长仍静默（E 组）**
   `clausesOf()` 只按标点切，一句无标点的 40 字回复会候选为空、
   退回整段 `admit()` → `too-long`，且**不写诊断行**。第 2 轮修了
   「整段不念」，这一层没修。建议在 `clausesOf` 里对超长分句按逗号或定长
   再切一刀，并在挑不出时也落一行诊断。

D. **`store-json` 的 README 键名写错（A 组，文档级）**
   README 写 `sqlite.state: unreadable`，实现读的是 `unavailable`；
   `cordis.yml` 引用的配置文件在仓里不存在。不修功能，只改文档。

**历史遗留（第 1–5 轮，状态更新见括号）**

1. **【待主人裁决】语音在生产会话里仍偏保守。** 见第 3 轮第三节
   与第 5 轮。第 5 轮已修「整轮情绪词结论没传下去」那一段（`voice.ts`），
   所以「她说了开心却一声不响」这条已消失。剩下的是**纯阈值口径**：
   闸门门槛 `0.15`（`ondra-tts-gate/src/settings.ts:89`）vs 单条位移上限
   `0.12`（`ondra-emotion-core/src/pad.ts:40`）+ 弥散只留四成
   （`ondra-emotion-diffuse/src/diffuse.ts:63`），实机 `mood` 恒定 0.50，
   于是**没有情绪词的那些轮次**仍然不出声。这是手册 §9.4 的设计取舍，
   **未擅自改阈值。**
2. **【第 6 轮已修】`check:voice` 依赖 `lib/` 产物，而脚本不会自动构建。**
   第 4 轮就是「新脚本跑旧产物」让一条断言假绿了一整轮。第 6 轮按方案 ②
   落地：脚本开头逐对比对 26 个产物的 mtime，任一源码更新即失败并指名道姓；
   同时把 lib 的静态 import 改成动态 `await import()`，让闸门先于模块求值。
2. **给 `camelizeKeys` 补一条不依赖钟表的确定性断言。** 第 3 轮的 B 段只锁到
   「用户层有没有被注入」，锁不到 kebab→camel 那一步（`ondra-tts-gate` 两种
   键名都认，是 63 个插件里唯一的一个）。设计：起宿主时同时写
   `tts-gate.max-chars: 60` 与 `tts.max-chars: 30`（后者只认 camel，且下限正好
   30），发一句 40 字无标点的回复 → 闸门放行、合成报 `too-long`
   （`ttsStats.failures === 1`）。若用户层被丢弃则 `failures === 0`。
   现在这条守卫只在 `check:e2e` 身上，而它是**时间相关**的（夜间才红）。
3. **情绪写入太稀疏，`mood` 贴死 0.50。** `feelings: 1` / `settles: 41`，
   日志里 `reunion（安慰 0 次）` 反复出现。`feel.ts` 的四信号（`stumble` /
   `apology` / `gratitude` / `reunion`）设计上是「宁可漏不可错」，但漏到这个
   密度，情绪链等于没接。需要单独一轮量一次：普通对话里四信号各命中几次、
   `reunion` 的时间阈值是多少。这一条不修，第 1 条无论怎么调阈值都会反复。
4. **`ondra-tts-gate` 的情绪词表不含 `寂寞`。** 该表是插件自定的 40 个词
   （README 已知限制第 1 条写明是自定的、故意只收常见词）。是否扩表属产品口径，
   不擅自改词表。
5. **记忆提炼对带细节的序号有损（第 3 轮复现）。** 第 2 轮是「我的工位在靠窗
   第二排」→ `用户的工位靠窗。`；第 3 轮实机再测一次，写入
   「备用键盘是青轴的，放在书桌左边第二格抽屉」→ 召回时她答
   「青轴的，书桌左边抽屉」——`第二格` 又丢了，稳定复现。
   已查明机制：`prompt.ts` 规则 4 写的是「**任何**数字（日期、年龄、价格、
   数量、次数）必须来自 TOOL 引文。用户口述的数字不要写进 text」，模型把
   「任何」按字面执行，序数位置（`第二格` / `三号门`）也被一并裁掉——
   而括号里枚举的五类**并不包含**序数与位置。所以这不是口径分歧，是
   **提示词的实际外延大于它自己声明的外延**。
   建议改法（未实施）：把「任何数字」收窄成「日期／年龄／价格／数量／次数」，
   并补一句「序数与位置（`第二格`、`三号门`）不属于此限，只要引文里逐字有」。
   不要动 `verify.ts` 的 `digit-without-tool`——它只查 ASCII 数字，本来就没拦
   这一类，真正的漏斗在提示词。
6. **【第 6 轮已复现并修复】`/api/plugins` 谎报装载。** 第 1 轮 E 组报过、
   当时判定「未复现」，第 6 轮两组独立复现并定位：`loaded` 判据只有
   `enabledPlugins`，而 `desktop-bridge` / `dsh-client` 在装载核心链之前就挂好了、
   不在那份名单里。已新增 `RESIDENT_PLUGINS` 与 `check:plugins` 回归网。
7. 【第 9 轮已核实、结论反转】`ondra-dialogue` **早就在装载**（`loadedPlugins` 有它），
   所以「将来启用 dialogue 时要成对启用 protocol」这条待办的前提已不成立。
   现状是：协议件缺席、`dialogue` 每次启动打一条降级 warn，走 `PlainSink` 兜底。
   补不补这件增强由主人裁决，见第 9 轮「已修正的判定」。

### 第 9 轮（2026-11-12 14:18）

**基线对照**：78 包 / 48 装载（46 核心链 + 2 常驻）/ 26 停用段，与第 8 轮
逐项一致，**无新增停用项**。日志只余一条设计内的降级 warn（见下「已修正的判定」）。

#### 一、这一轮换了把尺子

前八轮都在核「26 个停用段」，判据是「这个停用项对不对」。
本轮改看 `ondra status` 里那半句没人算过的读数：

```
配置段 64 段 / 619 项（已装载 38，有段声明 63）
```

64 − 63 = **1 段没有被认出**。逐段拉清单，是 `memory-intake`——记忆的入口，
恰好是唯一没把配置段交给配置层的那一个。八轮都没发现，因为它在停用清单之外
（它是**已装载**的），而所有核对表都是围着停用项建的。

#### 二、修 1：`ondra-memory-intake` 的配置段从未被认出

| 事实 | 证据 |
| --- | --- |
| 宿主扫段只认导出 `CONFIG_SECTION` 的包 | `cordis-host/src/settings.ts` 的 `collectFields()` |
| 本插件此前只导出 `FIELD_SPECS`，没有 `CONFIG_SECTION` | 64 个有 `settings.ts` 的包里唯它如此 |
| 读数为 `registered=false` | `/api/debug/settings` → 未登记 `["memory-intake"]` |
| 界面因此写一行告警 | `src/components/ModuleLayer.tsx` 的「未注册配置段，不参与四层合并」 |

**所以它虽然能读用户配置**（宿主第 1 轮的 `camelizeKeys` 注入路径不经配置层），
但设置页会当着用户的面说它「不参与四层合并」——63 个兄弟插件都不这么说。

**修复**（只改一个包，不动公共接口）：

- `cordis-host/plugins/ondra-memory-intake/src/settings.ts`：新增 `KEY_PAIRS` /
  `SECTION_KEYS` / `CONFIG_SECTION`（由 `FIELD_SPECS` 派生，不复制字段表）、
  `normalizeUserLayer()` / `valuesToConfigShape()`，以及 O-005 的结构对位类型。
- `cordis-host/plugins/ondra-memory-intake/src/index.ts`：`apply()` 里加
  `registerSection()`（注册进 `ctx.effect`，卸载即撤），有配置层就走
  `schema.resolve()` 四层合并。

**为什么不会改变行为**：三条降级路径（取不到服务 / 注册抛错 / 解析抛错）
终点都是原来的 `completeConfig(config)`。已跑 `check:intake-switch`（4 条全绿，
「关掉开关就一轮都不收」仍然成立）与 `check:wiring`（37 条全绿）。

**回归网**：`check:plugins` 新增 F 段——读 `/api/settings`，断言
**逐段 `registered` 全为 true**，再拿 `totals.unregistered` 跟逐段事实对账
（不只信宿主自己数的那个数）。反向验证：把 `CONFIG_SECTION` 改名后宿主直接
起不来（ESM 缺导出），F 段红；恢复后 64/64 绿。

#### 三、已修正的两个错误判定（理由错，结论仍成立）

这两条的**结论**（设计关闭）没变，但**写在表里的理由**是假的，会误导下一轮：

1. `dialogue-protocol` 原写「与 `ondra-dialogue` 同进同出，dialogue 未装载」。
   **`ondra-dialogue` 是装载的**（`loadedPlugins` 里有它，日志里有「对话编排就绪」），
   它每次启动都打一条 `帧协议未装载：将退回内部兜底 writer`。
   真实情况：协议是**增强件**，缺席时走 `PlainSink`（保留 seq 与终态，
   丢帧校验与「被截断」的区分）——降级是设计好的，所以结论不改；
   但「dialogue 未装载」这个前提是错的。
2. `worldbook` 原写「唯一运行期消费方是 `dialogue`，未装载」。同一个错误前提。
   真实情况：`dialogue` 在 `index.ts:144` 惰性取它，取不到就按空处理、**不告警**。

是否需要把这两件装上，留给主人裁决：两者都零依赖、消费者已在册，
装上只是补上被降级的那部分能力。**本轮没有为凑数强开。**

#### 四、本轮自检

| 项 | 结果 |
| --- | --- |
| 仓库插件包 | 78 |
| `/api/plugins` 装载 | **48**（46 核心链 + 2 常驻） |
| `[插件停用]` 段 | **26**，与第 8 轮逐项一致，**无新增** |
| 配置段 | 64 段，**全部已登记**（本轮修复前是 63/64） |
| 自检 | **31 条全绿**（30 条 pnpm 脚本 + `check-ui` / `check-acceptance` 90/90 / `check-contrast` 66/66） |
| 实机 | `phase: ready`、`busy: false`、`say "自检，玖玖在这里"` 正常回话 |
| 核心链路 | 记忆写入→召回（`check:e2e-memory` 绿）、主动判定（`check:e2e` 绿）、TTS（`check:voice` 绿） |

#### 五、仍红 / 待裁决（下一轮按此顺序）

1. **`energy` 轴没有写入方（已核实，非猜测）**：`ondra-emotion-core` 的
   `service.ts:228-230` 是它唯一的写入点，读的是调用方传入的 `input.energy`；
   而全仓 `grep -rn "energy" cordis-host/plugins/*/src` 除 `emotion-core` 自身、
   `emotion-express` 的**读取/阈值**、`drive-gap` 的**读取**（`service.ts:700`
   取 `state.axes['energy']`）之外，**没有任何一处构造这个入参**。
   所以该轴实际恒停在基线 60（`types.ts:60`），随之而来的是 `drive-gap` 的两条
   硬判据——自主唤醒 `energy > 30`、做梦 `energy > 30`——**恒成立**，
   等于没有这道闸。属口径/接线问题，未擅改。
2. **界面的情绪条恒为 0%——这是刻意的，不是缺陷**：`src/lib/useAppState.ts:1607`
   的 `deriveMood()` 直接返回 `{ mood: 0, energy: 0 }`，注释写明「真实情绪来自
   情绪引擎的心跳，本版本还没接」，并引原版一句话——「一个编出合理数字的页面，
   比一个承认缺口的页面更糟」。所以这里**不改**；真正的待办是「把心跳接进
   `deriveMood()`」，属功能开发，不属巡检修复。
3. **日志占位符写法错**（约 10 处，`%.2f` / `%d` 配 `console` 式出口）：
   *（第 10 轮已修：10 处全改 `toFixed` + `%s`，并新增 `check:logfmt` 静态锁）*
4. **`maxFacts` 三处默认值漂移**：`DEFAULT_CONFIG` 是 `undefined`、
   `FIELD_SPECS` 是 `6`、`completeConfig` 兜底也是 `6`，而字段说明写
   「留空交给提炼服务自己定」——实际永远传 6，那句说明不成立。
   *（第 10 轮已修：改用 `0` 做哨兵，默认值只从 `FIELD_SPECS` 派生）*
5. **装配器把「可选片段缺席」记成「缺项」**：宿主系统提示词装配每轮往
   `missing` 里塞一条「没有装载 `ondra-organ-host`」并写 stderr。属日志噪声，
   非功能缺陷；修法要对「必需件 / 可选片段」分层，需主人定口径。
   *（第 10 轮已修：按同文件「上下文缺席不进 `missing`」的既有口径改掉，未新增分层机制）*
6. TTS 阈值（`MAX_STEP=0.12` vs 门槛 `0.15`）仍等主人裁决（第 3 轮起）。
7. **安装期四插件：`apply()` 内同步取 `ondra-path-layout`，但成员表没给 `after`**（已核实）：
   *（第 10 轮部分修：`ondra-installer` 与 `ondra-life-rhythm` 两条有落盘后果，已补 `after`；
   `ondra-onboarding` / `ondra-log-zh` 两包仍出厂关闭且无已装载消费方，留着不动，等它们被启用时一起补）*
   `ondra-installer/src/index.ts:148`、`ondra-life-rhythm/src/index.ts:193`、
   `ondra-onboarding/src/index.ts:196`、`ondra-log-zh/src/index.ts:401` 都是同步取值，
   而 `ondra-core/src/index.ts:179/184/186/253` 的成员项**没有任何 `after`**。
   当前没出事，是因为它们在清单里排在 `ondra-path-layout` 之后——
   **靠的是顺序，不是声明**。这类「运气对了」的地方，别人一重排就变成
   「静默拿到 undefined + 降级写盘」。属健壮性缺口，不是已发生的故障。
8. **`startup-check` 的键名映射与宿主机械转换不一致**（已核实，影响为 0）：
   `settings.ts:76` 写 `maxFilesPerPackage: 'max-files'`，而宿主 `camelizeKeys`
   把 `max-files` 转成 `maxFiles`，插件 `settings.ts:259` 只读
   `raw['maxFilesPerPackage']` → 用户值被静默丢弃。该段属停用插件（界面灰显），
   所以现在拨了也不生效；但同形态第 1 轮刚修过一次，留作检查点。
9. **内存后备后端不支持事务**（已核实）：`ondra-store-memory/src/port.ts:149`
   明写 `transaction: false`，注释（`port.ts:472`）也要求「需要原子性的写入
   必须检查 `caps.transaction`」；而 `ondra-memory-core/src/repository.ts`
   的 4 处 `this.store.transaction(...)`（227/247/328/422）未按 caps 分流。
   默认走 SQLite（有事务），**只有落到内存后备时才失去这层保护**，未触发。

---

### 第 10 轮（2026-11-12 15:16）

**基线对照**：78 包 / 48 装载 / 停用段 **26 → 27**（数字变了，见下「为什么多了一段」）。
29 项自检全绿（26 条 pnpm + `check-ui` 0 ✗、`check-acceptance` 90/90、`check-contrast` 66/66），
实机 `phase: ready`、`say` 有回复、`/api/memory/health?run=1` 扫到 26 条事实并跑完判定。

本轮的角度不再是「哪个包没装上」，而是**「两个开关之间那根线断没断」**。

#### 修 1（本轮最高价值）：两个「出厂关闭、却没有开关」的包

一个包要真跑起来要过两道闸：**装载名单**（插件抽屉）与**插件自己的总开关**（设置页）。
只过第一道的形状是：

```
抽屉里：已启用 / loaded=true
启动日志：enabled=false（出厂默认）：……未注册
结果：服务仍然没注册
```

三个界面各说各话，**没有一处报错**。实测两个包同时中招：

| 包 | 缺什么 | 后果 |
| --- | --- | --- |
| `ondra-memory-vector` | 没有 `src/settings.ts` | 无配置段 → `config` 恒 `undefined` → `apply()` 在 `enabled=false` 分支 `return`，**永不 `provide`**。四处消费方（O-014 召回、`external.ts` 通道表、遗忘权两条）在任何配置下都读到 `undefined`；`external.ts` 还把「装了但关着」报成「没有这个包」 |
| `ondra-store-json` | 同上 | 同上。README 明写「不想接受内存后端『退出即丢』时打开它」——而它根本打不开 |

两个包的宿主注释都写着「用户能在设置页看到这一段、能自己打开」，**意图对、事实错**。
修法照 `ondra-memory-recognition` 的成熟形态各补一个 `settings.ts`（`FIELD_SPECS` 派生
`DEFAULT_CONFIG`，`CONFIG_SECTION` 派生字段表，四层合并三条降级路径终点仍是 `completeConfig`），
`index.ts` 里那条「有 O-005 就走合并」的分支接上，出厂默认**保持关闭**（不凑数）。

- `cordis-host/plugins/ondra-memory-vector/src/settings.ts`（新建）+ `src/types.ts`（补四个结构对位）+ `src/index.ts`（接四层合并）
- `cordis-host/plugins/ondra-store-json/src/settings.ts`（新建）+ `src/types.ts` + `src/index.ts`
- `cordis-host/plugins/ondra-core/src/index.ts`：`ondra-memory-vector` 的 `after` 补 `ondra-config-schema`

**为什么停用段从 26 变成 27**：`ondra-store-json` 现在有配置段了，而它不在装载名单里，
于是 `config` 会把它标成 `[插件停用]`。这条**判定为「设计关闭」**——台账第 16 组裁决
「SQLite（WAL）是默认底座」，JSONL 是用户显式选择的分支；现在它有了开关，
用户可以自己打开，符合「出厂关闭 + 可打开」的形态。`ondra-memory-vector` 仍在装载名单里，不计入停用段。

#### 修 2：`maxFacts` 的「留空」是假的

`DEFAULT_CONFIG.maxFacts` 原写 `undefined as unknown as number`——用类型断言把「没有值」
塞进 `Required<IntakeConfig>` 的数字位。后果是一条整链失效：`completeConfig()` 的 `num()`
见 `undefined` 必回退默认 → `maxFacts` 永远是个数 → `index.ts` 那句「有值才传」永远成立 →
**每轮都把 6 硬塞给提炼服务，提炼侧自己的 8 在真实链路上永不生效**，而界面上写着
「留空交给提炼服务自己定」。

改用 `0` 做哨兵（语义显式、可断言）：`DEFAULT_CONFIG.maxFacts = 0`、`FIELD_SPECS` 默认与
`completeConfig` 兜底都从它派生（不再各写一遍 6 和 1–30），`index.ts` 改成 `> 0` 才传。
`README.md` 对应表格行同步改成「默认 0 / 范围 0–30」。

#### 修 3：10 处精度占位符（`%.2f` / `%.0f`）静默失效

Cordis logger 只认 `%s/%d/%i/%o/%j/%%`，**不认精度**。于是 `'置信度 %.2f'` 落地成
`置信度 %.2f 0.9`——占位符原样留在行里，实参被追加到行尾。10 处分布在 9 个插件
（对话编排 / 情感投影 / 输出过滤 / 情绪弥散 / 关系结算 ×2 / 六态表达 / 器官宿主 /
缺口池 / 人格演化），全部是「日志难读」而非「功能坏了」，所以一直没人报。

改法是在调用点先 `toFixed(n)` 再交给 `%s`（不改外部依赖）。新增
`tools/check-log-format.mjs` + `check:logfmt` 做静态锁：源码里不得出现 `%.[0-9]+f`。
反向验证做过（改回 `%.2f` → 红 1 条并打印 `文件:行号`）。

#### 修 4：6 处 `after` 声明缺项（本仓的老毛病，第 8 轮同型）

| 包 | 同步取了什么 | 不声明的后果 |
| --- | --- | --- |
| `ondra-installer` | `identity` / `config-schema` / `path-layout` | `layout=null` → `LedgerStore.path` 恒 `undefined` → **账本静默不落盘**，每次启动都当第一次装 |
| `ondra-life-rhythm` | 同上 + `emotion-core` | `file=undefined` → **生活状态永不落盘**（能量与活动每次重启归零，而插件自己的 warn 恰好也这么说，看起来像已知限制） |
| `ondra-store-json` | `path-layout`（**硬失败**：取不到就拒绝注册） | 靠「字母序 `s` < `p` 不成立」侥幸正确 |
| `ondra-forget-right` | `snapshot`（只用于一句诊断） | 把已装载的快照误报成缺席 |
| `ondra-emotion-{core,diffuse,express,project,stage}` / `ondra-proactive-{gate,quota,reason}` / `ondra-asr` | `identity` / `config-schema` | 日志名退成硬编码、四层合并整段不发生（用户层仍由 `buildMemberConfigs` 递进，所以「生效」与「没走合并」在界面上完全同形） |

前四条有功能后果，后一类只损坏日志与合并层；两类都靠字母序侥幸，一次名单重排就全失效。

#### 修 5：装配器「可选片段缺席」不再记成缺项

`src/system-prompt.ts` 原每轮往 `missing` 塞一条「片段：没有装载 ondra-organ-host」。
而本仓**没有任何器官注册**，该包出厂关闭是刻意的 → 常驻一条假红之后，真缺项也没人看。
按同文件里「上下文缺席不进 `missing`」「情绪块拒绝产出不进 `missing`」的既有口径改掉。

#### 顺带修正的失真注释

- `cordis-host/index.ts` 称共现边「落笔在宿主的 `src/memory-links.ts`」——**该文件从未存在**，
  实现一直在 `ondra-memory-intake` 的 `linkCooccur()`。
- `ondra-memory-vector` / `ondra-store-json` 的 `enabled=false` 日志补上「去哪儿打开」。

#### 新增回归网

| 脚本 | 锁什么 | 反向验证 |
| --- | --- | --- |
| `tools/check-log-format.mjs`（`check:logfmt`） | 源码里没有 `%.[0-9]+f` | 改回 `%.2f` → 红并定位到 `文件:行号` |
| `check:plugins` 新增 **G 段** | 出厂关闭的包必须有配置段（否则用户永远开不了） | 造一个只有 `FIELD_SPECS` 没有 `CONFIG_SECTION` 的临时夹具 → G 段与 F 段同时红，夹具已删 |

#### 仍红 / 待主人裁决（下一轮的入口）

1. **TTS 生产会话仍不出声**（第 3 轮起）：`decisions=6/spoken=0`，本轮实测仍停在
   `voice 整段过长，且分句后仍无可念句（flat）`。门槛 0.15 vs 单条位移上限 0.12 是手册 §9.4
   口径，未擅改。
2. **`energy` 轴无写入方**（第 9 轮预言，本轮由 C 组核实）：唯一写入点读 `input.energy`，
   调用方 `memory-intake/src/feel.ts:311` 的实参**不含 energy**。下游三条判据恒为同一侧：
   `drive-gap` 的 `energy>30` 两道闸、`emotion-express` 的「雀跃（>60）/ 困（<30）」两态、
   `hormones.ts` 的血清素回充。属口径/接线，需定「体力从哪来」。
3. **`same_topic` 图谱边零创建方**：`link()` 只有 `cooccur`（intake）与 `surreal`（做梦荒诞分支，
   默认 `mode:'gate'` 不可达）两个调用方。补它要先定「什么算同主题」，未擅改。
4. **`proactive-quota.enable` 名不副实**（第 6 轮遗留，D 组本轮复证）：关掉仍开口，真开关是
   `proactive-gate.enable`；且 `patch()` **无条件**覆盖 `gate.daily-quota`，用户改 gate 的额度
   必被档位值覆写。
5. **`worldbook` 有已装载消费方却未装载**：`ondra-dialogue` 的 `includeWorldbook` 默认 `true`，
   缺席时**不告警** → 设置显示「开」、稳定段恒无世界书；`README.md:244` 还写「已启用」。
   要定：把它加进名单，还是把默认值改 `false` 并告警。
6. **`webServer` 零消费方**：四条回调式通道（钉钉/飞书/公众号/企微）在仓内**一个包都没有**，
   `ChannelWebServer.register()` 全仓零调用。
7. **`ondra-absence` 纯死包**：服务键零消费方、不在名单。判定设计关闭，但 README 未写。
8. `startup-check` 的 `max-files` 键名与宿主 `camelizeKeys` 不一致（第 9 轮遗留，仍为 0 影响）。
9. **打包应用仍是旧 bundle**：本轮改的是插件与宿主 TS，按任务书成本约束**未出包**；
   上面所有修复要 `pnpm run build:app` 或下次出包后才进实机。实机那几条验证跑的是旧 bundle。

### 第 11 轮（2026-11-12 16:15）

**现场**：78 包 / 48 装载 / 27 停用段（`store-json` 首次现身，与第 10 轮登记的 27 对齐）/
31 项自检全绿 / `phase: ready`、`busy: false` / `say` 正常回话。

**本轮主线：前十几轮验的是三小时前的代码。**

第 10 轮结束时把 7 类修复写进了 `src`，却没出包。于是本轮开局第一件事就撞上：

| 现场 | 看到的东西 | 真相 |
| --- | --- | --- |
| 运行中的宿主 | `phase: ready`、`say` 有回复 | 进程是 13:07 起的，跑的是**打包应用里的旧 bundle** |
| `ondra.mjs config` | 64 段 / 619 项 | 第 10 轮新加的 `store-json` / `memory-vector` 设置段**一个都没出现** |
| `debug.log` | `置信度 %.2f 0.9` | 第 10 轮的 `toFixed` 修复根本没上机 |

所以「全绿」这件事本身不可信：检查跑在产物上，产物比源码旧，绿的就不是当轮的代码。
这是本仓最贵的一类假绿——比红更贵，因为它直接支撑「已经修好了」的结论。

**修 1（本轮最高价值）**：新增 `tools/check-stale.mjs` + `check:stale`（第 31 条）。
逐包比 `src/**/*.ts` 与 `lib/**/*.js` 的最新时间（容差 2 秒），源码更新即判红；
打包应用里的宿主入口单独比一次，**落后只警告不判红**——出包要两分钟，
不该让每小时巡检都因为「没出包」而红。首次运行就抓到三处：`proactive-quota`（当时正在改）、
`emotion-project`（28 秒的隐性偏差）、应用包比仓库产物旧 168 分钟。

**修 2**：`ondra-core` 给 `ondra-tts-gate` 的 `after` 补 `ondra-emotion-core` /
`ondra-emotion-express`。此前每次启动都稳定打印两行：

```
此刻没有 ondra-emotion-core：情绪强度闸按降级放行（degraded 里会标 no-emotion）
此刻没有 ondra-emotion-express：拿不到六态语速，也判不出「炸毛不朗读」
```

而闸门的两个情绪依赖在运行期是**惰性取值**（`() => ctx.get(...)`），几秒后就位、照常工作。
那两行只是装载期一次性探测的结论被写死成日志。**「情绪强度闸」正是她朗读与否的关键一环**，
读日志的人会立刻怀疑语音链坏了——本仓已经为这条链查了五轮，最不需要的就是又一句假话。
这与第 8 轮 `ondra-filter-chain` 的假红同一类，`after` 一补即消。

**修 3**：`ondra-proactive-quota/src/index.ts` 的 `enable=false` 日志仍在说
「plan() 一律 drop/disabled」。第 7 轮改对了设置文案，漏了这行日志，而日志是排查第一现场。
改成如实描述（本插件不拦主动，额度与间隔照算，真开关是门控）。

**修 4**：`ondra-core` 文件头注释写「这里的 134 个成员…当前界面一个都没接，所以默认 `enabled: false`」。
两处错：成员是 **75** 个（134 是旧仓库的插件数），且情绪 / 记忆 / 人设 / 对话早就接进界面并在默认名单里。
这种注释会把后来人引向「这些都是死代码」。改为如实描述并指明唯一真源是本文件。

**首次出包**（55 秒 ×2，第二次带 `after` 修复）。重启后实机确认：
`ondra.mjs config` 从 64 段变 **66 段 / 629 项**（`store-json`、`memory-vector` 的设置段真的注册了），
`%.2f` 从新日志里彻底消失（`mood 0.50 / energy 60 / tension 0.00`），两行假告警消失。

#### 核心链路验证（同一轮内，全部在新产物上）

| 能力 | 证据 |
| --- | --- |
| 记忆写入 → 召回 | `say "我叫小玖，我的工位在靠窗第二排"` → `GET /api/memory` 里出现 `小玖的工位位置是靠窗第二排。`（含「第二排」，第 3 轮记的「丢序数位置」本轮未复现） |
| 主动消息判定 | `POST /api/proactive/check` → `allow:false, code:budget-exhausted, used:3/3`；是真判据而非 `gate-missing` / `content-empty` |
| TTS 合成 | `check:voice` 内真实调用一次 `synth()` 并成功；**生产路径仍 0 次**：`decisions=2 / spoken=0 / blocked={flat:2} / tts.calls=0` |
| 应用可用 | `phase: ready`、`busy: false`、`say` 拿到回复 |

#### 新增回归网

| 脚本 | 锁什么 | 反向验证 |
| --- | --- | --- |
| `tools/check-stale.mjs`（`check:stale`） | 源码不得新于产物；应用包落后只警告 | 改 `proactive-quota/src` 不重建 → 立刻红并指名该包；重建后转绿 |

#### 仍红 / 待主人裁决（下一轮的入口）

1. **TTS 生产会话仍不出声**（第 3 轮起，现已第 9 轮挂着）：`decisions=2/spoken=0`，
   `blocked={flat:2}`、`tts.calls=0`。门槛 0.15 vs 单条位移上限 0.12 + 弥散只留四成 +
   mood 长期停在 0.50，三条叠起来使这道闸**恒不放行**。属手册 §9.4 口径，需主人裁决：
   要么降 `intensity-min` 默认值，要么让闸门看「未弥散的单轮位移」。
2. **`energy` 轴仍无写入方**：`emotion-express` 启动日志已如实打印 `energy 60`（出厂基线），
   下游 `drive-gap` 的 `energy>30` 两道闸因此恒成立。需定「体力从哪来」。
3. **`proactive-quota.enable` 仍不是真开关**（第 6 轮起）：`patch()` 无条件覆盖 `gate.daily-quota`，
   用户改门控额度必被档位值覆写。本轮只改了那行会说反话的日志，行为未动。
4. **`worldbook` 仍出厂关闭**（第 10 轮待定）：本轮把判定理由里的假前提（「无设置页」）改掉，
   结论维持设计关闭。要不要进默认名单，仍待主人定。
5. **显示层盲区**：`memory-vector` 已装载但 `enable=false`（出厂默认），设置页**不带** `[插件停用]` 标记，
   用户看不出「这个段现在不工作」。日志里有如实一行（`向量分支未注册`），界面没有。
6. `webServer` 零消费方、`same_topic` 图谱边零创建方、`ondra-absence` 纯死包、
   `startup-check` 的 `max-files` 键名不一致——四条均沿自上轮，未动。

### 第 12 轮（2026-11-12 19:50）

**本轮的现场变了**：`plugins.json` 的 `mtime` 是 17:26，`extra` 从 30 项之外的名单扩到
**30 个包被打开**（`installer` / `install-doctor` / `first-meet` / `port-picker` / `window` /
`dialogue-protocol` / `log-zh` / `data-migrate` / `worldbook` / `store-json` / `vision` / `asr` …）。
这是**用户手动打开**的（非本轮改动），于是：

- 停用段 **27 → 0**；`ondra config` 66 段全部「已装载」
- 核心链装载 **48 → 75**（`DEFAULT_CORE_ENABLE` 46 + `extra` 30 − 1 个非成员 `ondra-core`）
- 装载数口径：75 + 宿主常驻 3 = **78**，与 `/api/plugins` 的 78 个包对齐

**判据不变**：全开不等于全绿。本轮只修「本该装好却降级」的那几处，不为凑数改动开关。

#### 修（3 处，均为「不报错但功能静默失效」）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `plugins/ondra-asr/src/settings.ts:108`、`plugins/ondra-vision/src/settings.ts:105` | 两个字段的**默认值是空串、而 `pattern` 不收空串** → `ondra-config-schema` 注册时校验 `default` 失败 → 整段抛错退回实例配置。每次启动两行「注册配置段失败」，而该段的 schema 级校验与逐字段回退从此不存在 | 各加一个 `LANGUAGE_PATTERN` / `CREDENTIAL_REF_PATTERN`（多一个可选空串），`FIELD_SPECS` 改用它。原 `*_RE` 仍是非空校验器，代码语义不变 |
| 2 | `plugins/ondra-core/src/index.ts:226`（`log-zh`）、`:316`（`onboarding`） | 两个包在 `apply()` 里**同步**解析 `ondra-path-layout`，而它们字母序排在其前 → 取不到 → **永久降级**：日志整进程转仅内存（不落盘）、首启状态每次重启重来。插件自己那行 warn 读起来像「已知限制」 | 补 `after: ['ondra-path-layout']` |
| 3 | 同上 `:202`（`inject-dedupe`）、`:214`（`lexicon`） | 同类漏声明，但取值器是惰性的、装完会自愈；错的是**装配期那句 warn 在说谎**（「本轮起 begin() 恒 bypassed」/「重启要重新攒样本」） | 补 `after: ['ondra-prompt-inject']` / `['ondra-path-layout','ondra-clock']` |

#### 顺带修（1 处，第 11 轮同族）

`cordis-host/index.ts:1036`：装配器 `ondra-core` 作为包被列进扩展抽屉，`core:false` → 开关可点。
点「启用」写 `extra`、点「停用」写 `disabled`，而它**从来不是成员**、宿主直接用
`corePlugin.loadCore()` 调它——两侧都是空响，且两侧显示都是假的。并入 `RESIDENT_PLUGINS`
（第三个成员），开关置灰；顺带让「75 + 3 = 78」与接口的 78 个包对上。

#### 新增 / 扩展回归网

| 脚本 | 锁什么 | 反向验证 |
| --- | --- | --- |
| `tools/check-defaults.mjs`（`check:defaults`，新增） | 逐包 import `lib/settings.js`，凡有 `pattern` 的字符串字段，`default` 必须被它命中（schema 注册时就是这么判的） | 把 asr 改回 `LANGUAGE_RE.source` 并 build → 红 1 条，指名 `ondra-asr :: language`；恢复 → 绿 |
| `tools/check-store-order.mjs` D 段（新增） | 四条「装配期同步取值」的顺序（`log-zh` / `onboarding` / `lexicon` / `inject-dedupe`） | 删 `log-zh` 的 `after` 并 build → 红 1 条（`10 > 14` 反了）；恢复 → 绿 |
| `tools/check-plugins.mjs` E 段 | `RESIDENT` 常量补第三个成员 | — |

**为什么 D 段只钉四条而不写通例**：通例「出现 `ctx.get('X')` 就必须列进 `after`」实测命中
**148 处**，绝大多数是惰性取值器与只影响日志名的良性降级，混报等于没有判据。

#### 自检

29 项 pnpm 脚本 + `check-ui` + `check-acceptance`(90/90) + `check-contrast`(66/66) 全绿。
注意：9 条脚本（`prompt-context` / `pack` / `emotion` / `project` / `feel` / `diffuse` /
`relation` / `evolve` / `drift`）清理 `.shots/` 时会被环境删除闸门拦下，需
`CODEBUDDY_SAFE_DELETE_ENABLED=0`，**这不是产品红**。

#### 实机取证（跑在**旧包**上，见「仍红 1」）

| 能力 | 证据 |
| --- | --- |
| 应用可用 | `phase: ready`、`busy: false`、`say` 三次均有回复 |
| 记忆写入 → 召回 | 写「我不吃香菜，闻到就难受。」→ `memory_fact` 27→28（`user/ondra.db` 20:09:16 落库，category=food）→ 新会话问「香菜那事你还记得吗？」→ 答「你不吃香菜，闻到都难受」 |
| 主动消息判定 | `POST /api/proactive/check` → `allow:false, code:content-empty, quota:3, used:3`；是真判据，非 `gate-missing` |
| TTS 合成 | 直接调 `MacSayEngine.synth()` → `ok:true`、**115940 字节 WAV**、voice=Tingting。生产路径仍 `spoken=0 / blocked={flat:5}` |

#### 仍红 / 待裁决

1. **修复未上机**（本轮最重要的一条）：三处改动都在 `src` + `lib`，打包应用里的宿主入口比仓库产物旧
   17 分钟（`check:stale` 已如实警告）。本轮**没有出包**，原因是 `src/App.tsx` / `Settings.tsx` /
   `TitleBar.tsx` 在 19:54–19:56 仍被编辑，此时 `build:app` 会把半成品 UI 一起打进包。
   下一轮第一件事：确认前端静止后 `build:app` + 重启 + 复核那两行「注册配置段失败」消失。
2. **`requireToolForDigits` 把用户口述的数字也挡了**：`say "记一下：我的旧自行车……B2 电梯口第三根柱子旁"` →
   `rejected:{digit-without-tool:1}`，事实未入库，而她的回复是「记下了」。
   **这是设置里写明的设计**（`settings.ts:86`：「关掉后口述数字也会入库」），不是缺陷，
   但「嘴上说记下、账本没记」这层不一致值得主人知道。要收口述数字：设置 → 记忆提炼 → 关掉该开关。
3. TTS 生产仍 `flat`（第 3 轮起第 10 次挂着）：门槛 0.15 vs 单轮位移上限 0.12 + 弥散四成 + mood 停 0.50，
   闸恒不放行。需主人裁决降 `intensity-min` 还是让闸看未弥散位移。
4. `energy` 轴无写入方（沿上轮）；`proactive-quota.enable` 非真开关（沿上轮）。
5. 本轮新开、但**功能本身缺上游**的三个包（诚实降级，不是缺陷）：
   `organ-gate`（全仓无 `tools` 提供方）、`process-host`（无 `ondra-subprocess` 包）、
   `installer`（无 manifest）。三者都在日志里如实说「不可用」，不阻断启动。
6. `check-ui` 本轮首跑曾因 `.pref__nav-item`「通知」找不到而超时，重跑即绿——与 19:54 的前端编辑同时发生，
   判为编辑期抖动，非缺陷。

---

### 第 13 轮（2026-11-12 20:51）

**开场状态**：78 个包全部 `enabled=true` + `loaded=true`，停用段 0，`phase: ready`、`busy: false`。
`check:stale` 立刻指出**打包应用比仓库产物旧**——应用 19:48 构建、19:49 启动，而第 12 轮的修复写于 20:03。
所以本轮所有「日志里还在报」的现象，先按「旧包」处理，不重复诊断。

#### 修（3 处）

| # | 位置 | 症状 | 修法 |
| --- | --- | --- | --- |
| 1 | `src/styles/richtext.css:254`、`src/styles/tokens.css`（新增 `--edge-fade` / `--ui-edge-fade`） | 表格右缘渐隐在组件里写了 `:root[data-theme='dark'] .md__table-wrap { … }` —— 深色下的第二套真源。`check-acceptance` 因此红 1 条（89/90） | 阴影提成令牌：原语层 `--edge-fade`（浅 18% 黑 / 深 14% 白）+ 别名层 `--ui-edge-fade`，组件只引别名。**90/90 转绿** |
| 2 | `plugins/ondra-core/src/index.ts:339`（`oral`）、`:401`（`rhythm`）、`:151`（`expression-decide`） | 三个包在 `apply()` 里**同步**判 `ondra-emotion-express` 在不在，而注册表序里它们排 4/10/20、表达档排 29 → 每次启动都说一遍「表达档未装载 / 此刻没有 emotion-express」。取值器是惰性的，**功能一直是好的，错的是诊断**（第 12 轮同族漏项） | 三处补 `after: ['ondra-emotion-express']` |
| 3 | `plugins/ondra-filter-chain/src/text.ts`、`passes.ts` | **删句链把段落压平**。`\n` 是它认的句末标点，`splitSentences()` 逐句 `trim()` 把换行剪掉，`joinSentences()` 又用空串拼回 → 只要删过一句，模型写的分段就整段粘成一行（实测三段回复变成「…出门只有屏幕。雨我看得见，听不见」） | `Sentence` 增 `gap`（该句**尾部**空白），`pushPiece()` 用 `trimEnd` 算出它、只左裁；三个拼接点改成 `text + gap`，并在删句时把 `gap` 顺延给下一句（`lastGap` 已含换行则不重复补，避免 4 个 `\n`） |

#### 为什么第 3 条是本轮最高价值

它不是日志能看出来的东西：`done` 事件里的文本、界面上的气泡、记忆里存的那条，**三处一致地都是错的**，
没有任何报错，也没有任何自检覆盖。发现路径是「`say` 打出的流式原文有三段、『塑形后』只有一段」——
即同一轮里两个值不一样。定位靠逐层排除：纯函数 `dropFinalPeriod` / `trimParticles` 实测都保换行，
宿主 `oral.ts` 把整段一次性交给 `applyTurn()` 也没切分，于是只剩删句链。

#### 新增回归网

| 脚本 | 锁什么 | 反向验证 |
| --- | --- | --- |
| `tools/check-filter.mjs`（`check:filter`，新增） | A 段：`split → join` 必须**逐字节**等于原文（5 例，含引号内句号、无标点尾巴）；B 段：三种删句位置（删整段唯一句 / 删同段中间句 / 删开头句）后段落间隔必须还在，且 `\n\n` 恰好一处 | 把 `gap` 改成恒 `''` → 红 **8 条**（A 5 + B 3），红出来的正是线上那个粘句症状 |
| `tools/check-store-order.mjs` D 段 | 由 4 条扩到 **7 条**，新增 `oral` / `rhythm` / `expression-decide` → `emotion-express` | 删 `oral` 的 `after` 并 build → 红 1 条（`9 > 30` 反了）；恢复 → 绿 |

#### 自检

30 项 pnpm 脚本 + `check-ui`（令牌 144 个、未定义 0）+ `check-acceptance`(90/90) + `check-contrast`(66/66) **全绿**。
`check:stale` 出包后转绿（不再警告应用落后）。

#### 实机取证（**新包**，两次 `build:app` + 两次重启）

| 能力 | 证据 |
| --- | --- |
| 旧告警清零 | 新包启动日志里「注册配置段失败」2 行、「未装载 `ondra-path-layout`」3 行、「仅内存」「重新引导」「重新攒样本」「表达档未装载」**全部 0 条** |
| `log-zh` 真落盘 | `~/Library/Application Support/com.ntars.ondra/logs/ondra-code.log` 12.5 KB（21:00） |
| 段落保住 | 同一提示词：`RAW` 3 段 → `DONE` 3 段（修复前 3 段 → 1 段）。实机文本「硬盘 2T…\n\n窗外的雨我没听见…\n\n（尾巴拍了一下）」 |
| 记忆写入 → 召回 | 写「下周三去杭州出差，住西湖边第二排那家酒店」→ 新会话问「我下周三去哪出差来着？」→ 答「杭州。西湖边的酒店」 |
| 主动消息判定 | `POST /api/proactive/check` → `allow:false, code:content-empty, quota:3, used:3`；真判据，非 `gate-missing` |
| TTS 全链路 | 受控触发（要求回复必须含「开心」）→ `gate: spoken=1, lastReason=ok` → `tts: calls=1 / ok=1 / played=1`，缓存文件 6→7。约 5 秒完成 |

#### 仍红 / 待裁决

1. **TTS 生产常态仍不出声**（第 3 轮起第 11 次挂着，本轮把成因量清了）：`intensityOf = max(|mood−0.5|, (energy−0.5)×0.5)`，
   而四种情绪信号（口误/道歉/道谢/重逢）的位移**全部乘 0.12**，单轮最大 `|mood−0.5| = 0.048`；
   `energy` 轴无任何写入方，恒在 0.6 → 贡献 0.05。**两条路都到不了 0.15**，
   所以强度那一支结构性常关，闸门实际只靠「本轮有情绪词」放行。
   而她的表达方式是动作描写（「尾巴快摇断了」）而不是情绪名词，40 词表很难命中。
   要真出声只有两条路，都得主人裁决：降 `intensity-min`，或让闸看「六态 ≠ 平静」而不是词表。
   **本轮未擅改**（0.15 是手册 §9.4 的数，词表是本插件唯一自定语料）。
2. `energy` 轴无写入方（第 9 轮起）：`emotion-express` 启动行「energy 60 · 数值来源 出厂基线」是这条的直接读数。
3. 记忆提炼丢细节（第 3 轮起）：召回拿到「西湖边的酒店」，`第二排` 被裁。
4. `organ-gate` 的 `tools` 服务全仓无提供方（第 12 轮记过）：门控注册但 `available=false`，
   本轮复核确认**没有任何包 provide `'tools'`**，也无 `ondra-subprocess` 包 → 诚实降级，非缺陷。
5. `proactive-quota.enable` 非真开关（第 7 轮起）；`maxFacts` 三处默认值漂移（第 10 轮修过一处，剩余未复核）。
6. 第 12 轮遗留的「`inject-dedupe` 说 `ondra-dialogue` 未装载」本轮**已随出包消失**，无需再查。

### 第 14 轮（2026-11-12 22:25）

**开场状态**：78 个包全部 `enabled=true` + `loaded=true`，停用段 **0**，`phase: ready`、`busy: false`。
主人 22:02 收尾了 `timeline.css`（21:23 之后又改了一版）——第 13 轮遗留的 `check-ui` 3 条红**自己绿了**
（6px/10px 已回到 8pt 栅格，`.message__row` 已有样式），本轮不需要介入前端。

#### 主线：装配期「同步取值」与 `after` 声明不一致

这一轮不开新角度，而是把 `check:order` D 段那条判据**推到全仓**：凡 `apply()` 里**同步** `ctx.get(X)`
并据此决定「注册什么 / 打什么日志」的，`after` 就必须列 X。一遍扫下来 **9 处**不符，全部同一根因。

| # | 位置（`plugins/ondra-core/src/index.ts`） | 取的是谁 | 不符的后果 | 严重度 |
| --- | --- | --- | --- | --- |
| 1 | `store-sqlite` 原本无 `after` | `path-layout` / `identity` | 取不到路径就 `log.error` + **拒绝注册** → 21 个消费方全拿 `undefined`（整库消失），此前只靠数组位置碰巧在前 | **最高**（静默灾难） |
| 2 | `store-json` 缺 `config-schema` | `config-schema` | 用户层 `enabled` 只经 `schema.resolve()` 进来；没有它就直接吃出厂 `false` → **设置页打开也不生效**，`/api/plugins` 却报 `loaded=true` | **高**（假开关） |
| 3 | `memory-vector` 缺 `store-memory` / `store-json` | 三个存储 | 取不到时把 `undefined` 传进 `VectorRepository` 构造函数**定死**，索引此后永远只在内存里，且日志谎称「没有存储端口」 | 中 |
| 4 | `emotion-express` 缺 `emotion-core` | `emotion-core` | 启动行固定写成「数值来源 出厂基线（未接情绪服务）」，而诊断接口里 `source` 明明是 `emotion` | 中（假诊断） |
| 5 | `rhythm-typing` 缺 `rhythm` | `rhythm` | 每次启动打「节奏服务未装载：所有回合都会一次性整段发出」——**实测早 28ms、相隔 58 行日志**，取值器是惰性的，功能一直正常 | 中（假诊断） |
| 6 | `emotion-project` 缺 `emotion-express` | `emotion-express` | 装配期 `stats()` 快照一次，取不到就打「投影一律不可用」 | 中（假诊断） |
| 7 | `memory-audit` 缺 `decay` / `graph` | `decay` / `graph` | **这条能真发作**：数组里 audit(258) 早于 decay(260)/graph(285)，字母序对它不利。默认配置靠三者共有的 `memory-core` 一起拖后才侥幸成立；**关掉 `memory-core` 后顺序真的反转**（audit 5 < decay 6），降级永久生效 | **高**（条件性真缺陷） |
| 8 | `memory-humanlike` 缺 `graph` | `graph` | `graphAvailable=false` 定死，荒诞分支建不了边（当前序侥幸，声明缺口） | 低 |
| 9 | `multimodal-memory` 缺 `evidence-gate` | `evidence-gate` | 启动打「没有 ondra-evidence-gate：入库不过证据闸」——实测只差 **12ms**（多模态 .391 / 证据闸 .414） | 中（假诊断） |

九处只改一个文件（全是声明），行为不变，只让顺序确定、诊断不说谎。

#### 自己踩出来的坑（本轮最该记住的）

补了第 4 条之后，`emotion-express` 整体后移，于是原本靠数组位置「碰巧在前」的 `emotion-project`
变成在前，启动日志**立刻多出一条新的假告警**（「六态服务未就绪」）。

> **改动一条 `after` 之后，必须重扫「谁在装配期快照了被移动的那个服务」。**
> 排序改动不是局部的——它把整条链上的相对位置都改了。第 6 条就是这么补的。

另一个坑：**判断修复是否生效前要先按时间过滤日志**。`logs --lines 260` 会把上一进程的尾巴一起带出来，
本轮一度据此误判成「多模态修复没生效」，实际是 14:46:56 那条属于 22:44 启动的旧进程，
新进程 22:52:29 启动后才真正验证（`awk '$1>="…T14:52"'`）。

#### 新增回归网

`check-store-order.mjs` D 段由 **7 条扩到 16 条**，新增 9 条一一对应上表。
反向验证：删掉 `rhythm-typing` 的 `ondra-rhythm` 后重建 → **恰好红 1 条且正是该条**；恢复 → 绿。
（按第 8 轮教训挑的是无传递依赖的节点。）

#### 实机取证（3 次 `build:app` + 4 次重启）

| 能力 | 证据 |
| --- | --- |
| 启动告警 8 → **7** | 消失的正是「节奏服务未装载」。剩下 7 条全部是诚实降级：`install-doctor` 空路径、`organ-gate` 无 `tools`、`process-host` 无 `subprocess`、`startup-check` 空 `root`、`window` 两条规格口径、`installer` 无清单 |
| 数值来源改真 | `六态表达就绪：平静（mood 0.53 / energy 60 / tension 0.00）… 数值来源 情绪服务`（原为 `mood 0.50 … 出厂基线`） |
| 多模态假日志清零 | 证据闸 `.510` 先于多模态 `.515`，那句「没有 ondra-evidence-gate」**不再出现** |
| 记忆写入 → 召回 | 写「旧工牌在书房左边第二个抽屉」→ `written=1`、总数 35→36 → 新会话问「旧工牌放哪儿」→ 答「书房左边的抽屉里」 |
| 主动消息判定 | `proactive-quota`「今日剩 0」+ `proactive-reason`「1 条候选全在冷却里」→ 不开口。**这是正常状态，不是故障**（第 7 轮已把兜底常量改成空串，判定码 `content-empty`） |
| TTS 全链路 | **受控 A/B**（`intensity-min` 0.15 → 0，配置已备份到 `backups/settings.json.20261112-1500`，验后 `config reset` 并与备份逐键 `diff` 一致）→ `decisions=1 / spoken=1 / calls=1 / ok=1 / failures=0 / played=1`，且分句兜底生效：「整段 41 字念不了，改念其中 16 字那句」 |

#### 自检

32 项 pnpm 脚本 + `check-ui`（令牌 144、未定义 0、✗ 0）+ `check-acceptance`(90/90) + `check-contrast`(66/66) **全绿**。

#### 仍红 / 待裁决

1. **TTS 生产常态仍不出声**（第 12 次挂，本轮又多一条量化证据）：单次情绪信号位移乘 0.12 后最大 `|mood−0.5| = 0.048`，
   `energy` 轴无写入方恒 60 → 贡献 0.05，**两条路都到不了 0.15**。本轮实机确证：把阈值临时降到 0，整链立刻通（`ok=1/played=1`）。
   即**链路没坏，是门槛与位移量级差一个数量级**。两条路都要主人裁决：降 `intensity-min`（0.15 → 0.05 量级），
   或让闸看「六态 ≠ 平静」。**未擅改。**
2. **记忆提炼剥掉用户口述的数字**（第 3 轮起）：本轮两条实证——「B2 层 317 号」「W-2841」全被裁成「地下车库车位旁」「书房左边抽屉」。
   根因是 `memory-extract` 的 `requireToolForDigits` 默认 `true`（`prompt.ts:66` 规则 4 + `verify.ts:197-215` 数字游程检查），
   文档举例是「他说他 28 岁」这类**第三方转述**，但它把「记一下我的车牌是沪A·8Z6K」这种**用户指令**也一起剥了。
   要改就得同时改提示词与 `verify.ts`（规则与检查一一对应，只改一边会造成规则与检查脱节）。**待裁决**。
3. `energy` 轴无写入方（第 9 轮起）：`emotion-express` 的 `joyful`（`energy > 60`）与 `sleepy`（`energy < 30`）两态**恒不可达**，六态实际只剩四态。
4. `tools` / `subprocess` 两个服务键全仓无提供方（本轮复核，`provide('tools')` 0 命中）。`organ-gate` 不是「拒绝所有工具」，是**纯 no-op**
   （`before()` 取 `agent.ctx.tools`，取不到就 `plainSkip('no-scope')`，不 deny）。属子系统缺席，不是装载缺陷。
5. `ondra-persona-evolve` 的 `adjust()` **全仓零调用方** → 特质漂移永不发生，`drift_entries` 恒 0 行（阈值漂移那一半是活的）。
   接一个调用方属新行为，需定口径（每 N 轮？只在大事件？）。
6. `ondra-breath` 的服务键**零消费方** → 「呼吸感 / 正在输入」从未显示（服务注册了，没人调 `presence()`）。
7. `ondra-multimodal-memory` 服务键零消费方（用户已打开，但无人调 `ingest()`）；且它的 `schema.register` 未挂 `ctx.effect`（15 个包里唯一违反这条纪律的）。
8. `proactive-quota` 的 `plan()` / `interval()` / `streak()` 全仓零外部调用 → `min-interval-minutes`、放弃率、退场句全是死配置，实际只有每日额度生效；
   `noteUserSpoke()` 也零调用 → `proactiveSinceUser` 永不复位。
9. `/api/plugins` 的 `loaded` 取自「请求装载名单」而非 `coreResult.loaded`（`cordis-host/index.ts:1055` vs `:1256`）→
   任一成员 apply 抛错时仍报 `loaded=true`。当前 78/78 全装，无实机症状。

#### 附：分诊 A 组复核后的补记（第 14 轮）

A 组在报告后复核工作树，撤回 4 条（`memory-vector` / `store-sqlite` / `store-json` / `memory-audit` 均已在本轮修掉），
并用 5 种启用组合（默认 46 / 全 75 / 各自减 `memory-core` / 仅 JSONL 后端）复算 **0 违规、0 环**，`lib` 与 `src` 逐条一致。

仍成立 1 条，**本轮刻意不改**：

`ondra-snapshot/src/index.ts:139` 的取用链只有 `store-sqlite ?? store-memory`，不含第三个后端 `store-json`；
取不到就 `warn` + `return`（服务不注册）。而 `service.ts:96-104` 本来能优雅处理无 SQL 的端口
（`availableCode='sql-unsupported'`），文件头也写「不可用时服务仍注册，调用返回原因码拒绝」——**代码与自己的契约不一致**。

不改成「注册但不可用」的理由：`memory-dream` 只在 `snapshot === undefined` 时记 `backup: skipped`，
若改成注册，它会去调 `create()` 拿到拒绝，于是「干净跳过」变成「备份失败」。**两种口径都自洽，
差别是产品语义，不是对错**——需主人定：`snapshot` 无 SQL 时该「不注册（干净跳过）」还是「注册但报原因码」。
影响面仅限「SQLite 打不开 + memory 关闭 + 只开 JSONL」这一种组合，当前无实机症状。
