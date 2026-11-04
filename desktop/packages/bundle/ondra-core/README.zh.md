---
description: "空谷 Ondra 人格组合包：133 个 cordis 人格侧插件叠成一个可安装的 patch 层，叠加在宿主 profile 之上。"
kind: "package-bundle"
---

# @ntars/ondra-core

中文 | [English](README.md)

## 概述

`@ntars/ondra-core` 把空谷 Ondra 的人格侧插件全集——身份、路径布局、记忆、人格、情绪、聊天通道、端侧、交付——作为一个单独的 patch 层安装进 `ondra --profile`。包的本体是 `cordis.patch.yml`（由 `ondra.bundle.patch` 清单字段声明）：一次 `insert` 追加 133 行，按插件 id 作键。行序不承载加载语义，激活由服务可用性驱动。依赖外部凭据的两个聊天通道适配器（`ondra-adapter-qq-official`、`ondra-adapter-qq-napcat`）出厂置 `disabled: true`，由后续 patch 层或用户自己的 profile patch 打开（同一行按最后写入为准）。

你通常不直接操作本包。把它加进 profile 即可：在 profile 的组合包列表里引用包名，启动器会把 133 个插件作为宿主树的 workspace 成员（`../cordis/*`）链接进来，并按清单解析。本包不是供导入的库。

## 你会得到什么

- 横跨九层（L0 身份 → L9 扩展池）的 133 个插件，每个都有自己的 `cordis.patch.yml`、locale 文件，服务键闭合已验证（0 悬空、0 多归属）。
- 两个 QQ 通道适配器在列但 `disabled`，直到凭据就绪。
- 无运行时 API：模块是空 stub，组合包只做 patch。

## 修改默认值

每一行都可以被后续 patch 层或用户的 profile `cordis.patch.yml` 覆盖：按 `id` 重写该行、给出想要的 `config`（或 `disabled`）。patch 替换目标行的整个 `config`，而不是合并。
