# ondra-startup-check

> O-077 · L7 系统与交付 · 档位〔研〕 · 服务键 `ondra-startup-check` · 状态 **done（静态自检通过，未实装运行）**

十项加载自检。**只判定不拦启动**：它验的不是「代码对不对」，而是「它到底有没有被装上」。

---

## 一、职责

1. **十项判定**（`checks.ts`）：master-plan §19.1 的九项 + 手册 §8.3 的第十项。
2. **第十项：宿主会不会真的加载我**（`compose.ts` + `yaml.ts`）：移植宿主 `applyEntryPatches` 的语义，算出「宿主会看到的那份入口树」，再看自己在不在里面。
3. **全仓索引**（`scan.ts` + `service.ts`）：扫出每个包 `ctx.provide()` 的键，供「服务键唯一」与「依赖可解析」两项使用。
4. **只读读端口**（`source.ts`）：路径关在根目录里，越界返回 `missing` 而不是抛错。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 改入口树 / 修文件 / 自动补 `ondra.bundle.patch` | **不做**。自检不是修理工；改了就不再是「它看到什么」 |
| 拦启动、禁用一个加载失败的包 | **不做**。台账原话「只判定不拦启动」 |
| TypeScript 语义分析（类型是否相容） | **不做**。本轮禁 `tsc`；只做文本级判定 |
| 安装器与 bootstrap 记账 | O-079 `ondra-installer`（`bootstrap-ok` 自检归它） |
| 出站与隐私判定 | O-076 `ondra-privacy` |
| 界面 | 应用外壳（L8 已下线；本包只出 `check()` / `checkAll()` / `status()` 三个只读入口） |

### 四条刻意的「不做」

1. **不拦启动。** 一个会拦启动的自检，在一次误报之后就会被永久关掉——那比没有自检更糟。所以 `apply()` 不 await 任何检查，失败只进日志。
2. **不修文件。** 「自检顺手把补丁补上」会让下一次自检永远通过，而人再也不知道当初错在哪。
3. **不猜扫描根。** `root` 默认空 = 什么都不扫。猜出来的根会让自检对着错的目录跑出「全过」，那是假的安全感。
4. **不把判不了说成通过。** 补丁里有 `!!js` / 锚点 / 流式集合时标 `unverifiable`。

## 三、服务键与方法

```
ondra-startup-check        ← 连字符，不是带冒号的写法
```

| 方法 | 说明 |
|---|---|
| `check(name?)` | 检查一个包（空 = 本插件）。**永不抛错** |
| `checkAll()` | 扫全部包，返回报告数组 |
| `index()` / `refresh()` | 取 / 重建服务键索引 |
| `hostLoads(name?)` | **只跑第十项**（不建索引，启动期用） |
| `status()` / `stats()` | 现状 / 计数 |
| `useSource(source \| null)` | 换读端口（换即失效索引） |
| `useOracle(oracle \| null)` | 换权威组合端口（宿主若愿意提供） |
| `dispose()` | 撤（幂等） |

### 十项

| # | id | 标题 | 判据 | 判不了时 |
|---|---|---|---|---|
| 1 | `files` | 结构完整 | 七个必需文件都在 | — |
| 2 | `manifest` | 清单合法 | name / type / main / types / exports / files / cordis 两侧 | — |
| 3 | `tsconfig` | 编译配置 | NodeNext ×2 / strict / rootDir / outDir / declaration | — |
| 4 | `entry` | 入口契约 | `export const name` 与包名一致 + `apply(` 存在 | — |
| 5 | `service-key` | 服务键唯一 | 形状合规 + 全仓无第二归属 | 索引空 → `warn` |
| 6 | `dep-resolvable` | 依赖可解析 | 每个 `ctx.get` 键都有主（含宿主键） | 索引空 → `unverifiable` |
| 7 | `no-cross-import` | 无越界 import | 没有 `from 'ondra-…'` | — |
| 8 | `degrade` | 降级到位 | `const x = ctx.get(…)` 后 8 行内有判空痕迹 | 无赋值形状 → `unverifiable` |
| 9 | `deliverables` | 交付物齐全 | README（技术来源 / 隔离五问）+ 两个 locale | — |
| 10 | `host-loads` | 宿主会加载我 | `ondra.bundle.patch` + 补丁可解析 + 入口树里有我 + 字段合规 | 子集不支持 → `unverifiable` |

报告级结论按 §19.4 三档：有 `fail` → `fatal`；有 `warn` / `unverifiable` → `partial`；否则 `pass`。第十项另有一个独立字段 `hostLoads: boolean | null`——它答的是元命题，界面可以直接拿它做红点。

