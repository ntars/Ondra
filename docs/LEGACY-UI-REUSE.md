# 旧版空谷 UI 可复用资产清单

> 来源：`/Users/ntars/Github/Temp/Ondra/build/空谷 Ondra.app`（Electron 1.2.0）
> 源码：`/Users/ntars/Github/Temp/Ondra/desktop`（pnpm monorepo，`packages/client/*`）
> 对照现版：`/Users/ntars/Github/Ondra`（Tauri 2.2.1，单会话制，56px Rail）
> 盘点日期：2026-11-12

---


## 实施结果（2026-11-12）

**#01–#39 已全部落地，#40–#49 不在本轮范围。** D1–D3 按建议方案执行（见下）。其中三项受本版后端能力限制，只做到"能做的部分"，逐条注明——不假装完成。

| 编号 | 状态 | 落点 |
| --- | --- | --- |
| #01 | 完成 | `lib/settingsTaxonomy.ts`（4 组 / 65 段，按问题分组） |
| #02 | 完成 | 同上 `HIGH_RISK_SECTIONS` + 段头「高风险」标 |
| #03 | 完成 | `ModuleLayer` 全局开发者模式（偏好持久化） |
| #04 | 完成 | 导航 order 常量 + 分类内显式顺序 |
| #05 | 完成 | 复用 `pref__row` / 内置行式，未自造面板 |
| #06 | 完成 | `Settings.tsx` 改表驱动（一页一处），面板 grid 168px |
| #07 | 完成 | 面板高 `min(720px, 100%)` |
| #08 | 完成 | 导航 34px 格 + 2px 间距 + 一档实底（取代反色块） |
| #09 | 完成 | 字段间 0.5px 发丝线，无卡片 |
| #10 | 完成 | 分组头（名+段数+一句说明）+ 段头三项元信息 |
| #11 | 保持 | 五种 kind 五种控件（原实现已正确） |
| #12 | 完成 | 遮罩用 mousedown 关闭；Esc 走 App 统一层级 |
| #13 | 完成 | 焦点落面板本体（去掉导航项上的假焦点环） |
| #14 | 完成 | `lib/logModel.ts` 五类 + 徽标两字 |
| #15 | 完成 | 四列网格 46/34/22 + gap 6 |
| #16 | 完成 | 等宽 + tabular-nums + 0.01em |
| #17 | 完成 | 按 round 分组，组头「第 N 轮·时间·N 条」 |
| #18 | 完成 | `<details>` 三类正文 + 字数 |
| #19 | 完成 | 48px 阈值 + 滚动祖先监听 + scrollIntoView |
| #20 | **部分** | 解码器已实现（`logText.plainToolName`），但本版宿主不产出 tool 行（`deriveSessionLog` 只派生 rhythm/channel/model），暂无数据点亮它 |
| #21 | **部分** | 同上（`toolSubject` / `toolLine`），等待 tool 事件接入 |
| #22 | 完成 | 时长并进句子；独立时长只用于工具行 |
| #23 | 完成 | 投影 `logModel.projectLog` 纯函数 + 视图分离 |
| #24 | 完成 | **标题栏**身份行（24px 头像 + 名字 + 状态词；左栏改回纯图标，参照 QQ） |
| #25 | **部分** | 实现「在想 / 在线」两档；第三档「等你回答」需宿主 pendingInteraction 信号，本版没有，不造假日志 |
| #26 | 完成 | 身份行非按钮、不可聚焦；标题栏已是 `data-tauri-drag-region`，标识不扣除拖拽带 |
| #27 | 完成 | 沿用 `padding-left: 84` 让位自绘红绿灯，身份行从其右侧开始 |
| #28 | 完成 | 名字由 `lib/persona.ts` 单一真源注入，布局层不读人设状态 |
| #29 | 完成 | 一句话盒子 + 1→3 行增长（D2：保留增长，卡内滚） |
| #30 | 完成 | 两列地板 `composer__floor` |
| #31 | **部分** | 三角/停止两态已实现；「发送中」转圈缺状态源（发送是同步入队，无 pending phase） |
| #32 | 完成 | 卡外脚注：权限 + 模型并排居中 |
| #33 | **部分** | 14px 环 + 百分比已实现；三段构成拆分需宿主回传分类用量，本版只有总量 |
| #34 | 完成 | 队列坞：可改/可挪/可删/折叠；顺带修复「排队静默丢弃」缺陷 |
| #35 | 完成 | 设置已有 queue/interrupt；本轮让其真正生效（两条路径都走队列） |
| #36 | **部分** | 附件 48px 轨与移除已实现；「上传中/失败重试」无上传管线可挂（文件按路径直传） |
| #37 | 完成 | 所有按钮 mousedown preventDefault + 回焦 textarea |
| #38 | 保持 | `nativeEvent.isComposing` 判定（原实现已正确） |
| #39 | 保持 | 本版无 `/` 命令菜单，无组合框可对齐；未新增 |

### D1–D3 的裁决

| 编号 | 采用 | 理由 |
| --- | --- | --- |
| D1 | **标题栏**身份行（先试 Rail 顶部，按参照改为标题栏） | 56px 放不下常驻昵称；标题栏有 44px 高与整条横向空间，人放这里、功能留左栏 |
| D2 | 1→3 行增长 + 卡内滚 | 保持用户已熟悉的增长行为，只把 140px 之后的行为明确为卡内滚 |
| D3 | 面板高 720 | 65 段的页在 540 里只能看到 6–7 个段头 |

### 追加：QQ 式分栏（2026-11-12 晚）

按参照调整了外壳，与 #01–#39 无关但同批落地：

- 左右两栏不再各染一档灰（原 `--ui-bg-canvas`），三栏同色；
- 分栏只靠 0.5px 发丝线（`.rail` 右边、`.spine` 左边）；
- 内容区成一枚内嵌纸片：`margin: 8px`、`border-radius: 8px`、`0.5px` 外框；
- 中栏 `--ui-bg-paper` 从 `#f7f7f7` 提到 `#fcfcfc`，与画布同色。

