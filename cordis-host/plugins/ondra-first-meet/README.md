# ondra-first-meet · 初见剧本

> O-107 · L9 扩展池（B13）·〔研〕自研 · 服务键 `ondra-first-meet`
>
> 把「第一次见面」切成五拍，每一拍只给约束，不给台词。

## 1. 它到底做什么

回答一个问题：**「第一次见面，按什么顺序让她把话说清楚、把边界立住？」**

只回答「节拍」，五拍顺序固定：

| # | 节拍 | 目的 | 句数上限 |
|---|---|---|---|
| 1 | `arrival` 到场 | 让对方知道这儿有个人在，而且不是客服窗口 | 2 |
| 2 | `introduce` 自我介绍 | 说清自己是什么、最常做的一件事、做不到什么 | 2 |
| 3 | `boundary` 立边界 | 先说清我不会做什么，再谈别的 | 3 |
| 4 | `invite` 邀请 | 给对方一个具体的、容易答的开口 | 1 |
| 5 | `settle` 收束 | 把这次认识收成一条事实：怎么称呼 + 一个偏好 | 2 |

每一拍返回四样东西：`intent`（要解决什么）、`mustDo`（必须做到）、
`mustNot`（绝对不许做）、`maxSentences`（句数上限）。**没有台词。**

## 2. 六条硬纪律

1. **不出台词。** 一旦这里出现「你好呀，我是……」，人格就有第二份声音来源，而那份声音不经过冻结前缀（O-033）与九步过滤（O-037）。
2. **读一次不推进。** `plan()` 只读，只有 `advance()` 才推进水位。外壳在渲染时顺手推进，节拍会在没人看见的地方被吃掉。
3. **允许被打断。** 用户自己先开口是最真实的信号：`interrupt()` 直接退到收束拍。硬按剧本走完五拍，等于让人听一段没人在听的播报。
4. **边界先于邀请。** 顺序不做成配置。把 `boundary` 调到 `invite` 之后，第一句就变成索取。
5. **只存进度，不存内容。** 存档里只有水位与时刻，**不存对方说的任何一句话**。
6. **水位与账目分开。** `position` 是水位，`delivered` 是「真的说出来过哪几拍」。被打断时水位前推，账目**绝不代补**——账目一造假，日志里就查不出「那次初见其实只说了两句」。

## 3. 服务键与契约

服务键 **`ondra-first-meet`**（连字符，全仓唯一归属；`ondra:first-meet` 会被模型侧直接拒绝）。

```ts
interface FirstMeetService {
  readonly available: boolean
  readonly reason?: MeetErrorCode
  readonly stored: boolean
  beats(): readonly ScriptBeat[]
  snapshot(): MeetSnapshot          // 只读
  plan(): MeetScript                // 只读，可随便轮询
  advance(expected?: BeatId): MeetScript
  interrupt(): MeetScript
  skipAll(): MeetScript
  reset(at?: number): MeetSnapshot
  stats(): MeetStats
}
```

- `advance(expected)` 会校验水位：两个调用方同时推进时，后到的那个当场抛 `bad-request`，而不是把下一拍悄悄吃掉。
- 错误码闭集：`disabled` / `bad-request` / `already-done`。
- **共享结构归属**：`ScriptBeat` 由本包（本轮先做方）定义，O-108 `ondra-absence` 的回归节拍与此同形，但按 §15.5 **不 import 本包源码**。

## 4. 明确不负责

| 不负责 | 归谁 |
|---|---|
| 说话、口吻、人称 | 人格 O-020 / 表达 O-047 |
| 首条消息的文本与规格 | O-045 `ondra-onboarding` 的 `firstMessage()` |
| 要不要主动开口、发到哪个通道 | O-042 `ondra-proactive-gate` 与通道适配器 |
| 把称呼存成记忆事实 | O-010 `ondra-memory-core`（本插件只在 `mustDo` 里要求调用方去做） |
| 渲染、Toast、面板、任何界面 | 应用外壳 `desktop/`（L8 界面插件已整批下线） |
| 多人分档 | 不做（见 §8 已知限制 2） |

## 5. 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | `true` | 总开关。关掉后服务仍注册，`advance()` / `reset()` 抛 `disabled`，`plan()` 照常可读 |
| `auto-start` | boolean | `true` | 关掉且还没见过时，`plan()` 返回空节拍、`advance()` 直接拒绝——**不是假开关**，它决定这条对话里到底有没有初见这一段 |
| `max-sentences-cap` | number（1–3） | `3` | 单拍句数天花板，**只收不放**：`min(节拍值, cap)`，调大不会有任何效果 |

刻意没有的：节拍顺序（是语义不是偏好）、逐拍句数（做成可配就能把「到场」调成五句话）、人设口吻（归人格）。

## 6. 降级与缺席（一张表说清）

| 缺什么 | 退回什么 | 怎么看出来 |
|---|---|---|
| `ondra-path-layout` | 只在内存，重启后初见从头再来一遍 | `stored=false` + 一行 `warn` |
| `ondra-clock` | 系统时间（`metAt` 只用于展示） | 无感，不额外报 |
| `ondra-config-schema` | 插件实例配置 + 本地 `completeConfig` | 一行 `warn` |
| `ondra-identity` | 日志命名空间退回 `ondra.first_meet` | 无感 |

全部 `ctx.get(...)` 之后都判 `undefined`，绝不直接调用。

