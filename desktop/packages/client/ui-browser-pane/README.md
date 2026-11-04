# @ntars/ondra-client-ui-browser-pane

> 内置浏览器面板的**界面半身**。宿主半身在 `cordis/ondra-browser-pane/`。

一个没有地址栏、没有输入框的侧栏面板，只用来显示内置插件登记的页面
（开通引导、插件调试页）。

## 用法

在 `bundle/web-app/cordis.patch.yml` 里挂上两行（顺序有意义）：

```yaml
- id: ui-browser-pane
  name: '@ntars/ondra-client-ui-browser-pane'
```

宿主半边必须同时装载 `ondra-browser-pane`，否则面板会停在「页面没能加载」。
`ui-sidebar-right` 与 `ui-slots` 是本包的硬依赖（`inject` 里声明），
缺席时本包不会激活。

## 为什么没有地址栏

不是「先不做」，是刻意不做。有地址栏就必然有输入框；有输入框，用户就能把地址
改成任意站点，宿主那边的白名单也就失去意义。所以连只读的地址展示都没有——
用户看不到 URL，也就没有「改一下试试」的入口。

## 为什么用 iframe 而不是 `<webview>`

`<webview>` 要配 Electron 的 `will-attach-webview` 与独立 partition
（那套机制见 `desktop/apps/desktop/src/browser-guests.ts`），它解决的是
「用户自己输地址上网」：地址栏、历史、每个 workspace 一个持久分区。本面板不需要这些。

iframe 的代价是只能加载**同源**页面。这恰好与需求一致——首屏永远是本机 `/pane/*`，
跨域只发生在页面内部向白名单域名的跳转，那次跳转由宿主 `/pane/allow` 放行。

沙箱属性固定为 `allow-scripts allow-same-origin allow-forms`：

- 给脚本与表单，是因为注册页要能正常工作；
- **不给** `allow-popups`：否则页面能开新窗口，绕开「不出应用」的约定；
- **不给** `allow-top-navigation`：否则页面能把整个应用导航走。

## 已知限制

1. **`file://` 下不可用**。相对路径拿不到宿主路由，iframe 只会白屏。所以组件先判
   `location.protocol`，不满足就渲染一句「这个环境暂时打不开内置页面」——
   白屏是最糟的失败形态，用户会以为功能坏了，而不是环境不支持。
2. **编译已验证**（2026-11-03）。`cd desktop && ./node_modules/.bin/tsc -b
   packages/client/ui-browser-pane/tsconfig.json` 通过，产物在 `lib/types/`。
   这一步同时修掉两个真错：`PaneTitle` 原本写在 `src/client/index.ts` 里，
   而那是个 `.ts` 文件，JSX 直接是语法错误（`<` 被当成类型参数起点）；
   guide 条目原本绑了 `commandId: 'browserPane.open'`，但本包没有注册任何
   command，绑一个不存在的命令只会让引导页显示一个按了没反应的键位，现已去掉。
   注意 `tsc -b` 会连带编译引用链上的包，仓库里其他包存在**既有**类型错误
   （`ClientRemote` 的属性合并、`ShortcutCommandId` 品牌类型等），与本包无关；
   只看本包是否报错可以用 `2>&1 | grep ui-browser-pane`。
3. **单一实例**。`multiple: false`：多开只会让用户困惑「哪个是哪个」，
   因为它们显示的是同一份宿主状态。

## 状态来源

面板不缓存页面清单，每次挂载与每次重试都读一次 `GET /pane/state`：

```json
{ "pages": [{ "id": "beichen-entry", "title": "开通北辰 API", "plugin": "ondra-beichen-api" }],
  "pending": null }
```

选页优先级：宿主给的 `pending` → 当前页 → 第一页。
