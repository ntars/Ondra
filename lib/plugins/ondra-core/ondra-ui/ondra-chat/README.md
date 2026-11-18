

## 传输层（stdio sidecar）

`ui/transport/` 是这条链路的全部实现，按上游 `dsh-sdk-protocol` 的线格式来：

| 项 | 值 |
|---|---|
| 启动 | `dsh --profile sdk-minimal`（可用 `ONDRA_DSH_BIN` 指定路径） |
| 分帧 | 按换行分帧的 JSON-RPC 2.0；带 `id`+`method` 是请求，只有 `id` 是响应，只有 `method` 是通知 |
| 初始化 | `initialize { cwd, provider, model }` |
| 发送 | `session/prompt { sessionId, contentBlocks: [{type:'text', text}] }` |
| 增量 | `session.event` 通知；文本取 `text` / `delta` / `content[]`，`turn/end` 作为一轮结束 |
| 兜底 | 30 秒没有 `turn/end` 就自己收尾，避免界面永远停在「正在生成」 |

Web 端没有子进程，`stdio_transport_stub.dart` 如实报「浏览器预览无法启动本机进程」；
桌面构建走 `stdio_transport_io.dart`。条件导出在 `stdio_transport.dart`。

编解码与事件解码在 `rpc_frames.dart`，脱离进程可测（`test/rpc_frames_test.dart` 5 条）。

## 实测记录（2026-11-17）

本机装 `@deepseek-ai/dsh@0.2.2-rc.1` 后跑 `test/dsh_sidecar_test.dart`，硬件链路已验证：

1. `initialize {cwd, provider: 'deepseek-official', model: 'deepseek-chat'}` → 返回
   `{serverInfo: {name: 'deepseek-harness-sdk-runtime', version: '0.0.1'}}`；
2. `session/prompt` 能拿到回执，随后 `session.event` 到达、流在 2 秒内正常闭合。

**踩到的坑（已修）**：直接用默认 `DSH_HOME` 会报
`session artifact … uses .jsonl.zstd, but this backend is configured for …` ——
桌面端的会话库是压缩格式，SDK profile 写未压缩 JSONL，共用一个目录必冲。
现在起进程时注入独立 `DSH_HOME`（默认 `~/.ondra/dsh`，可用 `ONDRA_DSH_HOME` 覆盖）。

**另一处（已修）**：`send()` 原来在未监听的 `StreamController` 上 `await close()`，
会永久挂起；改成 `events.stream.timeout(30s, onTimeout: close)` + `finally` 收尾。

**未验证**：真的生成文字。本机没有 `DEEPSEEK_API_KEY`，模型调用会失败；
设置该变量后右栏即可看到逐字输出。
