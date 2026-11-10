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
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
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
