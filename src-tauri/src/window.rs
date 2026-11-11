//! 主窗口的显示、隐藏与关闭拦截。
//!
//! # 关闭语义
//!
//! 点关闭 = 隐藏到托盘，不退出应用（§2.1、§2.7）。这不是 Windows 用户的
//! 默认预期——他按下 × 时认为程序结束了。所以**首次关闭必须解释**，
//! 而且解释完要能记住他的选择：第二次还弹同一个框就成了骚扰。
//!
//! 三端共用一条规则，只有 Linux 在没有托盘宿主时降级为最小化（§10.5）。
//!
//! # 为什么偏好存在磁盘上而不是内存里
//!
//! 「以后直接退出」是一个长期决定，用户按下它时预期是一劳永逸。
//! 存内存里关一次应用就忘了，等于每次启动都重新问一遍。
//!
//! 文件放在 `app_config_dir` 下——那是系统为应用划定的配置区，
//! 卸载时由安装器决定是否保留，不与用户数据混在一起。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime};

/// 托盘是否可用。
///
/// Linux 上 GNOME 默认不加载 StatusNotifier 扩展，托盘创建会失败。
/// 那种情况下「隐藏到托盘」等于把窗口藏进一个不存在的地方，
/// 用户再也找不回来——必须改成最小化。
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);

/// 记录托盘是否创建成功。
pub fn set_tray_available(available: bool) {
    TRAY_AVAILABLE.store(available, Ordering::Relaxed);
}

/// 关闭时该做什么。与 `prefs.json` 的字段一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseAction {
    /// 隐藏到托盘（默认）。
    Hide,
    /// 直接退出。
    Quit,
}

/// 落盘的窗口偏好。
///
/// 单独一个结构体而不是直接读写整个配置文件：将来要加「记住窗口位置」
/// 之类的项时，只需在这里加字段，不会牵动别的模块。
#[derive(Debug, Default, Serialize, Deserialize)]
struct WindowPrefs {
    /// 用户已确认过的关闭行为。`None` 表示还没问过。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    close_action: Option<CloseAction>,
}

/// 偏好文件路径。取不到配置目录时返回 `None`（此时一律按「每次都问」处理）。
fn prefs_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("window.json"))
}

/// 读取已保存的关闭行为。
fn read_pref<R: Runtime>(app: &AppHandle<R>) -> Option<CloseAction> {
    let path = prefs_path(app)?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<WindowPrefs>(&raw).ok()?.close_action
}

/// 保存关闭行为。
///
/// 写失败只记日志：用户点的是「以后别再问我」，这一次的窗口操作仍要生效，
/// 不能因为磁盘满了就把关闭流程卡住。
fn write_pref<R: Runtime>(app: &AppHandle<R>, action: CloseAction) {
    let Some(path) = prefs_path(app) else {
        eprintln!("[shell] 取不到配置目录，关闭偏好未保存");
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let prefs = WindowPrefs { close_action: Some(action) };
    match serde_json::to_string_pretty(&prefs) {
        Ok(text) => {
            if let Err(error) = std::fs::write(&path, text) {
                eprintln!("[shell] 写入关闭偏好失败：{error}");
            }
        }
        Err(error) => eprintln!("[shell] 序列化关闭偏好失败：{error}"),
    }
}

/// 窗口可见性变化事件的名称。
///
/// # 为什么由壳来广播，不让前端自己判 `document.hidden`
///
/// 前端判「窗口可不可见」有两条路：`document.hidden` 与
/// `document.hasFocus()`。两者都只回答「文档层」的问题，而这里要的是
/// **窗口层**的答案：
///
/// | 状态 | `document.hidden` | `hasFocus()` | 该不该发系统通知 |
/// | --- | --- | --- | --- |
/// | 窗口在前台 | false | true | 不发，她直接出现在时间轴上 |
/// | 窗口可见、焦点在别处 | false | false | 不发（§7.4 第二行），只加圆点 |
/// | 关到托盘 / 最小化 | true（**不保证**） | false | **发** |
/// | 切到别的 Space | 视 WebView 实现而定 | false | 介于上两行之间 |
///
/// 第三行的「不保证」是真问题：`window.hide()` 之后 WebView 是否触发
/// `visibilitychange` 取决于平台与 WebView 版本，macOS 的 WKWebView
/// 在被 `orderOut` 之后可能既不触发事件也不把 `hidden` 置真。用它当
/// 判据，结果会是「用户关了窗口，她永远不说话」——一个安静的、查不出
/// 原因的缺陷。
///
/// 而 `hide()` / `reveal()` 这两个动作**本来就发生在我们自己的代码里**，
/// 在那里发一条事件，是唯一确定的答案。
pub const VISIBILITY_EVENT: &str = "window-visibility";

/// 广播窗口可见性。
///
/// 载荷是布尔：`true` 表示窗口已经显示且被聚焦，`false` 表示它退到了
/// 看不见的地方（托盘、最小化）。
pub fn emit_visibility<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let _ = tauri::Emitter::emit(app, VISIBILITY_EVENT, visible);
}

