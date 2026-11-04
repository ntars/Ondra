# ondra-persona-workshop · 人格包工坊

> 台账 O-098（第 17 组 · L9 扩展池，B13 批次）｜档位〔研〕自研｜**默认开启**（只读体检，开着无副作用）

**一句话：给已有的人设包做一次八项元数据体检，并把「哪里不够」翻译成「改哪个文件哪个位置」的清单——一个字节都不写进包里，一句文案都不替你写。**

---

## 1. 它到底做什么

```
O-020 加载器 ──→ 「有哪些包、包内文件清单、meta 字段」
                        ↓
O-021 内核   ──→ 「六槽位到齐几个、有几条硬红线」（软，可缺席）
                        ↓
                  八项体检 → 逐项过/警告/不合格/跳过 + 证据 + 方向
                        ↓
                  派生草案 → 动作 + 文件 + 位置 + 为什么 + 优先级
                              + 新包骨架（只有路径）
                              + 必须自己定的三件事
```

### 八项判据

| # | 项 | 判据 | 不合格时该干什么 |
|---|---|---|---|
| 1 | id 与包名 | 文件名去后缀应等于 `meta.slug`（中文包名走 slug 视为正常） | 统一两者 |
| 2 | 文件登记 | `meta.files` 声明的文件占比 ≥ 50% | 补 `meta.json` 的 `files` |
| 3 | SKILL.md 篇幅 | 6000–60000 字之间 | 太短补厚 / 太长挪去 `references/` |
| 4 | 六槽位覆盖 | 身份/说话/驱动力/场景/格式/自检 六块齐全 | 补章节标题（内容自己写） |
| 5 | 触发词 | 1–32 条 | 补几条最像「喊她」的 |
| 6 | 硬红线 | 至少一条 `hard: true` 的边界 | 补明确写「禁止/红线」的条目 |
| 7 | 档案字段 | `profile` 至少 3 项非空 | 补身份/年龄段/性格/依恋类型 |
| 8 | 版权声明 | `meta.license` 非空 | 补一句授权方式 |

> **`skip` 与 `fail` 严格分开。** 第 4、6 项需要 O-021；它没装时这两项记 `skip`，**且不进健康分分母**。把它们记成 `fail` 会让用户去改一个其实没问题的包，改完还是 `fail`（因为查不了），于是永远修不好。

### 健康分口径

`pass` = 1 分、`warn` = 0.5 分、`fail` = 0 分、**`skip` 不进分母**。

---

## 2. 四条红线（都写进代码注释了）

1. **不写人设包，一个字节都不写。** `cordis/ondra-persona-skills/` 是产品资产（master-plan §17-7），用户根下的包属于用户。全文件零写调用。
2. **不生成新包文件。** 落盘成 `.skill.zip` 需要 **ZIP 编码**（写中央目录 + deflate），而仓内只有 O-020 自写的**读取**器（`zip.ts`，361 行，只做读）；禁装依赖、禁引第三方。所以「生成可导入的新包」在当前约束下**做不了**，见 §8 已知限制 1。
3. **不生成任何文案。** 草案只写「这里空着」，不写「填什么」。写文案是创作，要么归人，要么归模型（走 O-035 网关并计费）；插件自己编的句子会被人当成产品资产抄进包里，然后没人知道它是机器写的。
4. **不判「像不像」。** 文笔、OOC、语气一致性要读正文或跑评测集——那是 O-118 `ondra-consistency-bench` 与人的事。

---

## 3. 服务键与契约

**服务键：`ondra-persona-workshop`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓仅本插件 provide。

| 方法 | 说明 |
|---|---|
| `ids()` | 当前可体检的人设 id 清单（排序交给 O-020） |
| `audit(id?, at?)` | 体检一个包，返 `AuditReport`（八项 + 计数 + 健康分 + `usable`） |
| `draft(id?, at?)` | 派生草案 `VariantDraft`（改动清单 + 骨架 + 必须改的三件事） |
| `compare(at?)` | 横向对比（逐包 try/catch，坏包跳过，最多 `maxPersonas` 个） |
| `stats()` | 统计快照（`audits` / `drafts` / `slotChecks`） |
| `available` / `reason` | `disabled` / `no-loader` |

```ts
const shop = ctx.get('ondra-persona-workshop')
if (shop === undefined || !shop.available) return   // 优雅降级
const report = shop.audit()                          // 默认体检当前激活人设
for (const check of report.checks) {
  if (check.status !== 'pass') console.info(check.title, check.status, check.evidence, check.suggestion)
}
const plan = shop.draft()                            // 只出清单，不出文案
```

> `audit()` 对不存在的 id 抛 `WorkshopError('no-persona')`；`audit()` 在加载器缺席时抛 `WorkshopError('no-loader')`。**`compare()` 与 `ids()` 永不抛**——它们逐包吞错，避免一个坏包让整张表消失。

---

