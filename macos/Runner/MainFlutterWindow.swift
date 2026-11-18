import Cocoa
import FlutterMacOS
import UniformTypeIdentifiers
import WebKit

/// 主窗：**没有系统标题栏，内容按 960×600 铺满整窗，侧栏是一层毛玻璃**。
///
/// 数值来源（只读源码，`/Applications/小米互联服务.app/Contents/Resources/app.asar`）：
/// - `dist-electron/main.js` 主窗参数：`titleBarStyle:"hiddenInset"`、
///   `trafficLightPosition:{x:24,y:24}`、mac 上 `transparent:true` + `backgroundColor:"#00000000"`；
/// - `node_modules/electron-liquid-glass/src/glass_effect.mm` 的 `AddGlassEffectView()`：
///   **首选 `NSClassFromString(@"NSGlassEffectView")`**（macOS 26+ 的 Liquid Glass），
///   frame 铺满、插在 contentView 最底层；取不到这个类才回退
///   `NSVisualEffectView` + `blendingMode = .behindWindow` +
///   `material = .underWindowBackground` + `state = .active`；
/// - 同文件 `ConfigureGlassView()`：默认不设 tint、不设圆角（整窗铺满，交给系统裁）。
///
/// 所以窗口是透明的、玻璃由 AppKit 画在内容下面，Dart 只负责「哪块透、哪块实」：
/// 侧栏透出玻璃，内容区与右栏是实色。
///
/// **通透感几乎全部来自这一层**：参考应用的侧栏 `.miclaw-shell-surface` 是
/// `background:transparent` 且 `backdrop-filter:none`，Dart 侧不允许再叠任何白色。
class MainFlutterWindow: NSWindow {
  private let contentSize = NSSize(width: 960, height: 600)
  private var flutterController: FlutterViewController?
  private var glass: NSView?
  /// 玻璃之上、Flutter 之下的一层可调深色遮罩：深色模式的「深色玻璃」靠它。
  private var dimmer: NSView?
  private var appearanceChannel: FlutterMethodChannel?
  private var avatarChannel: FlutterMethodChannel?
  private var lastLightDelta = NSPoint.zero

