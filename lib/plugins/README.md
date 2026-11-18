# 插件目录

**插件体系只有一套：[Cordis](https://github.com/cordiverse/cordis)。**
所有能力都是 Cordis 插件，跑在同一个运行时里；Flutter 界面是运行时客户端，不是插件宿主。
完整文件树见 [LAYOUT.md](LAYOUT.md)。

## 四个分类

| 目录 | 加载 | 可关闭 | 装什么 |
|---|---|---|---|
| `ondra-core/` | 随包默认 | 否 | 空谷核心插件（UI 全在 `ondra-ui/` 下） |
| `ondra-extensions/` | 随包默认 | 是 | 随包附带、可开关 |
| `dsh-base/` | 随包默认 | 否 | dsh 内核（官方名） |
| `ondra-custom/` | 运行时按需 | 是 | 用户自装（`dsh-xxx`） |

框架本体 `cordis/` 留在根下，不属于上述四类——它是宿主，不是插件。

## 命名

- 插件 id 与目录名：`ondra-` 前缀 + **连字符**（`ondra-persona`，不是下划线）。
- 第三方内核用官方名（`dsh-base`、`cordis`），不改名，便于跟上游一比一同步。
- 每个插件目录含 `plugin.json`（id / layer / closable / owner / provides / depends）。

## 谁的界面归谁

左栏一项 = 一个插件；右栏 = `ondra-chat`；设置 6 类 = `ondra-settings` 下的六个子插件。
`ondra-ui` 只负责「把注册表里的条目画出来」，不认识任何具体页面。

## 校验

```sh
tool/typecheck_plugins.sh   # 插件源码的类型自检（stub 版 cordis 声明）
flutter analyze && flutter test
```

`typecheck_plugins.sh` 检查的是**我们自己代码的自洽性**（导入、参数、空值），
不检查上游 cordis 的 API 签名——后者要等 dsh-base 工作区 `pnpm install` 有真实类型。
它已经抓出过两个真 bug：memory 的 settings 导错类型、chat 插件残留的旧代码块。
