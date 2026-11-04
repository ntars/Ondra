# ondra-market

> O-078 · L7 系统与交付 · 档位〔复〕 · 服务键 `ondra-market` · 状态 **done（静态自检通过，未实装运行）**

封闭的插件市场：**只做接线**。上游 `pluginMarket` 负责读索引、模糊匹配、挑默认版本、判兼容性；本包只补「封闭、只读、安装方案」三件上游不做的事。

---

## 一、职责

1. **封闭过滤**（`service.ts` 的 `#decorate`）：手册 §7.4-⑩ 要求「与.ondra.market 同型但**封闭**——只显示认可的插件」。认可 = 内置清单（配置 `builtin`）+ 用户自定义（`approve()`）。
2. **只读目录**（`allowList()` / `search()` / `entry()`）：master-plan §5 原话「组合包清单，**只读**」。不装、不卸、不改索引源。
3. **安装方案**（`plan()`）：只算「装什么、从哪装、装之前必须先有什么」。`requiresRestorePoint` 恒 `true`（手册 §9.11「安装依赖 snapshot 还原点」）。
4. **认可清单落盘**（`store.ts`）：`user/market/approved.json`，0600，临时文件 + rename 原子写。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 读索引、解析 format 1、模糊匹配、挑默认版本、判 `engines.ondra` | 上游 `pluginMarket`（`desktop/packages/boot/plugin-market`）。**能复用却自研 = 违规** |
| 装 / 卸 / 升级 | O-079 `ondra-installer`（本包只出 `spec` 与前置条件） |
| 建快照还原点 | O-009 `ondra-snapshot` |
| 改索引源（`setIndexes`） | **不做**。改索引源是用户动作，不是插件的动作 |
| 界面 | 应用外壳（L8 已下线）。本包只出只读方法 |
| 出站隐私判定 | O-076 `ondra-privacy` |

### 四条刻意的「不做」

1. **不自己拼 `spec`。** `name@version` 看着等价，但只要上游的 spec 带 registry 前缀或 lockfile 语义，拼出来就是错的，而错的表现是「装上了另一个版本」。所以只取上游 `versions[].install.spec`。
2. **不把过滤前的总数当总数。** 见「四」。
3. **不在封闭模式下问上游「未认可的条目是什么」。** `entry()` 先判认可，再问上游——问一次就等于承认它存在。
4. **上游缺席不注销服务。** 注销会让消费方分不清「没装」与「装了但没配索引」；两种话术完全不同。

## 三、服务键与方法

```
ondra-market        ← 连字符，不是带冒号的写法
```

| 方法 | 说明 |
|---|---|
| `allowList()` | 认可清单（内置 + 用户），同步、只读 |
| `approve(name, note?)` / `revoke(name)` | 用户自定义（手册 §7.4-⑩ 的「也支持用户上传自定义」）。内置项撤不掉 |
| `search(text?, options?)` | 委托上游，按封闭市场过滤。**永不抛错** |
| `entry(name)` | 单条。**先判认可，再问上游** |
| `plan(name, version?)` | 安装方案（不执行）。按版本重取 `spec` |
| `status()` / `stats()` | 现状 / 计数 |
| `useHost(host \| null)` | 换上游端口（`null` = 断开） |
| `dispose()` | 撤（幂等） |

### 原因码

| 字段 | 值 | 含义 |
|---|---|---|
| `status().reason` | `disabled` / `no-market` / `no-index` | **整体**不可用（开关关着 / 没接上游 / 上游没配索引） |
| `search().status` | `ok` / `partial` / `no-market` / `no-index` | **这一次**查询的结果；`partial` = 有索引读失败，别的索引结果照常返回 |
| `plan().blocked` | `not-allowed` / `not-found` / `no-market` / `no-index` / `no-install-spec` | 给不出方案的原因 |

## 四、过滤之后不能再报过滤前的数

上游 `search()` 的 `total` 是**过滤前**的匹配数。封闭市场挡掉一部分后，若还拿它当总数，界面会显示「共 12 个」而列表只有 2 条——人会以为分页坏了。

所以：

- `SearchPage.hostTotal` = 上游这一页所属索引的匹配总数；
- `SearchPage.hidden` = 本页被挡掉的条数；
- `MarketSearchOutcome.hostTotal` / `.hidden` = 各页之和。

