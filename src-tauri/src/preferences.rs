//! 偏好设置窗口（§5.13 第一层）。
//!
//! # 为什么是独立窗口，而不是主窗口里的一块面板
//!
//! §5.13 把设置分成两层，两层面对的是两种不同的问题：
//!
//! | 层 | 用户在想什么 | 形态 |
//! | --- | --- | --- |
//! | 偏好设置 | 「改这个应用」——深浅色、字号、怎么发送 | 独立窗口 560 × 480 |
//! | 检查器设置 | 「改她」——1168 项插件参数 | 覆盖在主界面上的抽屉 |
//!
//! 后者必须贴着会话（改一项、看效果、再改），前者与当前会话无关。
//! 把偏好塞进主窗口会挤掉正文宽度，而它一年也改不了两次；
//! 把它做成独立窗口，主窗口的 716px 正文预算就一点不用让。
//!
//! # 为什么窗口是「建一次、之后只显隐」
//!
//! 建窗口要重新加载整个 WebView（几百毫秒白屏），而 `Cmd/Ctrl + ,`
//! 是随时会按的键。建一次留着，之后 `show` / `hide` 是常数时间，
//! 也不会丢掉窗口位置。代价是常驻一个隐藏窗口的内存——对这个应用
//! 的量级（一个空白页 + 几个表单）可以接受。
//!
//! # 为什么关掉偏好窗口不拦
//!
//! 主窗口的关闭要拦（§2.7：藏到托盘而不是退出）。偏好窗口只是一块
//! 配置界面，关掉它就是「改完了」，此时拦一句「她还在」是骚扰。
//! 所以这里单独隐藏，走的是同一套 `intercept_close` 之外的一条路。

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// 偏好窗口的 label。与主窗口 `main` 并列，两边都用常量避免拼错。
const LABEL: &str = "preferences";

/// 尺寸（§5.13：560 × 480）。
///
/// `min_width` / `min_height` 与尺寸相同：左侧 160px 导航 + 右侧内容区
/// 在更窄的时候会折行到没法看，而它本来就不需要放大——
/// 这里没有正文，没有「更宽更好读」的需求。
const WIDTH: f64 = 560.0;
const HEIGHT: f64 = 480.0;

/// 打开（或唤出）偏好窗口。
///
/// 已存在时只做显隐，不重建。重建的代价是整页重载：用户会看到一次白屏，
/// 而且窗口位置会回到居中。
pub fn open<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    /*
     * 同一个前端产物，用 hash 区分入口。
     *
     * ## 为什么不用第二个 HTML 入口
     *
     * 那会变成两个构建入口：`vite` 要配 `rollupOptions.input`，Tauri 的
     * `frontendDist` 要跟着改，而两个入口各自引一遍样式与令牌。
     * 用 `#preferences` 让同一个 bundle 自己判断渲染哪棵树，
     * 令牌、主题、平台标记三件事都只有一份实现。
     */
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#preferences".into()))
        .title("偏好设置")
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .maximizable(false)
        .center()
        /*
         * 隐藏标题栏（Overlay）与主窗口一致：SwiftUI 风格的窗口不该
         * 顶一条系统灰条，而 §3.2 的 44px 标题栏已经画了拖拽区。
         */
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        /*
         * 背景色取纸白。不设的话窗口出现的第一帧是系统默认灰，
         * 深色主题下会闪一下白再变深。
         */
        .background_color(tauri::window::Color(0xff, 0xfd, 0xf9, 0xff));

    match builder.build() {
        Ok(_) => {}
        Err(error) => eprintln!("[shell] 偏好窗口打开失败：{error}"),
    }
}

/// 关闭偏好窗口。
///
/// 用 `hide` 而不是 `close`：`close` 会销毁 WebView，下次打开又是白屏。
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

/// 把偏好广播到除来源窗口之外的所有窗口。
///
/// # 为什么由壳转发而不是窗口之间直连
///
/// 两个 WebView 文档之间没有共享的 JS 上下文，`localStorage` 的跨窗口
/// 可见性又因平台而异（WKWebView 与 WebView2 行为不同）。壳是两者
/// 唯一确定的共同祖先，由它转发是一条可验证的路。
///
/// # 为什么不回发给来源
///
/// 来源窗口已经自己应用过了，回发一次等于让它把自己的值再写一遍，
/// 且带着 `broadcast: false` 的标记也拦不住「收到即应用」的路径——
/// 干脆在源头排除，语义更清楚。
pub fn broadcast<R: Runtime>(app: &AppHandle<R>, from: &str, payload: &str) {
    for (label, window) in app.webview_windows() {
        if label == from {
            continue;
        }
        let _ = window.emit("preferences-changed", payload);
    }
}
