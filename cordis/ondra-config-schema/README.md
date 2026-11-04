# ondra-config-schema

> O-005 · L0 基座 · 〔研〕自研 · 服务键 **`ondra-config-schema`**（连字符，非 `ondra:config-schema`）

全仓唯一的「配置四层怎么合」与「这个值到底从哪一层来」。
出厂 → 组合包 → 用户 → 运行时，四层按固定顺序合并，**逐字段追溯来源**，
单字段校验失败只回退该字段的出厂默认值，**不整段失败**。

## 职责

- 提供 `ondra-config-schema` 服务：
  `register()` / `has()` / `list()` / `section()` / `resolve()` / `presetOf()`，
  外加两份只读序表 `layers`（四层）与 `presets`（四档）。
- **注册表**：段键单一归属，声明期 fail-fast（键不合规、字段声明不合法、
  预设引用了未声明字段、段键被别人占用 → 直接抛 `ConfigSchemaError`）。
- **合并算法**：对象深合并、**数组整体替换**、`null` 显式置空、缺键表示未设置。
- **来源追溯**：每个字段给出 `value / source / mergedFrom / overridden / issues`，
  界面据此回答「我改了怎么没生效」。
- **四档预设**：`off / slow / standard / fast`，`presetOf()` 只产出一个普通对象，
  由调用方塞进 `bundle` 层——**四档不新增第五层**。

## 明确不负责

- **不持有任何别人的默认值**。默认值一律由**声明方**在注册段时交出
  （`FieldSpec.default`），注册表只存这一份。这是本插件最重要的一条「不做」：
  再搞一份全仓 `DEFAULT_CONFIG` 大对象就是双真源，两边一漂移，
  界面显示值与实际生效值就会不一致，而且没有任何报错。
- **不做界面、不做持久化**：不渲染、不写文件、不读文件、不联网。
  渲染归应用外壳（L8 已下线），落盘归上游 `ctx.configEditor` / `ctx.settings`。
- **不接管上游配置解析**。Cordis 自己的 `resolveConfig(runtime, config)` 走的是
  各插件 `Config['~standard']`，那是**宿主对插件实例**的配置；本插件管的是
  **产品自己那套业务配置**（记忆预算、静默时段、四档等）。两者是并列关系，
  本插件**不 patch、不替换**上游解析——一旦去改，上游升级就会静默错效。
- **不做环境变量覆盖**。手册 §8.4 的环境变量只承载**密钥与路径**（`ONDRA_*`），
  业务配置不走环境变量：环境变量无法表达嵌套结构，且会让「设置页显示的值」
  与「真正生效的值」分叉。
- **不校验跨字段约束**（例如「min ≤ max 之外的业务关系」）。跨字段规则只有
  声明方自己知道，硬塞进通用 schema 会变成一堆 `if (id === 'xxx')`。
  本服务只保证**单字段合法性 + 层序**。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-config-schema` | 唯一归属 |
| 消费 | `ondra-identity` | **软依赖**（只为取日志命名空间，缺席则用内置前缀 `ondra.config-schema`） |

契约在 `src/types.ts`（`ConfigSchemaService` / `SectionDecl` / `FieldSpec` /
`ResolvedField` / `ResolvedSection` / `ConfigIssue` / `ConfigSchemaError`），
合并在 `src/layers.ts`，注册表在 `src/registry.ts`，框架接线在 `src/index.ts`。

## 文件分层

| 文件 | 职责 | 约束 |
|---|---|---|
| `src/types.ts` | 契约、错误类、`LAYER_ORDER` / `PRESET_ORDER` 两份序表 | 只放类型与常量，无算法 |
| `src/layers.ts` | 纯算法：`cloneJsonShaped` / `deepFreeze` / `mergeValue` / `checkFieldValue` / `checkFieldSpec` / `resolveSection` / `expandPreset` | **不碰 ctx、不起定时器、不读盘**，可独立推理 |
| `src/registry.ts` | 注册表与声明期校验（`SectionRegistry`） | 只操作内存 Map，生命周期由 `index.ts` 的 effect 管 |
| `src/index.ts` | Cordis 接线、配置校验、日志、服务注册 | 不自己实现合并算法，全部调 `layers.ts` |

**为什么这样拆**：四层合并是本插件唯一真正容易写错的地方（层序 × 数组/对象 ×
`null` 与 `undefined` × 单字段回退四重叠加），与框架解耦后才能纯函数推演。
本轮禁止实装运行（§16.3），拆分是唯一能让算法可被独立核对的手段。

## 配置（本插件自身，全部有默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| `anonymousOwner` | `ondra-unknown` | 注册段时未给登记方名字时使用 |
| `maxSections` | `512` | 段数上限，防「循环里注册段」把内存吃光 |
| `logIssues` | `true` | 是否把校验问题打进日志（关掉只影响日志，`issues` 照样给） |

## 用法（消费方视角）

```ts
const cfg = ctx.get('ondra-config-schema')
if (!cfg) return                       // 缺席即降级，绝不 throw

