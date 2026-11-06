//! 托盘图标与菜单。
//!
//! # 为什么陪伴类应用必须有托盘
//!
//! 这个应用的价值来自「她一直在」。窗口关掉就彻底消失，等于告诉用户
//! 「你需要它的时候它才在」——那不是陪伴，是工具。托盘是唯一能让进程
//! 继续活着、又不占桌面空间的地方。
//!
//! # 为什么菜单只有四项
//!
//! 「打开空谷 / 今天 / 静音 1 小时 / 退出」（§12.10）。托盘菜单不是功能
//! 入口，是**兜底**：用户在主窗口里能找到的东西，一样都不该在这里重复。
//! 这四项各自对应一个主窗口关掉之后仍然成立的动作。
//!
//! # 为什么不显示未读数
//!
//! 陪伴产品不做未读压力（§12.10）。红点、数字、"3 条新消息"都是
//! 社交软件的形状，它们的前提是「你不回就会失去什么」。这里没有那个前提。
//!
//! # 图标为什么要三档
//!
//! 16 / 32 / 64 对应普通屏、Retina、以及部分 Linux 桌面环境的放大场景。
//! 只给一档会由系统缩放，缩小后的细线会糊成一团灰。
//!
//! 图标本体由 `tools/build-icons.mjs` 从 `/icon.svg` 生成，
//! 与安装包、Dock、任务栏共用同一份母版（§4.5）。

use crate::window;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

/// 托盘图标在 `icons/` 下的文件。三档按平台取其一。
///
/// 打包后由 Tauri 的资源解析定位；开发态与安装后走同一条路径，
/// 所以这里写相对路径而不是绝对路径。
#[cfg(target_os = "macos")]
const TRAY_ICON: &str = "icons/32x32.png";
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: &str = "icons/32x32.png";

/// 菜单项 id。
///
/// 用常量而不是字面量：这些字符串同时出现在菜单构造与事件分支里，
/// 拼错一个字符不会报错，只会让那个菜单项静默失效。
mod ids {
    /// 打开主窗口。
    pub const OPEN: &str = "tray.open";
    /// 打开今天抽屉。
    pub const TODAY: &str = "tray.today";
    /// 静音 1 小时。
    pub const MUTE: &str = "tray.mute";
    /// 退出应用。
    pub const QUIT: &str = "tray.quit";
}

/// 创建托盘。
///
/// 在 `setup()` 里调用一次。返回的句柄保存在 `AppState` 里，
/// 用于后续更新菜单文字（静音开关要改文案）。
///
/// # 失败为什么只记日志不上报
///
/// 托盘创建失败（Linux 上没有 StatusNotifier 宿主时会发生）不该让应用
/// 起不来——主窗口还能用。这种情况下关闭行为改为最小化（§10.5），
/// 用户仍然找得回窗口。
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let open = MenuItem::with_id(app, ids::OPEN, "打开空谷", true, None::<&str>)?;
    let today = MenuItem::with_id(app, ids::TODAY, "今天", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let mute = MenuItem::with_id(app, ids::MUTE, "静音 1 小时", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ids::QUIT, "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open, &today, &separator, &mute, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("空谷 Ondra")
        // 左键不弹菜单，直接唤回窗口：菜单里有「打开空谷」，再让左键弹菜单
        // 就成了同一个动作的两条路径。右键留给菜单。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            ids::OPEN => window::reveal(app),
            ids::TODAY => {
                window::reveal(app);
                // 前端据此打开「今天」抽屉。托盘在 Rust 侧，抽屉在 React 侧，
                // 中间只有事件这一条路。
                let _ = tauri::Emitter::emit(app, "open-drawer", "today");
            }
            ids::MUTE => {
                // 静音的状态由前端持有（它要显示在 Spine 上，§12.12），
                // 这里只把动作传过去，不在 Rust 侧维护第二份真相。
                let _ = tauri::Emitter::emit(app, "toggle-mute", ());
            }
            ids::QUIT => {
                // 走与关闭按钮不同的路径：这里是真的退出，不拦截。
                window::quit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 只认左键抬起。右键抬起会立刻弹菜单，此时再唤回窗口
            // 会让菜单刚出来就失去焦点。
            if let TrayIconEvent::Click { button, button_state, .. } = event {
                if button == tauri::tray::MouseButton::Left
                    && button_state == tauri::tray::MouseButtonState::Up
                {
                    window::reveal(tray.app_handle());
                }
            }
        });

    // 图标：打包后从资源目录取，开发态从 `src-tauri/icons/` 取。
    // 取不到就不设图标——系统会显示一个占位方块，比整个托盘创建失败好。
    if let Some(icon) = load_icon(app) {
        builder = builder.icon(icon);
    }

    builder.build(app)
}

/// 读取托盘图标。
///
/// # 为什么不用 `default_window_icon()`
///
/// 那是应用图标（1024 的 squircle），缩到托盘尺寸后底板仍是一块实色方块，
/// 在 macOS 菜单栏里显得又重又脏。托盘要的是**只有图形、没有底板**的那一版。
///
/// 目前 `icons/32x32.png` 仍带底板（由 `build-icons.mjs` 统一生成），
/// 这一步留在图标脚本里做比在 Rust 里做更好——那里已经有渲染器。
/// 现在先直接读，取不到返回 `None`。
fn load_icon<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::image::Image<'static>> {
    // 打包后：资源目录旁；开发态：`CARGO_MANIFEST_DIR` 下。
    // 两处都试，是因为 `tauri dev` 与安装后的目录结构本就不一样。
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resolve(TRAY_ICON, tauri::path::BaseDirectory::Resource) {
        candidates.push(dir);
    }
    candidates.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(TRAY_ICON));

    for path in candidates {
        if let Ok(image) = tauri::image::Image::from_path(&path) {
            return Some(image.to_owned());
        }
    }
    eprintln!("[shell] 读不到托盘图标：{TRAY_ICON}");
    None
}
