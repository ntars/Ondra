//! 空谷 Ondra 桌面壳入口。
//!
//! # 这一层只做三件事
//!
//! 1. 开窗口、把前端页面加载进来。
//! 2. 拉起并看住 Cordis 宿主子进程。
//! 3. 把"只有操作系统才做得了的事"（选文件、开链接、窗口标题）暴露成命令。
//!
//! 业务逻辑一律不在这里。判断标准很简单：**如果这段逻辑在没有窗口的环境下
//! 也说得通，它就不属于壳**——那属于宿主。

// 在非测试构建里隐藏 Windows 的控制台窗口（release 打包时不弹黑框）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod commands;
mod host;
mod tray;
mod window;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};

use host::HostManager;

/// 壳持有的全局状态。
pub struct AppState {
    /// 宿主管家。命令层与退出钩子共用同一个实例。
    pub host: Arc<HostManager>,
    /// 托盘本体。
    ///
    /// 留着它是为了**寿命**，不是为了调用：`TrayIcon` 一被 drop，图标就
    /// 从菜单栏消失。托盘创建失败（Linux 无 StatusNotifier）时为 `None`。
    pub tray_icon: Option<tauri::tray::TrayIcon<tauri::Wry>>,
    /// 托盘里「静音 1 小时」那一项的手柄。改文案靠它。
    pub mute_item: Option<Arc<tray::MuteItem<tauri::Wry>>>,
    /// 待处理的深度链接（`ondra://…`）。
    ///
    /// 系统可能在窗口还没加载完页面时就把链接递进来（冷启动点链接必定如此），
    /// 那时前端还没有注册监听，事件发出去就是石沉大海。所以这里先攒着，
    /// 等前端就绪后主动取一次（`take_deep_links`），之后的事件照常走监听。
    pub deep_links: std::sync::Mutex<Vec<String>>,
}

/// 退出前的同步收尾。
///
/// # 为什么是同步的
///
/// 它被两条路调用：`window::quit()`（用户在确认框里选「退出」）与
/// `RunEvent::ExitRequested`（系统让他退出，比如 `Cmd+Q`、注销、关机）。
/// 后者发生的那一刻主线程已经在推进退出流程，再 `block_on` 一个异步
/// 关闭就等于把事件循环按住——旧实现正是这样，用户点退出后窗口僵住
/// 三秒才消失。
///
/// 这里改走 `HostManager::terminate()`：SIGTERM → 120ms → SIGKILL，
/// 整组收，总耗时约 120ms。重复调用是安全的（进程组 id 已被换出）。
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    state.host.terminate();
}


fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        /*
         * 系统通知插件（§12.10）。
         *
         * 它除了提供 Rust 侧的 `NotificationExt`，还会往页面注入两层：
         * `init-iife.js` 把 `window.Notification` 换成一个走 IPC 的实现，
         * `api-iife.js` 挂上 `__TAURI__.notification`。前端因此可以用
         * 标准 Web API 发通知，不必为它再造一条自定义命令。
         */
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // 宿主与 Node 都在开发态目录下；打包后由 Tauri 的资源目录提供。
            // 两者分开解析而不是硬编码，是为了让开发与安装后走同一段代码。
            let layout = commands::ProjectLayout::resolve()?;
            let manager = HostManager::new(layout.host_entry.clone(), layout.node_path.clone());

            // 每次启动都强制回到 820×580：它同时是默认尺寸与最小尺寸。
            // 即使用户上次把窗口拖大，这一版也只认这一个尺寸——
            // "无论用户调成多少，每次启动都是这么大"的要求由这里兜底。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(820.0, 580.0))));
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(820.0, 580.0)));

                // 红绿灯改由前端自绘（§2.4）：先把系统那三个藏掉，否则会叠在
                // 自绘圆点下面，出现"两对按钮"。
                //
                // 只处理主窗口：内置浏览器窗口（`browser.rs`）要的是系统原生
                // 三个按钮，一起藏掉它就没法关了。
                window::hide_system_traffic_lights(&window);
            }

            // 在后台启动宿主，不阻塞窗口显示。
            // 界面先出来再等宿主，用户看到的是"正在连接"而不是"白屏很久"。
            let app_handle = handle.clone();
            let manager_for_host = manager.clone();
            tauri::async_runtime::spawn(async move {
                match manager_for_host.start().await {
                    Ok(ready) => {
                        // 把访问信息交给前端：前端据此发请求。
                        let _ = app_handle.emit("host-ready", ready);
                    }
                    Err(message) => {
                        eprintln!("[shell] 宿主启动失败：{message}");
                        let _ = app_handle.emit("host-failed", message);
                    }
                }
            });

            /*
             * 托盘。失败不致命：主窗口还能用，只是关闭语义降级为最小化
             * （Linux 上 GNOME 没装 StatusNotifier 扩展时会发生）。
             *
             * ## 为什么先建托盘再 `manage`
             *
             * `app.manage()` 每个类型只能调一次，第二次会 panic。托盘要
             * 贡献一个字段（静音菜单项的手柄），所以它必须先建好，再和宿主
             * 一起装进同一个 `AppState`。
             *
             * ## 托盘本体为什么要留着
             *
             * `TrayIcon` 不是可以被随意丢弃的句柄：它一被 drop，图标就从
             * 菜单栏消失（Windows 与部分 Linux 上是这样，macOS 表现为
             * 菜单不再更新）。留它在状态里，寿命与进程一致。
             */
            let (tray_icon, mute_item, tray_ok) = match tray::create(&handle) {
                Ok((tray, mute)) => (Some(tray), Some(Arc::new(mute)), true),
                Err(error) => {
                    eprintln!("[shell] 托盘创建失败，关闭行为降级为最小化：{error}");
                    (None, None, false)
                }
            };
            window::set_tray_available(tray_ok);

            app.manage(AppState {
                host: manager,
                tray_icon,
                mute_item,
                deep_links: std::sync::Mutex::new(Vec::new()),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_host_state,
            commands::restart_host,
            commands::pick_files,
            commands::reveal_in_folder,
            commands::get_theme,
            commands::set_window_title,
            commands::resolve_close,
            commands::show_main_window,
            commands::open_log_dir,
            commands::set_tray_muted,
            commands::open_browser,
            commands::save_export,
            commands::open_import,
            commands::app_data_path,
            commands::open_settings_pane,
            commands::backup_create,
            commands::backup_list,
            commands::backup_restore,
            commands::kb_list,
            commands::kb_upsert,
            commands::kb_delete,
            commands::providers_list,
            commands::providers_upsert,
            commands::providers_remove,
            commands::transcribe_audio,
            commands::check_update,
            commands::take_deep_links,
        ])
        .on_window_event(|window, event| {
            /*
             * 系统红绿灯的运行时兜底（§2.4）。
             *
             * `setHidden(true)` 是持久属性，但两件事会绕过它：新建窗口在
             * 登记进 `NSApp.windows()` 之前漏掉一次，以及 macOS 切换全屏、
             * 系统重新布局标题栏时可能重建按钮容器。
             *
             * 因此挑两个窗口生命周期里必然会发生的事件再收一遍。三个按钮的
             * 开销是微秒级，换来的是「任何时刻都不会露出第二对红绿灯」。
             *
             * 只认主窗口：内置浏览器窗口用的是系统红绿灯，藏掉它就关不掉了
             * ——那正是上一版遍历 `NSApp.windows()` 时踩到的坑。
             */
            let relayout = match event {
                WindowEvent::Focused(true) => true,
                WindowEvent::Resized(_) => true,
                _ => false,
            };
            if relayout && window.label() == "main" {
                window::hide_system_traffic_lights(window);
            }

            /*
             * 内置浏览器的工具栏注入不在这里做。
             *
             * `tauri::WindowEvent` 没有 `PageLoad` 变体（它属于 Webview 事件），
             * 而 `tauri::Window` 也没有 `eval`。工具栏改在 `browser.rs` 创建窗口时
             * 用 `WebviewWindowBuilder::on_page_load` 注册，那里拿到的是
             * `WebviewWindow`，可以 `eval`，也天然只作用于浏览器窗口。
             */

            /*
             * 关闭不是退出（§2.1、§2.7）。
             *
             * 这里不直接 `exit`：交给 `window::intercept_close` 判断
             * 该隐藏、该最小化、还是该问一次用户。它返回 true 表示
             * 已经自己处理完了，我们只要把窗口留在原地即可。
             *
             * `api.prevent_close()` 必须无条件调用——它阻止的是这一次
             * 系统级的销毁，之后的去留由我们决定。不调它，窗口在
             * 判断完成前就已经没了。
             */
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window::intercept_close(window.app_handle()) {
                    api.prevent_close();
                }
            }

            /*
             * 最小化与恢复也要广播（§12.10 系统通知的判据）。
             *
             * `intercept_close` 覆盖了「点关闭」与「托盘降级」两条路，
             * 但用户还可以按 macOS 的黄键、Windows 的最小化键——那条路
             * 不经过我们的命令，只在这里能看到。少了这两种情况，
             * 用户最小化之后她就再也不说话了（前端以为窗口还在）。
             *
             * 只认主窗口：偏好设置窗口最小化不代表她看不见用户。
             */
            if window.label() == "main" {
                match event {
                    WindowEvent::Resized(_) => {
                        // 最小化在 Tauri 里表现为 Resized（尺寸变成 0 或
                        // 系统的收起尺寸），没有独立的 Minimized 事件。
                        // 用 `is_minimized()` 现查，比猜尺寸可靠。
                        if let Ok(minimized) = window.is_minimized() {
                            if minimized {
                                window::emit_visibility(window.app_handle(), false);
                            }
                        }
                    }
                    WindowEvent::Focused(true) => {
                        // 重新获得焦点：先确认它不是最小化态（点 Dock 图标
                        // 会先 focus 再 unminimize，中间那一帧不能算可见）。
                        if let Ok(minimized) = window.is_minimized() {
                            if !minimized {
                                window::emit_visibility(window.app_handle(), true);
                            }
                        }
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用初始化失败")
        .run(|app_handle, event| {
            /*
             * 深度链接（G8）。外部以 `ondra://...` 唤起时，macOS 把 URL 交给
             * 进程并触发 `RunEvent::Opened`。把它原样转给前端：前端按路径
             * 打开对应设置页或会话。协议本身已在 `tauri.conf.json` 的
             * `CFBundleURLTypes` 中登记。
             *
             * ## 为什么用 emit 而不是让壳直接改状态
             *
             * 链接能指向「设置·某页」「某会话」等只有前端才懂的目标。
             * 壳只负责把 URL 交出去，路由逻辑留在前端——与「业务逻辑在宿主、
             * 壳只做 OS 边界」的分工一致。
             */
            /*
             * `RunEvent::Opened` 只在 macOS / iOS 上存在——Windows 与 Linux
             * 的 Tauri 根本没有这个变体（协议唤起在那边走单实例插件）。
             * 不加 `cfg` 时 Linux 与 Windows 编译直接报 E0599：
             * `no variant named Opened found for enum RunEvent`。
             */
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let RunEvent::Opened { urls } = &event {
                for url in urls {
                    let text = url.to_string();
                    /*
                     * 两条路都走：先入队，再广播。
                     *
                     * 冷启动时前端还没注册监听，广播会丢——入队让它在就绪后
                     * 取得到；已经在运行时前端早已注册，广播即时生效，不必
                     * 等下一次轮询。前端取走即清空，因此不会重复触发。
                     */
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        if let Ok(mut pending) = state.deep_links.lock() {
                            pending.push(text.clone());
                        }
                    }
                    let _ = app_handle.emit("deep-link", text);
                }
            }

            if let RunEvent::ExitRequested { .. } = event {
                /*
                 * 退出前必须收掉宿主与它拉起的整组进程，否则会留下孤儿。
                 *
                 * ## 为什么这里不再 `block_on(host.stop())`
                 *
                 * 那是上一版的做法，也是"点退出会卡一会儿"的来源：
                 * `block_on` 会按住主线程，窗口在那一刻已经不再重绘，
                 * 用户看到的是应用僵住三秒才消失。
                 *
                 * `shutdown` 走同步信号（TERM → 120ms → KILL），整组一次收掉。
                 * 在 `quit()` 里已经收过一次，这里再来一次是幂等空操作——
                 * 但 `Cmd+Q` 与注销走的是这条路，不经过我们的命令，所以两处都要有。
                 */
                shutdown(app_handle);
            }
        });
}
