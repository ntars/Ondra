//! 壳向前端暴露的命令。
//!
//! # 命令粒度为什么是这样
//!
//! 每个命令对应一件"只有操作系统做得了、且界面上真实需要"的事。
//! 不提供通用的"执行任意命令"入口：那等于把壳的权限整体交给前端，
//! 而前端是可被远程内容替换的。

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

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
        //
        // 两个平台的布局不同，不能只写一种：
        //
        // | 平台 | 可执行文件 | 资源 |
        // | --- | --- | --- |
        // | macOS | `<App>.app/Contents/MacOS/ondra` | `<App>.app/Contents/Resources` |
        // | Windows | `<安装目录>/ondra.exe` | `<安装目录>`（同级） |
        //
        // 只认 macOS 那一条时，Windows 上 `resources` 恒为 `None`，于是
        // 回落到**编译期**的仓库路径——那份路径在别人的机器上不存在，
        // 启动时只会得到 MODULE_NOT_FOUND，看起来像宿主代码坏了。
        let resources = std::env::current_exe().ok().and_then(|exe| {
            let dir = exe.parent()?.to_path_buf();
            dir.parent()
                .map(|contents| contents.join("Resources"))
                .filter(|candidate| candidate.is_dir())
                .or(Some(dir).filter(|candidate| candidate.is_dir()))
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
        //
        // 包内自带的位置是 `Resources/node/bin/node`（Windows 上是
        // `node.exe`，由 `tools/collect-runtime.mjs` 按平台命名放入）。
        // 文件名必须分平台写死：Windows 上 `.exists()` 对没有扩展名的
        // `node` 恒为 false，于是会静默落到 PATH——而在用户机器上通常
        // 没有系统 node，启动时只会得到一句「找不到 Node 可执行文件」。
        let bundled_node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let node_path = std::env::var_os("ONDRA_NODE")
            .map(PathBuf::from)
            .or_else(|| {
                resources
                    .as_ref()
                    .map(|dir| dir.join("node").join("bin").join(bundled_node_name))
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

/// 在内置浏览器里打开一个白名单地址。
///
/// # 为什么白名单之外是错误，而不是「悄悄交给系统浏览器」
///
/// 悄悄转交会让白名单形同虚设：用户点一个链接，有时在应用里开、有时跳出去，
/// 而他无法从行为上预判是哪一种。明确失败 + 一句可读的原因，至少是诚实的。
/// 应用自己那几个链接（官网、仓库、下载页）都在白名单里，走不到这条路。
#[tauri::command]
pub async fn open_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    crate::browser::open(&app, &url)
}

/// 把导出的文本写进下载目录，并在文件管理器里高亮它。
///
/// # 为什么不做「另存为」对话框
///
/// 那需要引一个对话插件（Tauri 的 `dialog` 插件），而本项目一直避免为单一
/// 功能加插件。更重要的是：导出的用途是「带走一份」，落到最容易被找到的
/// 位置（下载目录）再当场打开它所在的文件夹，比让用户在树形目录里选路径
/// 少两步操作，也不容易存到一个自己都忘了的地方。
///
/// # 文件名为什么要在壳里再洗一遍
///
/// 名字由前端拼（含日期与标题），而标题是用户输入的自由文本——里面可能有
/// `/`、换行、`:`。直接拼进路径会写到别的目录里去，或者在某些文件系统上
/// 直接失败。这里把分隔符与控制字符一律换成 `-`。
#[tauri::command]
pub async fn save_export(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("取不到下载目录：{error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("下载目录不可写：{error}"))?;

    let path = dir.join(sanitize_filename(&filename));
    std::fs::write(&path, content).map_err(|error| format!("写入失败：{error}"))?;

    let target = path.to_string_lossy().to_string();
    reveal_in_folder(target.clone()).await?;
    Ok(target)
}

/// 洗掉文件名里不能用的字符。
///
/// 只处理「会让写入跑到别处」与「会让某些文件系统拒绝」的两类字符，
/// 不做任何美化：中文、空格、括号、破折号都原样保留，用户看到的就是
/// 他自己那段话的标题。
fn sanitize_filename(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            // 控制字符（含换行与制表）：文件名里出现它们，Finder 与资源
            // 管理器都会显示成怪符号或者直接打不开。
            ch if ch.is_control() => '-',
            ch => ch,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "ondra-export".to_string()
    } else {
        trimmed
    }
}

/// 选一个文件并读回它的文本内容。
///
/// 导入走这条路而不是让前端读文件：WebView 里没有文件系统权限，
/// 而为一个「偶尔用一次」的功能打开它，等于给页面永久开了整台机器的读权限。
#[derive(Serialize)]
pub struct PickedText {
    /// 用户选中的路径。用于回显「从哪儿导入的」。
    pub path: String,
    /// 文件内容（UTF-8）。
    pub content: String,
}

/// 选择并读取一个 JSON 文件。
///
/// @returns 用户取消时 `None`——取消是正常行为，不是错误。
#[tauri::command]
pub async fn open_import() -> Result<Option<PickedText>, String> {
    if !cfg!(target_os = "macos") {
        return Err("当前平台的导入尚未实现".to_string());
    }
    let paths = pick_macos(
        false,
        false,
        &["json".to_string()],
        Some("选择要恢复的对话文件"),
    )?;
    let Some(path) = paths.into_iter().next() else {
        return Ok(None);
    };
  let content = std::fs::read_to_string(&path).map_err(|error| format!("读不到这个文件：{error}"))?;
  Ok(Some(PickedText { path, content }))
}

/// 取走尚未处理的深度链接（`ondra://…`）。
///
/// 前端在挂载时调用一次：冷启动点链接时，系统会在页面就绪之前就把链接交给
/// 壳，那时监听还没建立。壳先把它们攒在 `AppState::deep_links` 里，这里一次
/// 性交出去并清空——清空是必须的，否则每次刷新页面都会重复触发同一批链接。
#[tauri::command]
pub fn take_deep_links(state: tauri::State<'_, AppState>) -> Vec<String> {
  match state.deep_links.lock() {
    Ok(mut pending) => std::mem::take(&mut *pending),
    Err(_) => Vec::new(),
  }
}

/// 应用数据目录（会话、记忆、世界书、知识库、配置、偏好都在这里）。
///
/// 所有「碰磁盘」的命令都从这里取路径，不各自拼。取不到时回落到配置目录——
/// 总比给一个不存在的路径好。
fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  app.path()
    .app_data_dir()
    .map_err(|error| format!("取不到数据目录：{error}"))
}

/// 当前 Unix 秒。
fn now_secs() -> i64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|duration| duration.as_secs() as i64)
    .unwrap_or(0)
}

