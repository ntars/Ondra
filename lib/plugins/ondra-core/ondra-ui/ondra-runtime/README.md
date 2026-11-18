# ondra-runtime · 运行时守护（合并版）

旧版 process-host / sandbox / port-picker / startup-check / install-doctor / installer
六个包，新版一个：这些判断必须一起看。

## 对外

`ctx.runtime`：`state()` / `begin()` / `ready()` / `fail()` / `check(status, ms)` / `port()`。

## 状态机

`idle → starting → ready`，失败按 `backoffMs × 2^(n-1)` 退避；
超过 `maxRestarts` 停在 `failed`，不再自动重试（自动重试到无限是最糟的行为）。

## 分工

状态机在这里（可测），真正 spawn 进程在平台层（`ondra-flutter` 的 `runtime` 服务）。
