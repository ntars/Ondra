# ondra-absence · 空窗期礼仪

> O-108 · L9 扩展池（B13）·〔研〕自研 · 服务键 `ondra-absence`
>
> 隔了很久回来，第一句该怎么接。给约束，不给台词，**一个数字都不给**。

## 1. 它到底做什么

回答一句话：**「她已经回来了，这一句该怎么接？」**

五档，依据是「对方还记不记得上次说了什么」，不是「我有多想你」：

| 档 | 空窗 | 对方的状态 | 该怎么接 | 句数上限 | 承认隔了一段 | 允许温度 |
|---|---|---|---|---|---|---|
| `brief` | 几小时 | 上下文还在 | 直接接上，不提隔了多久 | 2 | 否 | 是 |
| `noticed` | 半天到一天 | 记得，但话头断了 | 可以轻提一句，只说一次 | 2 | 否 | 是 |
| `long` | 一到三天 | 记得人，忘了细节 | 承认隔了一段，但不给天数 | 2 | 是 | 否 |
| `distant` | 三天到两周 | 记得有这么个人 | 先打招呼，把「还在」说清 | 3 | 是 | 否 |
| `stranger` | 两周以上 | 可能已经忘了 | 当重新认识的前半段，先报自己是谁 | 3 | 是 | 否 |

每一档返回：`mustDo`、`mustNot`、`maxSentences`、`mustAcknowledgeGap`、`allowWarmth`、
`coarse`（五个粗粒度词之一）、`askAboutGap`（**恒为 `false`**）。**没有台词。**

## 2. 六条硬纪律

1. **不报精确间隔。** `greet()` 的返回值里**一个数字都没有**（`maxSentences` 约束的是说几句，不是隔了多久）。`view()` 才有 `gapDays`，那是给外壳画时间轴与调试用的。
2. **`askAboutGap` 的类型是字面量 `false`。** 做成 boolean 就一定会有 `true` 分支，而那个分支一定会在某次「关心一下」的改动里被打开。
3. **不许假装没隔。** `long` 以上必须承认隔了一段。人对「她假装没发现我消失了」格外敏感。
4. **不许清算、不许索取、不许施压。** 四条禁令恒定在每一档：不问去哪了、不报天数、不编情节（「我一直在等你」）、不把缺席解读成被丢下。
5. **读一次不推进。** `greet()` 只读；`mention()` 才记「真的提过了」。同一轮提过之后课表自动收窄到 1 句并撤掉「承认隔了一段」——再说一遍就是念台词。
6. **远隔时不许撒娇。** `allowWarmth` 只在最近两档为真：三天以上还撒娇，那不是亲昵，是索取。

## 3. 服务键与契约

服务键 **`ondra-absence`**（连字符，全仓唯一归属；`ondra:absence` 会被模型侧直接拒绝）。

```ts
interface AbsenceService {
  readonly available: boolean
  readonly reason?: AbsenceErrorCode
  readonly stored: boolean
  touch(at?: number): AbsenceView        // 唯一写方法之一
  view(at?: number): AbsenceView         // 只读（含 gapDays，供外壳，不许念）
  greet(at?: number): RegreetPlan | null // 只读；从没记录过时返回 null
  mention(tier, at?): AbsenceView        // 唯一写方法之二
  reset(at?: number): AbsenceView
  stats(): AbsenceStats
}
```

- `greet()` 返回 `null` 的时刻：**从没记录过任何活动**。那时「隔了多久」根本不成立，给一份 `brief` 课表等于凭空断言「刚见过」。
- 错误码闭集：`disabled` / `bad-request`。
- **共享结构**：`mustDo` / `mustNot` / `maxSentences` 与 O-107 `ondra-first-meet` 的 `ScriptBeat` **同形但零共享**（§15.5：不 import、不共用文件、不共用键）。改字段名要两边一起改。

## 4. 明确不负责