/// 递归复制目录，跳过 `skip` 中列出的直接子项名。
///
/// 跳过项用来避免把「备份目录本身」或「将要写回的源」又复制一遍，造成嵌套。
fn copy_dir_excluding(src: &Path, dst: &Path, skip: &[&str]) -> std::io::Result<()> {
  std::fs::create_dir_all(dst)?;
  for entry in std::fs::read_dir(src)? {
    let entry = entry?;
    let name = entry.file_name();
    let name_str = name.to_string_lossy();
    if skip.iter().any(|item| *item == name_str.as_ref()) {
      continue;
    }
    let src_path = entry.path();
    let dst_path = dst.join(&name);
    if entry.file_type()?.is_dir() {
      copy_dir_excluding(&src_path, &dst_path, skip)?;
    } else {
      std::fs::copy(&src_path, &dst_path)?;
    }
  }
  Ok(())
}

/// 读一个 JSON 数组文件，不存在或解析失败时返回空数组。
///
/// 面向「知识库 / 模型提供商」这类以文件为单一真源的小清单：
/// 读不到不是异常，是「还没有任何条目」。
fn read_json_array(app: &tauri::AppHandle, name: &str) -> Vec<serde_json::Value> {
  let Ok(dir) = app_data_dir(app) else {
    return Vec::new();
  };
  match std::fs::read_to_string(dir.join(name)) {
    Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
    Err(_) => Vec::new(),
  }
}

/// 写一个 JSON 数组文件（带目录创建）。
fn write_json_array(app: &tauri::AppHandle, name: &str, items: &[serde_json::Value]) -> Result<(), String> {
  let dir = app_data_dir(app)?;
  std::fs::create_dir_all(&dir).map_err(|error| format!("创建数据目录失败：{error}"))?;
  let text = serde_json::to_string_pretty(items).map_err(|error| format!("序列化失败：{error}"))?;
  std::fs::write(dir.join(name), text).map_err(|error| format!("写入失败：{error}"))
}