**两者相加才是上游看到的全貌。** 界面可以说「显示 2 个，另有 10 个不在认可清单里」。

## 五、配置

| 字段 | 默认 | 理由 |
|---|---|---|
| `enable` | `true` | 关掉只停查询；本地清单与 `plan()` 的判认可仍有效 |
| `mode` | `closed` | 手册 §7.4-⑩ 明写「封闭」。默认开放等于把这句话反着做 |
| `builtin` | `xia-ningqi-complete` / `xia-ningqi-light` | **手册 §9.11 的旧项目实证值**，不是新体系官方清单（见「八」） |
| `pageSize` | `40` | 上游单页上限 100（`src/index.ts` 的 `MAX_LIMIT`），超过夹紧 |
| `sort` | `index` | `index` = 官方排列顺序；`relevance` = 按文本匹配度 |
| `maxIndexes` | `8` | 配了很多索引时，防止一次查询打十几个请求 |
| `persist` | `true` | 落盘到 `user/market/approved.json`（0600）；关掉只在内存 |
| `language` | `zh-CN` | 多语言条目按它挑一条；缺了退前缀 → `en` → 任取 |
| `verbose` | `false` | 每次查询一行日志 |

## 六、边界

- **服务键 / 配置键 / 段键**：`ondra-market` / kebab 字段名 / 段 `market`，全部匹配 `^[a-z][a-z0-9_-]{1,63}$`（§8.4）。
- **认可判定只有一处**（`#allowedNames` + `#decorate`）：`search()` / `entry()` / `plan()` 共用，不各写一份。
- **归一只有一处**（`normalize.ts`）：所有可选字段在这里收成 `undefined` 或空数组。界面拿到的字段类型是稳的，不会出现 `[object Object]`。
- **不建定时器、不抓网络、不监听端口**：一切由调用方触发。
- **不进提示词、不碰会话**（master-plan §6 禁令 5）。
- **不写 `app_session_log`**（禁令 5）。

## 七、已知限制

1. **跨索引分页不是全局游标。** `offset` 会**分别**传给每个索引（各索引各自一页），合并后去重。所以「第 2 页」在不同索引上可能对应不同的实际位置。要严格的全局分页，需要上游支持跨索引查询——它没有，本包不假装有。传 `options.indexUrl` 可锁定单个索引，此时分页语义是准的。
2. **同名条目跨索引只留第一个。** 两个索引列了同一个包名时，先查到的胜出（`maxIndexes` 顺序）。不做版本择优——那需要比较两边的 SemVer，属上游职责。
3. **不判版本相容性。** `engines.ondra` 由上游判，`plan()` 只把结果转述为「前置条件」。自己判一遍必然与上游分叉，而分叉的表现是「市场说能装、装上跑不起来」。
4. **`approve()` 抛 `TypeError`。** 这是本包唯一会抛的方法：包名不合法（空、含空白、超长）时抛，而不是静默接受一条坏记录。`revoke()` 不抛（不存在就返回 `false`）。
5. **内置清单是旧项目实证值。** 见「八」第 1 条。
6. **`plan()` 不知道快照是否真的建了。** 它只把「先建还原点」写进 `preconditions`；执行顺序由 O-079 保证。跨包检查「还原点存在吗」需要 O-009 的 `list()`，本包不调用——那会让 O-078 硬依赖 O-009。
7. **`status().indexes` 可能滞后。** 它每次现取 `listIndexes()`，上游缓存索引文档但不缓存「配了哪些 URL」，所以这个数是准的；条目内容仍受上游 `cacheTtlMs` 影响。
8. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app。全部结论来自静态检查与纯逻辑对拍。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 市场索引读取与搜索 | 上游 `@ntars/ondra-plugin-market` | 本仓 `desktop/packages/boot/plugin-market` | 自有（上游） | `listIndexes` / `search(url, query)` / `entry(url, name)` 三方法签名，`MarketQuery` 的 `sort/offset/limit/refresh`，`MAX_LIMIT=100` | 结构对位镜像 `MarketHostLike`，只调不改 | 否（同仓只读，未复制代码） |
| 索引格式（format 1） | 上游 `@ntars/ondra-plugin-market-index` | 本仓 `desktop/packages/util/plugin-market-index` | 自有（上游） | 「versions 非空且按 SemVer 降序」→ 取 `[0]` 即最新；`install.spec` 由上游算好 | `normalize.ts` 只读 `versions[]` 与 `install`，不自己拼 spec | 否 |
| 多语言文本 | 上游 `@ntars/ondra-package-manifest` | 本仓 `desktop/packages/util/package-manifest` | 自有（上游） | `LocalizedText = string \| { en, ... }` 的形状 | `pickText()`：精确 → 前缀 → `en` → 任取 | 否 |
| 封闭市场 | 手册 §7.4-⑩ | — | — | 「与.ondra.market 同型但封闭，只显示认可的插件，也支持用户上传自定义」 | `mode` + `builtin` + `approve()` | 否 |
| 组合包清单只读 | master-plan §5 L7 | — | — | 「`ondra-market`（组合包清单，只读）」 | 不装不卸不改索引源 | 否 |
| 安装依赖还原点 | 手册 §9.11 | — | — | 「market …只读，安装依赖 snapshot 还原点」 | `InstallPlan.requiresRestorePoint` 恒 `true` + `preconditions` | 否 |

