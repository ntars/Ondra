# ondra-install-doctor

> O-133 · B6 运行时治理 · 档位〔研〕· 服务键 `ondra-install-doctor` · P1
>
> 安装自检：用移植的 `parsePatchYaml / applyEntryPatches / composeEntries` 算出
> **「宿主会看到的那份入口树」**，报告哪些 bundle 会被跳过、补丁告警有几条。
> **只读。不改 profile、不写 `disabled`、不装包、不跑器官。**

## 一、职责

| # | 做什么 | 在哪 |
|---|---|---|
| 1 | **补丁 YAML 子集解析**：块序列 + 块映射 + 单行标量，超出的明确拒绝 | `src/yaml.ts` |
| 2 | **补丁语义移植**：`applyEntryPatches` / `composeEntries`，逐层应用并记来源 | `src/compose.ts` |
| 3 | **入口树算出来**：扁平视图 + 结构检查（第七字段 / id 合规 / 重复 / group 无数组） | `src/compose.ts` |
| 4 | **只读磁盘端口**：profile 清单 → .ondra.profile.bundles` → 逐层 `ondra.bundle.patch` | `src/source.ts` |
| 5 | **跳过清单**：7 类 `BundleSkipCode`，与宿主 `SkippedBundle.reason` 同义分档 | `src/source.ts` |
| 6 | **结论分级 + 纯文本报告**：可直接整段贴进 issue | `src/report.ts` |
| 7 | **服务与缓存**：内容指纹 + TTL，**不装定时器** | `src/service.ts` |

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 逐包十项体检（「我这个包会不会被加载」） | O-077 `ondra-startup-check`（本包只做装配级） |
| 装包 / 卸载 / 改 `node_modules` | 宿主的 .ondra.plugin` 命令，本包**只读** |
| 写 `disabled` / 改 profile 清单 | 用户或 `plugin-manager`，本包一个字节都不写 |
| 执行器官、跑任何插件代码 | O-132 `ondra-organ-host`（本包连它的服务都不取） |
| 判定「入口能不能跑起来」 | 本包只判**入口树形状**，不判运行时 |

### 三条刻意的「不做」

1. **不猜 profile 路径。** 宿主解析 profile 靠 `resolveProfileDir(name, home)` +
   `resolveBundleDir(…, installAnchor)`，依赖 .ondra. 的安装锚点与 `node_modules` 提升规则。
   本包拿不到安装锚点，硬抄一份必然与宿主漂移——那时报告说「装得上」而宿主说
   「skipped」，**比没有报告更坏**。所以 `profile-path` 默认空，空就报 `no-profile`。
2. **不执行器官、不 `import` O-077。** 台账写「O-133 只读，绝不执行器官」；
   §15.5 又禁止同轮互相 import。两条合起来决定了那份移植**必须存在两处**（见已知限制 1）。
3. **不改任何 `verdict` 来「看起来更好」。** 判不了就 `unverifiable`，不许降级成 `pass`。

## 三、它回答的问题与 O-077 不同

| | O-077 `ondra-startup-check` | 本包 `ondra-install-doctor` |
|---|---|---|
| 粒度 | **一个包** | **一份 profile** |
| 问 | 「我这个包会不会被加载」 | 「这份 profile 装配出来长什么样」 |
| 输入 | 包目录 | profile 目录（.ondra.profile.bundles`） |
| 输出 | 十项判定 | 入口树 + 跳过清单 + 补丁告警 |
| 典型失败 | 漏 `ondra.bundle.patch` | profile 里没登记这个包 / 包解析不到 |

**为什么要两个**：一个包的补丁写得完全正确，不代表它所在的 profile 装得上。
下面四种失败全发生在包**外面**，而且全都只有一行 stderr、界面上看不出来：

1. profile 的 .ondra.profile.bundles` 里没登记它；
2. 登记了但 `node_modules` 里解析不到；
3. `package.json` 缺 `ondra.bundle`（§8.3-1 最隐蔽的那个）；
4. `ondra.bundle.patch` 写的路径相对包目录是错的。

## 四、补丁语义（手册 §8.3-2，按源码而非摘要实现）

