# ondra-plugins · 插件管理（合并版）

只做四件事：**导入、安装、卸载、导出**。不碰插件跑起来之后的行为。
插件目录分布在四个分类下，所以每条记录都带 `root`，卸载时才知道删哪一份。

## 对外

`ctx.plugins`：`list()` / `counts()` / `inspect(pkg, root)` / `install(pkg, root)` /
`uninstall(id)` / `export(id)`。

## 规则

| 分类 | 可关闭 | 可卸载 |
|---|---|---|
| `ondra-core` | 否 | 否 |
| `ondra-extensions` | 是 | 是 |
| `dsh-base` | 否 | 否 |
| `ondra-custom` | 是 | 是 |

- 导入前校验 id 形状与包是否已校验；未校验的包默认拒收（设置里可放宽）。
- 卸载前可选备份（`keepBackup`）。
- 导出只打包插件本体，不带运行数据。

## 与 ondra-transfer 的分工

`ondra-transfer` 管**数据**（记忆 / 人设 / 配置），本插件管**插件**。
两边的导入导出互不覆盖，别混在一起。

## 页面

`ui/plugins_page.dart` 按**五个位置**归档（与目录一一对应）：应用核心 `cordis/`、
核心插件 `ondra-core/`、对话内核 `dsh-base/`、扩展插件 `ondra-extensions/`、
自定义插件 `ondra-custom/`。空分类也列出来，写「暂无插件」——它回答「装进来的东西
会落在哪」。

图标统一用空谷应用图标（`assets/icons/plugin.svg`，取自插件包 `icon.svg`）；
`dsh-base` 那一行用 dsh 官方图标（`assets/icons/dsh.png`），一眼能区分上游与自家。