## 目录（按编号挑选）

说「做 #14」「先 S01–S04」「按 D2 走」即可定位。

- **#01–#49**：资产项，每一项都是可以单独落地的一条设计判断。
- **S01–S15**：落地步骤，按「改动小 × 收益大」排序，一项可含多个资产；前四项不动布局骨架。
- **D1–D3**：待你裁决的形态分歧，定了才能开工对应的 S12/S13 与设置面板调整。

依赖关系：**S12 依赖 D1**，**S13 与 S10 的尺寸依赖 D2/D3**；其余步骤互不阻塞，可任意顺序或并行。

### 一、设置分类体系

| 编号 | 资产 | 一句话 |
| --- | --- | --- |
| **#01** | 按使用者问题分组（四类 + 开发者） | 123 段配置分成四个能读懂的入口 |
| **#02** | 通道四级风险档位 | preferred/common/device/highRisk，高危压最后 |
| **#03** | `advancedOnly` / `secret` 双闸 | 普通页过滤高级项，`secret` 只写不读 |
| **#04** | 导航排序是显式常量 | 通用 0 · 模型 10 · 人设 20 … 关于 70 |
| **#05** | 分类页复用内置行式 | 不自造卡片、不自造搜索框 |

### 二、设置 UI

| 编号 | 资产 | 一句话 |
| --- | --- | --- |
| **#06** | 四格网格 + 插槽注册 | 面板只有骨架，加一页不改骨架文件 |
| **#07** | 面板高度锁死 | 换页时纸片不跳 |
| **#08** | 导航选中态一档实底 | 40px 格 + 4px 间距 + 颜色过渡 |
| **#09** | 设置行 0.5px 分隔线 | 说明在左、控件贴右、不套卡片 |
| **#10** | 分组折叠 + 三项段头 | 标题 / 高危标 / 字段数 + 可写·只读·未注册 |
| **#11** | 控件按 kind 分派 | 五种 kind 五种控件，不做花活 |
| **#12** | 关闭路径三条 + 防误触 | 头部键 / 遮罩 / Esc；遮罩用 mousedown |
| **#13** | 初始焦点在当前页导航 | 不是第一个，也不是关闭键 |

### 三、日志展示（第二高价值）

| 编号 | 资产 | 一句话 |
| --- | --- | --- |
| **#14** | 五类徽标 | channel/model/tool/pace/error，五色柔和底 |
| **#15** | 四列网格 | 时间·徽标·发送方·叙述各占一列，扫描不对齐会锯齿 |
| **#16** | 等宽时间 + tabular-nums | 11px 等宽 + 数字等宽 + 一丝光学补偿 |
| **#17** | 按轮分组 | 组头「第 N 轮 · 时间 · 条数」，只认 turn 自己声明的边界 |
| **#18** | 可展开正文 | 收到/思考/回复各一个 `<details>` + 字数，默认折叠 |
| **#19** | 跟随滚动 48px 阈值 | 在底部才跟，往上翻就不抢 |
| **#20** | 工具名翻译表 | bash→运行命令；未知名保留原名，不瞎猜 |
| **#21** | 工具主体提取 | 取参数里最像宾语的项，路径只留尾名 |
| **#22** | 时长只说一次 | 工具行单独显示，回复/轮次写进句子 |
| **#23** | 投影与渲染分离 | 纯函数、可单测、不认得的降级为空行 |

### 四、左上角头像与昵称（#24–#28）

| 编号 | 资产 | 一句话 |
| --- | --- | --- |
| **#24** | 标记 + 名字 + 状态点 | 一行三层：头像 / 昵称 / 在线状态 |
| **#25** | 状态只有三档 | 等你回答 > 在想 > 在线，不推测心情精力 |
| **#26** | 身份行不是按钮 | 整行是窗口拖拽区，唯一可点项在最右 |
| **#27** | macOS 红绿灯让位 | 52px 空白 strip，内容列回吞 12px |
| **#28** | 品牌可被插件接管 | 有则接管、无则回退，persona 状态不进布局 |

### 五、输入框

| 编号 | 资产 | 一句话 |
| --- | --- | --- |
| **#29** | 「一句话的盒子」形态判断 | 恒定高、卡内滚，不是表单面板 |
| **#30** | 两列地板 | 文本占左、动作占右，发送键不在文字上方 |
| **#31** | 34px 圆形发送键三态 | 三角 / 转圈 / 停止块；空文本 40% 透明 |
| **#32** | 模型与权限在卡外 | 居中如脚注，「跟谁说话」是前置设置 |
| **#33** | 上下文计 14px 环 | 环 + 百分比，点开看系统/工具/对话三段 |
| **#34** | 队列坞 | 排队消息可编辑、调序、删除、带图预览 |
| **#35** | Enter 行为可配 | queue / steer，加速键取反义 |
| **#36** | 附件轨三态 | 待传/上传中/失败重试；未完成闸住发送 |
| **#37** | 焦点保持 | 按钮 mousedown 时 preventDefault，连续打字不断 |
| **#38** | 中文输入法判 isComposing | 判原生事件，否则选词回车发半截拼音 |
| **#39** | 命令菜单组合框契约 | 焦点不离开输入框，aria-activedescendant 高亮 |

### 六、其他组件

| 编号 | 组件 | 现版状态 |
| --- | --- | --- |
| **#40** | 对话/日志双视图切换（38px 药丸滑动） | 缺 |
| **#41** | 审批卡（waiting 锁 + 失败回滚） | 缺 |
| **#42** | 消息统计药丸（紧凑/详细两档） | 部分 |
| **#43** | 空态 Hero（标记置顶、输入守地板） | 有 |
| **#44** | 新建会话圆钮 | 不适用（单会话） |
| **#45** | 连接状态三态（800ms 防闪） | 部分 |
| **#46** | 文件类型图标 | 缺 |
| **#47** | 图片灯箱 | 缺 |
| **#48** | 差异块 | 缺 |
| **#49** | 风险确认（含"为什么危险"） | 部分 |

