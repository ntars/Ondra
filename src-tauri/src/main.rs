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

mod commands;
mod host;
mod preferences;
mod tray;
mod window;

use std::sync::Arc;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

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
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            commands::open_preferences,
            commands::close_preferences,
            commands::broadcast_preferences,
            commands::set_tray_muted,
        ])
        .on_window_event(|window, event| {
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
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用初始化失败")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // 退出前必须收掉宿主，否则会留下孤儿进程。
                // 这里用阻塞等待：退出流程本身是同步的，此刻再交回异步运行时
                // 已经来不及了。
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let host = state.host.clone();
                    tauri::async_runtime::block_on(async move { host.stop().await });
                }
            }
        });
}
