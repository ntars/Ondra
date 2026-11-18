# ondra-browser · 网页浏览

**被动出现**的内嵌浏览器：左栏没有入口，只有别的功能请求打开网页、或用户从
「设置 → 通用设置 → 浏览 → 网页白名单」进来时，它才顶替中栏那一页；关掉回到原来那页。

## 为什么不做成导航项

浏览不是「目的地」。一旦左栏有一项，用户就会把它当浏览器用；而这一页的定位是
**给能力读网页**（后续「读网页」「查文档」都从这里进），入口越少越好。

## 白名单

- 出厂只有一条：`https://platform.deepseek.com`（填 API Key 要去的地方）。
  别的站点由用户自己加——预置一堆「常用网站」等于替用户做隐私决定。
- 判定：本域与子域放行，其他一律拒绝；只接受 `http(s)`。
- 唯一写入者是 `ui/browser_client.dart`，后续读网页的工具也走 `allowed()`。

## 内嵌实现

macOS 用系统 **WKWebView**，注册为 Flutter 平台视图 `ondra/webview`
（`macos/Runner/MainFlutterWindow.swift` 的 `OndraBrowserFactory`）。

**不引第三方 WebView 插件**：`flutter_inappwebview` / `desktop_webview_window`
都带原生依赖，需要 CocoaPods 或 SPM；本机这两条路都不通（见根 README「构建与分发」）。
WebKit 是系统框架，零依赖。

## 不做

- 不注入脚本、不读取页面内容（只渲染）。
- 不做前进/后退历史：地址变了就换一个平台视图实例；历史等功能真的需要时再加。
- 浏览器预览（Web 构建）没有内嵌能力，页面会如实说明。