| 规则 | 宿主行为 | 本包怎么判 |
|---|---|---|
| `insert` 无 `id` | 追加到根入口列表 | 记录新增行与来源层 |
| `insert` 带 `id`，目标不存在 | 告警 + 跳过 | `insert-target-missing`（致命） |
| `insert` 带 `id`，目标非 `group` | 告警 + 跳过 | `insert-target-not-group`（致命） |
| `insert` 带 `id`，目标 `config` 非数组 | **静默改成 `[]`** | `group-without-list`（**非致命**，宿主不报） |
| 无 `insert` 且无 `id` | 告警 + 跳过 | `id-required`（致命） |
| 无 `insert`，目标不存在 | 告警 + 跳过 | `target-missing`（致命） |
| 无 `insert`，`name` 不一致 | 告警 + 跳过 | `name-mismatch`（致命） |
| `insert` 带 `id` 且 `name` 不一致 | **不检查** | 本包也不报（照源码） |

### 三处被手册摘要漏掉、本包按源码处理的细节

1. **`name` 校验只发生在「无 insert」的行上。** 源码在循环开头解构 `name`，
   insert 分支里从头到尾没看它。照摘要实现会把一条**实际能加载**的补丁判成「跳过」。
2. **`insert` 的目标是 group 但 `config` 不是数组时，宿主静默改成 `[]`。**
   宿主不告警，但用户需要知道原来的 `config` 被丢了——所以本包报一条 `soft`。
3. **被 insert 的行立刻进索引**，所以同一层里后面的补丁可以命中它。
   漏掉这步会让「先插入、再配置」的写法在报告里变成「目标不存在」，而宿主能正常处理。

## 五、入口结构检查（宿主不报的四类隐患）

| 码 | 判据 | 致命 |
|---|---|---|
| `seventh-field` | 入口行出现 `id/name/config/group/disabled/inject` 之外的键 | 否 |
| `bad-id` | 入口 id 不匹配 `^[a-z][a-z0-9_-]{1,63}$`（§8.4） | 是 |
| `anonymous-row` | 入口行既无 `id` 也无 `name` | 是 |
| `duplicate-id` | 同一 id 在树里出现多次（后插入者会盖掉索引） | 否 |
| `group-without-list` | `group: true` 但 `config` 不是数组 | 否 |

## 六、跳过清单（`BundleSkipCode`，7 类）

| 码 | 判据 | 宿主对应行为 |
|---|---|---|
| `not-found` | 逐级向上去 `node_modules` 找不到包 | `resolveBundleDir` 抛错 → skipped |
| `manifest-unreadable` | 包目录里 `package.json` 读不出来 | `readProfileManifest` 抛错 |
| `no-ondra.bundle` | 缺 `ondra.bundle` | **`declares no ondra.bundle`**（§8.3-1） |
| `bad-patch-declaration` | `patch` 既不是字符串也不是字符串数组 | `bundlePatchFiles` 抛错 |
| `patch-unreadable` | 声明的补丁文件读不到 | `loadOverlayPatches` 抛错 |
| `patch-unparsable` | 补丁 YAML 解析失败 | 读文件抛错 → 整层被跳过 |
| `platform-unsupported` | `bundle.platforms` 不含当前平台 | `assertBundlePlatform` 抛错 |

`willWarnOnStderr = 跳过数 > 0`：宿主 `reportSkippedBundles` 对每个被跳过的 bundle
打一行 stderr。**报告里直接告诉你「会有几行 stderr」**，省掉「去翻日志」这一步。

## 七、结论分级（顺序不可换）

1. **`unverifiable` 优先**：有本包判不了的东西（YAML 超子集、清单读不出、没配路径）。
   判不了就说判不了，**不许降级成 `pass`**。
2. **`fail`**：有 bundle 被跳过，或有致命告警。两者的共同点是「某个入口不会挂载」。
3. **`warn`**：装得上，但有宿主不报的隐患。
4. **`pass`**：以上皆无。

## 八、配置

字段与默认值只在 `src/settings.ts` 的 `FIELD_SPECS` 里出现一次。

