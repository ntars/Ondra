# ondra-persona-loader

> O-020 ｜ L2 人格域 ｜ 服务键 `ondra-persona-loader`（连字符，**不是** `ondra:persona-loader`）
> 档位：**〔研〕自研**（判定依据见「技术来源」表）
> 状态：`done`（2026-11-01，静态自检 9 项 + 语言 5 项全过）

## 职责

1. **找包**：只读扫描两个根——用户根（数据根 `user/personas`）与随包根（`cordis/ondra-persona-skills`）。
2. **解包**：读 `.skill.zip` 的中央目录，解出 `meta.json` 与 `SKILL.md`（以及 `references/*`），**全程在内存里**。
3. **注册**：把每个可用人设登记成一条 `PersonaDetail`，按 `meta.slug` 打上 `factory` / `sample` / `user` 三种角色。
4. **报账**：根、包数、跳过数、问题清单、当前人设——全部可从 `stats()` 读到（§12.2 可观测）。
5. **供文本**：`readText(id, relPath)` 给 `ondra-persona-core` 拿正文，**ZIP 解码只有本插件一处**。

出厂与示例的依据是包内实际值，不是猜：`哦鲸鲸.skill.zip` 的 `meta.slug` 逐字是 `oh-jingjing`，
`夏柠柒.skill.zip` 的逐字是 `xia-ningqi`（均已解包核对）。手册 §1.1 定「出厂鲸鲸、夏柠柒为示例包」。

## 明确不负责

- **不组装提示词**：六槽位、五关系变体、浓度、边界全在 O-021 / O-022 / O-023。
- **不写任何人设包**。没有 `writeFileSync`，没有「导出人设」，没有「保存修改」。人设包是产品资产（master-plan §17-7），
  写一次就等于「用户机器上的某次界面操作改掉了随包文件」，而且再也分不清哪份是原版。
- **不持久化「当前人设」**。`setActive()` 只改内存态，落盘归 O-005 用户层或界面（§3.3-5 单一真源）。
- **不注册到上游 `ctx.skills`**。理由见「多方案说明」。
- **不判断人设好坏**。像不像、能不能用，归 `ondra-persona-core` 与验收测试集。
- **不做自动切换**。`trigger_words` 只**提供**给上层，「叫到名字就切过去」的判定不在这里。

## 服务键

| 项 | 值 |
|---|---|
| 服务键 | `ondra-persona-loader` |
| 全仓唯一归属 | 是（台账第 4 组 O-020） |
| 导出的运行时值 | `PERSONA_LOADER_SERVICE_KEY` / `PERSONA_ARCHIVE_SUFFIX` / `PERSONA_ID_PATTERN` / `FACTORY_PERSONA_ID` / `SAMPLE_PERSONA_ID` / `PersonaError` / `PersonaRegistry` / `ZipError` / `openZip` / `readTextEntry` / `parseMeta` / `loadOne` / `resolveRoots` / `listArchives` / `defaultBundledDir` / `CONFIG_SECTION` / `FIELD_SPECS` / `DEFAULT_CONFIG` / `completeConfig` |
| 完整契约 | 见 `src/types.ts`（`PersonaLoaderService` / `PersonaSummary` / `PersonaDetail` / `PersonaProfile` / `PersonaSource` / `PersonaFileEntry` / `PersonaIssue` / `PersonaRoot` / `PersonaStats` / `ScanReport` / `PersonaRole` / `PersonaIssueCode` / `PersonaTagsSource` / `PersonaUnavailableReason` / `PersonaError`） |

`PersonaLoaderService` 的方法共 11 个：
`refresh` / `list` / `get` / `has` / `roots` / `readText` / `files` / `activeId` / `active` / `setActive` / `stats`。

## 包内结构（已核对，不是设想）

```
哦鲸鲸.skill.zip  (190,085 字节, 13 项)
└── 哦鲸鲸.skill/
    ├── meta.json      8,922     ← 本插件读这个
    ├── SKILL.md      19,982     ← 本插件读字符数；正文由 O-021 读
    ├── README.md     11,318
    └── references/  persona.md / persona_3000.md / voice.md / body.md
                     scenes.md / dialogue.md / corpus.md / fidelity.md

夏柠柒.skill.zip  (187,610 字节, 12 项)
└── 夏柠柒.skill/  meta.json(3,317) / SKILL.md(27,455) / README.md
                   references/ persona / voice / body / scenes / dialogue / corpus / fidelity
```