## 四、补丁语义：移植时按源码，不按摘要

手册 §8.3-2 的摘要是「目标不存在 / 不是 group / `name` 不一致 → 跳过」。读起来像三者都管 `insert` 行。**源码不是这样**（`desktop/vendor/include/src/index.ts` 的 57~127 行）。三处必须按源码：

1. **`name` 不一致的检查只发生在「无 insert」的补丁行上。** `name` 在循环开头被解构出来，`insert` 分支从头到尾没看它。照摘要写，会对一份实际能加载的补丁报 `fail`。
2. **`insert` 带 id 时，目标 `config` 不是数组就当场改成 `[]` 再 push。** 静默修正，不告警。本包照做（并把它写进 `compose.ts` 注释），因为「宿主会怎么做」才是第十项要回答的。
3. **被 `insert` 的行立刻进索引。** 同一条补丁列表里，后面的补丁可以命中前面刚插入的行。漏掉这一步，「先插入、再配置」会被误报成「目标不存在」。

## 五、配置

| 字段 | 默认 | 理由 |
|---|---|---|
| `enable` | `true` | 只判定不拦启动，默认开着没有代价 |
| `root` | `''` | **空 = 不扫**。猜出来的根会跑出假的全过 |
| `maxFilesPerPackage` | `400` | 防一个坏包把扫描拖死 |
| `maxFileBytes` | `262144` | 超过按「太大」处理（判不了，不硬读） |
| `maxPackages` | `200` | 防根目录指错到 `/` |
| `hostKeys` | `browserUse` / `credentials` / `llm` / `webServer` | 全仓 `ctx.get()` 里实际出现的四个非 `ondra-` 键（grep 得到，**不是手册给的**） |
| `selfCheck` | `true` | 启动时只跑第十项并打日志 |
| `verbose` | `false` | 每次检查一行日志 |

## 六、边界

- **服务键 / 配置键 / 段键**：`ondra-startup-check` / kebab 字段名 / 段 `startup-check`，全部匹配 `^[a-z][a-z0-9_-]{1,63}$`（§8.4）。
- **补丁语义只有一处**（`compose.ts`）：`check()` 与 `hostLoads()` 共用，不各写一份。
- **YAML 解析只有一处**（`yaml.ts`）：只服务补丁文件，不做通用 YAML。
- **路径关根**（`source.ts` 的 `#resolve`）：`..`、绝对路径、`\0` 一律 `missing`；不递归 `node_modules` / `lib`。
- **不装定时器**：没有轮询；索引按需重建（`refresh()`）。
- **不进提示词**、**不碰会话**（master-plan §6 禁令 5）。

## 七、已知限制

1. **YAML 是子集，不是 YAML。** 只认块序列 / 块映射 / 单行标量 / 注释。`!!js`、锚点、别名、块标量、流式集合一律标 `unverifiable`。全仓 82 个 `cordis.patch.yml` 去注释后**只有一种形状**，所以这个子集对当前仓是可证的；将来若有人用 `!!js`，第十项会明说「判不了」。
2. **`compose.ts` 用 JSON 往返代替 `structuredClone`。** 因为子集拒绝 `!!js`，值一定是 JSON 安全的；代价是「值里带 `undefined`」会被丢掉（YAML 不会产生 `undefined`）。
3. **「降级到位」是启发式。** 只看 `const x = ctx.get(…)` 之后 8 行。判空写在更远处会误报 `warn`（不是 `fail`）。
4. **「服务键唯一」依赖全仓索引。** `root` 没配时索引为空，这一项只验形状并如实说「没验唯一」。
5. **宿主键清单是 grep 来的，不是规范。** 全仓 `ctx.get()` 里非 `ondra-` 的键只有四个，所以默认值就这四个。将来某个插件用了第五个，需要手动加进 `hostKeys`——否则会被报成悬空依赖。
6. **没有 `reopen` 式的自愈。** 索引是快照；新长出来的包要 `refresh()` 才看得见。
7. **不做语义分析。** 「类型不相容」「导入名写错」这类问题文本级判不出来（`import` 名是否存在需要类型系统）。本包只判「键在不在索引里」「有没有 `from 'ondra-…'`」。
8. **注释遮罩是按行状态机，不是语法分析器。** 正则字面量里若出现两个**连续**斜杠，那一行会被当成注释截断。本仓没有这种写法（隐私包那条 URL 凭据正则是转义过的 `\/\/`，不是 `//`），但这是文本级扫描的固有边界。
9. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app；全部结论来自静态检查与纯逻辑对拍。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 补丁应用语义 | 上游 `desktop/vendor/include/src/index.ts` 的 `applyEntryPatches` | 本仓 | 自有（上游） | 六条分支、insert 索引、name 只校验 override 行 | `compose.ts` 结构对位移植 | 否（同仓只读，未复制代码） |
| 补丁层组合 | 上游 `desktop/packages/boot/app-boot/src/profile.ts` 的 `composeEntries` / `bundlePatchFiles` | 本仓 | 自有（上游） | 「空根 + 逐层 flat」与「一个路径或一组路径」 | `composeEntries()` + `patchDeclarations()` | 否 |
| 三条静默失败 | 手册 §8.3 | — | — | 声明漏写 / 语义写错 / 入口字段 | 第十项的四个判据 | 否 |
| 九项机械自检 | master-plan §19.1 | — | — | 逐项的判定方法 | `checks.ts` 的九个函数 | 否 |
| 注释遮罩（等长替换） | 本项目纪律 144（剥注释后偏移会错位） | 自有 | 自有 | 「换空格不删字符，行号才不错」 | `scan.ts` 的 `maskComments` | 是（自有资产） |
| 四值判定 | 本项目 O-075 `PrereqVerdict` / O-136 `MatchKind` | 自有 | 自有 | 判不了就说判不了 | `CheckVerdict` 四值 | 是（自有资产） |