| 键（段字段） | 默认 | 说明 |
|---|---|---|
| `enable` | `true` | 关掉只是不查，不影响任何加载 |
| `profile-path` | `''` | profile 目录绝对路径。**空 = 不扫**，如实报 `no-profile` |
| `user-layer` | `true` | 是否把 profile 自己的 `cordis.patch.yml` 当最后一层 |
| `max-file-bytes` | `262144` | 单文件上限，超了按「判不了」处理 |
| `verbose` | `false` | 每条告警一行日志 |
| `ttl-ms` | `30000` | 报告缓存有效期，0 = 每次都重读 |

## 九、服务键与依赖

**provide**：`ondra-install-doctor`（全仓唯一归属）

**consume（全部软依赖，`inject` 不声明）**：

| 键 | 用在哪 | 缺席怎么办 |
|---|---|---|
| `ondra-identity` | 日志命名空间 | 退回 `ondra.install-doctor` |
| `ondra-config-schema` | 配置四层合并 | 退回插件实例配置 |
| `ondra-clock` | `now()` | 退回 `Date.now()` |

**与 O-132 同批但互不 import**（§15.5）：本包连 `ondra-organ-host` 的服务都不取。
理由：安装自检必须能在「宿主没装上」的时候还能站起来报告——去依赖被检对象就自相矛盾了。

## 十、隔离五问（§16.4）

1. **关掉我，谁受影响？** 没有别人。本包不 provide 任何别的插件会用的东西，
   也没有任何插件依赖它。界面读不到报告时会自己显示「未体检」，不会误判。