/// 显示并聚焦主窗口。
///
/// 三种「看不见」的状态都要收拾：隐藏、最小化、被其他窗口盖住。
/// 只调 `show()` 不够——最小化的窗口 `show()` 之后仍然是收起的。
pub fn reveal<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    emit_visibility(app, true);
}

/// 隐藏主窗口。
fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    emit_visibility(app, false);
}

/// 真正退出。
///
/// 不走 `window.close()`：那会再次触发 `CloseRequested`，绕回拦截逻辑，
/// 形成「要退出 → 被问要不要退出」的循环。
///
/// # 为什么退出前要同步收一次宿主
///
/// `app.exit(0)` 之后进程就不再跑我们的代码了。若把"收宿主"交给
/// `RunEvent::ExitRequested`，那条路径只能 `block_on`——主线程被阻塞，
/// 用户看到的是"点了退出，窗口卡住几秒才消失"。这里在退出之前用同步信号
/// 收掉整组（约 120ms），`ExitRequested` 里再来一次是幂等的空操作。
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    crate::shutdown(app);
    app.exit(0);
}

/// 处理一次关闭请求。
///
/// @returns 是否已自行处理（`true` 表示调用方不要再关窗）。
///
/// # 分支顺序为什么是这样
///
/// 1. 托盘不可用 → 最小化。此时「隐藏」是个黑洞。
/// 2. 已记住「退出」 → 放行，由 `RunEvent::ExitRequested` 收宿主。
/// 3. 已记住「隐藏」 → 隐藏。
/// 4. 都没记住（首次） → 拦下来，让前端弹一次解释框。
pub fn intercept_close<R: Runtime>(app: &AppHandle<R>) -> bool {
    // 托盘不可用：降级为最小化，并让前端提示一次原因（§10.5）。
    if !TRAY_AVAILABLE.load(Ordering::Relaxed) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.minimize();
        }
        // 最小化也是「看不见」。与隐藏同一个语义，所以同一个事件。
        emit_visibility(app, false);
        let _ = tauri::Emitter::emit(app, "close-degraded", ());
        return true;
    }

    match read_pref(app) {
        Some(CloseAction::Quit) => false,
        Some(CloseAction::Hide) => {
            hide(app);
            true
        }
        None => {
            // 首次：窗口保持可见，前端在这个窗口里弹 Dialog。
            // 先隐藏再弹框是行不通的——用户会看不到任何东西。
            let _ = tauri::Emitter::emit(app, "close-requested", ());
            true
        }
    }
}

/// 前端在 Dialog 里做出的选择。
///
/// `remember` 为 `true` 时写盘，此后不再询问。
pub fn apply_close_choice<R: Runtime>(app: &AppHandle<R>, action: CloseAction, remember: bool) {
    if remember {
        write_pref(app, action);
    }
    match action {
        CloseAction::Hide => hide(app),
        CloseAction::Quit => quit(app),
    }
}