// 一次性交出默认值真源（此后不再自带第二份默认值）
const off = cfg.register({
  id: 'ondra-emotion-core',            // 段键：小写 + 连字符
  title: '情绪',
  owner: 'ondra-emotion-core',
  fields: {
    'tag-half-life-min': { kind: 'number', default: 45, min: 1, max: 1440, doc: '标签半衰期（分钟）' },
    'mood-half-life-hour': { kind: 'number', default: 6, min: 0.1, max: 72 },
    'pad-step-limit': { kind: 'number', default: 0.12, min: 0, max: 1, advancedOnly: true },
    'api-key': { kind: 'string', secret: true },   // 密钥类：禁止默认值，配置里给的值一律丢弃
  },
})
ctx.effect(() => off)

const resolved = cfg.resolve('ondra-emotion-core', {
  bundle: cfg.presetOf('ondra-emotion-core', 'standard'),
  user: await loadUserSection(),       // 由调用方自己读盘
})
if (!resolved) return
resolved.values['tag-half-life-min']   // 生效值
resolved.fields['pad-step-limit'].source // 'user' | 'bundle' | 'factory' | 'runtime' | 'default'
```

## 关键取舍（每条都对应一种「改了却没生效」的静默 bug）

1. **数组整体替换，不深合并。**
   深合并数组会让「用户删掉一条」永远删不掉——那条还活在下层，合并后又冒出来，
   没有任何报错。这是配置系统里最难查的一类 bug，宁可整块替换。

2. **`null` = 显式置空，缺键 / `undefined` = 本层未设置。**
   二者混同会让「清空字段」变成「恢复默认」，或反之。界面上这是两种不同意图。

3. **逐层校验，错的层单独丢弃；不是「先取高层的值再整体校验」。**
   后者会让高层一个字段填错就把整段拖回默认值，用户看到「我填的全没了」。
   逐层丢弃后，错的只影响它自己那一层，其余层照常贡献。

4. **「回退默认」必须可观测：`fallbackCount` + 逐条 `ConfigIssue`。**
   手册要求「校验失败回退该字段默认值而非整体失败」，但回退是**静默危险动作**：
   值被换了却没人知道。不报数等于埋雷，所以回退计数与问题清单是硬产出。

5. **段内未声明的字段一律忽略并记 `unknown-field`，不进 `values`。**
   严格白名单。放开会让拼写错的键静默生效一半——用户以为改了 `timeZone`，
   实际生效的是 `timezone` 之外的默认值，界面显示「已保存」。

6. **密钥类字段：禁止声明默认值，且任何层提供的值都被丢弃。**
   手册 §6 全局禁令 6「不得把密钥写进配置文件」。这里在**数据结构层面**堵住，
   而不是靠约定：`secret: true` + 有默认值 → 注册期直接抛错。

7. **`LAYER_ORDER` / `PRESET_ORDER` 只有一份，从 `types.ts` 导出并冻结。**
   层序若在两处各写一遍，加层时必漏一处；冻结是为了防某个插件 `push` 进新层，
   让「四层」悄悄变成五层而界面仍显示四层。

8. **注册期抛错、运行期不抛。**
   声明写错要在装载时就炸——否则表现是「界面上没有这个字段」这种无声无息的错。
   但 `resolve()` 取不到段就返回 `undefined`，配置读不出来不该让主对话跟着崩。

9. **原型污染防线**：合并与克隆一律跳过 `__proto__` / `constructor` / `prototype`。
   配置来自 YAML/JSON，一条恶意键就能把整条原型链改掉。

10. **命名硬约束施加在「段键与字段键」上，不施加在本插件自身的 3 个 Config 字段。**
    段键与字段键会进设置界面、可能进模型侧（§8.4 的事故现场），必须匹配
    `^[a-z][a-z0-9_-]{1,63}$`；而本插件自身的 `anonymousOwner` 等是
    **Cordis 插件实例配置**，遵循上游 camelCase 约定，改了会与
    `cordis.yml` / `ctx.settings` 的既有写法脱节。这条边界写在这里，避免下一轮误改。

## 边界

- 属于 L0，崩溃后果是「谁也不知道出了什么问题」，因此**零第三方依赖**：
  只用 `Object` / `Map` / `RegExp` 等语言内建。
- 无定时器、无监听器、无 IO。唯一的副作用是 `ctx.effect()` 里的服务注册与撤销。
- 服务是**纯内存**的：段声明在装载时注册，卸载即撤；不落盘、不缓存到 `kv`。
  （落盘是上游 `configEditor` 的事，本插件连它都不碰。）

## 已知限制

1. **不提供「跨字段约束」**（如「A 开启时 B 必填」）。只有声明方知道这类规则，
   本插件只保证单字段合法性与层序。需要时由声明方在 `resolve()` 之后自行判断，
   并把结论写进自己的 `ConfigIssue` 口径（本插件不代劳，避免变成 `if (id === 'xxx')` 大杂烩）。
2. **`kind: 'json'` 只做「可序列化」这一层粗校验**，不校验内部结构。
   嵌套结构复杂的段，建议拆成多个具名字段而不是塞一个 blob——blob 无法被界面渲染，
   也拿不到逐字段的来源追溯。
3. **不做深度/体量上限**。恶意构造的极深嵌套对象在克隆时可能吃栈；
   本插件假定配置来自本机可信文件（YAML/JSON），不做防御式深度计数。
   若将来接入外部配置源，应在此处补 `maxDepth`。
4. **`resolve()` 每次调用都重新合并**，不缓存。段数 × 字段数在真实规模下（几十段 ×
   十几个字段）开销可忽略；缓存会引入「层变了但缓存没失效」这类更难查的问题。
   **已登记**，若将来出现高频调用点再按 `layers` 的引用相等做记忆化。
5. **段内字段键强制小写连字符**，消费方若内部 Config 用 camelCase（如
   `pollIntervalMs`），需自己做一层映射。这是手册 §8.4 的直接后果，**刻意不打折**。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 四层配置合并与来源追溯 | `@ntars/ondra-settings`（上游，本仓 `desktop/packages/settings/settings`） | github.com/ntars/deepseek-assistant | MIT | 层序「schema 默认值 → 组合基座（base）→ 用户层（user）→ volatile」；`base` / `user` 双视图的追溯思路 | 自研 `layers.ts`：`mergeValue` / `resolveField` / `resolveSection`，层名对位上游四层 | 否（只读源码对位，未复制） |
| 配置解析入口形状 | `@ntars/cordis` 的 `resolveConfig(runtime, config)` | github.com/ntars/Ondra | MIT | 「`Config['~standard'].validate` 返回 `{value}` 或 `{issues}`」的标准 schema 形状 | 同形手写，不引 `schemastery`（本轮禁装依赖） | 否 |
| 段键单一归属 / 注册期 fail-fast | 本项目 O-001 `ondra-identity` | 本仓 `cordis/ondra-identity` | AGPL-3.0（自有） | `strictKeys` 与 `IdentityKeyError` 的校验-即-抛纪律；`ctx.effect` 内注册并返回 disposer | 自研 `registry.ts`，错误类换成 `ConfigSchemaError`（带 `code` / `section` / `key`） | 是（自有资产，同仓复用写法） |
| 数组替换 / `null` 置空 / 原型污染防线 | 通用配置系统共识（lodash `merge` 的数组语义争议、`JSON merge patch` RFC 7386） | rfc-editor.org/rfc/rfc7386 | — | 「`null` 表示删除该成员」的语义；「数组不递归合并」的取舍 | 自研 `mergeValue`，另加 `UNSAFE_KEYS` 黑名单 | 否 |

**档位判定（§1.8）**：〔研〕自研。理由是生态里**没有**「产品级四层配置 + 逐字段来源追溯」
这种插件：上游 `ondra-settings` 只做**插件实例**的配置表单投影，不提供
「多段业务配置的统一注册表 + 追溯」，也不管「数组替换 vs 深合并」这类语义；
`convict` / `cosmiconfig` 一类库能合并多层，但拿不到 `mergedFrom` / `overridden`
这种逐字段追溯，且引入后会与 Cordis 的 `~standard` 形状打架。
**这是刻意不引入的，代价写在「已知限制」第 4、5 条。**

## 多方案分支说明（§12）

**不涉及分支。** 四层合并只有一条正确语义：固定层序 + 固定合并规则。

手册 §12.3 的「多方案」在本插件这一层表现为**参数**而非**分支**：
- 简单模式四档（`off / slow / standard / fast`）→ 参数化为 `presetOf()`，
  不新增层、不新增服务键；
- 「配置存哪」（YAML / JSON / SQLite）→ 不是本插件的职责，本插件只收
  `LayerSet` 这个纯数据结构，持久化归上游 `configEditor` 与各域插件。

唯一可能有分歧的是「数组到底该替换还是该合并」，本插件**拍死为替换**，
理由见取舍 1。若将来真出现「必须深合并数组」的段，正确做法是该段改用
`kind: 'json'` 并自行解释，**不得**为它新增第五层或第二个服务键（违反 §15.4）。

## 隔离五问（§16.4）

1. **关掉我，谁受影响？** 所有注册过配置段的插件 `ctx.get` 取到 `undefined`，
   各自应降级为「用自己的内置默认值」并记 warn。主对话不受影响——
   本插件不参与对话链路。
2. **我的状态存在哪？** 仅在内存：`SectionRegistry` 里的一个 `Map`。
   无文件、无数据库，重启即重置（段声明本就该在装载时重建）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.config-schema`
   （有 O-001 时走 `identity.loggerName('config-schema')`）。
   段登记失败会打 error 并带上问题码；`resolve()` 的每条问题都带
   `code / layer / key`，设置页可以直接渲染成「哪一层哪个字段错了」。
