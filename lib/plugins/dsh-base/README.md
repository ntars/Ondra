# dsh-base · 对话内核

这里放 **DeepSeek Harness 内核**。官方命名查证结果：上游把「共享内核组合」叫
**`@deepseek-ai/dsh-base`**（`packages/bundle/base`，自述 "The shared dsh core as a
profile bundle"）——所以目录用 `dsh-base`，不用自造的 `dsh-core`。

- 抽取好的内核目前放在下载目录：`~/Downloads/dsh-kernel/`
  （50 个包 / 3.2MB 源码，含 `KERNEL.md` 调用链导读与同步脚本）。
- 迁入时**保持上游目录结构**（`packages/core/agent-loop/…`、包名 `@deepseek-ai/dsh-*`），
  不摊平、不改名，否则每次上游发版都要手工对 diff。
- 它不是 Dart 代码：作为本机 sidecar 运行，界面通过 JSON-RPC 调用
  （上游 `--profile sdk-minimal` 就是这条路径）。
- 接入工作由 `ondra-core/ondra-dsh/` 这个插件承担，界面不直接碰内核。