外壳目录（`xxx.skill/`）由 `detectWrapper()` 自动剥掉，所有消费方一律按相对路径说话
（`SKILL.md` / `references/voice.md`）。不剥的话「`SKILL.md` 在哪」会变成每个消费方都要特判一次的问题。

## `meta.json` 的取用口径

| 字段 | 用途 | 缺失时 |
|---|---|---|
| `slug` | **人设 id 的首选来源** | 退回 `name` → 退回包文件名 → 都不合规则**拒收并报 `bad-id`** |
| `name` / `display_name` | 展示名 | 退回 id |
| `trigger_words` | 供上层做自动切换 | 报 `no-trigger`，人设照常可用（手动选） |
| `profile.*` | 人设卡（年龄/身份/性格/依恋/语言指纹） | 留空，**不补默认值** |
| `source.*` | 语料考证（只取 6 个两边都稳的字段） | 留空 |
| `files` | 渐进披露索引（路径 → 说明） | 留空，`PersonaFileEntry.declared` 全为 `false` |
| `safety` / `license` | 原样带出，给界面展示 | 留空 |

**为什么 `id` 缺失是唯一致命项**：它会成为别处的键（`activePersona` 配置项、日志命名空间 `persona.<id>`）。
不合规的键在下游以「查不到」的形态出现，而不是在装载期报错。所以入口处拦住，并把修法写进问题文案。

**为什么中文名包会被拒**：`哦鲸鲸` 机械转不出合法 id（`^[a-z][a-z0-9_-]{1,63}$`）。
不做音译——把中文名硬翻成拼音就是编造，而且「音译出来的 id」与用户心里的名字毫无关系。
两个人设包都写了 `slug`，正常路径上永远走不到这一步。

## 配置（全部有默认值）