4. **我依赖谁？缺席时怎么降级？** 依赖 `ondra-identity`（软，仅取日志命名空间）；
   缺席时退回内置前缀 `ondra.config-schema`，功能不受影响。
   **不依赖** `ctx.settings` / `ctx.configEditor`——那是上游插件实例配置的通道，
   本插件与它并列而非搭在上面。
5. **我和同域的谁共享可变状态？** 没有。注册表是私有的；对外只给
   深冻结快照（`section()` / `resolve()` / `presetOf()` 全部 `deepFreeze`）。

## 自检（master-plan §16.1 九项 + §16.2 语言五项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整 | 过（11 文件：7 个必需 + `src/types.ts` / `src/layers.ts` / `src/registry.ts` / `icon.svg`） |
| 2 | 清单合法 | 过（JSON 可解析、`ondra-config-schema`、`type: module`、`main`/`types`/`exports`/`files` 齐、cordis 双声明、`ondra.bundle.patch` 在） |
| 3 | 编译配置 | 过（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） |
| 4 | 入口契约 | 过（`name` 字符串 + `apply` 函数 + `Config` 三字段全有默认值；无 `export const inject`） |
| 5 | 服务键唯一 | 过（`ondra-config-schema` 全仓仅本插件 provide；O-001~O-004 无人占用） |
| 6 | 依赖可解析 | 过（唯一 `ctx.get('ondra-identity')`，O-001 已 done） |
| 7 | 无越界 import | 过（无 `from 'ondra-`，只有同包内 `./types.js` / `./layers.js` / `./registry.js`） |
| 8 | 降级到位 | 过（`identity` 判空后走内置前缀；`resolve()` 段缺失返回 `undefined` 不抛；`presetOf()` 缺失返回空对象） |
| 9 | 交付物齐全 | 过（技术来源表 / 多方案说明 / 隔离五问齐） |
| 语言 1–5 | 括号配平 / 无残留半句 / `import type` 正确 / 无 TODO / UTF-8 无 BOM | 过（四个源文件全查：括号 9/9、65/65、34/34、52/52 配平；跨文件导入符号 31 条全部真实导出；`import type` 与值导入零混用；无 TODO/FIXME；无 BOM） |

