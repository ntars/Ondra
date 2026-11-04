# ondra-installer

> O-079 · L7 系统与交付 · 档位〔研〕 · 服务键 `ondra-installer` · 状态 **done（静态自检通过，未实装运行）**

清单制安装：**九步流水线 + 每组件独立 sha256 + 记账本 + `bootstrap-ok` 自检**。默认**演练**，不写盘。

---

## 一、职责

1. **九步流水线**（`steps.ts`）：预检 → 清单 → 定位 → 校验 → 复用 → 冲突 → 落盘 → 记账 → 自检。前一步不过，后一步不跑。
2. **每组件独立 sha256**（`hash.ts` + `manifest.ts`）：逐组件算、逐组件比，**不是整包一个哈希**——整包哈希答不了「哪一个坏了」。
3. **记账本**（`ledger.ts`）：`user/.ondra-bootstrap.json`，0600，原子写，**两阶段**（`pending` → `installed`）。
4. **`bootstrap-ok` 自检**（`service.ts` 的 `verify()`）：账本 / 覆盖 / 文件与内容 / 清单漂移 / 完成戳，五项。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 下载组件 | 本版没有网络端口（禁装依赖）。组件由安装包随附，本包只从 `sourceDir` 读 |
| 解压归档 | **不做**。`node:zlib` 不认 zip/tar，禁装依赖；`kind: archive` 如实报不支持 |
| 回滚 | O-009 `ondra-snapshot`。本包**绝不自动删**已装文件 |
| 挑端口 / 开浏览器 | O-083 `ondra-port-picker` / O-080 `ondra-process-host`。手册 §6.4 的「四件套」里后两件不属安装器 |
| 市场清单与认可 | O-078 `ondra-market`（本包只消费它的 `plan().spec`） |
| 首启引导 | O-082 `ondra-onboarding` |
| 加载自检（入口树） | O-077 `ondra-startup-check`。见「七」第 2 条：组件不是插件包，那一项对本包无意义 |

### 四条刻意的「不做」

1. **不猜路径。** 三个路径默认全空，空着报 `no-manifest` / `no-source` / `no-dest`。
2. **不自动回滚。** 一个会自己删文件的安装器，第二次误删就没人敢用了。
3. **不「先装上再说」。** 哈希不通过，一个字节都不落盘。
4. **不覆盖别人的文件。** 账本里没有、目标位置有同名文件 = 别人的东西，默认拒绝（`allowOverwrite` 才放行）。

## 三、服务键与方法

```
ondra-installer        ← 连字符，不是带冒号的写法
```

| 方法 | 说明 |
|---|---|
| `plan()` | 九步声明 + 清单里的组件（只读，不跑） |
| `run({ dryRun? })` | 跑一轮。默认按配置的 `dryRun`。**永不抛错** |
| `verify()` | `bootstrap-ok` 五项自检（只读，但会重算全部哈希） |
| `ledger()` | 当前账本快照 |
| `steps()` | 九步声明（含每步出处） |
| `status()` / `stats()` | 现状 / 计数 |
| `useSource()` / `useSink()` / `useRuntime()` | 换端口 |
| `dispose()` | 撤（幂等） |

### 九步与出处

| # | id | 做什么 | 出处 |
|---|---|---|---|
| 1 | `preflight` | Node ≥ 20 | 手册 §6.4「一键部署四件套：检查 Node≥20」 |
| 2 | `manifest` | 读 + 解析 + 展平 + 逐条校验 | 手册 §4.6「`components` 嵌套」+「每组件独立 sha256」 |
| 3 | `source` | 定位组件文件、查大小上限 | 手册 §4.6（没有真实文件，哈希无从谈起） |
| 4 | `verify` | 逐组件算实际哈希 vs 声明 | 手册 §4.6「每组件独立 sha256」 |
| 5 | `reuse` | 账上已装且文件哈希一致 → 跳过 | 手册 §4.6「记账本」；幂等属 master-plan §14.4「稳定优先」 |
| 6 | `conflict` | 目标位置有「不是我装的」文件 → 拒绝 | **反推**（手册无出处，见「七」第 1 条） |
| 7 | `install` | 临时文件 → 复验 → 原子改名 | 手册 §4.6；验收口径见 §6.4 |
| 8 | `ledger` | 写 `manifestSha256` + `bootstrapAt` | 手册 §4.6「`.ondra-bootstrap.json` 记账」 |
| 9 | `self-check` | 跑 `bootstrap-ok` | 手册 §4.6「`bootstrap-ok` 自检」 |

