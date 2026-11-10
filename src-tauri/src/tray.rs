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
//! 三档取自 `tools/build-tray-icons.mjs`，它从 `/icon.svg` 渲染出**无底板**的
//! 纯剪影。这一处与 `icons/32x32.png` 是两个不同的东西，不能互换：
//!
//! | | `icons/32x32.png` | `tray/tray-*.png` |
//! | --- | --- | --- |
//! | 用途 | 应用图标（Dock / 安装包 / 任务栏） | 菜单栏 / 系统托盘 |
//! | 底板 | 白色 squircle | 无，四周透明 |
//! | 颜色 | 白底黑鱼 | 纯黑剪影，交给系统按 template 染色 |
//!
//! 把应用图标塞进菜单栏，得到的是一枚 16×16 的白方块——比旁边的系统图标
//! 重得多，深色菜单栏上尤其扎眼。这是 §4.5 明确要求两版分开的原因。

use crate::window;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

/// 托盘图标的候选档位（像素边长）。
///
/// 由小到大排列，选档时取「第一个不小于所需像素」的那一档。
const TRAY_SIZES: [u32; 3] = [16, 32, 64];

/// 托盘图标的逻辑基准边长。
///
/// macOS 菜单栏图标高 18pt（系统值，写死 16 会显得偏小）；Windows 通知区与
/// 主流 Linux 桌面环境都是 16px。这个基准乘上显示缩放，才是真正需要的像素。
#[cfg(target_os = "macos")]
const TRAY_BASE: f64 = 18.0;
#[cfg(not(target_os = "macos"))]
const TRAY_BASE: f64 = 16.0;

/// 菜单项 id。
///
/// 用常量而不是字面量：这些字符串同时出现在菜单构造与事件分支里，
/// 拼错一个字符不会报错，只会让那个菜单项静默失效。
mod ids {
    /// 打开主窗口。
    pub const OPEN: &str = "tray.open";
    /// 打开今天抽屉。
    pub const TODAY: &str = "tray.today";
    /// 静音 1 小时 / 取消静音。
    pub const MUTE: &str = "tray.mute";
    /// 退出应用。
    pub const QUIT: &str = "tray.quit";
}

/// 托盘图标 id。改菜单文字时要靠它取回那个托盘。
const TRAY_ID: &str = "main";

/// 静音菜单项的两种文案。
///
/// 为什么不是一句「静音」：菜单项写的是**点下去会发生什么**。
/// 静音期间点它应当是取消，文字就得如实写「取消静音」。
/// 只写「静音」的话，用户没有取消的入口，只能等一小时过去。
const MUTE_OFF_TEXT: &str = "静音 1 小时";
const MUTE_ON_TEXT: &str = "取消静音";

/// 静音菜单项的句柄。
///
/// 为什么要把这一项单独存起来：托盘菜单建好之后，`TrayIcon` 上**没有**
/// 读回菜单的方法（即便有，也得先在菜单树里按 id 找一遍）。要改一句文案，
/// 唯一稳的路是在建的时候就留住那一项的手柄。
///
/// 这也解释了为什么只留静音这一项：其余四项的文案一辈子不变，
/// 留住它们只会多出四个没人用的字段。
pub struct MuteItem<R: Runtime>(pub MenuItem<R>);

impl<R: Runtime> MuteItem<R> {
    /// 按静音状态改写菜单文字。
    ///
    /// 失败只记日志：`set_text` 在 Linux 某些桌面环境下会返回错误，
    /// 而那时菜单仍能用，只是文字没跟上——不值得让一次静音操作报错。
    pub fn set_muted(&self, muted: bool) {
        if let Err(error) = self.0.set_text(if muted { MUTE_ON_TEXT } else { MUTE_OFF_TEXT }) {
            eprintln!("[shell] 托盘菜单文字没能改成静音态：{error}");
        }
    }
}