### 七、落地步骤

| 步骤 | 采用资产 | 事项 | 改动面 |
| --- | --- | --- | --- |
| **S01** | #14–#16 | 日志五色徽标 + 四列网格 + 等宽时间 | 小 |
| **S02** | #20 #21 | 工具名翻译表 + 主体提取 | 极小（纯函数） |
| **S03** | #17 | 日志按轮分组 | 中 |
| **S04** | #18 | 日志可展开正文 | 中 |
| **S05** | #01–#04 | 设置四类分组 + 风险档 | 中 |
| **S06** | #03 | 字段双闸 | 小 |
| **S07** | #31 | 运行中空输入 → 停止键 | 小 |
| **S08** | #36 | 附件三态 + 闸住发送 | 中 |
| **S09** | #37 | 按钮 mousedown 保焦点 | 极小 |
| **S10** | #33 | 上下文计 | 小 |
| **S11** | #19 | 日志跟随滚动 | 极小 |
| **S12** | #24–#28 | 左上角身份行（依赖 D1） | 大 |
| **S13** | #32 | 模型/权限移出卡片 | 中 |
| **S14** | #34 | 队列坞 | 大 |
| **S15** | #35 | Enter 行为设置 | 中 |

### 八、待你裁决

| 编号 | 分歧 | 我的建议 |
| --- | --- | --- |
| **D1** | 头像昵称放哪（Rail 顶 / 标题栏 / 恢复侧边栏） | Rail 顶部方案 A |
| **D2** | 输入框恒定高 vs 1→5 行增长 | 保持增长 + 卡内滚 |
| **D3** | 设置面板高 540 vs 720 | 720 |

---

## 0. 先划清两版的形态差异

复刻前必须先承认一个结构性冲突，否则清单会被误读成「照抄就能用」。

| 维度 | 旧版 | 现版 | 影响 |
| --- | --- | --- | --- |
| 左栏 | 280px 侧边栏，含头像/昵称/会话列表 | 56px 图标脊（Rail），无身份区 | 头像昵称**没有现成位置**，需新增决策 |
| 会话 | 多会话，左侧列表切换 | 单会话制，全应用一段对话 | 旧版的会话列表行、分组、搜索全部作废 |
| 设置 | 800×800 浮层面板，188px 导航，8 项 | 760×540 纸片，160px 导航，11 项 | 尺寸/分组口径需重定，不能直接搬 |
| 日志 | 中间列的第二个「读法」（对话/日志切换） | 右侧抽屉里的三类分区 | 交互容器不同，投影层可直接复用 |
| 组件化 | 60+ 独立包，槽位注册 | 单 `src/components` 平铺 | 旧版的分层思路可借，物理结构不必照搬 |

结论：**投影逻辑、度量口径、交互契约可以直接复用；视觉容器要按现版的单会话形态重做。**

---

## 一、设置分类体系（#01–#05，最高价值）

### #01 · 1.1 按「使用者要解决什么问题」分组，而不是按代码模块

旧版最有价值的一条设计判断，写在 `ui-settings-plugin-inventory/src/client/cordis-categories.ts` 文件头：

> 把 123 个配置段按「使用者要解决什么问题」分成四组，另把高级、高风险与不可更改的项收进「开发者模式」……分组与组内顺序都是显式数组，不依赖任何运行时推断。

四组的口径（原文）：

- **人设设定**：从「装上人设包」到「写自己的人设包」，基础 → 进阶
- **记忆与情绪**：记忆写入、召回、审计在前，情绪与关系在后
- **通道与接口**：首选（官方托管，零本地风控）→ 常用 → 端侧与公共段 → 高危最后
- **扩展功能**：日历、天气、日记、语音、主动行为等日常能力
- **开发者模式**：底层参数、注入链、评测沙箱、安装宿主，以及标了 `advancedOnly` / `secret` 的项

**可复用点**：现版 `SettingsPlugins.tsx` 目前是平铺的配置段列表。可以直接套用这个四组 + 开发者模式的口径，插件参数页立刻从「1116 项的墙」变成「四个能读懂的入口」。

### #02 · 1.2 通道组内的四级风险档位（tier）

`CordisCategorySection.tsx` 用 `SectionTier = 'preferred' | 'common' | 'device' | 'highRisk'`，把"官方托管 → 本地桥接 → 端侧设备 → 个人号自动化"按风险递增排列，高危压到最后并打红标。

**可复用点**：现版若有"微信个人号 / ADB / GUI 操控"这类高风险能力，同样需要一个视觉上的"最后一道"位置，而不是混在列表中间。

### #03 · 1.3 分级字段可见性：`advancedOnly` / `secret` 双闸

```ts
function isAdvanced(field) {
  return field.advancedOnly === true || field.secret === true
}
// 普通分类页：过滤掉 advanced
// 开发者页：只显示 advanced（本段专属的则全显）
```

三条好处：普通页不吓人；开发者页不是另一个列表；`secret` 字段额外 `disabled`（只写不读）。

**可复用点**：现版 `SettingsPlugins.tsx` 283 行里没有这个双闸，所有字段同级平铺。

### #04 · 1.4 导航栏的排序是显式常量，不是运行时推断

```ts
/** 左栏顺序：通用 0 · 模型 10 · 人设 20 · 记忆 30 · 通道 40 · 扩展 50 · 开发者 60 · 关于 70 */
const CATEGORY_ORDER_START = 20   // 四类配置各占 20/30/40/50
const ABOUT_ORDER = 70            // 关于恒在最后
```