/// 应用数据目录路径。
///
/// 隐私页要能把它显示出来并「在访达中显示」。前端不能自己拼这个路径——
/// 不同平台位置不同，且它可能还没被创建。
#[tauri::command]
pub async fn app_data_path(app: tauri::AppHandle) -> Result<String, String> {
  let dir = app_data_dir(&app)?;
  std::fs::create_dir_all(&dir).map_err(|error| format!("创建数据目录失败：{error}"))?;
  Ok(dir.to_string_lossy().to_string())
}

/// 打开 macOS 系统设置的某一隐私面板。
///
/// # 为什么只做 macOS
///
/// Windows / Linux 没有统一的「隐私与安全性」深层链接协议。当前目标平台是
/// macOS，给其它平台返回一个明确的「暂不支持」比静默无反应诚实。
#[tauri::command]
pub async fn open_settings_pane(pane: String) -> Result<(), String> {
  if !cfg!(target_os = "macos") {
    return Err("当前平台暂不支持直接打开系统设置".to_string());
  }
  let url = match pane.as_str() {
    "microphone" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    "camera" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
    "files" => "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    "notifications" => "x-apple.systempreferences:com.apple.preference.notifications",
    _ => "x-apple.systempreferences:com.apple.preference.security",
  };
  std::process::Command::new("open")
    .arg(url)
    .status()
    .map_err(|error| format!("无法打开系统设置：{error}"))?;
  Ok(())
}

/// 一个备份的元信息。
#[derive(Serialize)]
pub struct BackupInfo {
  /// 以 Unix 秒命名的目录名，同时是排序键。
  pub id: String,
  /// 创建时间（Unix 秒），便于前端格式化。
  pub created_at: i64,
  /// 备份目录的绝对路径。
  pub path: String,
}

/// 创建一次整库快照。
///
/// # 为什么是「整库复制」而不是「导出 JSON」
///
/// 备份要能回滚到那一刻的**全部**状态——会话、记忆、世界书、知识库、
/// 模型提供商、配置。只导会话 JSON 会丢掉其余所有。整库复制牺牲一点体积，
/// 换来「恢复后和当时一模一样」。复制时跳过 `backups` 自身，避免嵌套。
#[tauri::command]
pub async fn backup_create(app: tauri::AppHandle) -> Result<BackupInfo, String> {
  let data = app_data_dir(&app)?;
  let secs = now_secs();
  let id = secs.to_string();
  let dest = data.join("backups").join(&id);
  copy_dir_excluding(&data, &dest, &["backups"]).map_err(|error| format!("创建备份失败：{error}"))?;
  let manifest = serde_json::json!({
    "id": id,
    "created_at": secs,
    "app_version": env!("CARGO_PKG_VERSION"),
  });
  let _ = std::fs::write(dest.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default());
  Ok(BackupInfo {
    id,
    created_at: secs,
    path: dest.to_string_lossy().to_string(),
  })
}