**档位判定〔研〕的依据**：手册 §1.8 的「必须自研」清单里没有「加载自检」，但生态里也没有可直接用的实现——宿主的 `applyEntryPatches` 是**运行时**实现，不是自检工具，且本仓 82 个插件只声明 `@ntars/cordis` 一个 peer，多声明一个宿主包会让「宿主没带它」时整插件加载失败。所以按手册 §8.3 的原话「用**移植的**…」做结构对位移植，档位维持〔研〕。

## 九、多方案分支说明

master-plan §14.3 的已知多方案项**无对应项**。本包内部一处真分支：

| 能力 | 方案 A（默认） | 方案 B | 处理 |
|---|---|---|---|
| 入口树计算 | 本包移植版（`compose.ts` + `yaml.ts`） | 宿主权威实现（`BootOracle` 端口） | **能兼容就兼容**：`useOracle()` 接进来即用，本包一行不改；算不了（返回 `null`）就退回移植版 |

这条分支的意义：移植版对 `!!js` 无能为力，而宿主本来就能算。留一个端口，等于留一条「将来接上真实现」的路。

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「自检报不报」。`dispose()` 清空索引与端口引用；没有定时器、没有 socket、不监听端口、不写任何文件。
2. **我的状态存在哪？** **只在内存**：索引快照、计数、读端口引用。**不落盘任何东西**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.startup-check`；`status()` 有 `reason`（`disabled` / `no-root`）与 `indexedAt`；`check()` 出错回 `unverifiable` 而不是抛；`stats()` 分 `fatal` / `partial` / `passed` 三桶。
4. **我依赖谁？缺席时我怎么降级？** `ondra-identity`（缺 → 日志前缀兜底）、`ondra-config-schema`（缺 → 本地校验）、`ondra-clock`（缺 → `Date.now`）。三个全软，一个都不 `inject`。**读端口不是服务键**，是本包自己按 `root` 建的。
5. **我和同域的谁共享了可变状态？** 没有。与 O-076 的分工是「加载自检」对「出站判定」，两者不共享任何对象；与 O-079 的分工是「判定」对「安装与记账」。

## 十一、与文档的口径差异（必须留痕）

1. **「自检十项」的第十项在手册里只有一句话。** §8.3 的原话是「自检十项的第十项：验证『宿主会不会真的加载我』」，没给判据。本包的四个判据（声明 / 可解析 / 在树里 / 字段合规）是从同节的三条静默失败逐条反推的，写在 `checks.ts` 的 `checkHostLoads` 注释里。
2. **手册 §8.3-2 的摘要与源码不一致，按源码。** 见「四」。这是本轮最重要的一条口径裁定。
3. **宿主键清单是 grep 得到的，不是规范。** 手册没给「宿主提供哪些服务键」的表；`browserUse` / `credentials` / `llm` / `webServer` 四个来自全仓 `ctx.get()` 的实际出现。所以它可配。
4. **master-plan §3.1 / §6 仍写 `ondra:<短名>`**，与同文件 §3.3-6、手册 §8.4 冲突；按「手册优先」全仓连字符，**未改 master-plan**。