### 原因码

| 字段 | 值 |
|---|---|
| `status().reason` | `disabled` / `no-manifest` / `no-source` / `no-dest` / `no-ledger` |
| `run().verdict` | `ok` / `failed` / `blocked` |
| `step.status` | `ok` / `skipped` / `failed` / `blocked` / `unsupported` |
| `verify().verdict` | `ok` / `fail` / `unverifiable`（`bootstrapOk` 另有 `boolean \| null`） |

## 四、清单格式（format 1）

```json
{
  "version": 1,
  "components": [
    { "name": "node", "version": "22.11.0", "file": "node-v22.11.0-darwin-arm64", "sha256": "…64 位小写…" },
    { "name": "runtime", "components": [
      { "name": "app", "file": "app.asar", "sha256": "…" }
    ] }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 叶名或组名；展平路径用 `/` 连接（`runtime/app`） |
| `sha256` | 是（叶） | 64 位**小写**十六进制。缺了整份清单不通过 |
| `file` | 是（叶） | 相对 `sourceDir` 的路径；不得绝对、不得含 `..`、不得含反斜杠 |
| `version` | 否 | 只进账本，不参与比较 |
| `kind` | 否 | `file`（默认）/ `archive`（本版不支持） |
| `optional` | 否 | 缺了不判失败，只跳过 |
| `exec` | 否 | 装完给执行位 `0755`；省略 = `0600`。**运行时二进制必须写 `true`**，否则装了个跑不起来的 node |
| `dest` | 否 | 相对 `destDir` 的子目录；省略 = 直接放 `destDir` |

**清单摘要**取「规范化后的组件表」而不是文件原文：改缩进不算改清单，否则一次纯格式调整就会让账本判漂移，而假警报会让人开始无视这条检查。

## 五、配置

| 字段 | 默认 | 理由 |
|---|---|---|
| `enable` | `true` | 关掉后 `run()` 拒绝，`verify()` 仍可读账本 |
| `dryRun` | **`true`** | 安装是唯一会写用户目录的能力；不可逆操作放到明确确认之后 |
| `manifestPath` | `''` | **空 = 不装**（报 `no-manifest`）。猜清单会装出一套错组件 |
| `sourceDir` | `''` | **空 = 不装**（报 `no-source`） |
| `destDir` | `''` | **空 = 不装**（报 `no-dest`）。由壳/引导页在首启写入 |
| `ledgerPath` | `''` | 空 = `user/.ondra-bootstrap.json`（0600） |
| `maxComponents` | `256` | 防一份写坏的清单把安装拖死 |
| `maxComponentBytes` | `268435456`（256 MiB） | 超过判失败，不硬读也不半读 |
| `verifyAfterCopy` | `true` | 落盘后再算一次哈希再改名 |
| `allowOverwrite` | `false` | 只放行「账本没记录但目标已有同名文件」这种**收编**场景 |
| `verbose` | `false` | 每步一行日志（`run()` 本身每步都打一行 info） |

## 六、边界

- **服务键 / 配置键 / 段键**：`ondra-installer` / kebab 字段名 / 段 `installer`，全部匹配 `^[a-z][a-z0-9_-]{1,63}$`（§8.4）。
- **写盘只有一个入口**（`FileSink`）：所有落盘都经它，看一眼 `local.ts` 就能答「有没有绕过临时文件直接写目标」。
- **临时文件与目标同目录**：`rename` 只在同一文件系统内原子；放 `/tmp` 跨卷会退化成「复制 + 删除」，中间那段时间目标文件不存在。
- **哈希只有一处实现**（`hash.ts`）：`verify` 步与 `verify()` 共用，不各写一份。
- **不建定时器、不监听端口、不抓网络**。
- **不进提示词、不碰会话**（master-plan §6 禁令 5）。

## 七、已知限制

1. **九步的名称与顺序手册没给。** 全文检索「九步流水线」只有 master-plan §5 与台账那一行，都没展开。本包的九步是从 §4.6 与 §6.4 反推的，每步在 `STEP_DECLS[].source` 里带出处；`conflict` 一步**明确标「反推」**，不假称手册给过。
2. **`bootstrap-ok` 没有「宿主会不会加载我」这一项。** 本包的产物是运行时组件（node、静态资源），不是插件包；O-077 的 `hostLoads(name)` 问的是「这个包名在不在入口树」，对组件无意义，拿它检安装器自己又是自欺（它正在跑，当然在）。所以这一项不做，而不是硬凑一个仪式。
3. **不支持归档件。** `node:zlib` 只认 gzip/deflate，zip/tar 要额外依赖，本轮禁装。`kind: archive` 在 `install` 步报 `failed` 并写明原因，**不假装解开**。
4. **没有网络端口。** 组件必须随安装包到达 `sourceDir`。要做「在线下载」，那是 O-079 之外的下载器，且要先过 O-076 的出站判定。
5. **不查磁盘剩余空间。** Node 没有跨平台的 `statfs`；本包禁装依赖，所以 `RuntimeProbe.freeBytes()` 如实返回 `null`（判不了），不编一个数字。
6. **`verify()` 会读一遍全部组件。** 100 MB 量级大约几百毫秒，但它不适合每次启动都跑，所以 `apply()` **不自动调它**。
7. **`reuse` 会重算目标文件的哈希。** 只信账本不验文件，等于「账上说装了就算装了」——而那正是本包要消灭的旧病。
8. **不自动回滚。** 装到一半失败时，已成功的文件保留、临时文件删掉、账本记 `failed`。回滚请用快照。
9. **不校验 `version` 的语义。** 它只进账本，不做 SemVer 比较——升级判定不在本包（没有「更新」概念，重跑即重装）。
10. **被拒或异常时 `run().steps` 只有 1 条。** `enable=false` / 已卸载 / 流水线自己抛异常时，返回的 `steps` 只含 `preflight` 一条（后面八步无从谈起），`verdict: blocked`。形状仍是合法的 `StepResult`，但**长度不是九**——消费方别假设恒九条。
11. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app。全部结论来自静态检查与纯逻辑对拍。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 清单制 Bootstrap（嵌套 + 每组件哈希 + 记账 + 自检） | 手册 §4.6 转述的 `DSH-Memory/tools/check-install.mjs` 与 Bootstrap 清单 | — | — | 「`components` 嵌套」「每组件独立 sha256」「`.ondra-bootstrap.json` 记账」「`bootstrap-ok` 自检」四条要求 | `manifest.ts` + `ledger.ts` + `service.ts#verify` | 否（只有思路，手册转述） |
| 一键部署四件套 | 手册 §6.4 | — | — | 「检查 Node≥20」作为第一步 | `stepPreflight` | 否 |
| 原子写（临时文件 + rename） | 本项目 O-076 / O-078 的同类做法 | 自有 | 自有 | 「同目录临时文件 + rename」避免半截 JSON | `ledger.ts#write`、`local.ts#writeTemp/commit` | 是（自有资产） |
| 流式哈希 | Node 内建 `node:crypto` + `node:fs` | nodejs.org | MIT（Node 本体） | `createHash` + `createReadStream` | `hash.ts#hashFile` | 否（内建 API） |
| 两阶段记账 | 本项目 O-074 的单实例状态机 | 自有 | 自有 | 「先记中间态，再记终态」 | `ledger.ts` 的 `pending` → `installed` | 是（自有资产） |
| 四值判定 | 本项目 O-075 / O-077 | 自有 | 自有 | 判不了就说判不了 | `BootstrapVerdict` 四值 + `bootstrapOk: null` | 是（自有资产） |