**可复用点**：现版 `Settings.tsx` 的 `PAGES` 数组已经是这个思路（顺序即导航顺序），保持一致即可，不必改。但可以补上"关于必须最后"这条硬约定。

### #05 · 1.5 分类页复用内置设置的行式，不自造面板

`CordisCategorySection.tsx` 文件头的自律条款值得保留：

> 版式与「通用设置」一致：一段一行标题 + 12px 说明，右侧是控件……没有自造搜索框、没有卡片式浮层——只保留内置设置本来就有的 disclosure（展开箭头）。

**可复用点**：现版 `SettingsPlugins` 若已自造了一套卡片，建议回退到 `preferences.css` 已有的 `pref__row` 行式，避免同一应用里两种行高。

---

## 二、设置 UI（#06–#13）

### #06 · 2.1 四格网格 + 插槽：面板只有骨架，分类由插件注册

`SettingsRoot.tsx` 的核心结构：

```
grid-template-columns: 188px minmax(0, 1fr)
grid-template-areas:
  'title header'
  'nav   options'
```

四个座位都是 panel 的直接子元素，靠 grid area 定位：标题 / 导航 / 头部动作 / 内容区。分类不是写死的数组，而是 `settings.section` 槽位的注册项——新插件加一页设置，不改这个文件。

**可复用点**：现版 11 个页面是 `PAGES` 数组 + 一长串 `{page === 'xxx' ? <SettingsXxx /> : null}` 条件渲染（`Settings.tsx` 第 181–204 行）。这是 11 条平行的三元表达式，加第 12 页要改三处。可以借"注册表"思路收敛成一张表。

### #07 · 2.2 面板尺寸：高度锁死，不随内容变

```css
width: 800px;
height: min(800px, calc(100vh - 2 * max(24px, ...)));
```

源码注释给的理由很关键：

> One height for every section, taken from the viewport rather than the content, because a content-sized panel would resize under the pointer on every nav click.

**可复用点**：现版 760×540 已经是固定高，方向一致。但 540 对"1116 项配置"这类长页偏矮，建议提高到 `min(720px, 100vh - 96px)`，理由同旧版：换页时纸片不该跳。

### #08 · 2.3 导航单元格的选中态：一档实底 + 4px 间距 + 过渡

```css
.navList { gap: 4px; }
.navCell { height: 40px; padding: 9px 16px 9px 12px; border-radius: var(--dsw-radius-md); }
.navCell.active { background: var(--dsw-specific-sidebar-nav-item-active); }
/* 注释：selected fill 在相邻格子间跳动会读成两次重绘，加过渡让它"走"过去 */
transition: background-color var(--dsw-motion-fast);
```

**可复用点**：现版 `pref__nav-item` 用的是 `aria-current='page'` + `::before` 主色条（第 70–83 行）。两种方案都成立，但**不要混用**：一档实底更安静，主色条更强调。单会话制产品建议用旧版的一档实底。

### #09 · 2.4 设置行：0.5px 分隔线，不套卡片

`CordisCategorySection.module.css` 的口径：

```css
.group { border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.group:last-child { border-bottom: none; }
```

行本身：`说明在左（label + key + 默认值 + 范围），控件贴右`，字段级错误就地显示，不弹 toast。

**可复用点**：与现版 `pref__row` 一致，无需改。可作为"新页面的默认长相"写进规范，防止再长出第三种行式。

### #10 · 2.5 分组折叠：段头一行 + 字段数 + 状态提示

```tsx
<span className={css.groupTitle}>{title}</span>
{highRisk && <span className={css.badgeHigh}>高危</span>}
<span className={css.count}>{fields.length} 项</span>
// 段头第二行：<code>{id}</code> + 「可写 / 只读 / 未注册」
```

**可复用点**：现版插件参数页可直接采用。三个状态词（已装载可写 / 只读 / 未注册）比一句"加载中"信息量大得多。

### #11 · 2.6 控件集：按字段 kind 分派，不做花活

`FieldRow` 的分派只有五种：`boolean → checkbox`、`enum → select`、`json → textarea`、`number/text → input`。

**可复用点**：现版 `settingsUi.tsx` 的 `Choices`（radiogroup + 完整键盘语义）是比旧版 select 更好的实现，**保留现版**，不要回退。

### #12 · 2.7 关闭路径的三条，和一个防误触细节

- 头部关闭键、点遮罩、Esc（`useModalLayer`）
- 现版 `Settings.tsx` 第 133 行用 `mousedown` 而非 `click` 关遮罩，注释解释了原因：在遮罩上按下、拖到面板里松手，`click` 会记在遮罩上，于是"想选中一段文字"变成"把面板关了"

**可复用点**：这条现版已修好，保持。旧版的 `mask` 单独成元素（`aria-hidden` + onClick），比"根节点判 target"更清晰，可借。

### #13 · 2.8 初始焦点落在当前页导航项，不是关闭键

现版 `Settings.tsx` 第 146–148 行已实现，注释也写对了理由。旧版 `data-modal-autofocus` 落在 `active` 那一格，同一思路。

**保持现状**，写进规范。

---

## 三、日志展示方式（#14–#23，第二高价值）

旧版把日志做成**"同一段对话的另一种读法"**，而不是一块调试输出。这套设计几乎可以整块搬。

### #14 · 3.1 五类徽标：按"她在做哪类事"分类

```ts
type RunLogCategory = 'channel' | 'model' | 'tool' | 'pace' | 'error'
```

映射规则（`entries.ts` 的 `categoryOf`）：

| 徽标 | 覆盖事件 | 含义 |
| --- | --- | --- |
| `channel` | 收到消息、注入上下文 | 信息进出 |
| `model` | 思考、回复、压缩 | 模型在动 |
| `tool` | 工具开始/成功/失败 | 动手了 |
| `pace` | 轮次开始/结束/阻塞/中止 | 节奏 |
| `error` | 回复被中断、轮次失败 | 出错 |