  override func awakeFromNib() {
    let controller = FlutterViewController()
    // 让 Flutter 图层透明，否则它会盖住下面的玻璃。
    controller.backgroundColor = .clear
    self.contentViewController = controller
    self.flutterController = controller

    // **只设 backgroundColor 不够。** FlutterView 的 CALayer 默认是不透明的，
    // 窗口一旦被判成不透明，`blendingMode = .behindWindow` 就不再采样桌面，
    // 玻璃退化成一块纯色（实测 rgb 227,227,228 的均匀灰，桌面的深紫壁纸
    // 一点都没透出来）。必须把 layer 的 isOpaque 也关掉。
    controller.view.wantsLayer = true
    controller.view.layer?.isOpaque = false
    controller.view.layer?.backgroundColor = NSColor.clear.cgColor

    RegisterGeneratedPlugins(registry: controller)

    // 明暗同步：Flutter 那边只换自己的画布，动不了窗口的 NSAppearance，
    // 而磨砂玻璃是 AppKit 画的。不接这条通道，深色下会出现
    // 「纸片是深的、玻璃还是浅的」的错层。
    let channel = FlutterMethodChannel(
      name: "ondra/window",
      binaryMessenger: controller.engine.binaryMessenger
    )
    channel.setMethodCallHandler { [weak self] call, reply in
      guard let self else { reply(nil); return }
      guard call.method == "setAppearance" else { reply(FlutterMethodNotImplemented); return }
      self.applyAppearance(dark: (call.arguments as? Bool) ?? false)
      reply(nil)
    }
    self.appearanceChannel = channel

    // 头像选择：沿用手感一致的 NSOpenPanel，不引第三方 file picker 插件。
    //
    // 裁切与缩放放在这一侧，是因为 Flutter 没有图像编码器：Dart 侧做就要多一个
    // 图像库的依赖，而 AppKit 本来就要弹选择框。落盘的是**最终尺寸**的 PNG
    // （512 正方形、居中 aspect-fill），所以每次启动读到的就是几十 KB。
    let avatar = FlutterMethodChannel(
      name: "ondra/avatar",
      binaryMessenger: controller.engine.binaryMessenger
    )
    avatar.setMethodCallHandler { call, reply in
      switch call.method {
      case "pick":
        reply(self.pickAvatar())
      case "reset":
        reply(self.clearAvatar())
      default:
        reply(FlutterMethodNotImplemented)
      }
    }
    self.avatarChannel = avatar

    // 内嵌浏览器：用系统 WebKit 的平台视图，不引第三方插件（也就没有 CocoaPods）。
    let registrar = controller.registrar(forPlugin: "ondra-browser")
    registrar.register(OndraBrowserFactory(), withId: "ondra/webview")

    applyChrome()

    super.awakeFromNib()

    // nib 加载完会把 storyboard 里的样式与尺寸再套回来一次，所以 super 之后再校一遍。
    applyChrome()
    logGeometry(stage: "after-super")

    // 红绿灯的位置会被 AppKit 在「窗口成为 key / 上屏 / 改变尺寸」时重置，
    // 所以监听这几个时机再放一次，而不是只放在 awakeFromNib 里。
    for name in [
      NSWindow.didBecomeKeyNotification,
      NSWindow.didBecomeMainNotification,
      NSWindow.didResizeNotification,
      NSWindow.didEndLiveResizeNotification,
      NSApplication.didBecomeActiveNotification,
    ] {
      NotificationCenter.default.addObserver(
        self, selector: #selector(onWindowEvent(_:)), name: name, object: self
      )
    }

    // 1.5 秒后复核一次：只有真的被改过才重新套，用户刚开就拉窗口的话不该被拉回。
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      guard let self else { return }
      let expected = self.frameRect(
        forContentRect: NSRect(origin: .zero, size: self.contentSize)
      ).size
      if self.frame.size != expected { self.applyChrome() }
      // 红绿灯的位移会被 AppKit 在布局后重置，所以这里无条件再放一次。
      self.moveTrafficLights()
      self.logGeometry(stage: "after-1.5s")
    }
  }

  @objc private func onWindowEvent(_ note: Notification) {
    moveTrafficLights()
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  /// 应用明暗：窗口与玻璃层一起切。
  ///
  /// 只设 `self.appearance` 时，`NSVisualEffectView` 会自动跟随（它是按窗口
  /// 外观取材质的），但 `NSGlassEffectView` 在部分系统版本上不重取，
  /// 所以显式再给玻璃层设一次，两条路都覆盖到。
  private func applyAppearance(dark: Bool) {
    log("appearance dark=\(dark)")
    let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    // 三层都设：NSGlassEffectView 不总是跟着窗口外观重取材质，
    // 最外层的 NSApp 是唯一保证材质重新取色的地方。
    NSApp.appearance = appearance
    self.appearance = appearance
    contentView?.appearance = appearance
    glass?.appearance = appearance
    updateGlassTint(dark: dark)
    // 主题切了以后玻璃会重绘，红绿灯的位置也可能被 AppKit 重新排一次。
    moveTrafficLights()
  }

  /// 玻璃的「深浅」：光靠 appearance 不够。
  ///
  /// **深色玻璃不是把浅色玻璃调暗**。只切 appearance 时，系统玻璃只把背衬
  /// 压暗一档，透出来的仍是桌面那块亮色（实测侧栏 rgb 103,94,121，壁纸的紫
  /// 还在），看起来像「一层浅玻璃盖在深色纸上」。
  ///
  /// `NSGlassEffectView` 虽然有 `tintColor`，但实测它是在**提亮**而不是压暗
  /// （同一位置 103,94,121 → 112,105,128），不能拿来做深色。所以改用一层
  /// 夹在玻璃与 Flutter 之间的遮罩：模糊仍由玻璃提供，遮罩只降低亮度，
  /// 深色玻璃的观感才成立——壁纸只剩明暗，不再有颜色。
  private func updateGlassTint(dark: Bool) {
    if let dim = dimmer {
      // 0.55 是量出来的：底下的玻璃约 rgb 110，压到 50 上下，
      // 与深色纸片（#10121A）同一档，缝里不会突兀地亮一条。
      dim.layer?.backgroundColor = NSColor.black
        .withAlphaComponent(dark ? 0.55 : 0.0)
        .cgColor
      dim.isHidden = !dark
    }
    // 玻璃自身不再染色：浅色下显式清掉，避免从深色切回来留着上次的灰。
    guard let glass else { return }
    if glass.responds(to: Selector(("setTintColor:"))) {
      glass.setValue(nil, forKey: "tintColor")
    } else if let visual = glass as? NSVisualEffectView {
      visual.material = dark ? .hudWindow : .underWindowBackground
    }
  }

  private func applyChrome() {
    styleMask.insert(.fullSizeContentView)
    titlebarAppearsTransparent = true
    titleVisibility = .hidden
    title = "空谷"
    if #available(macOS 11.0, *) {
      titlebarSeparatorStyle = .none
    }

    // 透明窗口 + 背后的 vibrancy：这是参考应用的做法，玻璃只在侧栏露出来。
    isOpaque = false
    backgroundColor = .clear
    hasShadow = true

    installGlass()
    applyFrame()
    moveTrafficLights()
  }

  private func installGlass() {
    guard let content = contentView else { return }
    // 玻璃挂在 contentView 的最底层、铺满整窗——与参考应用一致
    // （`glass_effect.mm` 把 NSGlassEffectView 加到 contentView 的 below）。
    //
    // 前提是**这一层要真的被判成透明**：`FlutterViewController.backgroundColor = .clear`
    // 之外，还要把 `view.layer.isOpaque` 关掉（见 awakeFromNib）。少了这一步，
    // behind-window 合成会被中断，玻璃退化成一块纯色。
    let host = content

    let view: NSView
    if let existing = glass {
      view = existing
    } else {
      view = Self.makeGlassView(frame: host.bounds)
      view.autoresizingMask = [.width, .height]
      host.addSubview(view, positioned: .below, relativeTo: nil)
      glass = view
    }
    view.frame = host.bounds

    // 遮罩：夹在玻璃与 Flutter 之间（below Flutter）。玻璃负责模糊与折射，
    // 遮罩只负责「暗」，两者的职责分开，深浅才有得调。
    if dimmer == nil, let flutterView = flutterController?.view {
      let dim = NSView(frame: host.bounds)
      dim.wantsLayer = true
      dim.autoresizingMask = [.width, .height]
      dim.layer?.backgroundColor = NSColor.black.cgColor
      host.addSubview(dim, positioned: .below, relativeTo: flutterView)
      dimmer = dim
    }
    dimmer?.frame = host.bounds

    // 玻璃建好之后补一次当前的明暗，否则首帧会是浅色玻璃。
    updateGlassTint(dark: NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua)
  }

  /// 玻璃层：Liquid Glass 优先，回退到窗口背景材质。
  ///
  /// 两条路都来自参考应用的原生模块（见类注释），不是凭观感挑的材质。
  /// 之前用的 `.menu` 来自 `main.js` 的 `D3t()`——那是 **addon 加载失败之后的第三层
  /// 兜底**，不是参考实现的真实路径，材质档位也不一样。
  private static func makeGlassView(frame: NSRect) -> NSView {
    // 默认走 Liquid Glass（与参考应用主路径一致，实测通透度差一档：
    // 同一侧栏位置 Liquid Glass 是 rgb 173,166,207，壁纸的紫/蓝/红都分得出来；
    // 回退材质被洗成 217,216,228，几乎看不出壁纸颜色）。
    // 排障 / 对照：`defaults write cn.ondra.ondra OndraGlass legacy` 切回窗口背景材质。
    let mode = UserDefaults.standard.string(forKey: "OndraGlass") ?? "glass"

    // macOS 26 起系统才有 NSGlassEffectView；这里按运行时查类，不写死 SDK 版本。
    if mode != "legacy",
       let glassClass = NSClassFromString("NSGlassEffectView") as? NSView.Type {
      let view = glassClass.init(frame: frame)
      view.autoresizingMask = [.width, .height]
      return view
    }

    let visual = NSVisualEffectView(frame: frame)
    visual.autoresizingMask = [.width, .height]
    visual.blendingMode = .behindWindow
    // 参考模块的回退材质是 underWindowBackground，不是 menu。
    visual.material = .underWindowBackground
    visual.state = .active
    // **不锁 appearance。** 早先这里写死了 `.aqua`（当时只做浅色皮肤），
    // 现在主题跟系统走：锁成浅色会让深色模式下的玻璃依旧发白，
    // 而纸片已经变深，两者之间那条 4px 缝会亮得像一道刻痕。
    // `NSGlassEffectView` 本来就跟窗口外观走，这里保持一致。
    return visual
  }

  private func applyFrame() {
    let frameSize = frameRect(
      forContentRect: NSRect(origin: .zero, size: contentSize)
    ).size

    var frame = self.frame
    frame.size = frameSize
    if let screen = self.screen ?? NSScreen.main {
      let visible = screen.visibleFrame
      frame.origin = NSPoint(
        x: visible.midX - frameSize.width / 2,
        y: visible.midY - frameSize.height / 2
      )
    }
    setFrame(frame, display: true)

    contentMinSize = contentSize
    contentMaxSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude,
      height: CGFloat.greatestFiniteMagnitude
    )
  }

  /// 红绿灯放在 (24, 24)。
  ///
  /// 系统默认把它们摆在 28 高的标题栏正中（约 y=14），参考应用显式下移到 24——
  /// 这样三颗点和侧栏 48 高表头的中心对齐。整组平移，间距保持系统原样。
  private func moveTrafficLights() {
    let inset = NSPoint(x: 24, y: 24)
    guard let close = standardWindowButton(.closeButton),
          let container = close.superview else { return }

    // 以三颗点当前的相对位置为准，算一次整体位移，避免依赖具体系统版本的间距。
    let anchor = close.frame
    let targetX = inset.x
    let targetTopFromWindow = inset.y
    // 按钮视图在标题栏容器里：容器顶边就是窗口顶边。
    let targetY = container.bounds.height - targetTopFromWindow - anchor.height
    let dx = targetX - anchor.minX
    let dy = targetY - anchor.minY
    lastLightDelta = NSPoint(x: dx, y: dy)

    for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      guard let button = standardWindowButton(type) else { continue }
      var f = button.frame
      f.origin.x += dx
      f.origin.y += dy
      button.frame = f
    }
  }

  /// 追加一行到窗口日志（GUI 应用看不到 stdout）。
  private func log(_ text: String) {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let dir = home.appendingPathComponent(".ondra/logs")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("window.log")
    let line = "[\(Date())] \(text)\n"
    if let handle = try? FileHandle(forWritingTo: file) {
      handle.seekToEndOfFile()
      handle.write(line.data(using: .utf8) ?? Data())
      try? handle.close()
    } else {
      try? line.write(to: file, atomically: true, encoding: .utf8)
    }
  }

  /// 窗口几何与玻璃实现的落盘日志：GUI 应用看不到 stdout，排障时只能读文件。
  ///
  /// `glass` 一栏记的是**实际拿到的类名**：`NSGlassEffectView` 说明走的是
  /// Liquid Glass（macOS 26+），`NSVisualEffectView` 说明回落到了窗口背景材质。
  /// 这条是核对通透感唯一可靠的办法——不靠截图，靠运行时事实。
  private func logGeometry(stage: String) {
    let content = contentView?.frame.size ?? .zero
    let glassClass = glass.map { String(describing: type(of: $0)) } ?? "none"
    let line = """
    [\(stage)] frame=\(Int(frame.width))x\(Int(frame.height)) \
    content=\(Int(content.width))x\(Int(content.height)) \
    layout=\(Int(contentLayoutRect.width))x\(Int(contentLayoutRect.height)) \
    fullSize=\(styleMask.contains(.fullSizeContentView)) \
    glass=\(glassClass) \
    lights=\(Int(lastLightDelta.x)),\(Int(lastLightDelta.y)) \
    closeY=\(Int(standardWindowButton(.closeButton)?.frame.minY ?? -999))\n
    """
    let home = FileManager.default.homeDirectoryForCurrentUser
    let dir = home.appendingPathComponent(".ondra/logs")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("window.log")
    if let handle = try? FileHandle(forWritingTo: file) {
      handle.seekToEndOfFile()
      handle.write(line.data(using: .utf8) ?? Data())
      try? handle.close()
    } else {
      try? line.write(to: file, atomically: true, encoding: .utf8)
    }
  }

  // MARK: - 人设头像

  /// 头像落盘位置。与 `prefs.json`、`logs/` 同一个目录，卸载时一起清掉。
  private var avatarFileURL: URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home.appendingPathComponent(".ondra/avatar.png")
  }

  /// 弹选择框 → 居中裁方 → 缩到 512 → 写 PNG。
  ///
  /// 返回是否真的写了文件：用户取消、图片读不出来都返回 false，界面不必分辨。
  private func pickAvatar() -> Bool {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowedContentTypes = [.png, .jpeg, .heic, .tiff, .gif, .webP]
    panel.prompt = "用作头像"
    panel.message = "选一张图片，会居中裁成正方形"
    guard panel.runModal() == .OK, let src = panel.url,
          let image = NSImage(contentsOf: src) else { return false }

    let side = 512
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: side, pixelsHigh: side,
      bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0, bitsPerPixel: 0
    ) else { return false }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high

    // aspect-fill：短边铺满，长边溢出后居中裁掉——头像是圆的，
    // 留白拼接（aspect-fit）会让人物缩成一小块。
    let size = image.size
    guard size.width > 0, size.height > 0 else {
      NSGraphicsContext.restoreGraphicsState()
      return false
    }
    let scale = max(CGFloat(side) / size.width, CGFloat(side) / size.height)
    let w = size.width * scale
    let h = size.height * scale
    image.draw(in: NSRect(
      x: (CGFloat(side) - w) / 2,
      y: (CGFloat(side) - h) / 2,
      width: w, height: h
    ))
    NSGraphicsContext.restoreGraphicsState()

    guard let png = rep.representation(using: .png, properties: [:]) else { return false }
    do {
      try FileManager.default.createDirectory(
        at: avatarFileURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try png.write(to: avatarFileURL)
      log("avatar saved \(png.count) bytes")
      return true
    } catch {
      log("avatar write failed: \(error)")
      return false
    }
  }

  /// 恢复默认：删文件。故意不写一张默认图进来——那会变成「用户选了一张
  /// 和默认一样的图」，以后换默认图时它跟不上。
  private func clearAvatar() -> Bool {
    do {
      if FileManager.default.fileExists(atPath: avatarFileURL.path) {
        try FileManager.default.removeItem(at: avatarFileURL)
      }
      return true
    } catch {
      log("avatar delete failed: \(error)")
      return false
    }
  }
}