## 7. 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。初见这段不出现，对话照常。
2. **我的状态存在哪？** `user/first-meet.json`（0600，临时文件 + `rename` 原子写）；缺路径服务时**仅在内存**。
3. **我崩了怎么知道是我崩了？** 日志命名空间 `ondra.first_meet`（经 O-001 拼），`stats().lastIssue` 留一行中文原因。
4. **我依赖谁？缺席怎么降级？** 四项全软依赖，见 §6；每处都 `if (svc === undefined) return/退化`。
5. **我和同域的谁共享可变状态？** 没有。O-108 与本包结构同形但零共享——不 import、不共用文件、不共用键。

## 8. 已知限制（诚实清单）

1. **不支持多人分档。** 一份存档对应一个人。多通道多人场景下第二次会被当成「已经见过」。修法要按 `personId` 分档，那会把 O-028 的按人维度复制一遍——本轮不做。
2. **不校验「对方是不是原来那个人」。** 只靠调用方在换人时调 `reset()`；忘了调，就变成「跟新来的人说『我们见过了』」。
3. **`metAt` 不参与任何判定。** 它只用于展示与调试；把它做成「多久之后算不再初见」是另一种设计，本轮没做（那更接近 O-108 的职责）。
4. **`delivered` 是节拍 id，不是次数。** 同一拍走两遍（reset 后）不会出现两次。
5. **不做进度回退。** 退一格会让两个调用方各自退一次后水位开始飘；要重来只有 `reset()`，它把 `restarts` 加一。

## 9. 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 初见节拍编排 | 无（生态审计：GitHub 上没有任何「首次见面流程」的可移植实现；相关材料全是产品散文与 onboarding 文案规范） | — | — | 只有「先立边界再索取」这一条设计原则 | `beats.ts` 五拍表 + `progress.ts` 纯状态机 | 否 |
| 安装期首启流程 | 本项目 O-045 `ondra-onboarding` | 仓库内 | AGPL-3.0（同仓） | **边界划分**：它管装得上，本包管认得下；首条消息归它 | 只读其契约划界，未 import | 否 |
| 状态原子写 | 本项目 O-021 / O-101 / O-105 的 `store.ts` 同款手法 | 仓库内 | AGPL-3.0（同仓） | 临时文件 + `rename`，0600，字段逐个写出 | `store.ts` 独立实现 | 否 |

## 10. 多方案分支（master-plan §12）

| 方案 | 做法 | 取舍 |
|---|---|---|
| A（默认，已实现） | 固定五拍 + 水位推进 | 最稳：顺序即语义，脚本可被静态复核 |
| B | 按人格档位给不同节拍表（冷淡人格只走两拍） | **不采用**：节拍表一变，「初见」就不可比，而人格档位归 O-020，本包不该读它 |
| C | 让模型现编初见剧本 | **不采用**：现编的剧本每轮不同，等于没有剧本；且多一条绕过冻结前缀的路径 |

A 与 B/C 不兼容也不可融合（B/C 都要读人格或调模型），故走分支而非参数化。默认永远选最稳的 A。

## 11. 文件清单（14）

```
package.json          清单（含 ondra.bundle.patch 指向下方补丁）
tsconfig.json         NodeNext ×2 + strict + rootDir/outDir/declaration
cordis.patch.yml      入口补丁（insert 无 id → 追加根入口）
icon.svg              图标副本（真源＝仓库根 icon.svg，由 tools/sync-plugin-icons.mjs 生成）
locale/en.json        英文元数据（商店/清单用）
locale/zh.json        中文元数据
README.md             本文件
src/index.ts          入口：name / apply(ctx, config) / Config
src/types.ts          契约：服务键、五拍闭集、错误码、结构对位
src/settings.ts       配置单一真源（FIELD_SPECS → DEFAULT_CONFIG / 段声明 / completeConfig）
src/beats.ts          五拍节拍表（唯一真源）+ 句数天花板派生
src/progress.ts       纯进度层（无 IO / 无 Date / 无定时器）
src/store.ts          user/first-meet.json 原子读写
src/service.ts        接线与降级
```

## 12. 快速上手

```yaml
# cordis.yml（节选）
plugins:
  - ondra-first-meet     # 零硬依赖；身份 / 时钟 / 路径 / 配置都是软依赖
```

外壳侧典型用法：

```ts
const meet = ctx.get('ondra-first-meet')
if (meet === undefined) return           // 缺席就安静退出
const script = meet.plan()               // 随便轮询，不推进
if (script.current !== null) {
  // 把 script.current.intent / mustDo / mustNot 交给人格去说
  // 说完之后：
  meet.advance(script.current.id)
}
```

## 13. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

| 类别 | 项 | 结果 |
|---|---|---|
| §16.1 | 1 结构完整（7 必需 + icon） | 过 |
| §16.1 | 2 清单合法（JSON 可解析 / `ondra-*` / `type: module` / main+types+exports+files / `@ntars/cordis` 双声明） | 过 |
| §16.1 | 3 编译配置 | 过 |
| §16.1 | 4 入口契约（`name` + `apply` + `Config` 默认值齐全） | 过 |
| §16.1 | 5 服务键唯一（`ondra-first-meet` 全仓唯一） | 过 |
| §16.1 | 6 依赖可解析（4 个软依赖全部有提供方） | 过 |
| §16.1 | 7 无越界 import（`from 'ondra-` 0 条） | 过 |
| §16.1 | 8 降级到位（4 处 `ctx.get` 全判 `undefined`） | 过 |
| §16.1 | 9 交付物齐全（技术来源 / 多方案 / 隔离五问 / 不负责 / 已知限制） | 过 |
| §16.2 | 括号配平 / 无残留半句 / `import type` 用法 / 无 TODO / UTF-8 无 BOM 无乱码 | 过 |
| 图标 | 与仓库根 `icon.svg` 逐字节一致 | 过 |