| 不负责 | 归谁 |
|---|---|
| 说话、口吻、人称 | 人格 O-020 / 表达 O-047 |
| 要不要在她回来之前主动找她 | O-042 `ondra-proactive-gate`（静默时段、日额度、六道闸） |
| 空窗期的日记、叙事补写 | O-049 `ondra-narrative-log` / O-048 |
| 关系四维的结算（沉默久了掉不掉分） | O-028 `ondra-emotion-core` |
| 「上次聊到哪儿了」 | O-014 召回 / O-017 图（本插件刻意不记内容） |
| 渲染、Toast、时间轴视图 | 应用外壳 `desktop/`（L8 界面插件已整批下线） |
| 多人分档 | 不做（见 §8 已知限制 1） |

## 5. 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | `true` | 总开关。关掉后服务仍注册，`touch()` / `mention()` 抛 `disabled` |
| `brief-hours` | number（1–48） | `6` | 短于这个小时数不算空窗（一次完整的睡眠） |
| `noticed-days` | number（1–7） | `1` | 超过即进入 `noticed` |
| `long-days` | number（2–30） | `3` | 超过即进入 `long`（从这档起必须承认隔了一段） |
| `distant-days` | number（4–365） | `14` | 超过即进入 `distant`，再往上就是 `stranger` |
| `max-sentences-cap` | number（1–3） | `3` | 句数天花板，**只收不放** |

四道阈值必须**严格递增**：写反了会被**抬上去**（而不是把前一道压下来）——压低阈值会让礼仪提前变生分，而那是整份分级里最伤人的方向。

刻意没有的：报不报天数（是纪律不是偏好）、要不要问去哪了（契约里连开关位置都没留）、逐档句数（做成可配就能把「很久没见」调成三句话）。

## 6. 降级与缺席（一张表说清）

| 缺什么 | 退回什么 | 怎么看出来 |
|---|---|---|
| `ondra-path-layout` | 只在内存，重启后当成第一次记录 | `stored=false` + 一行 `warn` |
| `ondra-clock` | 系统时间（本插件只用时刻差，不用日历） | 无感，不额外报 |
| `ondra-config-schema` | 插件实例配置 + 本地 `completeConfig` | 一行 `warn` |
| `ondra-identity` | 日志命名空间退回 `ondra.absence` | 无感 |

## 7. 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。回归那一下变成「按平常接」，不会有任何一句关于间隔的话。
2. **我的状态存在哪？** `user/absence.json`（0600，临时文件 + `rename` 原子写）；缺路径服务时**仅在内存**。
3. **我崩了怎么知道是我崩了？** 日志命名空间 `ondra.absence`（经 O-001 拼），`stats().lastIssue` 留一行中文原因。
4. **我依赖谁？缺席怎么降级？** 四项全软依赖，见 §6。
5. **我和同域的谁共享可变状态？** 没有。与 O-107 结构同形但零共享。

## 8. 已知限制（诚实清单）

1. **不支持多人分档。** 一份存档对应一个人。换人不调 `reset()` 就会把「和新来的人」算成「和上一个人」的空窗——大概率报成 `stranger`，不算伤人但也不对。
2. **不校验「第一次活动」是否真的是第一次。** 首次安装后第一次 `touch()` 就会写 `firstSeenAt`；那一刻的 `gap` 是 `null`，所以不会有任何一句多余的话。
3. **时钟回拨时把空窗夹到 0。** 不报负间隔，也不试图判断「是不是改过系统时间」——那需要读系统日志，属越界。
4. **`mention()` 不校验档位是否与当前一致。** 传进来的是「我以为提到的是哪一档」，只校验闭集。跨档不一致只影响计数，不影响课表（课表永远按真实间隔算）。
5. **不做「连续缺席」统计。** 连续几天没来属于 O-042 的 `silentDays`；这里再统计一遍就有两个真源。

## 9. 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 空窗分级 | 无（生态审计：GitHub 上没有「回归问候」的可移植实现；同类产品的做法是硬编码一句「好久不见」，不构成机制） | — | — | 只有「按记忆留存度而非思念强度分档」这一条设计原则 | `gap.ts` 五档表 + 纯函数分档 | 否 |
| 粗粒度时间词 | 本项目 O-021 的承诺时间词闭集（后天/明天/下周…） | 仓库内 | AGPL-3.0（同仓） | **词表粒度**：只到「下周」这一级，不精确到天 | 自建五个粗粒度词，与 O-021 不重叠（那是未来时间，这是过去间隔） | 否 |
| 状态原子写 | 本项目 O-021 / O-101 / O-107 的 `store.ts` 同款手法 | 仓库内 | AGPL-3.0（同仓） | 临时文件 + `rename`，0600，字段逐个写出 | `store.ts` 独立实现 | 否 |