| 键（段字段 / Config） | 默认 | 说明 |
|---|---|---|
| `enable` / `enable` | `true` | 总开关。关掉后不扫描，服务以不可用状态注册 |
| `bundled-dir` / `bundledDir` | `''` | 随包根。空 = 自动探测插件包同级的 `ondra-persona-skills` |
| `user-subdir` / `userSubdir` | `personas` | 用户根在 `user/` 下的子目录名（拒收含 `/`、`\`、`..` 的值） |
| `factory-persona` / `factoryPersona` | `oh-jingjing` | 出厂人设 id（只打标记，不改正文） |
| `sample-persona` / `samplePersona` | `xia-ningqi` | 示例人设 id |
| `active-persona` / `activePersona` | `oh-jingjing` | 初始激活的人设 id |
| `max-archive-bytes` / `maxArchiveBytes` | `33554432` | 单包上限（32MB）。到上限**拒收**，不截断 |
| `max-entry-bytes` / `maxEntryBytes` | `4194304` | 单文件上限（4MB） |
| `max-text-cache-bytes` / `maxTextCacheBytes` | `8388608` | 文本缓存预算（8MB），FIFO 淘汰 |
| `max-personas` / `maxPersonas` | `64` | 一次扫描的人设上限。到上限**停下**，不淘汰已注册的 |
| `keep-issues` / `keepIssues` | `50` | 保留的问题条数 |

字段名两套（camel / kebab）由 `KEY_PAIRS` 双向映射，段声明、用户层归一化、结果回填三处**全部由它派生**。
不做这张表的话，`FIELD_SPECS` 直接当段声明交出去会在注册期抛 `bad-field-spec`，
现象是「配置段静默不可用、四层合并与追溯全失效」（O-035 第 19 轮踩过）。
本插件的 11 个 Config 字段**刻意保持 camelCase**：它们属于 Cordis 插件实例配置，改了就与 `cordis.yml` 脱节。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| ZIP 读取（中央目录 → 局部解压） | `yauzl` | github.com/thejoshwolfe/yauzl | MIT | **「只信中央目录、只把本地头当数据起点」**这条读法，以及「本地头的 `nameLen/extraLen` 与中央目录里的不是同一份」这个坑 | 自研 `src/zip.ts`（约 340 行），`node:zlib` 的 `inflateRawSync` | 否 |
| ZIP 读取 | `adm-zip` | github.com/cthackers/adm-zip | MIT | EOCD 需要**从文件末尾往前扫**（尾部可能跟最长 65535 字节注释） | 同上，`findEocd()` | 否 |
| 人设包格式 | Agent Skills（`SKILL.md` + `references` 渐进披露） | 无单一仓库（格式约定） | — | 「入口文档 + 按需读取」的组织方式；本仓两个人设包就是这个格式 | 只按文件名定位入口与 references | 否 |
| 只读 provider 的边界划分 | `@ntars/ondra-skill-filesystem` | 仓内 `desktop/packages/skill/skill-filesystem` | MIT | 「发现 → 校验 → 注册，永不回写」这条边界；以及 `realpath` 之后再 `isInside` 校验的思路 | `service.ts` 的注册表与 `scan.ts` 的只读扫描 | 否（只读源码） |
| 配置四层与来源追溯 | 本仓 `ondra-config-schema`（O-005） | 仓内 `cordis/ondra-config-schema` | AGPL-3.0 | 段声明形状与 `resolve()` 语义 | 经服务键调用，不 import | 否（同仓，经服务键） |
| 数据根与权限 | 本仓 `ondra-path-layout`（O-002） | 仓内 `cordis/ondra-path-layout` | AGPL-3.0 | `ensure` / `fileIn` / `display` 的口径 | 经服务键调用 | 否（同仓，经服务键） |

**档位判定结论：〔研〕自研。** 依据三条：
① 手册 §1.8 的复用档清单（通道/语音/视觉/桌宠/市场/图标/农历/记忆底层）**不含人设包加载**；
② 上游 `ondra-skill` 的 `SkillDefinition` 里没有 `trigger_words`、没有角色标记、没有关系变体的位置——
  把「人设」塞进「技能」会得到一个语义错位的目录，且 `ctx.skills` 的 `modelInvocable` 语义是「给模型挑工具」，
  人设不是工具；
③ 但**机制层可复用的部分全部复用了**：解压用 `node:zlib`（内建）、配置走 O-005、路径走 O-002、日志走 O-004 命名空间。
  自研的只有「读中央目录」与「哪些包算人设」这两件生态里确实没有的事。

## 多方案说明（master-plan §12）

### 分支一：ZIP 读取（同一件事的三种做法，选了最稳的）

| 方案 | 做法 | 结论 |
|---|---|---|
| **A（默认）** | 自研中央目录读取 + `node:zlib` | ✅ 采用。零依赖、可静态审计、错误码完整 |
| B | 引第三方解压库（`yauzl` / `adm-zip`） | ❌ 本仓禁止 `pnpm install`；且为 190KB 的包引一棵依赖树不划算 |
| C | 调外部 `unzip` 命令 | ❌ 那是「要求用户手工跑命令才能生效的东西」，master-plan §12.4 明令禁止；且跨平台（Windows）没有 `unzip` |

C 被否掉还有一条更硬的理由：外部解压必须先把包解到磁盘上再读，而**人设包只读**——
一旦落盘就多出一份可以被人改、也可以被人误当成真源的副本。

### 分支二：注册到哪（`ctx.skills` 还是自己的服务键）

| 方案 | 结论 |
|---|---|
| **A（默认）** | 注册自己的服务键 `ondra-persona-loader` | ✅ 采用。人设的语义（出厂/示例/关系变体/浓度）与「技能」不同 |
| B | 复用上游 `ctx.skills.registerProvider` | ❌ 语义错位：`SkillDefinition` 没有 `trigger_words`、没有角色、没有关系变体；且「人设」会被 `ondra-tool-skill` 当成工具暴露给模型 |

两者并存也没有意义：注册到 `ctx.skills` 只会让同一份内容在两个目录里各出现一次，
而「哪个才是真的」的问题会在半年后爆炸。

### 分支三：文本缓存（有上限 / 无上限）

| 方案 | 结论 |
|---|---|
| **A（默认）** | FIFO + 字节预算 8MB | ✅ 采用。行为可预测 |
| B | 不缓存 | ❌ 每次组装提示词都要 `readFileSync` + 解压（§8.2 反模式②） |
| C | LRU | ❌ 命中顺序会改变淘汰顺序；缓存生命周期只有一次会话，精细度换不来收益 |

## 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。`ondra-persona-core` 会拿不到正文（`available=false` + 日志说清），
   但对话主链不崩——它不声明插件级 `inject`。没有任何插件会把「人设包」当成必需依赖。
2. **我的状态存在哪？** 只在内存（注册表 + 文本缓存 + 当前人设 id）。**不落盘**。
   人设包本体在磁盘上，但那是只读输入，不是我的状态。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.persona-loader`（经 O-001 的 `loggerName`）；
   `stats()` 里的 `available` / `reason` / `issues` 可被 `ondra-startup-check` 与成长面板读取。
