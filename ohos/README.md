# HarmonyOS 工程（待生成）

这个目录目前只有说明，没有工程文件。原因很简单：`ohos/` 必须由
**OpenHarmony SIG 的 Flutter 移植版**生成，手写会与 hvigor 的校验对不上。

```bash
# 用移植版 SDK 打开一个终端（不要与官方 SDK 共用 PATH）
git clone -b oh-3.22.0 https://gitee.com/openharmony-sig/flutter_flutter.git ~/development/flutter_ohos
export PATH=~/development/flutter_ohos/bin:$PATH

cd /Users/ntars/Github/Ondra
flutter create --platforms ohos .
flutter build hap --release
```

生成后本目录会出现：

```
ohos/
├─ AppScope/app.json5          应用级配置（包名、图标、版本）
├─ entry/                      主模块：EntryAbility + Index 页
├─ hvigor/                     构建脚本配置
├─ build-profile.json5         构建产物与签名
└─ oh-package.json5            依赖清单
```

注意两点：

1. **生成物要提交**。`ohos/` 是工程骨架，不是缓存；`build/`、`oh_modules/`、
   `.hvigor/` 已在根 `.gitignore` 里排除。
2. **Dart 代码不需要改**。本仓库没有平台插件，`lib/` 在七个端上是同一份；
   将来引入插件时，先确认它在 `flutter_packages` 的 OHOS 分支里有实现。

完整的平台矩阵与工具链要求见 [`../docs/platforms.md`](../docs/platforms.md)。