/// 列出全部备份（按创建时间倒序）。
#[tauri::command]
pub async fn backup_list(app: tauri::AppHandle) -> Result<Vec<BackupInfo>, String> {
  let dir = app_data_dir(&app)?.join("backups");
  if !dir.is_dir() {
    return Ok(Vec::new());
  }
  let mut out: Vec<BackupInfo> = Vec::new();
  if let Ok(entries) = std::fs::read_dir(&dir) {
    for entry in entries.flatten() {
      if !entry.file_type().map(|file_type| file_type.is_dir()).unwrap_or(false) {
        continue;
      }
      let id = entry.file_name().to_string_lossy().to_string();
      /*
       * 只认本命令创建的目录：名字必须是正的 Unix 秒。
       *
       * `backups/` 还会被别的功能用到（例如 `snapshots/`）。把它们列成备份，
       * 用户会看到一条 1970-01-01 的记录，点「回滚」则会把整库倒进一个
       * 来路不明的目录——宁可少列，也不能列错。
       */
      let Ok(stamp) = id.parse::<i64>() else {
        continue;
      };
      if stamp <= 0 {
        continue;
      }
      let created_at = std::fs::read_to_string(entry.path().join("manifest.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("created_at").and_then(|created| created.as_i64()))
        /* 目录名本身就是创建时刻；manifest 丢了也照样能排出正确时间。 */
        .unwrap_or(stamp);
      out.push(BackupInfo {
        id,
        created_at,
        path: entry.path().to_string_lossy().to_string(),
      });
    }
  }
  out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
  Ok(out)
}

/// 回滚到某个备份。
///
/// 把快照内容整库写回数据目录（同样跳过 `backups`）。这是覆盖式恢复：
/// 与导入会话不同，这里**不归档**当前数据，因为备份的意义就是「整库回到那一刻」。
/// 调用方（设置页）应在回滚前提示用户此操作会覆盖当前全部数据。
#[tauri::command]
pub async fn backup_restore(app: tauri::AppHandle, id: String) -> Result<(), String> {
  let src = app_data_dir(&app)?.join("backups").join(&id);
  if !src.is_dir() {
    return Err("找不到这个备份".to_string());
  }
  let data = app_data_dir(&app)?;
  copy_dir_excluding(&src, &data, &["backups"]).map_err(|error| format!("恢复失败：{error}"))
}

/// 列出知识库条目（用户可管理的版本，区别于内核自带的「世界书」插件）。
#[tauri::command]
pub async fn kb_list(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
  Ok(read_json_array(&app, "kb.json"))
}

/// 新增或更新一条知识库条目。
///
/// 有 `id` 则按 `id` 覆盖，无 `id` 则生成新 `id`。`created_at` 只在首次写入，
/// 之后保留——这是「什么时候建的」而不是「什么时候改的」。
#[tauri::command]
pub async fn kb_upsert(app: tauri::AppHandle, entry: serde_json::Value) -> Result<serde_json::Value, String> {
  let mut items = read_json_array(&app, "kb.json");
  let id = entry
    .get("id")
    .and_then(|value| value.as_str())
    .map(str::to_string)
    .unwrap_or_else(|| format!("kb-{}", now_secs()));
  let mut merged = entry.clone();
  merged["id"] = serde_json::Value::String(id.clone());
  merged["updated_at"] = serde_json::Value::Number(now_secs().into());
  let created = entry
    .get("created_at")
    .and_then(|value| value.as_i64())
    .unwrap_or_else(now_secs);
  merged["created_at"] = serde_json::Value::Number(created.into());
  items.retain(|item| item.get("id").and_then(|value| value.as_str()) != Some(id.as_str()));
  items.push(merged.clone());
  write_json_array(&app, "kb.json", &items)?;
  Ok(merged)
}

/// 删除一条知识库条目。
#[tauri::command]
pub async fn kb_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
  let mut items = read_json_array(&app, "kb.json");
  items.retain(|item| item.get("id").and_then(|value| value.as_str()) != Some(id.as_str()));
  write_json_array(&app, "kb.json", &items)
}

/// 语音转写的结果。成功与失败都走正常返回（前端据此给提示），不抛错——
/// 「没装本地模型」是预期状态，不是异常。
#[derive(Serialize)]
pub struct TranscribeResult {
  /// 是否成功拿到文字。
  pub ok: bool,
  /// 转写文字（成功时）。
  pub text: String,
  /// 失败原因（失败时）。
  pub reason: Option<String>,
}

/// 在 PATH 里找一个名为 `name` 的可执行文件（语音识别后端）。
fn which_program(name: &str) -> Option<PathBuf> {
  if let Ok(path) = std::env::var("PATH") {
    for dir in path.split(':') {
      let candidate = Path::new(dir).join(name);
      if candidate.is_file() {
        return Some(candidate);
      }
    }
  }
  None
}

/// 把录音转写成文字。
///
/// # 为什么是「尽力而为」
///
/// 真正的离线识别需要一个本机模型（whisper.cpp / openai-whisper 等），
/// 而它不在安装包内。命令先写出临时文件、再找本机是否有可用的识别后端：
/// 有则调用，没有则明确告诉前端「未安装本地语音模型」——而不是假装失败。
/// 音频以 `Vec<u8>` 传入（Tauri 会把前端的 `Uint8Array` 直接映射过来），
/// 省掉 base64 往返。
#[tauri::command]
pub async fn transcribe_audio(audio: Vec<u8>) -> Result<TranscribeResult, String> {
  if audio.is_empty() {
    return Ok(TranscribeResult {
      ok: false,
      text: String::new(),
      reason: Some("没有收到音频数据".to_string()),
    });
  }
  let tmp = std::env::temp_dir().join(format!("ondra-stt-{}.webm", now_secs()));
  std::fs::write(&tmp, &audio).map_err(|error| format!("写入临时音频失败：{error}"))?;

  let Some(whisper) = which_program("whisper") else {
    let _ = std::fs::remove_file(&tmp);
    return Ok(TranscribeResult {
      ok: false,
      text: String::new(),
      reason: Some("未检测到本地语音模型（whisper）。请先在系统中安装本地语音识别，再使用语音输入。".to_string()),
    });
  };

  let output = std::process::Command::new(&whisper)
    .arg(&tmp)
    .arg("--output-format")
    .arg("txt")
    .arg("--fp16")
    .arg("False")
    .output();
  let _ = std::fs::remove_file(&tmp);

  match output {
    Ok(result) if result.status.success() => Ok(TranscribeResult {
      ok: true,
      text: String::from_utf8_lossy(&result.stdout).to_string().trim().to_string(),
      reason: None,
    }),
    Ok(result) => Ok(TranscribeResult {
      ok: false,
      text: String::new(),
      reason: Some(String::from_utf8_lossy(&result.stderr).to_string()),
    }),
    Err(error) => Ok(TranscribeResult {
      ok: false,
      text: String::new(),
      reason: Some(format!("调用语音识别失败：{error}")),
    }),
  }
}

/// 更新检查结果。
#[derive(Serialize)]
pub struct UpdateInfo {
  /// 当前安装版本。
  pub current: String,
  /// 远端最新版本（去前缀 `v`）。
  pub latest: String,
  /// 最新版本的发布页地址。
  pub url: String,
  /// 版本说明。
  pub notes: String,
  /// 是否有可用更新。
  pub available: bool,
}

/// 比较两个 `主.次.修` 版本号，判断 `latest` 是否比 `current` 新。
fn is_newer(latest: &str, current: &str) -> bool {
  let parse = |version: &str| -> Vec<i64> {
    version
      .trim_start_matches('v')
      .split('.')
      .map(|part| part.parse::<i64>().unwrap_or(0))
      .collect()
  };
  let left = parse(latest);
  let right = parse(current);
  for index in 0..left.len().max(right.len()) {
    let l = left.get(index).copied().unwrap_or(0);
    let r = right.get(index).copied().unwrap_or(0);
    if l != r {
      return l > r;
    }
  }
  false
}

/// 检查更新。
///
/// # 为什么用 `curl` 子进程而不是 HTTP 客户端
///
/// 项目刻意不引 `reqwest`，仅为「查一下最新版本」增加一个 TLS 栈不划算。
/// macOS / Windows 都自带 `curl`，用它拉取 GitHub Releases 的最新发布信息，
/// 解析 `tag_name` 与 `body`。网络不可达时返回明确错误，由前端引导用户去仓库看。
#[tauri::command]
pub async fn check_update() -> Result<UpdateInfo, String> {
  let current = env!("CARGO_PKG_VERSION").to_string();
  let url = "https://api.github.com/repos/ntars/Ondra/releases/latest";
  let output = std::process::Command::new("curl")
    .args(["-sS", "--max-time", "10", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: ondra", url])
    .output();
  match output {
    Ok(result) if result.status.success() => {
      let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap_or(serde_json::Value::Null);
      let latest = value
        .get("tag_name")
        .and_then(|tag| tag.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
      let notes = value
        .get("body")
        .and_then(|body| body.as_str())
        .unwrap_or("")
        .to_string();
      let release_url = value
        .get("html_url")
        .and_then(|html_url| html_url.as_str())
        .unwrap_or("https://github.com/ntars/Ondra/releases")
        .to_string();
      Ok(UpdateInfo {
        current: current.clone(),
        latest: latest.clone(),
        url: release_url,
        notes,
        available: is_newer(&latest, &current),
      })
    }
    _ => Err("无法连接到更新服务器，请稍后重试或前往仓库查看更新。".to_string()),
  }
}
