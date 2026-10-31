---
description: "dsh Web 客户端的侧边栏外壳插件：品牌行、New Session 操作、可感知滚动的区域席位与底部固定的 Settings 席位。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar

[English](README.md) | 中文

桌面端产品事件使用可选的[产品埋点服务](../product-analytics/README.zh.md)，不包含普通 Web 交互。

## 概述

dsh Web 客户端的侧边栏让用户识别当前构建、启动新会话、浏览 Workspace 与 Session，以及打开 Settings。该栏常驻：它占据窗口宽度的四分之一，不提供折叠控件、收起轨道或全屏呈现。它会将 Settings 入口固定在底部，并在隐藏空闲滚动条时避免浏览器行发生位移。New Session 优先使用显式选择的 Workspace，其次使用当前 Session 所属的 Workspace，再其次使用最近活跃的 Workspace；如果都不存在，则打开空白的 New Session 页面。部署可以替换品牌标记或名称，同时保留导航控件和行几何。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

侧边栏是导航外壳：用户看到品牌、启动新会话、浏览自己的 Workspace 并到达 Settings。该栏永不折叠、隐藏或展开，因为框架将其锁定为四等分栏（ui-layout `columns.ts`）。功能插件填充它的席位——ui-workspace 填充 `sidebar.workspaces`，ui-settings 在 `sidebar.settings` 注册触发行与设置面板。

### 品牌与 New Session

品牌行把 `sidebar.brand.mark` 与 `sidebar.brand.name` 渲染为两个独立的 single slot。在 Web 和 Windows 桌面端，点击品牌会新建会话，悬停或聚焦时不显示 tooltip。没有占位者时，外壳使用鱼形标记和本地化的本地构建标签。完整构建会在标签下方显示代码徽标；该徽标使用 `DSH_CLIENT_VERSION`、可选的 7 位 `DSH_CLIENT_COMMIT_HASH` 与 `DSH_CLIENT_GIT_DIRTY=true` 组装成 `version[-commit][-dirty]`；缺少版本元数据时不显示徽标。此类构建中点击回退的标记或标签会复制该徽标文本而非新建会话，macOS 桌面端同样适用；写入成功后弹出“版本号复制成功”toast。New Session 优先使用作用域操作明确指定的 Workspace，否则使用当前 Session 所属 Workspace，再否则使用最近活跃 Workspace；一个 Workspace 都没有时则清空选择，进入空白 New Session 页面。新建会话按钮在键盘聚焦时于右侧以灰色文字显示当前有效绑定，不受设备悬停能力限制；支持悬停的设备也会在悬停时显示。快捷键可见且空间较窄时，居中的图标与文字在快捷键之前渐隐；CSS 为快捷键保留宽度，无需测量按钮。纯图标控件保留使用平台键位样式的 tooltip。所有控件均提供 `aria-keyshortcuts`。全局访问快照不含 `session/create` 时，品牌行不可点击，New Session 按钮不渲染；每个新建请求仍由 Host 判定。

### 全局面板入口

插件在 root 作用域的 `sidebar.panellist` list 中注册图标组件，提供 `id`、可选 `order`，以及字符串或 locale-aware 的 `label`。同一个 id 寻址布局中 root 作用域 `main` keyed slot 的组件；选择不存在的主面板条目会抛错，并保留当前选中态。标签提供普通可见文字与无障碍名称。导航行的间距为 2px。每一行通过 `usePanelInfo` 读取自己的选中态；DOM 焦点移到搜索框或目录选择器时，显示的面板及其列表项选中态不变。没有面板注册项时，列表及其间距均不渲染。产品随附的组合不注册示例面板。

root 作用域的 `sidebar.panellist.actions` list 有注册项时，导航区域的面板行之后显示面板行样式的**更多**按钮。它打开的菜单以该 list 的注册项为菜单行。每个注册项接收 `entries`（按注册顺序的可自定义面板，含 `id`、`label`、`pinned` 与 `active`；不含插件管理）、选中面板的 `onOpen(id)`、`onPinnedChange(id, pinned)`，以及关闭菜单的 `onDismiss()`。侧边栏在内存中保存所有会话共用的已取消固定面板 id 列表；插件管理入口始终显示。默认更多菜单只提供插件浏览和创建，不列出面板或 Pin 控件。其他注册项仍可调用 Pin 回调，但插件重新加载时选择重置，不读取旧 localStorage 值。取消固定只隐藏导航行，主面板、其注册和当前选中态不变。未注册面板的 id 保留在内存列表中，直到插件重新加载。

### 固定分栏

该栏常驻。框架求解 1/4、2/4、1/4 的分栏（ui-layout `columns.ts`），因此侧边栏既不可调整宽度也不可折叠：外壳不渲染折叠控件、56px 轨道、展开可供性或 `sidebar.toggle.badge` 席位。`SidebarRoot` 因此无条件向每个席位传入 `wide: true`，命令目录也不再绑定折叠或全屏命令；New Session、面板导航与刷新保留各自的快捷键。

由于该栏只有一种状态，外壳不携带折叠过渡、不为折叠保留减少动态效果的例外，也不对任何控件做横向位移。固定在底部的 `sidebar.settings` 席位与 `sidebar.footer.action` 列表在页脚区域内纵向堆叠。

