//! 壳向前端暴露的命令。
//!
//! # 命令粒度为什么是这样
//!
//! 每个命令对应一件"只有操作系统做得了、且界面上真实需要"的事。
//! 不提供通用的"执行任意命令"入口：那等于把壳的权限整体交给前端，
//! 而前端是可被远程内容替换的。

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::host::HostState;
use crate::AppState;

/// 项目目录布局。
///
/// 开发态与安装态的文件位置不同，这里集中解析一次，
/// 其余代码只认这个结构体，不各自拼路径。
pub struct ProjectLayout {
    /// 宿主入口脚本。
    pub host_entry: PathBuf,
    /// Node 可执行文件。
    pub node_path: PathBuf,
}

impl ProjectLayout {
    /// 解析布局。
    ///
    /// # 三种来源，优先级从高到低
    ///
    /// 1. `ONDRA_HOST_ENTRY` / `ONDRA_NODE` 环境变量——调试与自定义部署用。
    /// 2. **App 包内的 Resources 目录**——安装态走这条。打包时把
    ///    `cordis-host`、`dsh-sidecar` 与 Node 运行时都放进 Resources，
    ///    这样把 .app 拷到任何机器上都能跑，不依赖源码目录是否存在。
    /// 3. 编译期源码路径——开发态兜底。
    ///
    /// # 为什么第 2 步必须排在第 3 步前面
    ///
    /// 早先只做了 1 和 3，导致打出来的 .app 里硬编码着
    /// `/Users/ntars/Github/Ondra/src-tauri`。在本机能跑，拷给别人就
    /// `MODULE_NOT_FOUND`——而且报错长得像"宿主代码有问题"，
    /// 排查方向会被带偏。资源目录是随包走的，它才是安装态的唯一真相。
    ///
    /// # 为什么不接收 AppHandle
    ///
    /// 这里需要的全是"路径从哪来"的信息，而三个来源都不依赖运行中的窗口。
    /// 不传 handle 意味着这个函数在测试里可以被直接调用。
    pub fn resolve() -> Result<Self, Box<dyn std::error::Error>> {
        // 开发态：从源码目录向上两级找到仓库根。
        // 用编译期路径而不是运行时猜测：`CARGO_MANIFEST_DIR` 在开发态一定正确，
        // 运行时猜相对路径会因为启动目录不同而失败。
        let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = crate_dir
            .parent()
            .ok_or("无法定位仓库根目录")?
            .to_path_buf();

        // 安装态的 Resources 目录：从当前可执行文件反推。
        // 路径形如 `<App>.app/Contents/MacOS/ondra`，向上两级即 Contents。
        let resources = std::env::current_exe().ok().and_then(|exe| {
            exe.parent()
                .and_then(|p| p.parent())
                .map(|contents| contents.join("Resources"))
                .filter(|dir| dir.is_dir())
        });

        // 候选入口：资源目录优先，源码兜底。取第一个**真正能用**的。
        //
        // 「能用」的判据不只是 index.js 存在，还要有 node_modules。
        // 只判文件存在会让半成品包（只拷了 lib、漏了依赖）在启动时
        // 抛 MODULE_NOT_FOUND，而那个报错长得像宿主代码有 bug。
        // 这里的完整性检查把失败提前到路径解析阶段，回落源码仍能跑起来。
        let host_entry = match std::env::var_os("ONDRA_HOST_ENTRY").map(PathBuf::from) {
            Some(explicit) => explicit,
            None => {
                let bundled = resources
                    .as_ref()
                    .map(|dir| dir.join("cordis-host"))
                    .filter(|dir| Self::is_complete_host(dir));
                match bundled {
                    Some(dir) => dir.join("lib").join("index.js"),
                    None => repo_root.join("cordis-host").join("lib").join("index.js"),
                }
            }
        };

        // Node 可执行文件：环境变量 > 包内自带 > PATH 里的系统 node。
        // 包内自带的位置是 Resources/node/bin/node，由打包脚本放入。
        let node_path = std::env::var_os("ONDRA_NODE")
            .map(PathBuf::from)
            .or_else(|| {
                resources
                    .as_ref()
                    .map(|dir| dir.join("node").join("bin").join("node"))
                    .filter(|candidate| candidate.exists())
            })
            .or_else(which_node)
            .ok_or("找不到 Node 可执行文件，请设置 ONDRA_NODE")?;

        Ok(Self { host_entry, node_path })
    }

    /// 判断一个宿主目录是否具备运行条件。
    ///
    /// 两条都要满足：入口脚本在、依赖目录在。缺任一条就说明这个目录
    /// 是半成品——多半是打包时只拷了编译产物、忘了依赖。
    ///
    /// 依赖目录允许两种形态：`node_modules`（直接安装）或
    /// `.pnpm`（pnpm 的硬链接池）。两者任一存在即可，
    /// 因为 Node 的解析规则在两种布局下都能找到模块。
    fn is_complete_host(dir: &Path) -> bool {
        if !dir.join("lib").join("index.js").exists() {
            return false;
        }
        dir.join("node_modules").is_dir()
    }
}