## 10. 多方案分支（master-plan §12）

| 方案 | 做法 | 取舍 |
|---|---|---|
| A（默认，已实现） | 固定五档 + 粗粒度词闭集 | 最稳：档位可静态复核，且类型层面禁止报出天数 |
| B | 按关系四维（O-028）微调档位：亲密高的人空窗三天仍算 `noticed` | **不采用**：这会让「隔了多久」变成关系分的函数，而关系分本身会漂；且本包一旦读 O-028，就多一条与情绪域的耦合 |
| C | 让模型自己判断「隔了多久算久」 | **不采用**：每次判断不同，同一段空窗会得到两种礼仪；且多一个不确定源 |

A 与 B 不可融合（B 需要读情绪域），与 C 不可兼容（C 要调模型）。默认永远选最稳的 A。

## 11. 文件清单（13）

```
package.json          清单（含 ondra.bundle.patch 指向下方补丁）
tsconfig.json         NodeNext ×2 + strict + rootDir/outDir/declaration
cordis.patch.yml      入口补丁（insert 无 id → 追加根入口）
icon.svg              图标副本（真源＝仓库根 icon.svg，由 tools/sync-plugin-icons.mjs 生成）
locale/en.json        英文元数据
locale/zh.json        中文元数据
README.md             本文件
src/index.ts          入口：name / apply(ctx, config) / Config
src/types.ts          契约：服务键、五档闭集、粗粒度词闭集、错误码、结构对位
src/settings.ts       配置单一真源（FIELD_SPECS → DEFAULT_CONFIG / 段声明 / completeConfig）
src/gap.ts            纯判定层：分档 / 课表 / 归一化（无 IO / 无 Date / 无定时器）
src/store.ts          user/absence.json 原子读写
src/service.ts        接线与降级
```

## 12. 快速上手

```yaml
# cordis.yml（节选）
plugins:
  - ondra-absence        # 零硬依赖；身份 / 时钟 / 路径 / 配置都是软依赖
```

外壳侧典型用法：

```ts
const absence = ctx.get('ondra-absence')
if (absence === undefined) return            // 缺席就安静退出
const plan = absence.greet()                 // 只读，随便轮询
if (plan !== null) {
  // 把 plan.mustDo / mustNot / maxSentences 交给人格去接话
  absence.mention(plan.tier)                 // 真的说出去之后才记
}
absence.touch()                              // 记录「她刚活动过」
```

## 13. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

| 类别 | 项 | 结果 |
|---|---|---|
| §16.1 | 1 结构完整（7 必需 + icon） | 过 |
| §16.1 | 2 清单合法（JSON 可解析 / `ondra-*` / `type: module` / main+types+exports+files / `@ntars/cordis` 双声明） | 过 |
| §16.1 | 3 编译配置 | 过 |
| §16.1 | 4 入口契约（`name` + `apply` + `Config` 默认值齐全） | 过 |
| §16.1 | 5 服务键唯一（`ondra-absence` 全仓唯一） | 过 |
| §16.1 | 6 依赖可解析（4 个软依赖全部有提供方） | 过 |
| §16.1 | 7 无越界 import（`from 'ondra-` 0 条） | 过 |
| §16.1 | 8 降级到位（4 处 `ctx.get` 全判 `undefined`） | 过 |
| §16.1 | 9 交付物齐全（技术来源 / 多方案 / 隔离五问 / 不负责 / 已知限制） | 过 |
| §16.2 | 括号配平 / 无残留半句 / `import type` 用法 / 无 TODO / UTF-8 无 BOM 无乱码 | 过 |
| 图标 | 与仓库根 `icon.svg` 逐字节一致 | 过 |