在 Windows Electron 中，`html[data-windows-titlebar]` 将品牌行设为 40px 高、无外边距、前导内边距 8px，把标记右移 1px、身份块下移 1px，并给新建会话按钮 6px 的上边距，使其避开顶栏。

### macOS 桌面

在 `html[data-platform='darwin']`（仅由桌面 preload 设置）下，侧边栏列顶部有一条 52px 的顶部条，用于避开 hiddenInset 红绿灯；顶部条与其下的 logo 行各自打上 `data-window-drag`，于是每行自己的盒子就是窗口的拖拽区（唯一的 darwin drag 规则由 ui-web base.css 声明），因此品牌 wordmark 在 macOS 上不再是 New Session 快捷入口——专用的 New Session 按钮保留该操作。[Desktop 参考](../../../apps/desktop/README.zh.md)负责窗口集成。

### 滚动条

栏内的滚动条是一种指针可供性：只要指针不在栏内，外壳就把滚动条间接层重新绑定为 `transparent`；指针离开后滑块再保留 2 秒，因此没人指向的列表不会带着滚动条。避免行位移的空间预留属于滚动区域本身（ui-workspace），所以显示滑块不会引起重排。

### 点击埋点

在桌面端，官方导航控件在执行操作前上报 `sidebar_menu_click`，携带 `menu_name` 与 `position`。没有埋点服务时，这些控件只执行导航。通过其他途径选中面板不上报，侧边栏也不上报曝光事件。

- 品牌与新建会话按钮上报 `menu_name=new_session`、`position=sidebar`。
- **插件**与**自动化任务**面板行分别上报 `menu_name=plugin` 与 `menu_name=cron`，`position=sidebar`。其他面板行不上报。
- 每次点击**更多**按钮都上报 `menu_name=more`、`position=sidebar`，无论打开还是关闭菜单。
- 第三方注册的更多菜单行通过 `onOpen(id)` 打开插件或自动化任务时，上报 `menu_name=plugin` 或 `menu_name=cron`，`position=sidebar_more`。随产品提供的更多菜单只浏览和创建插件，不会调用 `onOpen`。上报先于注册检查，因此所请求的面板已注销时仍会计数，但不会选中任何面板。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

外壳是纯组合：`SidebarRootComponentProps` 组合布局 owner share、全局 `useSessions` 与 `useWorkspaces` 钩子、已声明的品牌、`sidebar.workspaces` 与 `sidebar.settings` 子 slot，以及注入的导航回调。侧边栏声明 `sidebar.panellist`，并直接渲染各面板注册的图标。面板元数据由列表注册和 locale 变化派生；选中态属于布局存储。注入的 `trackEntryClick(attributes)` 转发到 `ctx.get('productAnalytics')?.track('sidebar_menu_click', attributes)`；`selectPanel` 只负责选中，因此由各控件自行提供入口与位置。

导航行的左右外距为 8px，悬停与选中底色在两侧各内缩 3px，前置单元宽 16px，与标签间隔 6px。新会话内容居中，左右外边距为 4px，底部外边距为 10px。logo 行无底部外边距；内容从侧栏左边缘向内 16px 开始，标记与名称间隔 5px。

侧边栏根节点向 `sidebar.workspaces` 与 `sidebar.settings` 提供可继承的 CSS 属性：`--dsh-sidebar-inline-padding: 8px`、`--dsh-sidebar-row-padding: 12px`、`--dsh-sidebar-label-gap: 6px` 和 `--dsh-sidebar-paint-inset: 3px`。占用者使用这些值对齐行；独立组合必须在祖先节点提供这些值。底色内缩不移动内容：行从左右内边距中减去该内缩值，并以等宽透明边框承载内缩。

### slot 纪律

声明感知的 `slots.inject()` 让替换包无论先于还是后于侧边栏激活都能生效。页脚承载 `sidebar.settings` 席位：侧边栏只渲染固定在底部的布局 slot，并无条件向其上报 `wide: true`，因为该栏没有其他状态。`/client` 导出接口只包含插件主体（`apply`/`inject`）及约定类型；SidebarRoot、行组件与树派生仍由 slot 注册封装在包内。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖填充外壳席位的各个界面与组合模型。

- [ui-workspace](../ui-workspace/README.zh.md)——渲染到 `sidebar.workspaces` 的 Workspace 与 Session 浏览器。
- [ui-settings](../ui-settings/README.zh.md)——在 `sidebar.settings` 注册触发行与设置面板的设置领域底座。
- [ui-layout](../ui-layout/README.zh.md)——求解固定三栏分栏的布局 owner。
- [ui-theme](../ui-theme/README.zh.md)——外壳所重新绑定的滚动条 token 间接层。
- [slot 系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.zh.md)——席位背后的组合模型。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义外壳拥有什么、其占位方拥有什么；它们是当前包约束。

- **Session 状态点渲染由 ui-workspace 持有**：本外壳没有可用的 done/error 通知数据源。
- **Workspace 浏览行为由组合持有**：分组、排序、搜索与行状态都属于 ui-workspace，不属于此外壳。
- **「New task completed」未读标记是本地查看状态**：完成时间 > 上次查看时间这一事实永远不会到达宿主。
- **复制本地构建版本号仅支持鼠标**：键盘激活品牌会新建会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