/// 隐藏 macOS 系统红绿灯，把窗口按钮交给前端自绘（§2.4）。
///
/// ## 为什么必须动 AppKit
///
/// `TitleBarStyle::Overlay` 下系统一定会画三个按钮，`trafficLightPosition`
/// 只能挪位置——按钮的直径、描边、渐变、hover 时浮出的 `× − +` 符号全都
/// 由 AppKit 决定，CSS 碰不到。要按参考应用做成 12px 纯色圆点，只有两条路：
/// 自绘并隐藏系统按钮，或者接受系统原样。这里选前者。
///
/// ## 为什么用 setHidden 而不是把按钮挪出可视区
///
/// 把 `trafficLightPosition` 设成窗口外的坐标也能让按钮看不见，但那是靠
/// 几何裁剪：窗口 becomeKey、切换全屏、系统重新布局标题栏时，AppKit 会
/// 把按钮摆回默认位置，于是三个原生按钮突然又冒出来。`setHidden(true)`
/// 是 NSView 的持久属性，重布局不会把它翻回来。
///
/// ## 为什么只处理传进来的这一个窗口
///
/// 上一版遍历 `NSApp.windows()`。那时只有一个窗口，看不出问题；加入内置
/// 浏览器窗口（用系统装饰、需要真的红绿灯）之后，主窗口获得焦点就会把
/// 浏览器窗口的按钮一起藏掉——表现为那个窗口再也关不掉。按窗口收窄是
/// 唯一不会互相干扰的写法。
///
/// ## 不在主线程就什么都不做
///
/// `setHidden` 是 UI 操作，必须主线程。`setup` 与窗口事件回调都在主线程，
/// 这个分支只防万一；真走到这里，系统按钮没藏掉而前端仍会自绘，界面上会
/// 露出两对按钮——那是需要修的故障，不是可接受的降级。
///
/// ## 为什么要一个小 trait
///
/// 主窗口在 `setup` 里拿到的是 `WebviewWindow`，窗口事件回调里拿到的是
/// `Window`（那是另一个类型，不是它的父类）。两者各有自己的 `ns_window()`，
/// 且**都只在 macOS 上存在**。没有这层抽象，三个调用点就得各自写一遍
/// `#[cfg(target_os = "macos")]`，读代码要分平台理解主流程。
pub trait NativeWindow {
    /// 原生 NSWindow 指针。非 macOS 或取不到时为空指针。
    fn native_handle(&self) -> *mut std::ffi::c_void;
}

/// 给两种窗口类型各实现一次。
///
/// 用宏而不是写两遍：两个实现体逐字相同，唯一的差别是 `Self` 的类型。
macro_rules! impl_native_window {
    ($ty:ty) => {
        impl<R: Runtime> NativeWindow for $ty {
            fn native_handle(&self) -> *mut std::ffi::c_void {
                #[cfg(target_os = "macos")]
                let handle = self.ns_window().unwrap_or(std::ptr::null_mut());
                #[cfg(not(target_os = "macos"))]
                let handle = std::ptr::null_mut();
                handle
            }
        }
    };
}

impl_native_window!(tauri::Window<R>);
impl_native_window!(tauri::WebviewWindow<R>);

#[cfg(target_os = "macos")]
pub fn hide_system_traffic_lights<W: NativeWindow>(window: &W) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSWindow, NSWindowButton};

    if MainThreadMarker::new().is_none() {
        return;
    }
    let handle = window.native_handle();
    if handle.is_null() {
        return;
    }

    // SAFETY: `ns_window()` 返回的是本进程内一个活的 NSWindow 指针，
    // 且当前已在主线程（上面刚判过），符合 AppKit 的线程要求。
    let ns_window: &NSWindow = unsafe { &*handle.cast::<NSWindow>() };

    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = ns_window.standardWindowButton(kind) {
            button.setHidden(true);
        }
    }
}

/// 非 macOS 上系统窗口按钮由 Windows 自绘三键 / Linux 装饰接管，无需处理。
#[cfg(not(target_os = "macos"))]
pub fn hide_system_traffic_lights<W: NativeWindow>(_window: &W) {}