## 4. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| **生成 / 改写 / 保存人设包（含写 ZIP）** | 人（或将来独立的打包工具） | 仓内只有 ZIP 读取器，禁装依赖；且写人设包 = 改产品资产 |
| 解包与「有哪些包」 | O-020 `ondra-persona-loader` | 唯一 ZIIP 解码处，第二份解析就是第二真源 |
| 六槽位切片、边界提取、激活规则 | O-021 `ondra-persona-core` | 本插件只问「到齐几个」，不取正文 |
| 拼提示词 | O-023 `ondra-persona-assemble` | 本插件不产任何要进提示词的东西 |
| 「像不像 / OOC / 语气一致性」评测 | O-118 `ondra-consistency-bench` + 验收测试集 | 那要读正文或跑样本，不是元数据判定 |
| **渲染、三栏、设计令牌、主题、Toast、体检面板** | **应用外壳（`desktop/`）** | L8 界面 14 个插件已整批下线，插件只交结构化数据 |
| 给新包起名 | 用户 | `draft()` 里那个 `<id>-variant` 只是拼骨架目录名用的建议值，不写进任何文件 |

---

## 5. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | **`true`** | 总开关。关掉后服务仍注册但 `available=false` |
| `maxPersonas` | number | `32`（上限 64） | 对比表最多看几个包，太多会卡住一次渲染 |
| `verbose` | boolean | `true` | 上游缺席、单项跳过时打一行日志 |

**刻意没有的配置项**：各类阈值（字数区间、触发词上限、档案字段下限）、以及**「是否允许写回人设包」的开关**——后者做成布尔就一定有人打开它，然后产品资产被静默改掉。

---

## 6. 降级与缺席

| 缺席的上游 | 表现 | 用户看到 |
|---|---|---|
| `ondra-persona-loader` | `available=false`、`reason='no-loader'`；`ids()` 返空；`audit()` 抛 `no-loader` | 工坊显示「未接入」 |
| `ondra-persona-core` | 第 4、6 项记 `skip`，**不进健康分分母** | 六项体检照常，两项标「跳过」 |
| `ondra-clock` | 退回系统时间 | 无感 |
| `ondra-config-schema` | 退回插件实例配置 | 无感（少四层合并与来源追溯） |

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。只读体检，零副作用；关掉后依赖本服务的面板拿不到数据，对话链与人格域完全不受影响。
2. **我的状态存在哪？** **没有持久状态**。三个计数器（`audits` / `drafts` / `slotChecks`）只在内存，重启归零。这是刻意的——工坊不产生需要保存的东西。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.persona-workshop`；`stats()` 给出 `available` / `reason` / 三个计数器；`AuditReport.tally` 逐档计数。
4. **我依赖谁？缺席时怎么降级？** O-020（**硬**：没有它连包都列不出来）、O-021（软，记 `skip`）、O-003（软）、O-005（软）。逐项见 §6。
5. **我和同域的谁共享了可变状态？** **没有**。全部只读上游；自己不持有任何包相关状态。

---

## 8. 已知限制（诚实清单）

1. **不能生成可导入的新包。** 落盘 `.skill.zip` 需要 ZIP 编码（中央目录 + deflate + CRC），仓内没有写入器，本轮禁装依赖也禁引第三方库。所以 `draft()` 只给**路径骨架**，实际的打包必须由人（或用系统 `zip` 命令）完成。这是本插件最大的能力缺口，明确登记。
2. **八项判据里两依赖 O-021。** 没装它时六槽位与硬红线查不了，只能 `skip`。健康分因此只在剩余六项上计算，跨环境的分数不完全可比。
3. **阈值全是工程取值**（6000 / 60000 字、50% 登记率、3 项档案字段、32 条触发词）。参照两个实包（`SKILL.md` 19982 字、`meta.json` 8922 字节）定的量级，不是手册值。
4. **`slot-coverage` 依赖 O-021 的槽位关键词表。** 若作者把章节标题写成关键词表以外的话（比如「我是谁」而不是「身份锚定」），会被判缺失——那时是关键词表要补，不是包要改。此判定的失败方向是「误报缺失」，已在 `suggestion` 里写明关键词表。
5. **不判正文质量。** 一个通过的包可能写得很差，一个不通过的包可能写得很好。八项只保证「结构上说得通」。
6. **`compare()` 每次全量重算**，不缓存。32 个包的元数据体检在毫秒级，但若用户塞了上百个包，应由应用外壳自行节流。

---

## 9. 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 人设包发现与解包 | O-020 `ondra-persona-loader`（本仓） | 本仓 `cordis/ondra-persona-loader` | AGPL-3.0 | 只借 `PersonaDetail` 的元数据结构（`to-large` / `no-meta` / `no-skill` 这类问题码的划分思路） | 经服务键消费，结构对位镜像 `LoaderLike` / `PersonaDetailLike` | 否 |
| 六槽位与边界判定 | O-021 `ondra-persona-core`（本仓） | 本仓 `cordis/ondra-persona-core` | AGPL-3.0 | 只借槽位 id 与中文名（`identity` / `voice` / `drive` / `scene` / `format` / `selfcheck`），**不取切片正文** | 经服务键消费，结构对位镜像 `CoreLike` | 否 |
| 体检项的「过/警告/不合格/跳过」四态 | ESLint 的 `error / warn / off` 与各类 linter 的 `skipped` 语义 | —（生态共性） | — | 「判定不了的不能记成不合格」这条原则（ESLint 对无法解析的文件报 parsing error 而不是 rule failure 的取舍） | 自研 `audit.ts`（`CheckStatus` 四态 + `scoreOf` 的跳过分母口径） | 否 |
| 派生草案的「只指位置不写内容」 | 各类脚手架（`create-*`）的模板变量机制的反面 | — | — | 脚手架会**填内容**，本工坊刻意不填；借鉴的是「骨架与内容分离」这个分层 | 自研 `draft.ts`（`skeletonOf` 只回路径、`mustChangeOf` 只回三条待定项） | 否 |

**为什么是〔研〕而不是〔复〕/〔薄〕**：
- 生态里的人设/角色卡工具（SillyTavern 角色卡、各类 Prompt 模板管理）几乎都是**编辑器**——它们的目标是「帮你写」，会把生成的文案直接写回文件。本仓的红线是「不写包、不写文案、只判元数据」，语义正相反，引入后必须把写入路径全部拆掉，成本高于自写。
- 〔薄〕要求「有可用实现、只包一层适配」。这里没有可包的上游：八项判据的阈值与「`skip` 不进分母」的口径是本仓特有，生态无对应物。
- 台账第 17 组「来源方案：人格包工坊」未指定上游项目，按 §11.2 逐条写明借鉴点与不引入代码。

---

## 10. 多方案分支（手册 §12）

| 项 | 内容 |
|---|---|
| 是否涉及多方案 | **否**。单一只读体检方案，无分支 |
| 与 O-020 / O-021 的关系 | 只读消费，不提供替代分支 |
| 不共享缓存 | 与 O-020 的文本缓存、O-021 的内核缓存**零交集**；本插件不缓存任何包数据 |

---

## 11. 文件清单（13）

```
package.json          # ondra.bundle.patch → ./cordis.patch.yml（漏了插件永远不加载）
tsconfig.json         # NodeNext + strict + declaration
cordis.patch.yml      # insert 块自身不带 id，条目带 id → 追加根入口
src/index.ts          # name / apply / Config；inject 刻意不声明（依赖全软）
src/types.ts          # 服务键 + 八项 id + 五动作 + 阈值常量 + 结构对位镜像
src/settings.ts       # FIELD_SPECS（默认值唯一真源）→ DEFAULT_CONFIG / SectionDecl / completeConfig
src/audit.ts          # 八项判据 + 计数 + 健康分（skip 不进分母）
src/draft.ts          # 体检结论 → 改动清单 + 路径骨架 + 必须自定的三件事
src/service.ts        # Workshop：ids / audit / draft / compare / stats
locale/zh.json        # meta.title / meta.description
locale/en.json
README.md
icon.svg              # 由 tools/sync-plugin-icons.mjs 从根 icon.svg 生成
```

---

## 12. 快速上手

```yaml
# cordis.yml（节选）
- id: ondra-persona-workshop
  name: ondra-persona-workshop
  config:
    enable: true        # 默认 true
    max-personas: 32