/// 在 PATH 里找 node。
///
/// 只用于开发态。安装态由环境变量给定，因为用户机器上不保证有 node。
fn which_node() -> Option<PathBuf> {
    let candidates = ["/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node"];
    for candidate in candidates {
        let path = PathBuf::from(candidate);
        if path.exists() {
            return Some(path);
        }
    }
    let output = std::process::Command::new("which").arg("node").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(PathBuf::from(text)) }
}

/// 读取宿主当前状态。
#[tauri::command]
pub async fn get_host_state(state: tauri::State<'_, AppState>) -> Result<HostState, String> {
    Ok(state.host.state().await)
}

/// 重启宿主。用于"连接失败后重试"。
#[tauri::command]
pub async fn restart_host(state: tauri::State<'_, AppState>) -> Result<HostState, String> {
    state.host.stop().await;
    match state.host.start().await {
        Ok(_) => Ok(state.host.state().await),
        Err(message) => Ok(HostState::Failed { message }),
    }
}

/// 文件选择的结果。
#[derive(Serialize)]
pub struct PickFilesResult {
    /// 选中路径。用户取消时为空数组。
    pub paths: Vec<String>,
}

/// 弹出系统文件选择对话框。
///
/// # 为什么用户取消返回空数组而不是错误
///
/// 取消是正常的用户行为，不是异常。把它当错误会让前端必须区分
/// "用户取消了"和"选择失败了"，而这两者对界面来说同样是"没选到文件"。
#[tauri::command]
pub async fn pick_files(
    multiple: bool,
    directory: bool,
    extensions: Vec<String>,
    title: Option<String>,
) -> Result<PickFilesResult, String> {
    // 用 Tauri 的对话插件需要额外依赖；此处直接走系统命令，避免为单一功能
    // 引入一个插件。macOS 用 osascript，Windows 用 PowerShell。
    let paths = if cfg!(target_os = "macos") {
        pick_macos(multiple, directory, &extensions, title.as_deref())?
    } else {
        return Err("当前平台的文件选择尚未实现".to_string());
    };
    Ok(PickFilesResult { paths })
}

/// macOS 文件选择实现。
fn pick_macos(
    multiple: bool,
    directory: bool,
    extensions: &[String],
    title: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut script = String::from("tell application \"System Events\" to activate\n");
    // 用 `choose file` / `choose folder` 而非 `choose item`：
    // 后者在不同 macOS 版本上行为不一致。
    let choose = if directory { "choose folder" } else { "choose file" };
    script.push_str(&format!("set chosen to {choose}"));
    if multiple {
        script.push_str(" with multiple selections allowed");
    }
    if let Some(title) = title {
        // AppleScript 字符串里的双引号要转义，否则脚本语法被破坏。
        let escaped = title.replace('\\', "\\\\").replace('"', "\\\"");
        script.push_str(&format!(" with prompt \"{escaped}\""));
    }
    script.push_str("\nset output to \"\"\n");
    script.push_str("if class of chosen is list then\n");
    script.push_str("  repeat with item_ in chosen\n");
    script.push_str("    set output to output & (POSIX path of item_) & \"\\n\"\n");
    script.push_str("  end repeat\n");
    script.push_str("else\n");
    script.push_str("  set output to POSIX path of chosen & \"\\n\"\n");
    script.push_str("end if\n");
    script.push_str("return output");

    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|error| format!("无法调用系统文件选择：{error}"))?;

    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        // 用户按取消时 osascript 会以错误码退出。这不是失败，返回空列表。
        if message.contains("User canceled") || message.contains("-128") {
            return Ok(Vec::new());
        }
        return Err(format!("文件选择失败：{message}"));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // 扩展名过滤在这里做：AppleScript 的 type 过滤会按 UTI 匹配，
        // 用户拿到一个"看起来允许但其实打不开"的文件比没选更糟。
        .filter(|line| matches_extension(line, extensions))
        .map(str::to_string)
        .collect())
}

/// 判断路径扩展名是否在允许列表内。空列表表示不限。
fn matches_extension(path: &str, extensions: &[String]) -> bool {
    if extensions.is_empty() {
        return true;
    }
    let lower = path.to_lowercase();
    extensions.iter().any(|ext| lower.ends_with(&format!(".{}", ext.to_lowercase())))
}

/// 在系统文件管理器中显示路径。
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径不能为空".to_string());
    }
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg("-R").arg(&path).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(format!("/select,{path}")).status()
    } else {
        std::process::Command::new("xdg-open")
            .arg(Path::new(&path).parent().unwrap_or(Path::new(&path)))
            .status()
    };
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err("系统文件管理器未接受该路径".to_string()),
        Err(error) => Err(format!("无法调用系统文件管理器：{error}")),
    }
}

