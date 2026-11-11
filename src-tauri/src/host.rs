//! 宿主子进程的生命周期管理。
//!
//! # 为什么壳要管住宿主的生命周期
//!
//! 宿主是壳拉起的子进程。若壳退出而宿主还活着，它会继续占内存、占端口，
//! 且用户看不到任何窗口——这类"幽灵进程"是桌面应用最常见的投诉来源之一。
//! 因此这里做三件事：
//!
//! 1. **启动时绑定进程组**：宿主与它再拉起的 `dsh-sidecar` 同属一个组，
//!    退出时能整组收掉，不必逐个找。
//! 2. **退出时先礼后兵**：关 stdin 让宿主自己收尾，超时连同子进程一起强杀。
//! 3. **异常时不静默**：宿主异常退出要留下原因，供界面展示。
//!
//! # 为什么用 stdio 而不是端口通信
//!
//! 端口需要处理冲突与鉴权，而 stdio 天然绑定生命周期、天然只对父子可见。
//! 代价是无法跨机，桌面应用不需要。
//!
//! # 为什么必须有「进程组」
//!
//! 宿主不是叶子进程：它自己会 spawn 一个 Node 内核（`dsh-sidecar`）。
//! 只杀宿主，内核就成了孤儿——它继承了宿主打开的端口与管道，但父进程
//! 已经没了，于是它既不退出也没人管，正是用户看到的"退出后还有后台进程"。
//! 把宿主放进独立的进程组（`setpgid(0)`），组内所有后代都能一次 `kill(-pgid)`
//! 收掉。这是 POSIX 提供的唯一可靠办法，比按名字匹配进程安全得多。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI32, Ordering};
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
    /// 子进程组 id。
    ///
    /// Unix 上等于宿主的 pid（因为它被 `setpgid(0)` 设成组长），Windows 上
    /// 是 pid 本身（靠 `taskkill /T` 收树）。`0` 表示当前没有活着的宿主。
    ///
    /// 用 `AtomicI32` 而不是塞进 `child` 那把锁：退出流程是**同步**的，
    /// 而 `tokio::sync::Mutex` 只能在异步上下文里 await。等锁的那一下
    /// 就是用户感觉到的"退出卡了一秒"。
    group: AtomicI32,
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
            group: AtomicI32::new(0),
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

        /*
         * 独立进程组。
         *
         * `0` 表示"以自己为组长建一个新组"，于是宿主与它再 spawn 的
         * 内核共用一个 pgid。退出时 `kill(-pgid)` 一次收掉全组，
         * 不依赖任何进程名匹配。
         *
         * 不加这一句，宿主被 SIGKILL 后它拉起的 Node 内核会继续跑——
         * 那正是"退出后还有后台进程"的来源。
         */
        #[cfg(unix)]
        command.process_group(0);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let message = format!("无法启动宿主进程：{error}");
                *self.state.lock().await = HostState::Failed { message: message.clone() };
                return Err(message);
            }
        };

        // 记下进程组 id。Unix 上 spawn 时已 `setpgid(0)`，进程组 id 就是
        // 子进程 pid；Windows 上 `taskkill /T` 认 pid。
        if let Some(pid) = child.id() {
            self.group.store(pid as i32, Ordering::SeqCst);
        }

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
    /// 顺序：关 stdin 触发优雅退出 → 等 1.2 秒 → **整组**收掉。
    ///
    /// # 为什么最后一步是整组而不是只 kill 宿主
    ///
    /// 宿主自己会 spawn 内核进程。只杀宿主，内核会活下来并继续占着端口——
    /// 用户看到的就是"退出了还有 node 在跑"。整组收掉才能保证零残留。
    ///
    /// # 为什么等待从 3 秒收到 1.2 秒
    ///
    /// 3 秒是给"优雅收尾"留的余量，而实测宿主收尾在 200ms 内完成。
    /// 用户点退出时多等的那 2.8 秒没有任何收益，只是把退出读成卡死。
    pub async fn stop(&self) {
        let mut guard = self.child.lock().await;
        let Some(mut child) = guard.take() else {
            self.group.store(0, Ordering::SeqCst);
            return;
        };

        // 关闭 stdin 是"壳要走了"的信号，宿主据此自行收尾。
        drop(child.stdin.take());

        let waited = tokio::time::timeout(std::time::Duration::from_millis(1200), child.wait()).await;
        if waited.is_err() {
            eprintln!("[shell] 宿主未在 1.2 秒内退出，强制结束整组");
            let _ = child.kill().await;
        }

        // 无论宿主是否优雅退出，都再收一次整组：优雅退出不代表它拉起的
        // 内核也退了（内核只认自己的 stdin，而那个 fd 由宿主持有）。
        let group = self.group.swap(0, Ordering::SeqCst);
        terminate_group(group);

        *self.state.lock().await = HostState::Idle;
    }

    /// 退出流程专用的**同步**收尾。
    ///
    /// # 为什么它必须是同步的
    ///
    /// 它跑在 `RunEvent::ExitRequested` 里，那一刻主线程正在推进退出流程，
    /// 不能再 await（`block_on` 会把整个事件循环卡住——旧实现就是这样，
    /// 用户点退出后窗口僵住 3 秒）。
    ///
    /// # 为什么先 TERM 再 KILL
    ///
    /// SIGTERM 给 Node 一个跑 `exit` 钩子的机会（落盘会话、关库）；
    /// 120ms 后还在的，说明它不打算配合，SIGKILL 兜底。总耗时约 120ms，
    /// 用户感觉不到。
    pub fn terminate(&self) {
        let group = self.group.swap(0, Ordering::SeqCst);
        terminate_group(group);
    }

    /// 强制结束宿主，不做优雅等待。仅用于启动失败后的清理。
    async fn kill(&self) {
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
        }
        let group = self.group.swap(0, Ordering::SeqCst);
        terminate_group(group);
    }
}

/// 收掉一个进程组（Unix）或进程树（Windows）。
///
/// `group == 0` 时什么都不做：没有活着的宿主，或者已经被收过了。
/// 收两次是安全的——第二次 `kill` 只会返回 ESRCH。
fn terminate_group(group: i32) {
    if group <= 0 {
        return;
    }

    #[cfg(unix)]
    {
        // 负 pid = 对整个进程组发信号。
        unsafe {
            libc::kill(-group, libc::SIGTERM);
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    {
        // Windows 没有进程组信号，用 taskkill 的 /T 收整棵树。
        // /F 是强杀：默认的关闭消息会被无窗口的 Node 进程忽略。
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &group.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
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