/// 内嵌浏览器的平台视图工厂。
///
/// 为什么不用 flutter_inappwebview / desktop_webview_window：它们都带原生依赖，
/// 需要 CocoaPods 或 SPM；本机这两条路都不通（见 README「构建与分发」）。
/// WKWebView 是系统框架，直接挂平台视图就行，零依赖。
final class OndraBrowserFactory: NSObject, FlutterPlatformViewFactory {
  func createArgsCodec() -> (FlutterMessageCodec & NSObjectProtocol)? {
    FlutterStandardMessageCodec.sharedInstance()
  }

  func create(withViewIdentifier viewId: Int64, arguments args: Any?) -> NSView {
    OndraBrowserView(frame: .zero, args: args)
  }
}

final class OndraBrowserView: NSView, WKNavigationDelegate {
  private let webView = WKWebView(frame: .zero)

  init(frame: NSRect, args: Any?) {
    super.init(frame: frame)
    webView.navigationDelegate = self
    webView.autoresizingMask = [.width, .height]
    addSubview(webView)
    if let dict = args as? [String: Any], let text = dict["url"] as? String,
       let url = URL(string: text) {
      webView.load(URLRequest(url: url))
    }
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) 未实现")
  }

  override func layout() {
    super.layout()
    webView.frame = bounds
  }

  /// 页面里 target=_blank 的链接：留在同一个视图里打开，不弹新窗。
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
      webView.load(URLRequest(url: url))
    }
    return nil
  }
}
