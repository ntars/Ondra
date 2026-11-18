# ondra-core · 核心插件

放**不可关闭、不可卸载、随包默认加载**的插件。装配在 `main.dart`，没有开关。

- 目录名 = 插件 id，`ondra-` 前缀 + 连字符（`ondra-persona`）。
- 每个插件是一个 Cordis 插件：导出 `apply(ctx)`，用 `ctx.provide/inject` 交互。
- 不允许依赖 `lib/modules/`——依赖方向永远是插件 → 界面，不是反过来。
