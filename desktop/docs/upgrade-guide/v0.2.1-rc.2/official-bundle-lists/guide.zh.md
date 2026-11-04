---
kind: upgrade-guide
description: "组合包列表和 profile 模板从 @ntars/ondra-app-boot 移至 @ntars/ondra-official-bundles。"
---

# 从 `@ntars/ondra-official-bundles` 导入组合包列表

[English](guide.md) | 中文

## 变更

`@ntars/ondra-app-boot` 不再导出 `PROFILE_TEMPLATES`、`ProfileTemplate`、`DEFAULT_PROFILE_BUNDLES`、`OPTIONAL_BUNDLES`、`ON_DEMAND_BUNDLES`、`OFFICIAL_ON_DEMAND_CATALOG` 和 `OfficialBundleCatalogEntry`。新发布的包 `@ntars/ondra-official-bundles` 导出它们，值和类型不变。从 `@ntars/ondra-app-boot` 导入这些名称的代码将无法编译或加载。`ondra` 启动器、profile 和组合包选择的行为不变。

## 迁移

1. 在每个导入这些名称的包的 `dependencies` 中加入 `@ntars/ondra-official-bundles`。
2. 把这些导入从 `@ntars/ondra-app-boot` 改为 `@ntars/ondra-official-bundles`，例如 `import { PROFILE_TEMPLATES } from '@ntars/ondra-official-bundles'`。其他名称（如 `initProfile` 或 `loadProfile`）仍从 `@ntars/ondra-app-boot` 导入。
3. 运行类型检查或构建；不再有从 `@ntars/ondra-app-boot` 导入已移动名称的代码时即通过。各列表的说明见[包 README](../../../../packages/util/official-bundles/README.zh.md)。
