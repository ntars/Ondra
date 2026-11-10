//! 宿主子进程的生命周期管理。
//!
//! # 为什么壳要管住宿主的生命周期
//!
//! 宿主是壳拉起的子进程。若壳退出而宿主还活着，它会继续占内存、占端口，
//! 且用户看不到任何窗口——这类"幽灵进程"是桌面应用最常见的投诉来源之一。
//! 因此这里做三件事：
//!
//! 1. **启动时绑定父子关系**：宿主通过 stdin 的 EOF 感知壳退出，自行收尾。
//! 2. **退出时主动等待**：先关 stdin 触发优雅退出，超时才强杀。
//! 3. **异常时不静默**：宿主异常退出要留下原因，供界面展示。
//!
//! # 为什么用 stdio 而不是端口通信
//!
//! 端口需要处理冲突与鉴权，而 stdio 天然绑定生命周期、天然只对父子可见。
//! 代价是无法跨机，桌面应用不需要。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// 宿主就绪后上报的信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostReady {
    /// 宿主 HTTP 服务地址，形如 `http://127.0.0.1:64158`。
    pub url: String,
    /// 访问令牌。壳把它注入页面，前端请求时带上。
    pub token: String,
    /// 实际监听端口。
    pub port: u16,
}

/// 壳与宿主之间的一条消息。
///
/// 用 `#[serde(tag = "type")]` 而不是数字枚举：JSON 里出现 `"ready"` 这样的
/// 可读字符串，出问题时能直接看懂日志，不必查码表。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostMessage {
    /// 宿主已启动并能接受请求。
    Ready(HostReady),
    /// 宿主启动失败。
    ///
    /// 只带可读消息，不含堆栈：堆栈里可能有本机路径，而界面不需要它。
    Fatal { message: String },
}

/// 宿主当前状态。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum HostState {
    /// 尚未启动。
    Idle,
    /// 正在启动。
    Starting,
    /// 已就绪，携带连接信息。
    Ready(HostReady),
    /// 启动或运行中失败。
    Failed { message: String },
}

/// 宿主管家。
///
/// 用 `Arc<Mutex<_>>` 而非全局单例：单例在测试里无法隔离，
/// 而这里的状态只有"一个子进程 + 一份就绪信息"，加锁开销可以忽略。
pub struct HostManager {
    /// 子进程句柄。就绪后仍需保留，以便退出时关闭。
    child: Mutex<Option<Child>>,
    /// 当前状态。
    state: Mutex<HostState>,
    /// 宿主入口脚本路径。
    entry: PathBuf,
    /// Node 可执行文件路径。
    node: PathBuf,
}

