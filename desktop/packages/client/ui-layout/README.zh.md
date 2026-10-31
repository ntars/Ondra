---
description: "Web GUI 的外壳布局：三栏 AppFrame（右栏作为贴边面板的轨道）、面板几何服务与主题呈现；供窗口外壳的使用者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

## 概述

本包提供 Web GUI 的三栏 AppFrame、左右栏宽度与 `ctx.layout` 呈现控制。右栏先让步以保护中栏空间，其占用方只画一列常驻面板，框架不必为它建模形态。主题呈现器负责配色、别名 token、字号、字体列表与 document 元数据；布局状态在刷新后重置。

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

框架不绑定折叠命令，因为该栏永不折叠；快捷键席位处于惰性状态（ui-shortcuts 不提供命令目录），因此没有任何按键可以切换某一栏。

本插件在 root slot 中组合侧边栏、主内容和右栏。三条轨道都来自固定的四等分（columns.ts）：左栏占 1/4、中栏占 2/4、右栏占 1/4，三者既不可调整宽度也不可折叠。右栏的四分之一在首帧即被预留；占用方报告是否显示以及是否保留该轨道。

全局面板占据 root 作用域的 `main` keyed slot；`conversation` 是为会话界面保留的 key。`ctx.layout.selectPanel(id)` 选中已注册面板，`null` 则选中会话界面，但不改变当前会话。Plugins 页面是默认组合中的一个全局面板。

root 作用域的单一 `shell.bottom` slot 横跨三列下方的整行。占用方控制自身高度与显隐；三列按该高度缩短，空内容不预留空间。切换主面板时保留底部组件。列宽拖拽手柄止于底部内容上方，`shell.overlay` 仍覆盖整个框架。默认组合不占用此 slot。

<a id="window-chrome-seat"></a>
### 窗口 chrome 座

在 macOS 桌面（`html[data-platform='darwin']`，仅由桌面 preload 设置）下，收起的侧边栏整列隐藏而非保留控制栏，框架在左上角挂载 root 作用域的单一 `shell.leading` 座——位于 hiddenInset 红绿灯旁，覆盖所有主面板；ui-sidebar 以重新打开与 New Session 控件占据该座。座挂载期间框架发布 `--dsh-frame-leading-clearance`：窗口 chrome 占据的行内带宽，自框架左边缘起量；内容抵达左上角的主面板以它做内边距，避免落在红绿灯或控件之下。框架还始终在根元素上发布 `--dsh-frame-top-clearance`（48px）：窗口顶带之下的固定下沉量；主面板中的入口型页面（插件管理器等类似页面，非对话）以它做顶部内边距。框架自己不声明任何 darwin drag：每个 chrome 行给自身打上 `data-window-drag`，ui-web base.css 把该标记变成唯一那条 darwin drag 规则，于是行自己的盒子就是窗口的可拖几何——行的空白段可拖，控件保持可点。框架仅剩的那条 drag 规则属于 Windows 标题栏行。

Windows Electron 的 `data-windows-titlebar` 标记在所有列上方预留顶栏高度，并移除收起后的侧栏轨道。内容区仅左上角保留 16px 圆角，其余角和内部交界处保持直角。框架发布 `--dsh-windows-content-radius` 供自身左上圆角使用，并发布 `--dsh-windows-sidebar-width`，使该列可以避开展开的侧栏。普通 Web 文档不会获得该标记；macOS 保留其独立布局。

根元素通过 `--dsh-frame-top-clearance` 发布顶栏占用量（macOS 为 48px，Windows 为标题栏高度），通过 `--dsh-frame-overlay-top` 为弹窗和菜单再留出 20px。原生全屏时浮层起点降为 20px；弹窗仍保留自身 24px 的最小边距。`--dsh-frame-chrome-top` 让模态遮罩不绘制 Windows 顶栏区域，全屏时归零。覆盖整个视口的模态层仍阻挡背景点击。普通浏览器文档不发布这些值。

### 主题呈现

呈现器消费解析后的主题快照，并投影到 document：`html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，把主题的别名 token、`--dsh-content-font-size`、`--dsh-code-font-size`、`--dsh-terminal-font-size` 以及每个非空的 `--dsh-font-family-<role>` 列表设为 body 上的内联变量，并持有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新。对呈现器执行 dispose（资源释放）时，它会连同其他全局写入一起移除自己的元数据节点。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`selectPanel(id)` 在改变选中态前检查实时 `main` 注册表；缺失的 key 会抛错并保留当前面板。`beginNavigation()` 为异步 UI 导航返回 abort signal。后续调用、有效面板选择（包括重复选择）或布局释放会中止该 signal，但不取消底层会话创建。消费方在提交导航或搬移草稿前检查 signal。

一次注册声明框架的子 slot，并绑定 `ctx.layout` 的 `selectPanel`、`openRightbar(track)` 与 `closeRightbar`。同一个 root 存储把 `panelInfo` 选中态与 `layoutInfo` 测量、右栏报告分开。`ctx.layout.panelInfo` 与标准 `usePanelInfo` hook 共用同一个选中态来源；AppFrame 订阅引用稳定的布局对象。框架的三栏是固定的（columns.ts），因此该存储只记录两侧栏是否打开，从不记录宽度、折叠标志或呈现形态，`openRightbar` 也只接收占用标志。AppFrame 保持各列容器挂载。右栏的 root 控制器仅在选中会话界面时，经 `SessionProvider` 渲染 `rightbar.session`；内容卸载时的报告释放轨道。独立的标题组件仅在会话界面可见时使用所选会话标题，以构建配置的产品标题或本地化 `common.brand.localBuild` 为回退值；语言变化会更新该回退值。主题呈现器是第二个 effect：从解析后的快照做纯 DOM 写入——初始状态经 getter 读取一次，此后仅事件驱动，不经过 React。它先应用调色板、字号、字体列表与 token 变量，再把渲染出的背景测量为唯一的颜色依据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当布局面不够用时阅读以下页面。它们从框架进入它所渲染的栏与它所呈现的主题。

- [ui-sidebar](../ui-sidebar/README.zh.md)——占据 `sidebar` 栏及其座位。
- [ui-conversation](../ui-conversation/README.zh.md)——占据 `main` 中的 `conversation` key。
- [ui-sidebar-right](../ui-sidebar-right/README.zh.md)——以每会话一个停靠面占据 `rightbar` 栏。
- [ui-theme](../ui-theme/README.zh.md)——呈现器消费其解析快照的主题 seam。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——浏览器插件行如何加载并注册槽位。

-----

<a id="model-experience"></a>
## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前布局行为。它们是当前包约束，不是通用窗口管理器对比或任务积压。

- **面板几何是瞬时状态**——重新加载会恢复侧栏打开、右侧面板隐藏；比例由当前框架宽度重新求解，因此不保存任何偏好。
- **极窄窗口**——两侧栏各保留自己的四分之一，中栏吸收剩余宽度，因此可能小于 400px；框架不会折叠某一侧栏来回收空间。
- **轨道不带过渡**——分栏固定，没有任何状态会以指针频率写入它，因此框架不携带轨道过渡，也不为轨道过渡保留减少动态效果的例外。
- **挤压重排期间无滚动锚定**——布局变化可能移动读者的视口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
