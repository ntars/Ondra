# ondra-browser · 网页浏览

**被动出现**的内嵌浏览器：左栏没有入口，只有别的功能请求打开网页、或用户从
「设置 → 通用设置 → 浏览 → 网页白名单」进来时，它才顶替中栏那一页；关掉回到原来那页。

## 为什么不做成导航项

浏览不是「目的地」。一旦左栏有一项，用户就会把它当浏览器用；而这一页的定位是
**给能力读网页**（后续「读网页」「查文档」都从这里进），入口越少越好。

## 白名单

- 出厂只有一条：`https://platform.deepseek.com`（填 API Key 要去的地方）。
  别的站点由用户自己加——预置一堆「常用网站」等于替用户做隐私决定。
- 判定：**精确 origin 相等**（scheme + host + port，默认端口归一化）。子域、
  后缀伪装、其他协议/端口、带凭据或编码含糊的地址一律拒绝。
- 唯一写入者是 `ui/browser_client.dart`，后续读网页的工具也走 `allowed()`。

## 内嵌实现

macOS 用系统 **WKWebView**，注册为 Flutter 平台视图 `ondra/webview`
（`macos/Runner/MainFlutterWindow.swift` 的 `OndraBrowserFactory`）。
Android 用系统 **WebView**，同一平台视图协议
（`android/app/src/main/kotlin/cn/ntars/ai/OndraWebView.kt`）。

Windows 用 **WebView2 Win32 COM**（`windows/runner/web_view_win.cpp`）：

- Dart 侧 `WindowsView` 是本地 shim——Flutter 3.50 的 Windows embedder 尚未
  实现 HWND PlatformView 工厂，不能把 `AppKitView` 那套直接搬过去。
- 创建参数仍为 `{url, allowedSites}`，宿主通道 `ondra/webview/host/create`
  承载该次视图创建；每视图仍用 `ondra/webview/<id>` 收发 `start` / `stop` /
  `navigationRejected` / `loadFailed`（`{reason: string}`）。
- WebView2 导航（含 iframe、新窗口请求）按同一 origin 规则拦截；HTTPS 页面
  不允许降级到 HTTP；拒绝只回 reason，不把 URL 写进错误栏。
- WebView2 SDK 由 `windows/runner/CMakeLists.txt` 从 NuGet
  `Microsoft.Web.WebView2` 下载静态 loader（版本可缓存/覆盖）。运行时本身
  是系统共享组件，不打进发布包；缺运行时时按协议报告 `loadFailed`。
- SDK 下载/解包失败时构建 fallback 变体：不加载任何网页，`start` 返回错误；
  可用 `-DONDRA_ENABLE_WEBVIEW2=OFF` 显式离线构建。
- 页面像素通过 `ICoreWebView2::CapturePreview(PNG)` 由后台线程抓取，经 WIC
  解码、缩放成 BGRA/RGBA 后写入 Flutter 外部像素纹理，并以 5fps 标记新帧；
  顶层窗口 `WM_SIZE` 会同步 WebView2 的 bounds 与纹理尺寸。初次创建时先给
  不透明占位帧，避免纹理未解码前显示为透明。
- **限制**：当前是 PNG 抓帧路径，不等同于 D3D11 共享纹理的逐帧合成；滚动、
  动画以约 5fps 更新。macOS 构建不能验证 Windows 原生编译或运行时。

**不引第三方 Flutter WebView 插件**：系统 WebKit / Android WebView / WebView2
分别由各平台原生侧直接接入，不为此改动 `pubspec.yaml`。

## 不做

- 不注入脚本、不读取页面内容（只渲染）。
- 不做前进/后退历史：地址变了就换一个平台视图实例；历史等功能真的需要时再加。
- 浏览器预览（Web 构建）没有内嵌能力，页面会如实说明。