impl HostManager {
    /// 创建管家。
    ///
    /// # 参数
    ///
    /// * `entry` — 宿主入口脚本（`cordis-host/index.js` 的绝对路径）。
    /// * `node` — Node 可执行文件。
    pub fn new(entry: PathBuf, node: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            child: Mutex::new(None),
            state: Mutex::new(HostState::Idle),
            entry,
            node,
        })
    }

    /// 读取当前状态。
    pub async fn state(&self) -> HostState {
        self.state.lock().await.clone()
    }

    /// 启动宿主并等待它就绪。
    ///
    /// # 为什么需要超时
    ///
    /// 宿主若因配置错误卡在启动流程，没有超时的话界面会永远停在加载态，
    /// 用户既看不到原因也无法重试。
    ///
    /// # 返回
    ///
    /// 成功时返回就绪信息；失败时返回可读原因。
    pub async fn start(self: &Arc<Self>) -> Result<HostReady, String> {
        {
            let mut state = self.state.lock().await;
            // 已在运行则直接返回现有信息，避免重复拉起第二个内核。
            if let HostState::Ready(ready) = state.clone() {
                return Ok(ready);
            }
            *state = HostState::Starting;
        }

        let mut command = Command::new(&self.node);
        command
            .arg(&self.entry)
            // 管道三件套：stdout 是协议通道，stderr 是日志通道，
            // stdin 保持打开——关闭它等于告诉宿主"壳已经走了"。
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 不在 Windows 上弹控制台窗口。
            .creation_flags_no_window();

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let message = format!("无法启动宿主进程：{error}");
                *self.state.lock().await = HostState::Failed { message: message.clone() };
                return Err(message);
            }
        };

        // stderr 直接转发到壳的日志。不给它单独缓冲：
        // 宿主崩溃时最后几行往往就是原因，丢了就无从排查。
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[host] {line}");
                }
            });
        }

        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let message = "宿主进程没有 stdout，无法接收就绪信息".to_string();
                *self.state.lock().await = HostState::Failed { message: message.clone() };
                return Err(message);
            }
        };

        // 先保存句柄再等就绪：等待期间若失败，仍需要一个可杀的句柄。
        *self.child.lock().await = Some(child);

        match tokio::time::timeout(
            std::time::Duration::from_secs(20),
            Self::await_ready(stdout),
        )
        .await
        {
            Ok(Ok(ready)) => {
                *self.state.lock().await = HostState::Ready(ready.clone());
                Ok(ready)
            }
            Ok(Err(message)) => {
                self.kill().await;
                *self.state.lock().await = HostState::Failed { message: message.clone() };
                Err(message)
            }
            Err(_) => {
                let message = "宿主启动超时（20 秒）".to_string();
                self.kill().await;
                *self.state.lock().await = HostState::Failed { message: message.clone() };
                Err(message)
            }
        }
    }

    /// 从宿主的 stdout 读到就绪消息。
    ///
    /// 读到 `fatal` 立即失败；读到非 JSON 行则跳过——原生模块偶尔会往 stdout
    /// 打警告，为此判定失败会让启动无故失败。
    async fn await_ready(stdout: tokio::process::ChildStdout) -> Result<HostReady, String> {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<HostMessage>(&line) {
                        Ok(HostMessage::Ready(ready)) => return Ok(ready),
                        Ok(HostMessage::Fatal { message }) => {
                            return Err(format!("宿主报告启动失败：{message}"));
                        }
                        Err(_) => {
                            eprintln!("[shell] 忽略无法识别的宿主输出：{line}");
                        }
                    }
                }
                Ok(None) => {
                    return Err("宿主在报告就绪前退出了".to_string());
                }
                Err(error) => {
                    return Err(format!("读取宿主输出失败：{error}"));
                }
            }
        }
    }

    /// 停止宿主。
    ///
    /// 先关闭 stdin 触发优雅退出，等待 3 秒，仍未退出则强杀。
    /// 顺序不能反：直接强杀会让宿主来不及收尾，内存版会话数据会丢失。
    pub async fn stop(&self) {
        let mut guard = self.child.lock().await;
        let Some(mut child) = guard.take() else {
            return;
        };

        // 关闭 stdin 是"壳要走了"的信号，宿主据此自行收尾。
        drop(child.stdin.take());

        let waited = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await;
        if waited.is_err() {
            eprintln!("[shell] 宿主未在 3 秒内退出，强制结束");
            let _ = child.kill().await;
        }
        *self.state.lock().await = HostState::Idle;
    }

    /// 强制结束宿主，不做优雅等待。仅用于启动失败后的清理。
    async fn kill(&self) {
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
        }
    }
}

/// Windows 专用：阻止子进程弹出控制台窗口。
///
/// 用扩展 trait 而不是 `#[cfg]` 包住整段启动代码：调用处的写法在三个平台
/// 完全一致，条件编译只影响这个空实现，读代码时不必分平台理解流程。
trait CommandExt {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl CommandExt for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        // Windows 的 creation_flags 来自 std::os::windows::process::CommandExt，
        // 只在 Windows 目标下存在，因此导入也限定在条件编译内。
        use std::os::windows::process::CommandExt as _;
        // CREATE_NO_WINDOW = 0x08000000
        self.creation_flags(0x0800_0000)
    }
}

#[cfg(not(windows))]
impl CommandExt for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        self
    }
}