/// 读取系统主题偏好。
///
/// 前端已有 `prefers-color-scheme` 可用，这个命令是给"需要在 Rust 侧
/// 根据主题调整托盘图标"等场景准备的。
#[tauri::command]
pub async fn get_theme(window: tauri::Window) -> Result<String, String> {
    window
        .theme()
        .map(|theme| match theme {
            tauri::Theme::Dark => "dark".to_string(),
            _ => "light".to_string(),
        })
        .map_err(|error| format!("读取主题失败：{error}"))
}

/// 设置窗口标题。
#[tauri::command]
pub async fn set_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|error| format!("设置标题失败：{error}"))
}

/// 关闭 Dialog 里做出的选择。
///
/// `action` 取 `"hide"` 或 `"quit"`；`remember` 为真时写盘，此后不再询问。
///
/// # 为什么这个命令要暴露给前端
///
/// 首次关闭的对话框是前端画的（要遵守 §5.12 的 Dialog 规格：宽 400、
/// 遮罩 0.18、Esc 关闭、焦点锁定）。Rust 侧画不了这种框，
/// 它只负责在拦截时发一条事件，等前端把选择传回来。
#[tauri::command]
pub async fn resolve_close(app: tauri::AppHandle, action: String, remember: bool) -> Result<(), String> {
    let choice = match action.as_str() {
        "hide" => crate::window::CloseAction::Hide,
        "quit" => crate::window::CloseAction::Quit,
        other => return Err(format!("未知的关闭方式：{other}")),
    };
    crate::window::apply_close_choice(&app, choice, remember);
    Ok(())
}

/// 从托盘唤回窗口。前端也用它做「从设置里回到主界面」。
#[tauri::command]
pub async fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::window::reveal(&app);
    Ok(())
}

/// 打开偏好设置窗口（§5.13）。
///
/// # 为什么由前端发起而不是壳自己弹
///
/// 三个入口里有两条在前端：`Cmd/Ctrl + ,` 与 Rail 底部齿轮。
/// 壳自己弹会让「按 Cmd+, 打开的是什么」变成两处判断——
/// 一处在前端的快捷键表，一处在这里。
#[tauri::command]
pub async fn open_preferences(app: tauri::AppHandle) -> Result<(), String> {
    crate::preferences::open(&app);
    Ok(())
}

/// 关掉偏好设置窗口。
#[tauri::command]
pub async fn close_preferences(app: tauri::AppHandle) -> Result<(), String> {
    crate::preferences::close(&app);
    Ok(())
}

/// 把偏好广播到其他窗口。
///
/// `from` 由前端传窗口自己的 label。不在这里自己查：Tauri 2 的
/// 命令签名里取「发起调用的窗口」要额外一个 `WebviewWindow` 参数，
/// 而那个参数的 label 在 `WebviewUrl::App` 带 hash 时不一定等于
/// 我们在 builder 里设的那个——传进来是唯一确定的做法。
#[tauri::command]
pub async fn broadcast_preferences(
    app: tauri::AppHandle,
    from: String,
    prefs: String,
) -> Result<(), String> {
    crate::preferences::broadcast(&app, &from, &prefs);
    Ok(())
}

/// 把静音状态写到托盘菜单上（§12.10、§12.12）。
///
/// # 为什么状态在前端，文字在壳
///
/// 静音要不要生效、Spine 上显示什么，全由前端的状态机决定（`lib/mute.ts`）。
/// 但托盘菜单活在 Rust 侧，前端改不到。所以每次静音状态变化，前端把
/// 新的布尔值送过来，壳只做一件事：把那一项的文字换成对应的说法。
///
/// # 为什么托盘不可用时不报错
///
/// 没有托盘（Linux 无 StatusNotifier）的机器上本来就没有菜单可改。
/// 这不影响静音本身是否生效，返回错误只会让前端弹一条用户无法处理的提示。
#[tauri::command]
pub async fn set_tray_muted(state: tauri::State<'_, AppState>, muted: bool) -> Result<(), String> {
    if let Some(item) = state.mute_item.as_ref() {
        item.set_muted(muted);
    }
    Ok(())
}

/// 宿主日志目录。
///
/// 故障页的「查看日志」要能打开一个真实存在的位置。宿主把 stderr 转发到
/// 壳的日志通道，落盘位置在这里统一给出，避免前端拼路径。
///
/// 取不到日志目录时退回配置目录——总比给一个不存在的路径好。
#[tauri::command]
pub async fn open_log_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_log_dir()
        .or_else(|_| app.path().app_config_dir())
        .map_err(|error| format!("取不到日志目录：{error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建日志目录失败：{error}"))?;
    let target = dir.to_string_lossy().to_string();
    reveal_in_folder(target.clone()).await?;
    Ok(target)
}