每类一个柔和底色（`state-*-tertiary` + `state-*-primary` 文字），**颜色只是扫描辅助，词才是语义**。

**可复用点**：现版 `LogDrawer.tsx` 用的是 `轮/收/她/具/错` 单字徽标（第 58–64 行）——方向对了，但单字太挤、无法一眼归类。建议换成旧版的**双字词 + 五色**，并保留现版已分的三类分区（会话/通道/系统）。

### #15 · 3.2 四列网格：时间 / 徽标 / 发送方 / 叙述

```css
.row {
  display: grid;
  grid-template-columns: auto 44px 32px minmax(0, 1fr);
  align-items: baseline;
  gap: 8px;
  font-size: 13px; line-height: 18px;
}
```

源码注释：

> A grid rather than inline flow so the timestamps and both badges form straight columns — a reader scanning for "when did she think" follows one edge instead of a ragged one.

**可复用点**：现版 `LogDrawer` 若是"徽标 + 文字"的 flex 流，扫描时会呈锯齿。改成网格是纯 CSS 改动，收益明显。

### #16 · 3.3 时间用等宽字体 + `tabular-nums`

```css
.time {
  font-family: ui-monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;   /* 等宽字偏小，一丝光学补偿 */
}
```

**可复用点**：现版 `clockOf` 已输出 `HH:mm:ss`，只缺等宽与 tabular-nums 两行样式。

### #17 · 3.4 按轮分组：组头是"第 N 轮 · 时间 · 条数"

```tsx
<h3>
  <span>第 {turn} 轮</span>
  <span className={css.groupTime}>{clockTime(...)}</span>
  <span className={css.groupCount}>{count} 条</span>   {/* margin-left: auto */}
</h3>
{...rows}
<div className={css.divider} />   {/* 0.5px 组间分隔 */}
```

关键判断：**分组只认 `turn/start` 与 `turn/end` 自己声明的边界**，不在轮次内的事件（`turn === null`）不硬造组头——"inventing a heading would be the log guessing"。

**可复用点**：现版日志是平铺流。加了按轮分组后，"这几轮她做了什么"才读得出来。

### #18 · 3.5 可展开正文：默认折叠，带字数

三类正文各用一个原生 `<details>`：

- `received` → 「收到的话」+ 字数
- `thinking` → 「她想的过程」+ 字数
- `replied` → 「她说的」+ 字数

```css
.body { grid-column: 4; border-left: 0.5px solid var(--dsw-alias-border-l3); padding-left: 8px; }
.bodySummary::before { content: '›'; transition: transform 120ms; }
.body[open] > .bodySummary::before { transform: rotate(90deg); }
.bodyText { max-height: 280px; overflow-y: auto; }
```

源码理由：

> The bodies that make the log a record rather than a ticker: what she thought and what she said. Collapsed by default so the list stays scannable, and always present so the reader never has to leave the view to see it.

**可复用点**：现版已有 `日志` 抽屉但没有内联展开。这三块是"日志能当记录看"的关键，强烈建议补。

### #19 · 3.6 跟随滚动：48px 阈值

```ts
const STICK_THRESHOLD_PX = 48
following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48
// 只有仍在底部时才在新增条目后滚到底
```

源码：

> A log that does not follow its own tail is a log nobody reads: pin to the newest line unless the reader has scrolled up to study something.

**可复用点**：任何实时追加的列表都该有这条，现版日志抽屉未见实现。

### #20 · 3.7 工具名说人话：一张翻译表 + 未知则原样

```ts
const TOOL_KEYS = {
  bash/shell/terminal: '运行命令',
  read/readfile: '读文件',
  write/writefile: '写文件',
  edit/multiedit/applypatch: '改文件',
  glob/grep/search/filesearch: '找文件',
  websearch/webfetch/fetch: '上网查',
  task/agent: '交给子代理',
}
```

关键自律：**表里没有的工具保留原名**——"a tool this build has never seen is still a real thing she picked up, and renaming it would be the log guessing"。

**可复用点**：现版 `LogDrawer` 直接显示工具原名。补这张表即可，成本极低，可读性提升很大。

### #21 · 3.8 工具主体提取：取参数里最像"宾语"的那个，路径只留尾名

```ts
const candidates = ['file_path','filePath','path','notebook_path','command','pattern','query','url','description','prompt']
// 路径类只取 basename：列已经说了她在哪
// 超过 64 字截断加省略号
```

源码理由：

> A line saying only "picked up: read a file" leaves the obvious next question — which file? — unanswered, and that is the difference between a log that narrates and a log that just ticks.

**可复用点**：这是"日志有用"和"日志是 ticker"的分水岭，优先补。

### #22 · 3.9 时长只在工具行显示，回复与轮次写在句子里

```ts
function rowDuration(entry) {
  if (line.kind !== 'toolFinished' && line.kind !== 'toolFailed') return null
  return `${(line.elapsedMs / 1000).toFixed(1)}s`
}
```

源码：

> a reply and a turn already say their own duration inside the sentence（"想了 10.1 秒"）, so repeating it as a trailing figure printed the same time twice. Tools have no such sentence, so the figure is the only place their duration appears.

**可复用点**：这条是"不重复说同一件事"的典范，值得抄进规范。

### #23 · 3.10 投影与渲染分离：纯函数、可单测、不认得的降级为空行

`entries.ts` 的定位：

> A pure projection: Session events in, narrated lines out. Nothing here renders and nothing here fetches, so the whole reading is testable without a browser, and the view stays a dumb list.

且有明确的"不显示"清单：chunks、请求头、system prompt、token 用量、model id 全部不出现，理由是一句硬标准：

> A reader who does not know what an API is must understand every line.

**可复用点**：现版日志若在组件内直接拼装文本，建议把 `deriveRunLog` 这类纯函数层抽出来——可测、可复用给导出、可给第二视图。

---

## 四、左上角头像与昵称（#24–#28）

