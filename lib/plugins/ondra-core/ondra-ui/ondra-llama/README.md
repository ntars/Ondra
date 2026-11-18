# ondra-llama · 本地模型

用 **llama.cpp** 在本机跑大模型：下载 GGUF、启动 `llama-server`、看日志、停掉。
模型基座里「本地部署」那一类的能力由这个插件提供，界面只有一段面板。

## 做什么

| 能力 | 实现 |
|---|---|
| 找 `llama-server` | 登录 shell → 常见安装位置（`/opt/homebrew/bin`、`/usr/local/bin`） |
| 模型目录 | `~/.ondra/models`（不存在就建） |
| 下载 GGUF | HTTP 直下，进度条；先写 `.part` 再改名，中断不留半截模型 |
| 启动 | `llama-server -m <gguf> --host 127.0.0.1 --port 8080 -c 8192 -ngl 999` |
| 就绪判定 | 轮询 `/v1/models`，能列出模型才算加载完（最多等 48 秒） |
| 停止 | `Process.kill()`，退出码写回日志行 |

服务就绪后把 `http://127.0.0.1:<port>/v1` 回填到 provider 的地址，模型基座立刻可用。

## 为什么不放在 Cordis 运行时

拉起子进程是**平台能力**（`dart:io`），运行时是 Node。两边都能做时选离用户近的一侧：
少一层转发，日志与退出码直接可读。`src/index.ts` 保留同一套约束（端口、上下文、
GPU 层数）与 `args()`/`endpoint()`/`status()`，运行时接通后可以接管，界面不用改。

## 前提

```sh
brew install llama.cpp     # 提供 llama-server
```

没装时面板会写「没找到，brew install llama.cpp」，不会假装能用。

## 不做

- 不内置模型：GGUF 由用户自己下载与保管（体积大、许可各异，空谷不代持）。
- 不做模型市场/推荐：预置一份「推荐列表」等于替用户做选择，且很快过期。
- 不改模型基座的配置：地址回填由界面完成，插件只报事实。