4. **我依赖谁？缺席时我怎么降级？** `ondra-path-layout`（软：缺席则只扫随包根）、
   `ondra-config-schema`（软：缺席则只用插件实例配置）、`ondra-identity`（软：只拼日志命名空间）。
   三处都是 `ctx.get(...)` 后立刻判 `undefined` 并继续跑，**没有一处直接调用可能为 undefined 的服务**。
5. **我和同域的谁共享了可变状态？** 没有。`ondra-persona-core` 只能通过 `readText()` 读**不可变的字符串**，
   拿不到我的注册表对象，也改不了我的缓存。

## 已知限制

1. **ZIP 读取器的边界**：不支持 ZIP64、加密、`deflate64`/`bzip2`/`lzma`；不校验 CRC32（改比长度 + 上层可解析性）。
   实包是 `deflate` + 普通 ZIP，正常路径上碰不到。碰到时报 `unsupported-zip` 并给出「请重新打包成普通 ZIP」。
2. **文件名解码不看 flag bit 11**，一律按 UTF-8 解。这两个包的中文目录名正是这种情况（flag 没置位、字节是 UTF-8）。
   代价：真有一份按 CP437 打包的包，外壳目录名会变乱码——但外壳只用于剥壳，剥不掉也不影响按 basename 找文件。
3. **不监听文件变化**。导入新包后必须有人调 `refresh()`（应用外壳的「人设导入」按钮）。
   不做 `fs.watch` 的理由：它会给每个根挂一个 watcher，而「人设包一年换两次」的变更频率撑不起常驻监听。
4. **`tags`（人设卡 chips）可能不是作者写的**。两个人设包的 `meta.json` 都没有 `tags` 字段，
   此时取 `profile.personality` 前三条并标 `tagsSource: 'personality'`。
   界面应当能看出这是派生值——不要把「性格标签」当「作者定的 chip」展示。
5. **`source` 段只取 6 个字段**。两个包的 `source` 形状不一致（`chapters` 一个是数字一个是字符串、
   `characters` 一个是数组一个是数字），其余字段原样丢弃。它们只是考证信息，不参与任何判定。
6. **不改写人设正文**。人设包里有没有错字、有没有与手册冲突的口径，本插件一律不管——
   那是产品资产的问题，不是运行时的问题。发现问题应当改包，不该在运行时打补丁。
7. **单进程单用户**。两个人设包同名（同 slug）时按「用户根 > 随包根」定胜负，其余跳过并记 `duplicate-id`。
   多用户场景不在本产品的范围内（手册 §1.10 非目标）。

## 文件清单（14 个）

```
ondra-persona-loader/
├── package.json          # name / type:module / main / types / exports / files / ondra.bundle.patch
├── tsconfig.json         # NodeNext + strict, rootDir src, outDir lib
├── cordis.patch.yml      # ★ 必需，缺失即静默不加载（手册 §8.3-1）
├── icon.svg
├── locale/en.json
├── locale/zh.json
├── README.md
└── src/
    ├── index.ts          # 入口：name / apply / Config；注册段、注册服务、报账
    ├── types.ts          # 契约（服务键、11 方法、全部类型、错误类）
    ├── settings.ts       # 配置单一真源（FIELD_SPECS → DEFAULT_CONFIG / 段声明 / 校验）
    ├── zip.ts            # 最小 ZIP 读取器（中央目录 + inflateRaw）
    ├── meta.ts           # meta.json 解析与归一化（宽进严出）
    ├── scan.ts           # 根解析、列包、装一个包（唯一碰文件系统的层）
    └── service.ts        # 注册表：去重、角色、当前人设、文本缓存、统计
```

## 与相邻插件的接口约定

- **`ondra-persona-core`（O-021）** 消费本插件的 `get` / `readText` / `files` / `active` / `stats`。
  它**不得自己解压**：ZIP 解码只有 `zip.ts` 一份。它也不得改本插件的状态（`readText` 只返回字符串）。
- **`ondra-config-schema`（O-005）** 提供段注册与四层合并。段 id 是 `persona-loader`，字段键是 kebab。
- **`ondra-path-layout`（O-002）** 提供用户根路径与 `display`。本插件不自己拼 `~/.ondra`。
- **`ondra-startup-check`（O-077）** 读 `stats()`：`factoryPresent === false` 应当是一条 fatal 级的检查项——
  「装完打开，她不知道自己是谁」比任何一项都更该在启动时说出来。
- **应用外壳设置页** 读 `list()` 渲染人设卡；用户导入新人设后调 `refresh()`。