### #24 · 4.1 结构：标记 + 名字 + 状态点，一行三层信息

```tsx
<span className={css.brand}>
  <span className={css.brandIdentity}>
    <span className={css.brandMark}>{/* 24px 头像/标记，可被 slot 替换 */}</span>
    <span className={css.brandName}>
      <span className={css.personaName}>{persona.name}</span>
      <span className={css.personaPresence} data-presence={presence}>
        <span className={css.presenceDot} />
        {t(`brand.${presence}`)}
      </span>
    </span>
  </span>
</span>
```

### #25 · 4.2 状态词只有三档，且从会话状态真实推导

```ts
// waiting > thinking > online
for (const status of statuses.values()) {
  if (status.pendingInteraction !== undefined) return 'waiting'   // 有交互在等
  if (status.running) running = true
}
return running ? 'thinking' : 'online'
```

源码自律条款：

> Nothing is inferred beyond that — mood and energy belong to the emotion engine, not to this row.

**可复用点**：现版 `SessionStats` / `Inspector` 已有心情与精力读数，但左上角缺一个**最轻的一眼状态**。这三档（在线/在想/等你回答）比百分比更适合放身份行。

### #26 · 4.3 身份行不是按钮，整行是窗口拖拽区

```tsx
<div className={css.logoRow} data-window-drag>
  <span className={css.brand}>...</span>
  <button className={css.newSessionIcon}>+</button>   {/* 唯一可点项在最右 */}
</div>
```

源码理由：

> The identity is never the click target: on macOS this row is the window's drag band, and a button here would subtract itself from it.

**可复用点**：现版 `TitleBar.tsx` 是"应用名 + 版本号"居中，左 84px 让位红绿灯。若把头像昵称搬回来，**建议放在 Rail 顶部的拖拽区内**，且自身不可点，点击身份 = 无操作或打开 About。

### #27 · 4.4 macOS 红绿灯让位条：52px 空白 strip

```css
.topStrip { height: 52px; margin: -6px calc(-1 * var(--ondra-sidebar-inline-padding)) 0; }
.topStrip + .logoRow { margin-top: -12px; }   /* 内容列回吞 12px */
```

**可复用点**：现版 `TitleBar` 用 84px 左侧留白，同样效果。若改侧边栏版式可直接借这两个数值。

### #28 · 4.5 品牌可被插件整体接管（槽位回退）

```tsx
{renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <PersonaAvatar /> })}
{renderSlot('sidebar.brand.name', {}, { fallback: <PersonaName /> })}
```

**可复用点**：现版若要支持"换人设包换头像"，用同样的"有则接管、无则回退"结构，避免把 persona 状态写进布局组件。

---

## 五、输入框（#29–#39）

### #29 · 5.1 一等的形态判断：它是"一句话的盒子"，不是"表单"

`InputBar.module.css` 的开场注释：

```css
/* One-line capsule: the text area and the tool row sit close together, so
   the card stays a sentence box instead of a panel. */
.card { gap: 4px; padding-top: 4px; }
```

配套的强约束：**卡片高度恒定**。

```css
.scroll {
  height: var(--ondra-composer-text-max-height);   /* 固定一行高 */
  overflow-y: auto;                                 /* 长文在内部滚 */
}
```

源码：

> Fixed to ONE line: the composer is a sentence box, so its height never follows the draft. Longer text wraps inside and scrolls here, which keeps the card — and therefore the whole floor group — at a constant height.

**与现版的差异**：现版 `composer.css` 是 `min-height: 28px; max-height: 140px`，即"1→N 行逐级增长、封顶 5 行"。两种都成立，但**必须选一个并写死**。旧版恒定高的好处是整个底部区不跳动；现版增长的好处是长草稿可见更多。建议：**保持现版的 28→140 增长**（用户已经在用），但把"卡片内滚"这条补上，避免 140 之后整卡继续长。

### #30 · 5.2 两列地板：文本占左，动作占右，动作不在文本上方

```tsx
<div className={css.composeRow}>
  <DraftEditor />                 {/* flex: 1 */}
  <div className={css.sendColumn}>
    {interruptible && <StopButton />}
    <PrimaryButton />              {/* 34px 圆 */}
  </div>
</div>
```

源码：

> the send column is its own track on the right — nothing is written above the button, so the capsule reads as text · action rather than a stacked form.

**可复用点**：现版是 textarea 在上、工具行在下、发送键在工具行右端（`composer__row`）。旧版把发送键提到与文字同一行，视觉更紧凑。这是**可选优化**，改动面中等。

### #31 · 5.3 发送键：34px 圆、强调色实底、空文本 40% 透明

```css
.primary {
  width: 34px; height: 34px; border-radius: 999px;
  background: var(--ondra-accent-fill);   /* 浅色近黑 / 深色近白 */
  color: var(--ondra-accent-ink);
}
.primary:disabled { opacity: 0.4; }
```

三个图标状态，各有语义：

| 状态 | 图标 | 含义 |
| --- | --- | --- |
| 可发 | 带凹口的实心三角 | 方向，不是纸飞机 |
| 发送中 | 旋转圆弧 | 等 Host 接收 |
| 运行中且空输入 | 圆角方块 | 停止 |

源码：

> Navigation arrow: a solid triangle with a notched base, the compass cursor rather than a paper plane — a direction, not a letter.

**可复用点**：现版 `IconSend` 是纸飞机。换成三角是纯图标改动。**"运行中空输入 = 停止键"** 这条交互强烈建议补——现版有 `running` 态但发送键语义未合并。

### #32 · 5.4 模型与权限在卡片**外**，居中如脚注

```tsx
<div className={css.modelBelow}>
  {renderSlot('conversation.input.permission')}
  {renderSlot('conversation.input.model')}
</div>
```

源码：

> The model seat lives below the card, not inside it: a companion's composer is a sentence box, and choosing who replies is a separate decision. Centered under the card, it reads as a footnote rather than a control row.