2. **我的状态存在哪？** **仅在内存**：一份报告缓存 + 六个计数。不落盘。
   缓存 30 秒 TTL 在读取时比对，**不装定时器**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.install-doctor`。
   `stats().lastVerdict` 会停在最后一次成功的结论；`inspect()` 本身永不抛错，
   崩的表现是「结论变成未判定 + 一条 finding 说清为什么」。
4. **我依赖谁？缺席时我怎么降级？** 三个软依赖，见第九节。全部有兜底。
5. **我和同域的谁共享了可变状态？** **没有**。与 O-132 同批但零 import、零 `ctx.get`。

## 十一、多方案分支说明（§12）

| 能力 | 方案 A（默认） | 方案 B | 处理方式 |
|---|---|---|---|
| 补丁组合 | 本包移植版（`composeEntries`） | 权威端口（宿主自己算） | **兼容**：`inspect()` 先用移植版，接口留出 `InspectOptions` 覆盖点 |
| YAML 解析 | 自带子集解析器 | `yaml` / `js-yaml` | **刻意不引依赖**：`peerDependencies` 只有 cordis，多一个在模块加载期就抛 |
| 路径解析 | 只认显式 `profile-path` | 猜（`~/.ondra/profiles/*`） | **不提供 B**：猜出来的根会让自检对着错目录跑出「全过」 |

**稳定优先**：报告说「通过」的前提是它**真的读到了那批文件**。任何「大概对」的输入
都会让结论从「证据」降成「猜测」，所以宁可不判。

## 十二、自查找出并修掉的问题

纯逻辑对拍（Python 复刻 YAML 子集解析 + 补丁语义 + 结论判定，**非实装运行**，
共 18 例）当场抓出一个真问题：

1. **YAML 子集把 `config: []` 判成「不支持」。** 首版把一切 `[` 开头的标量都按
   `flow collection` 拒绝，于是 `group: true` + `config: []`（「先建空组，等别的层
   往里 insert」的自然写法，也是本仓多方案分支的常规形态）会让整份**合法**补丁
   被判 `unverifiable`。**这是把工具的边界当成用户的错。** 已放行空的 `[]` 与 `{}`
   （一个字符确定整个值，无歧义），非空的仍明确拒绝，并把例外写进文件头与 README。

※ 另修掉一处冗余三元：`skipCode: parsed.ok ? 'patch-unparsable' : 'patch-unparsable'`
（两支相同，是我从另一个分支复制过来后忘了收敛）。
※ 对拍脚本自身也修了三轮：首版 `parse()` 里 `"""…"""` 少一个闭合引号、
`sink` 元组下标取错（`w[0][3]` 取到 layer 而非 `fatal`）、以及一个用例把
「无 id 的 `insert`」写成了「目标不存在」（前者是根插入，本就不该报错）。
**又一次印证：对拍脚本也是代码，绿灯只对它真跑到的那条路径有效。**

## 十三、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 补丁语义（`applyEntryPatches`） | `@ntars/cordis-plugin-include`（仓内 vendored） | `desktop/vendor/include/src/index.ts`（MIT，Shigma） | MIT | 六字段入口、`insert` 两种语义、边插边索引 | 逐行重写为 `src/compose.ts`（含三处源码细节），**不复制代码** | 否 |
| 入口树组合（`composeEntries`） | `@ntars/ondra-app-boot`（仓内） | `desktop/packages/boot/app-boot/src/profile.ts:755` | 仓内包 | 「`applyEntryPatches([], layers.flat(), warn)` 就是宿主会看到的东西」 | 逐层应用并额外记层名 | 否 |
| bundle 跳过与 stderr 报告 | 同上 `profile.ts` 的 `loadProfileDirectory` / `reportSkippedBundles` | 同上 | 仓内 | 7 类跳过原因的**语义分档**（本包把它们拆成码） | 自研 `BundleSkipCode` | 否 |
| 安装自检工具形态 | `DSH-Memory/tools/check-install.mjs`（手册语料·第一编 4.2 引用） | 手册未给仓库地址 | 未给 | 「只读检查文件与 profile 登记，用移植的补丁解析算入口树」＋「自检十项缺这一项」 | 自研只读端口 + 缓存 + 文本报告 | 否 |
| YAML 子集 | `js-yaml`（宿主用它） | — | MIT | 「不支持就明确拒绝，不给近似值」 | 自研 ~230 行子集解析器，拒绝清单写进文件头 | 否 |

**档位判定：〔研〕。** 依据：台账与手册 §1.6 把 O-132~O-145 七件治理插件统一列进自研档。
`check-install.mjs` 提供的是**做法**（算出宿主会看到的入口树），其实现依赖 DSH-Memory
自家的 profile 布局；本包必须按 Ondra 的 profile 形状自写，故只借鉴做法。

## 十四、已知限制

1. **同一份移植存在两处**（O-077 的 `src/compose.ts` 与本包的）。这是 §15.5
   「禁止同轮互相 import」+ §15.6「全仓 `import 'ondra-*'` 只允许 channel-kit 类型消费」
   两条的直接后果。**真源不是这两处，是 `desktop/vendor/include/src/index.ts`**——
   要改就三处一起改。已把「照源码改」写在两个文件头。
2. **逐层应用与宿主「摊平后一次性应用」在告警层名上不完全等价。** 语义（谁插了谁、
   哪条被跳过）等价，因为两边都边插边索引。差别只在告警归属与每层新增计数——
   而那两个正是本包的产出。
3. **不接权威端口时，`!!js` 表达式一律判 `unverifiable`。** 本包 YAML 子集拒绝
   `!!` 标签，而宿主支持它。用到了 `!!js` 的补丁会得到「未判定」而不是「通过」。
   这是刻意的：给近似值会让报告说「能装」而宿主说「不能」。
4. **`node_modules` 解析只向上找两级**（`profiles/<name>/node_modules` 与
   `profiles/node_modules`）。宿主的解析链更长（含安装锚点与链接投影），
   超出两级的提升会误报 `not-found`。解决办法是直接把 `profile-path` 指到就近目录。
5. **不判「入口能不能跑起来」。** 本包只判形状。一个入口能挂载但 `apply()` 抛错，
   报告里仍是 `pass`——那要 O-077 第十项或运行时日志才看得见。
6. **`ttl-ms` 的 30 秒是工程取值**，手册没给数字。
7. **`max-file-bytes` 的 256 KiB 是工程取值**（本仓最大的补丁在 4 KB 量级）。
8. **`group-without-list` 报 `soft` 而不是 `fail`。** 宿主会静默修正并挂上，
   所以它「能装」；但它丢了原来的 `config`，所以必须提醒。这条分级是判断，不是事实。

## 十五、待裁决

1. `ttl-ms` / `max-file-bytes` 两个默认值无手册出处。
2. 逐层应用 vs 摊平应用：本包选了逐层（为了层名），若主人要求逐字节等价宿主，
   可改成 `applyEntryPatches([], layers.flat(), warn)` 并把层名降级为「无法归属」。
3. 两处移植是否合并成一个只读共享包（例如 `ondra-patch-parse`）——那需要新编号，
   本包不擅自增项。