### 纯算法推演（非实装运行，§16.3）

本轮禁止跑 TS / 起插件，因此用一份逐条复刻 `layers.ts` 语义的 Python 推演核对合并行为，八组用例：

| 用例 | 期望 | 实测 |
|---|---|---|
| 数组替换（bundle `[1,2,3]` / user `[9]`） | `[9]`（下层不得复活被删元素） | `[9]` 过 |
| 对象深合并（bundle `{a,b}` / user `{b,c}`） | `{a:1,b:9,c:3}` | 同 过 |
| 单字段错值（`a=999` 超限、`b=42` 正常） | `a` 回退 10、`b` 保留 42、`fallbackCount=1` | 同 过 |
| `null` 显式置空（bundle 7 / user `null`） | `null` | `null` 过 |
| 密钥字段（user 给 `sk-1`） | 值丢弃、`fallbackCount=0` | 同 过 |
| 四层同给（1/2/3/4） | `4`（runtime 最高） | `4` 过 |
| 数字填成文字（`'一百'`） | 判 `type-mismatch` 而非超范围 | 同 过 |
| 上层类型错、下层有效（user `'x'` / bundle 7） | 取 7（错层丢弃，不整段失败） | 过 |
| 原型污染（`__proto__` 注入） | 被跳过，只剩正常键 | 过 |

> **这只是语义推演，不等于类型检查。** 真正的 `tsc` 校验留到允许构建的轮次；本轮所有结论以静态阅读 + 纯算法复刻为限，已在简报里如实标注。