**与现版的差异**：现版模型名在卡片内的工具行左端（`+  magpie ⌄`）。旧版把它移出卡片。这是**形态级判断**，取决于产品定位：卡片内 = 它是输入的一部分；卡片外 = 它是"跟谁说话"的前置设置。

**建议**：单会话 + 人设固定的产品，模型选择频率很低，移到卡外更合适；同时把权限档位并排放在同一行——"谁回复"和"能走多远"是两个前置答案，天然成对。

### #33 · 5.5 上下文计：环 + 百分比，点开看三段构成

```ts
const RADIUS = 5.5;   // 14px viewBox，2px 描边
const ROWS = [
  { key: 'systemTokens',  label: '系统提示' },
  { key: 'toolsTokens',   label: '工具定义' },
  { key: 'messageTokens', label: '对话内容' },
]
```

关键：**两项都齐才渲染**（压力 + 路由容量），否则不画空环。

**可复用点**：现版 `SessionStats` 有 token 总量，但没有"还剩多少"。这个 14px 环是低成本高价值的常驻读数。

### #34 · 5.6 队列坞：运行中排队的消息可编辑、可调序、可删

`QueueDock.tsx` 415 行，比输入框本身还重。能力清单：

- 折叠/展开（`IconChevronUp/Down`）
- 就地编辑（`InlineEditor`）
- 上移/下移、删除
- 图片附件的持久引用与预览
- 空队列不占位

**可复用点**：现版的 `running` 状态只能"等"或"打断"。旧版的"排队 + 可编辑"是"边跑边改下一句"的关键能力。若现版已有 `queue` 概念，界面需要补齐这套操作。

### #35 · 5.7 Enter 行为的用户可选项：queue / steer

```ts
// resolveSubmitMode(preferred, running, gesture, steeringAvailable)
// 空闲：两者都是 queue
// 运行中 + plain Enter：按偏好
// 运行中 + Cmd/Ctrl+Enter：取偏好的反义
```

配套一个设置行（`EnterBehaviorRow`）：下拉二选一「排队 / 直接插话」。

**可复用点**：这是把"运行中按回车到底干什么"这个高频困惑交给用户决定，并给出加速键反义。任何有"运行中仍可输入"的产品都该有。

### #36 · 5.8 附件轨：64px 方缩略图，横滚，不画滚动条

```css
.rail { display: flex; gap: 10px; overflow-x: auto; scrollbar-width: none; }
.item { flex: none; height: 64px; }
.thumbnail { width: 64px; height: 64px; border-radius: var(--dsw-radius-xl); }
```

配套四种状态：待上传 / 上传中 / 失败可重试 / 就绪。**上传未完成时发送键被闸住**，且失败不会被静默丢弃。

**可复用点**：现版 `composer__attachment` 已有缩略图，缺"上传中/失败重试"的状态机与"闸住发送"的规则。

### #37 · 5.9 焦点保持：按钮 mousedown 时阻止抢焦点

```ts
const keepFocus = (e) => { keepDraftFocus(e, editor) }   // mousedown 上 preventDefault
```

源码：

> Button presses steal focus from the editor; suppress at mousedown so typing continues seamlessly.

**可复用点**：现版若无此处理，点一下加号再打字会丢焦点。一行代码的收益。

### #38 · 5.10 中文输入法：`isComposing` 必须判原生事件

现版 `Composer.tsx` 第 33–39 行已经写明这条，且实现正确。**保留并写进规范**——这是中文界面最易出、最难在英文环境复现的缺陷。

### #39 · 5.11 命令菜单：`/` 触发的组合框，焦点不离开输入框

`MenuView.tsx` 的契约：

- `combobox` 模式，`aria-activedescendant` 暴露高亮行
- 行内容：标题 → 命令别名（仅当标题不是别名的另一种大小写形式）→ 右对齐说明
- 最多 400px 高，顶部留 84px 给会话头部
- 有面包屑时才画面包屑头
- 无结果时两个骨架行，不是空白

**可复用点**：现版若有 `/` 命令，建议对齐这套无障碍契约。

---

## 六、其他值得抄的组件（#40–#49）

| 编号 | 组件 | 旧版位置 | 一句话价值 | 现版状态 |
| --- | --- | --- | --- | --- |
| **#40 对话/日志双视图切换** | `ui-sidebar/ViewSwitch.tsx` | 38px 分段控件，一颗药丸滑动；`radiogroup` 语义；无会话时整体禁用而不假装选中 | 缺（现版是抽屉） |
| **#41 审批卡** | `ui-approval/ApprovalCard.tsx` | 每个请求重置状态、`waiting` 锁防重复提交、失败可回滚、键盘可答 | 缺 |
| **#42 消息统计药丸** | `ui-chat/StatsPills.tsx` | 紧凑/详细两档；速度与缓存命中常显，token 总数点开看 | 部分（SessionStats） |
| **#43 空态 Hero** | `ui-conversation/EmptyHero.tsx` | 标记与产品名置顶，输入框守地板，中间刻意留白 | 有（empty-first-run） |
| **#44 新建会话圆钮** | `ui-sidebar/SidebarRoot.tsx` | 身份行最右的 15px `+`，与拖拽带共处不冲突 | 不适用（单会话） |
| **#45 连接状态指示** | `ui-primitives/ConnectionIndicator.tsx` | 连接中/断开/已恢复三态，含 800ms 最短可见期防闪烁 | 部分 |
| **#46 文件类型图标** | `ui-primitives/FileTypeIcon.tsx` | 按扩展名给图标，附件卡与消息共用一套 | 缺 |
| **#47 图片灯箱** | `ui-primitives/ImageLightbox.tsx` | 缩略图点击放大，附件与消息内图片共用 | 缺 |
| **#48 差异块** | `ui-primitives/DiffBlock.tsx` | 文件改动行内展示 | 缺 |
| **#49 风险确认** | `ui-primitives/RiskConfirmation.tsx` | 高危操作二次确认，含"为什么危险" | 部分（Dialog） |