**档位〔研〕的依据**：手册 §1.8 的「必须自研」清单里没有安装器，但生态里也没有「带记账本 + `bootstrap-ok` 的 Cordis 插件」——插件市场管的是**插件包**安装，不是**运行时组件**安装，语义不同。手册 §4.6 点名的三处缺口（无记账本、无自检命令、整包哈希）必须自己补，所以按〔研〕写；但**只写差异部分**：复制、哈希、改名全用 Node 内建，一行依赖都不加。

## 九、多方案分支说明

master-plan §14.3 的已知多方案项**无对应项**。本包内两处真分支：

| 能力 | 方案 A（默认） | 方案 B | 处理 |
|---|---|---|---|
| 组件来源 | 本地 `sourceDir`（`LocalSource`） | 任何实现 `ComponentSource` 的端口（将来接下载器） | **端口隔离**：接口唯一，实现各一个文件；下载器落地时不动流水线 |
| 写目标 | 本地 `FileSink`（复制 + rename） | 任何实现 `FileSink` 的端口 | 同上 |

端口化不是「为了测试」：它让**写动作只有一个入口**，于是「有没有绕过临时文件直接写目标」这个问题有确定答案。

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「装不了」。没有定时器、没有 socket、不监听端口。`dispose()` 清空端口引用。副作用只有两处，都是本包自己的文件：账本 `user/.ondra-bootstrap.json` 与安装目标目录里由本包写入的组件。
2. **我的状态存在哪？** 账本落 `user/.ondra-bootstrap.json`（0600，原子写）；计数、清单缓存、端口引用**只在内存**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.installer`；`status()` 有 `reason` 与 `dryRun`；`run()` 每一步都返回 `status` + `detail` + `findings`，**永不抛**；`verify()` 五项逐项给结论；`stats()` 有 `failed` 计数。
4. **我依赖谁？缺席时我怎么降级？** `ondra-identity`（缺 → 日志前缀兜底）、`ondra-path-layout`（缺 → 账本路径只能靠 `ledgerPath`，否则 `no-ledger`）、`ondra-config-schema`（缺 → 本地校验）、`ondra-clock`（缺 → `Date.now`）。**一个都不 `inject`**。
5. **我和同域的谁共享了可变状态？** 没有。与 O-078 的分工是「去安装」对「给参数」：本包只从 `plan().spec` 取字符串，不持有市场对象；与 O-077 的分工是「装组件」对「验插件加载」，两者不共享任何对象。

## 十一、与文档的口径差异（必须留痕）

1. **九步的名称与顺序在手册里没有**（见「七」第 1 条）。台账写「九步流水线」四个字，master-plan §5 也只重复这四个字。本包按 §4.6 + §6.4 反推，并逐条标出处；推不出的一步（`conflict`）标「反推」，不编一个「手册说」。
2. **`bootstrap-ok` 不含入口树检查**（见「七」第 2 条）。手册 §4.6 只说「`bootstrap-ok` 自检」，没说验什么；本包按「装好了没有」定五项，把「宿主会不会加载我」留给 O-077。
3. **`allowOverwrite` 是新增配置**，手册没有。它的存在是为了把「收编一个已有安装」与「覆盖别人的文件」分开——后者是删了就找不回来的操作。
4. **master-plan §3.1 / §6 仍写 `ondra:<短名>`**，与同文件 §3.3-6、手册 §8.4 冲突；按「手册优先」全仓连字符，**未改 master-plan**。
