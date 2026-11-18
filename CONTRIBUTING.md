# 参与贡献

## 1. 开发环境

| 项 | 要求 |
|---|---|
| Flutter | 3.32+（Dart 3.14+） |
| Node.js | 18+（内核与插件） |
| Xcode | 完整安装（macOS 构建） |

```sh
git clone https://github.com/ntars/Ondra.git
cd Ondra && flutter pub get
flutter analyze && flutter test
```

## 2. 分支与提交

- `main` 保持可构建；改动走 `feat/<主题>` 或 `fix/<主题>`。
- 提交信息格式：`<type>(<scope>): <subject>`，type 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`，scope 取 `ui` / `plugin` / `core` / `design` / `docs`。
- 合并前须通过 `flutter analyze`、`flutter test`、`tool/typecheck_plugins.sh`。

## 3. 新增插件的约定

1. 目录名用 `ondra-` 前缀 + 连字符，Dart 文件名仍用 snake_case。
2. 目录内必须含 `plugin.json`（`id` / `layer` / `closable` / `owner` / `provides` / `depends`）与 README。
3. 依赖单向：`ui/` → 投影 → 插件服务；插件之间不互相 import 对方 `ui/`。
4. 需要重启才能生效的注册逻辑，必须挂在 `ctx.effect` 上，否则插件二次 apply 会撞「段键已登记」。
5. 第三方内核（`cordis`、`dsh-base`）保留官方名，不改名。

## 4. PR 自查清单

- [ ] 提交信息符合格式
- [ ] `flutter analyze` 无新增问题
- [ ] `flutter test` 全通过
- [ ] 插件源码通过 `tool/typecheck_plugins.sh`
- [ ] 界面改动无写死色值与字号，全部走 `lib/design/`
- [ ] 空态如实显示「没有数据」，不摆示例条目
- [ ] 新增依赖已同步 `NOTICE`

## 5. 行为准则

参与本项目即表示同意 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