**档位〔复〕的依据**：手册 §1.7「复用（生态成熟，直接用）」明列「插件市场（.ondra.market`）」；并按**能力**（不是按依赖名）在 `desktop/packages` 里核到了 `pluginMarket` 服务的真实现与三个方法。所以本包只做接线、过滤与方案，**重写搜索或索引解析都属违规**。

## 九、多方案分支说明

master-plan §14.3 的已知多方案项**无对应项**。本包内一处真分支：

| 能力 | 方案 A（默认） | 方案 B | 处理 |
|---|---|---|---|
| 条目来源 | 上游 `pluginMarket`（完整索引） | 只有本地认可清单（无上游） | **能兼容就兼容**：上游缺席不注销服务，`allowList()` 照常返回，`search()` 报 `no-market`。两边共用同一份 `CatalogEntry` 形状 |

意义：界面不必写「有市场 / 没市场」两套渲染；它永远拿到同形状的数据，只是 `status` 不同。

## 十、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「市场查不查得了」。没有定时器、没有 socket、不监听端口。`dispose()` 断开上游端口并清空缓存引用。唯一副作用是 `user/market/approved.json`，那是我自己的文件。
2. **我的状态存在哪？** 认可清单落 `user/market/approved.json`（0600，原子写）；其余（计数、上游端口引用）**只在内存**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.market`；`status()` 有 `reason`（`disabled` / `no-market` / `no-index`）与 `corrupt`（清单解析失败过）；`search()` 的失败进 `pages[].error` 而不抛；`stats()` 有 `failures`。
4. **我依赖谁？缺席时我怎么降级？** `ondra-identity`（缺 → 日志前缀兜底）、`ondra-path-layout`（缺 → 只在内存，`store: memory`）、`ondra-config-schema`（缺 → 本地校验）、`ondra-clock`（缺 → `Date.now`）、宿主 `pluginMarket`（缺 → `no-market`，本地清单仍可读）。**一个都不 `inject`**。
5. **我和同域的谁共享了可变状态？** 没有。与 O-077 的分工是「市场接线」对「加载自检」；与 O-079 的分工是「给参数」对「去安装」，两者不共享对象，只经返回值交接。

## 十一、与文档的口径差异（必须留痕）

1. **内置清单的两个包名来自手册 §9.11 的旧项目实测**（「market：清单实为 2 个包」）。新体系的官方组合包尚未定义，所以它是默认值而不是硬编码常量——配置可改、可清空（清空 = 一个都不认可，`status().allowCount` 会如实报 0）。
2. **「封闭市场」的条目来源在手册里只有一句话**（§7.4-⑩）。「用户上传自定义」落到 `approve()` + `approved.json`，没有上传 UI——界面归应用外壳。
3. **master-plan §5 写「组合包清单，只读」，但 §9.11 又要求安装依赖还原点。** 两者不冲突：本包只读，安装归 O-079；`plan()` 只是把「需要还原点」这条前置条件交出去，不自己校验、不自己建。
4. **master-plan §3.1 / §6 仍写 `ondra:<短名>`**，与同文件 §3.3-6、手册 §8.4 冲突；按「手册优先」全仓连字符，**未改 master-plan**。
