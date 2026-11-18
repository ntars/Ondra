# 平台支持

空谷 2.0 的目标是**一套 Dart 代码，七个端**。当前骨架不含任何平台插件
（没有相机、蓝牙、窗口管理、文件选择等原生依赖），所以画面与交互在七个端上完全一致，
差异只存在于「窗口外壳」和「输入方式」。

| 端 | 目录 | 状态 | 构建命令 | 工具链要求 |
|---|---|---|---|---|
| Android | `android/` | 已生成 | `flutter build apk --release` | Android SDK 35+、JDK 17 |
| iOS | `ios/` | 已生成 | `flutter build ios --release` | Xcode 16+、CocoaPods |
| Windows | `windows/` | 已生成 | `flutter build windows --release` | VS 2022 + Desktop C++ |
| macOS | `macos/` | 已生成 | `flutter build macos --release` | Xcode 16+（仅有 CLT 不可用） |
| Linux | `linux/` | 已生成 | `flutter build linux --release` | clang、ninja、GTK3 开发包 |
| Web | `web/` | 已生成 | `flutter build web --release` | 无 |
| HarmonyOS | `ohos/` | **待生成** | `flutter build hap --release` | 社区 OHOS Flutter SDK（见下） |

版本基线：**Flutter 3.50.0 stable / Dart 3.14.0**，全部依赖取最新正式版，
不使用 beta / rc / dev 通道。

---

## 自适应规则

同一套三栏外壳在三类宽度下有三种形态，判定在 `lib/frame/chassis.dart`：

| 宽度 | 形态 | 两栏行为 |
|---|---|---|
| ≥ 980 | 三栏并列 | 流内展开，宽度 200 / 280，切换带 200ms 过渡 |
| 620–980 | 紧凑 | 两栏默认收起，展开时是覆盖式抽屉（不推挤内容） |
| < 620（手机） | 紧凑 | 同上；标题栏隐藏窗口三键，页面横向内距从 70 降到 20 |

页面内部还有两处局部适配：设备停靠页头部在 < 620 时改为纵向堆叠；
定时任务的分段控件按可用宽度收缩（396 → 最小 180）。

---

## HarmonyOS（社区）

官方 Flutter 至今没有 HarmonyOS 目标，鸿蒙支持来自 OpenHarmony SIG 维护的
**Flutter 移植版**（`flutter_flutter`），它自带 `ohos` 平台模板与 `flutter build hap`。

```bash
# 1. 单独装一份移植版 SDK，不要与官方 SDK 共用同一个 PATH
git clone -b oh-3.22.0 https://gitee.com/openharmony-sig/flutter_flutter.git ~/development/flutter_ohos
export PATH=~/development/flutter_ohos/bin:$PATH

# 2. 校验：DevEco Studio / hvigor / OHOS SDK 就位
flutter doctor -v

# 3. 在本仓库生成 ohos/ 工程（只做一次，生成的工程要提交）
cd /Users/ntars/Github/Ondra
flutter create --platforms ohos .

# 4. 构建
flutter build hap --release
```

三个必须知道的前提：

1. **移植版与官方版是两份 SDK**，各自有独立的 `bin/flutter`、独立缓存。切端时切 PATH，
   不要试图让一份 SDK 同时出 `ohos` 和 `macos`。
2. **本仓库不预置 `ohos/`**。它是移植版模板生成的产物，手写会与 hvigor 的校验对不上；
   生成后提交即可，后续与另外六个端一起演进。
3. **代码层面无需改动**：只要不引入带原生实现的插件，`flutter create` 生成壳之后
   直接就能跑。将来若必须引入插件，先确认该插件有 OHOS 实现（社区 `flutter_packages` 分支），
   否则该功能要在鸿蒙上做降级——这是唯一需要按端分支的地方。