```

```ts
// 应用外壳：拉一次对比表，按不合格数排
const shop = ctx.get('ondra-persona-workshop')
if (shop?.available) {
  const rows = shop.compare()
  rows.sort((a, b) => a.tally.fail - b.tally.fail)
  render(rows)                     // 渲染归外壳，插件不碰 DOM
}
```

---

## 13. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整 | 过（13 文件：7 必需 + `src/types.ts` / `src/settings.ts` / `src/audit.ts` / `src/draft.ts` / `src/service.ts` + `icon.svg`） |
| 2 | 清单合法 | 过（JSON 可解析、`ondra-*`、`type: module`、四字段齐、cordis 双声明、`ondra.bundle.patch` 在且文件真实存在） |
| 3 | 编译配置 | 过（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） |
| 4 | 入口契约 | 过（`name` 字符串 + `apply(ctx, config)` + `Config` 三字段全有默认值；不声明 `inject`） |
| 5 | 服务键唯一 | 过（`ondra-persona-workshop` 全仓仅本插件 provide） |
| 6 | 依赖可解析 | 过（四键 `ondra-persona-loader` / `ondra-persona-core` / `ondra-clock` / `ondra-config-schema` 均有提供方） |
| 7 | 无越界 import | 过（无 `from 'ondra-`） |
| 8 | 降级到位 | 过（每个 `ctx.get` 后均判空；`#detailOf` 抛稳定错误码；`compare` 逐包 try/catch） |
| 9 | 交付物齐全 | 过（技术来源表 / 多方案说明 / 隔离五问齐） |
| 语言 1–5 | 括号配平 / 无残留半句 / `import type` 分清 / 无 TODO / UTF-8 无 BOM | 过 |
| 图标 | 与根 `icon.svg` 逐字节一致（`node tools/sync-plugin-icons.mjs`） | 过 |

> 判定由静态检查产出（只读 + JSON 解析 + 括号配平 + 服务键交叉核对），未执行 `tsc` / `build` / `pnpm install`（§16.3）。