---

## 七、落地步骤（S01–S15）

按"改动小 × 收益大"排序，前四项都不动布局骨架。

| 步骤 | 采用资产 | 事项 | 改动面 | 收益 | 落点 |
| --- | --- | --- | --- | --- | --- |
| **S01** | #14 #15 #16 | 日志五色徽标 + 四列网格 + 等宽时间 | `LogDrawer.tsx` + 样式 | 日志从"能看"到"好扫" | 第 58–64 行、行渲染 |
| **S02** | #20 #21 | 日志工具名翻译表 + 工具主体提取 | 新增约 60 行纯函数 | 日志说人话 | 新增 `lib/logText.ts` |
| **S03** | #17 | 日志按轮分组 + 组头（轮次/时间/条数） | 中 | 过程可读成"轮" | `LogDrawer` 渲染层 |
| **S04** | #18 | 日志可展开正文（收到/思考/回复 + 字数） | 中 | 日志成为记录 | 同上 |
| **S05** | #01 #02 #03 #04 | 设置分组口径：四类 + 开发者模式 + 风险档位 | `SettingsPlugins.tsx` | 1116 项变成四个入口 | 参照 `cordis-categories.ts` |
| **S06** | #03 | 设置字段双闸：`advancedOnly` / `secret` | 小 | 普通页不吓人 | 字段过滤器 |
| **S07** | #31 | 输入框：运行中空输入 → 停止键 | 小 | 少找一个按钮 | `Composer.tsx` |
| **S08** | #36 | 输入框：附件上传三态 + 闸住发送 | 中 | 不再静默丢文件 | `Composer.tsx` |
| **S09** | #37 | 输入框：按钮 mousedown 保持焦点 | 极小 | 连续输入不中断 | `Composer.tsx` |
| **S10** | #33 | 上下文计（14px 环 + 三段构成） | 小 | 常驻"还剩多少" | `Composer` 下方 |
| **S11** | #19 | 日志跟随滚动（48px 阈值） | 极小 | 新条目可见 | `LogDrawer` |
| **S12** | #24 #25 #26 #27 #28 | 左上角身份行（头像 + 昵称 + 三态点） | **大**（需形态决策 D1） | 产品有"人" | 见第八章 |
| **S13** | #32 | 模型/权限移出卡片成脚注 | 中 | 输入区更纯 | `Composer` + 样式 |
| **S14** | #34 | 队列坞（可编辑/调序/删除） | 大 | 边跑边改 | 新增组件 |
| **S15** | #35 | Enter 行为设置（queue/steer） | 中 | 高频困惑交给用户 | 设置页 + `Composer` |

---

## 八、待你裁决（D1–D3）

不要直接照抄旧版的地方，列出来等决策：

### D1 · 头像昵称放在哪？

现版 56px Rail 没有身份区。三个选项：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A. Rail 顶部加 56px 头像 | 图标脊最上方一个圆形头像 + 悬浮 tooltip 显示昵称 | 最省地，但昵称要 hover 才见 |
| B. TitleBar 左侧加身份 | 红绿灯右侧放头像 + 昵称 | 与"标题栏只放应用身份"的既有判断冲突 |
| C. 恢复窄侧边栏 | 回到 240–280px，身份行 + 会话列表 | 与单会话制矛盾，不建议 |

**建议 A**：Rail 顶部放头像（含三态状态点），昵称通过 `title` 与悬浮卡呈现；身份行仍作拖拽区，自身不可点。

### D2 · 输入框高度：恒定单行 还是 1→5 行增长？

旧版恒定（内部滚动），现版增长。两者不能混（混了会出现"长到 5 行后才开始内部滚"的跳变）。**建议保持现版增长**，但把 `max-height` 之后的行为明确为"卡内滚动"。

### D3 · 设置面板尺寸：540 还是 720？

现版 760×540 对短页合适，对 1116 项配置页偏矮（一屏只能看 6–7 段）。**建议 760×`min(720px, 100vh - 96px)`**，理由沿用旧版：换页时纸片不该跳动。

---

## 附：源码索引

| 主题 | 路径（相对 `Temp/Ondra/desktop`） |
| --- | --- |
| 设置面板骨架 | `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` + `.module.css` |
| 设置分类表 | `packages/client/ui-settings-plugin-inventory/src/client/cordis-categories.ts` |
| 设置分类页 | `packages/client/ui-settings-plugin-inventory/src/client/CordisCategorySection.tsx` |
| 设置表单原语 | `packages/client/ui-primitives/src/settings-form/` |
| 日志投影 | `packages/client/ui-run-log/src/client/entries.ts` |
| 日志视图 | `packages/client/ui-run-log/src/client/RunLogView.tsx` + `.module.css` |
| 侧边栏/身份行 | `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` + `.module.css` |
| 双视图切换 | `packages/client/ui-sidebar/src/client/ViewSwitch.tsx` + `.module.css` |
| 输入框 | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` + `.module.css` |
| 输入机器/提交策略 | `packages/client/ui-conversation/src/client/input/submission-policy.ts` |
| 富文本编辑器 | `packages/client/ui-conversation/src/client/input/editor/` |
| 命令菜单 | `packages/client/ui-input-trigger/src/client/MenuView.tsx` |
| 队列坞 | `packages/client/ui-conversation/src/client/queue/QueueDock.tsx` |
| 上下文计 | `packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx` |
| 附件轨 | `packages/client/ui-attachment/src/client/ComposerAttachments.tsx` |
| 审批卡 | `packages/client/ui-approval/src/client/ApprovalCard.tsx` |
| 统计药丸 | `packages/client/ui-chat/src/client/chat/StatsPills.tsx` |
| 原语库（60+） | `packages/client/ui-primitives/src/` |