/// 创建托盘。
///
/// 在 `setup()` 里调用一次。返回托盘句柄与静音菜单项的手柄：
/// 前者由 Tauri 自己持有（丢掉会让图标消失），后者交给命令层改文案。
///
/// # 失败为什么只记日志不上报
///
/// 托盘创建失败（Linux 上没有 StatusNotifier 宿主时会发生）不该让应用
/// 起不来——主窗口还能用。这种情况下关闭行为改为最小化（§10.5），
/// 用户仍然找得回窗口。
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<(TrayIcon<R>, MuteItem<R>)> {
    let open = MenuItem::with_id(app, ids::OPEN, "打开空谷", true, None::<&str>)?;
    let today = MenuItem::with_id(app, ids::TODAY, "今天", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let mute = MenuItem::with_id(app, ids::MUTE, MUTE_OFF_TEXT, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ids::QUIT, "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open, &today, &separator, &mute, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
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

    // 图标：打包后从资源目录取，开发态从 `src-tauri/tray/` 取。
    // 取不到就不设图标——系统会显示一个占位方块，比整个托盘创建失败好。
    if let Some(icon) = load_icon(app) {
        builder = builder.icon(icon);
        // macOS 菜单栏图标是**模板图**：系统只看 alpha 通道，把不透明部分
        // 整体染成黑（浅色菜单栏）或白（深色菜单栏）。不设这一位，图标会
        // 保持文件里的纯黑，深色菜单栏上基本看不见。
        //
        // Windows / Linux 没有这个概念，它们的托盘直接显示原图，
        // 所以只在 macOS 上开。
        #[cfg(target_os = "macos")]
        {
            builder = builder.icon_as_template(true);
        }
    }

    // 菜单项在 `menu` 构造时已被克隆进菜单树，这里再把静音那一项单独
    // 交出去：之后改文案靠它，不靠从菜单树里找。
    let tray = builder.build(app)?;
    Ok((tray, MuteItem(mute)))
}

/// 读取托盘图标。
///
/// # 选档规则
///
/// 菜单栏图标高 18pt（macOS）/ 16px（其余），乘窗口所在屏的缩放系数，
/// 得到真正需要的**物理像素**，取第一个不小于它的档位。1x 屏要 18 像素 →
/// 取 32 档（16 不够，会糊）；2x 屏要 36 像素 → 取 64 档。
///
/// 不从 `TRAY_SIZES` 里逐个 `scale_factor` 反算，是因为缩放不是整数
/// （Windows 有 125% / 150%），反算出来的边长会落在两档之间，
/// 判断「够不够」比「相等」稳得多。
///
/// # 为什么不用 `default_window_icon()`
///
/// 那是应用图标（1024 的 squircle），缩到托盘尺寸后底板仍是一块实色方块，
/// 在 macOS 菜单栏里显得又重又脏。托盘要的是**只有图形、没有底板**的那一版，
/// 由 `tools/build-tray-icons.mjs` 单独渲染。
fn load_icon<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::image::Image<'static>> {
    let scale = app
        .get_webview_window("main")
        .and_then(|window| window.scale_factor().ok())
        // 窗口还没建好时按 1x 起步：宁可选小一档，也不要凭空放大一倍
        // 之后在 1x 屏上被系统缩回去——那一步必糊。
        .unwrap_or(1.0);
    let needed = TRAY_BASE * scale;
    let size = TRAY_SIZES
        .iter()
        .copied()
        .find(|candidate| f64::from(*candidate) >= needed)
        // 全部不够（缩放超过 400%）时用最大档，不让它退化成 None。
        .unwrap_or(*TRAY_SIZES.last().unwrap_or(&64));
    let file = format!("tray/tray-{size}.png");

    // 打包后：资源目录旁；开发态：`CARGO_MANIFEST_DIR` 下。
    // 两处都试，是因为 `tauri dev` 与安装后的目录结构本就不一样。
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(path) = app.path().resolve(&file, tauri::path::BaseDirectory::Resource) {
        candidates.push(path);
    }
    candidates.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(&file));

    for path in candidates {
        if let Ok(image) = tauri::image::Image::from_path(&path) {
            return Some(image.to_owned());
        }
    }
    eprintln!("[shell] 读不到托盘图标：{file}（先跑 `node tools/build-tray-icons.mjs`）");
    None
}
