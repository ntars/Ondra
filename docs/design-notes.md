# 空谷 Ondra 设计笔记

> 本文件是界面与插件体系的实现笔记：每一节记录「为什么这么切」与「否决了什么」。
> 面向使用者的说明在根目录 [README](../README.md)；本文只保留设计依据与实测数据，供维护者查阅。
> 原文自 README 迁入，章节结构未改动。

---

# 空谷 Ondra

桌面陪伴体。本仓库是 **2.0.0-alpha**：Flutter 写的三栏桌面界面，左栏导航、中栏页面、
右栏是**聊天窗口**。能力边界由 Cordis 插件决定，页面只读插件投影出来的状态。

应用名是 **空谷 Ondra**（窗口标题、Web 标题、关于页）；界面里的品牌锁定只写短名「空谷」
——侧栏只有 200 宽，全名会把菜单挤窄。

**没有后端，也没有演示数据。** 清单里有几条插件就画几条，记忆 / 会话 / 备份 / 日志
没有数据源时显示空态。宁可空着，也不摆一组看起来像真的示例条目——那会让人分不清
哪些是自己的数据。

---

## 版本标记

| 位置 | 值 | 说明 |
|---|---|---|
| `pubspec.yaml` | `version: 2.0.0-alpha+1` | 语义版本 + 构建号 |
| `lib/app/version.dart` | `ondraVersion = '2.0.0-alpha'` | 界面与「关于」页读这里 |
| 启动屏 | 标记 + `空谷` + `记得住，也帮得上`（`ondraSlogan`） | 冷启动第一帧即可见，不显示版本号 |

## 运行

```sh
flutter run -d macos            # 桌面（能起 dsh 子进程，右栏可以真的说话）
flutter run -d chrome           # 浏览器预览（无法起子进程，右栏如实报错）
tool/dev.sh                     # 开发预览：9060 起，带热重载（终端 r / R / q）
```

调试参数（仅 Web）：`?page=plugins` 直达某页、`?settings=1` 开设置、`?boot=hold` 把启动屏停住。

桌面上右栏要真的生成回复，需要两件事：

```sh
npm i -g @deepseek-ai/dsh       # 内核
export DEEPSEEK_API_KEY=sk-...  # 模型密钥
```

## 构建与分发

```sh
flutter build macos --release
# → build/macos/Build/Products/Release/空谷 Ondra.app
ditto -c -k --sequesterRsrc --keepParent "空谷 Ondra.app" ondra-macos.zip
hdiutil create -volname "空谷 Ondra" -srcfolder "空谷 Ondra.app" -ov -format UDZO ondra-macos.dmg

flutter build web --release     # → build/web（无子进程，右栏连不上本机内核）
```

四条与构建相关的硬约束，都是踩过之后定下来的：

1. **关闭 App Sandbox**（`macos/Runner/Release.entitlements`）：空谷要拉起本机的 `dsh`
   子进程、读写用户目录，沙箱下都做不到。代价是不能上 Mac App Store，本应用直接分发。
2. **不引入原生插件**：窗口尺寸与标题栏写在 `macos/Runner/MainFlutterWindow.swift`，
   因此不需要 CocoaPods / SPM——少一套容易和 Xcode 版本打架的集成。
3. **GUI 应用要自己找 `dsh`**：Finder 启动的进程 PATH 是极简版。传输层按
   「显式参数 → 环境变量 → 绝对路径候选（含 nvm / 自带 node 的版本目录）→ PATH」
   依次探测，并把 dsh 所在目录塞进子进程 PATH——`dsh` 是 `#!/usr/bin/env node` 脚本，
   PATH 里没有 node 会静默退出（表现为 initialize 超时）。
4. **数据目录独立**：子进程注入 `DSH_HOME=~/.ondra/dsh`（可用 `ONDRA_DSH_HOME` 覆盖）。
   桌面端的会话库是 `.jsonl.zstd`，SDK profile 写未压缩 JSONL，共用目录会直接报错。

排障看 `~/.ondra/logs/transport.log`（二进制路径、启动、握手、失败原因）
与 `~/.ondra/logs/window.log`（窗口 frame / content / layout 尺寸）。

**名字分两处写**（`macos/Runner/Configs/AppInfo.xcconfig`）：

| 键 | 值 | 谁在读 |
|---|---|---|
| `PRODUCT_NAME` | `空谷 Ondra` | 访达里的 `.app`、程序坞气泡、菜单栏、关于面板（`CFBundleName` / `CFBundleDisplayName`） |
| `EXECUTABLE_NAME` | `Ondra` | `ps`、活动监视器、`kill`——进程名 |

分开的原因：显示名要中文带空格，进程名要能用一条命令查到。
合成一个的结果是进程列表里出现 `空谷\ Ondra`，而且 `pkill 空谷 Ondra` 得先想清楚引号。
应用图标在 `macos/Runner/Assets.xcassets/AppIcon.appiconset`（16–1024 七档，
白底圆角 + 居中标，超椭圆 n=5），`tool/icons.sh` 可重新生成。

## 平台矩阵

| 平台 | 状态 | 说明 |
|---|---|---|
| macOS | 可构建、可运行 | 关闭沙箱；无标题栏；960×600 |
| Web | 可构建 | 界面完整，无法起子进程 |
| Windows / Linux | 生成过工程 | 窗口尺寸尚未下沉到原生入口，功能不受影响 |
| iOS / Android / 鸿蒙 | 生成过工程 | 三栏在窄屏退化为抽屉，非目标形态 |

## 窗口与三档

**窗口没有系统标题栏，内容正好 960×600**（`macos/Runner/MainFlutterWindow.swift`）：

1. 标题栏并入内容区（`fullSizeContentView` + 透明标题栏 + 隐藏标题 + 去掉分隔线）：
   三栏各有自己的表头，再叠一条系统标题栏就成了两条。
2. 尺寸用 `frameRect(forContentRect:)` 把「内容 960×600」换算成外框再设 frame；
   直接 `setFrame` 会把标题栏算进去，内容矮 32pt。
3. 最小尺寸与内容尺寸同值；每次启动居中，不读也不写上次的尺寸。
4. 系统红绿灯留在左上角，落在侧栏 48 高的表头里；折叠键与三键同处上方 28 高一带，
   Dart 侧不再画仿制三键（只在浏览器预览里画）。

| 窗口宽 | 形态 | 行为 |
|---|---|---|
| ≥ 930 | 三栏并列 | 左栏 200 + 内容 480 起 + 右栏 280，两栏可各自收起 |
| ≥ 930 + 展开 | 沉浸对话 | 中栏让位，右栏接管整张纸；左栏开合不受影响 |
| 620–930 | 紧凑 | 两栏收进抽屉（覆盖式，不推挤内容） |
| < 620 | 手机 | 抽屉 + 隐藏窗口三键 + 页面内距收窄 |

960 减去左栏 200 与右栏 280，中栏剩 480——**所有页面都按 480 宽设计**。

### 纸片：玻璃上面那张纸

层次只有两层，谁也不叠色：

1. **最底**是窗口那层原生玻璃（下面「毛玻璃」一节），Dart 碰不到；
2. **上面**是一张实色纸片，**圆角 12、四周让出 4px**（`chassis.dart` 的 `_Paper`）。

那 4px 就是全部的通透感来源：纸与窗缘之间留一道缝，桌面从缝里透出来。
所以纸必须是实色——半透明会让缝与面糊成一片，看不出「纸浮在玻璃上」。
纸缘只给一条 4% 投影交代厚度，**不再压白描边**：缝里出现第二根线就脏了。

左栏**不在**这张纸上：它本身就是玻璃的一部分，压上白纸就成了第四块灰。

### 毛玻璃

通透感只有一层，且在窗口层，不在 Dart 层（`macos/Runner/MainFlutterWindow.swift`）：

1. **主路径 `NSGlassEffectView`**（macOS 26+，运行时 `NSClassFromString` 查类）。
2. **回退 `NSVisualEffectView`**：`blendingMode = .behindWindow` +
   `material = .underWindowBackground` + `state = .active`（不是 `.menu`）。
3. **挂载点是 `contentView` 的最底层**，尺寸铺满整窗；`FlutterViewController.backgroundColor = .clear`
   且 `view.layer.isOpaque = false`。
4. **Dart 侧不叠任何白色**。侧栏 `background: transparent`，**也不画右缘发丝线**：
   侧栏与纸片之间已有 4px 玻璃缝，缝就是分界，再贴一根 42% 白线等于在玻璃上画了道亮痕。
   Web 没有原生玻璃，才退回实色 `#F6F7FA`。

**明暗分两套参数，不是同一套调暗**。深色下只换 `NSAppearance` 不够：
系统玻璃是「把背衬调暗」，透出来的仍是桌面那块亮色，看着像一层浅玻璃盖在深色纸上。
所以深色额外压一层 22% 黑 `tintColor`（回退材质则换 `.hudWindow` 档）：

| 模式 | 设置 | 侧栏实测（同一位置） |
|---|---|---|
| 浅色 | `appearance = .aqua`，遮罩隐藏 | `166,157,188`（壁纸的紫/蓝/红分得清） |
| 深色 | `appearance = .darkAqua` + 黑色遮罩 55% | `59,55,69`（沉下去，白字够对比） |

主题由设置里的三选一决定，再通过 `ondra/window` 通道回传给 AppKit——
**`ThemeMode` 只换 Flutter 的画布，动不了窗口的 `NSAppearance`**；
不同步就会出现「纸片已经变深、玻璃还是浅的」的错层。

同一位置下，回退材质 `NSVisualEffectView(.underWindowBackground)` 是 `217,216,228`，
几乎洗白、发奶——这是「主路径必须优先」的实测依据。

**深色玻璃不是把浅色玻璃调暗**。只切 `NSAppearance` 时，系统玻璃只把背衬压掉一档，
透出来的仍是桌面那块亮色（实测侧栏 `rgb 103,94,121`，壁纸的紫还在），
看起来像「一层浅玻璃盖在深色纸上」。而 `NSGlassEffectView.tintColor` 实测是在**提亮**
（同位置 103,94,121 → 112,105,128），不能拿来压暗。

所以深色靠一层**夹在玻璃与 Flutter 之间的黑色遮罩**（`dimmer`）：模糊与折射仍由玻璃
提供，遮罩只降低亮度。实测同一位置：深色 `59,55,69`、浅色 `166,157,188`；
纸片左缘那 4px 缝里是 `60,61,78`，比纸片（`16,17,26`）亮一档，缝才看得见。
遮罩在浅色下 `isHidden = true`，不留任何灰。

排障：`defaults write cn.ondra.ondra OndraGlass legacy` 切回回退材质，删掉该键恢复默认。

一个坑记在这里，省得下次再踩：**窗口截图（`screencapture -l`）拍不到 behind-window 合成**，
侧栏会显示成一片均匀纯色，与真实观感无关——最初就是被它误导，以为玻璃没生效。
验像素只能用区域截图（`-R`），它走屏幕合成。

### 主题模式

设置 → 通用设置 → 主题：**浅色 / 深色 / 跟随系统**，默认跟随系统。
选择写进 `~/.ondra/prefs.json`（`{"themeMode":"dark"}`），下次启动直接是这个外观。

- `ShellState.themeMode` 管状态，落盘由应用根负责（`app/prefs.dart`，Web 走内存）。
- 换模式时除了 `MaterialApp` 的 `themeMode`，还要把亮度通过 `ondra/window`
  通道传给原生：磨砂玻璃是 AppKit 画的，只认 `NSAppearance`。
  不传这一下，深色下必然出现「纸片已深、玻璃还浅」的错层。
- 头像等跟随主题的组件读皮肤角色（`OndraAvatar`：浅色白底黑笔迹、
  深色 `#20242D` 实色底 + 浅笔迹）。深色下**不用半透明白**：
  头像站在磨砂玻璃上，半透明底会被壁纸染色，看起来永远比面板亮一档。

### 右栏

280 宽，三段：表头 48（与左栏 `h-12` 同高）、对话流、输入盒 70 + 用量条 26。

- **表头只有一行名字**：没有副标题，没有「内容由 AI 生成」——免责声明不是信息，
  不该常驻在每次对话顶端。
- **一共两颗图标**：新建对话（24 圆）+ 收纳（36 浮在 `right:14 top:6`）。
  这两颗按**墨迹**对齐而不是画布：气泡那条 SVG 描边几乎顶满 24 的 viewBox，
  双竖线框在 19 的 viewBox 里有大片内边距。实测渲染后墨迹都是 14×14，
  并排看不出高低——「两个画布一样大、看着却一大一小」就是差在这里。
- **收纳不是开关，是入口**：点开是两行菜单（收纳右栏 / 展开对话）。
  把「收起」和「沉浸」拆成两颗按钮时，表头有三颗图标，每颗都要靠 tooltip
  才说得清；现在处置这一栏的两种方式收进菜单，图标回到「一个功能一枚图标」。
- **背景是灰点神经元网**（`neuron_backdrop.dart`）：线 5.5%、点 10%，**全部同色**。
  早先给两三个节点上蓝，结果那两个点在满屏灰里成了视觉焦点——背景的职责是退后。
  **展开态不画它**：一整页铺满连线会变成壁纸，长对话读起来到处是噪点。
- **展开态**（沉浸对话）内容限宽 720 居中：纸宽了字不该跟着变宽，
  一行 700 以上正文回行时容易串行。
- **输入盒 70 高、横排一行**：`TextField` + 加号 + 发送键同在一条基线上。
  140 的竖排版本把「写一句话」压成了三行公文，70 才是一个输入框该有的呼吸。
- **输入盒下面挂一条用量 dock（26 高）**：`454 token/s` · `79.8万 token · 缓存命中 63%` · `◯ 16%`。
  三段全部来自内核 `assistant/message` 上的 `usage`（`outputTokens ÷ 步耗时`、
  累计计费 token、`cacheRead ÷ 计费输入`、`输入 ÷ contextWindow`）。
  **没有数据时画 `—` 而不是 0**：没连内核是「不知道」，写 0 会被读成「这轮免费」。
  单位一律写 `token`，不译成「词元」——这个词在中文里没有第二个意思，
  译了反而对不上任何一份 API 文档。
  280 宽放不下整串：先省掉 `token` 这个词，再不够就把「缓存命中」缩成「命中」，
  两档都只是**同一句事实的缩写**，不换单位、不丢位数。

## 目录结构

```
lib/
├─ main.dart                     唯一入口：读人设 / 插件清单 → 接内核 → runApp
├─ app/
│  ├─ ondra_app.dart             根组件：壳状态 + 主题 + 启动屏 → 主壳
│  ├─ window_geometry.dart       窗口能力入口：条件导出（桌面 / web 空实现）
│  ├─ window_geometry_stub.dart  web：空实现
│  ├─ window_geometry_desktop.dart  原生侧已设好尺寸，这里只留调用点
│  └─ version.dart               应用名、版本号、窗口基线尺寸、调试端口
├─ design/                       设计层：页面不写死色值与字号
│  ├─ tokens.dart                颜色 / 圆角 / 间距 / 字重轴值
│  ├─ skin.dart                  角色名（content / shell / rail / ink / line）浅深两套
│  ├─ theme.dart                 ThemeData：无涟漪、MiSans + 系统回退
│  ├─ font_face.dart             字体运行时加载：装不上就降级到系统字体
│  ├─ page_frame.dart            统一页框：拖拽条 + 标题行 + 滚动正文 + 白面板
│  ├─ glyph.dart                 图标：lucide 一套 + 插件统一图标（plugin.svg）
│  ├─ brand.dart                 品牌标记：着色 + 视觉归位
│  ├─ primitives.dart            基元：开关 / 分段 / 设置行 / 标签 / 三圆点
│  └─ window_frame.dart          「浮层当独立窗口」的路由封装
└─ plugins/                      **一切能力都是 Cordis 插件**
   ├─ cordis/                    框架本体（@deepseek-ai/cordis 4.1.0，原样引入）
   ├─ dsh-base/                  dsh 内核（官方名；本体在 dsh-kernel 抽取版）
   ├─ ondra-core/                随包默认、不可关闭
   │  ├─ ondra-ui/               UI 总层：外壳 / 菜单 / 注册表
   │  │  ├─ ui/                  chassis · side_rail · boot_screen · module · registry · shell_state
   │  │  ├─ ondra-status/ ondra-memory/ ondra-history/ ondra-backup/
   │  │  ├─ ondra-transfer/ ondra-guide/ ondra-plugins/ ondra-chat/
   │  │  ├─ ondra-emotion/ ondra-relationship/ ondra-channel/ ondra-voice/
   │  │  ├─ ondra-beichen-api/ ondra-llama/ ondra-browser/
   │  │  ├─ ondra-model/ ondra-store/ ondra-runtime/
   │  │  ├─ ondra-logs/          ← 下辖 ondra-log-dialog/-plugin/-system
   │  │  ├─ ondra-settings/      ← 下辖 5 个设置分类
   │  │  └─ ondra-onboarding/ ondra-font/ ondra-locale/
   │  └─ ondra-flutter/          占位：平台能力（窗口 / 托盘 / 文件 / 进程）
   ├─ ondra-extensions/          随包默认、可关闭（当前为空）
   └─ ondra-custom/              用户自装插件（如 dsh-xxx）
```

## 插件体系

**只有一套：Cordis**（`@deepseek-ai/cordis`）。Flutter 侧是运行时客户端，不实现插件框架；
界面与插件之间只有**投影**一层（`*_client.dart`）。完整文件树见
[`lib/plugins/LAYOUT.md`](lib/plugins/LAYOUT.md)。

| 目录 | 加载 | 可关闭 | 装什么 |
|---|---|---|---|
| `ondra-core/` | 随包默认 | 否 | 核心插件（UI 全在 `ondra-ui/` 下） |
| `ondra-extensions/` | 随包默认 | 是 | 随包附带、可开关 |
| `dsh-base/` | 随包默认 | 否 | dsh 内核（官方名，原样引入） |
| `ondra-custom/` | 运行时按需 | 是 | 用户自装（`dsh-xxx`） |

框架 `cordis/` 在插件根目录，不属于这四类——它是宿主，不是插件。

- 插件 id 与目录名：`ondra-` 前缀 + **连字符**（`ondra-persona`，不是 `ondra_persona`；
  Dart 文件名仍是 snake_case）。
- 第三方内核用官方名（`cordis`、`dsh-base`），不改名，便于跟上游一比一同步。
- 每个插件目录含 `plugin.json`（id / layer / closable / owner / provides / depends）与 README。
- 依赖单向：`ui/` → 投影 → 插件服务；插件之间不 import 彼此的 `ui/`。
- 插件扩展页按上面五个位置归档（应用核心 / 核心插件 / 对话内核 / 扩展 / 自定义），
  图标统一用空谷应用图标；dsh 内核用官方图标。

### 插件页的两路数据源

插件页不是一张静态清单，它把两件事拼在一起：

| 来源 | 是什么 | 条数 |
|---|---|---|
| `assets/plugins/manifest.json` | 随包发的 18 项（框架 / 内核 / 核心插件），有作者写的中文名与简介 | 18 |
| `~/.ondra/dsh/profiles/ondra/cordis.patch.yml` | **内核真正会加载**的插件，逐条回 `node_modules/<包>/package.json` 取版本与简介 | 75 |

两路零重名（18 + 75 = 93 条），合并时同名以清单为准。

第二路是活的：装了、关了就变，不需要重新构建应用。开关改的是装配层里那两行的
注释状态（`- id:` ↔ `# - id:`，跟着 `name:` 那行一起翻），**下次连接内核时生效**——
正在跑的进程不会重读 YAML，这一点界面会如实写出来，不假装即时。
第一次写入前留一份 `cordis.patch.yml.bak`，先写临时文件再改名：
装配层是内核唯一入口，改坏了必须有回头路。

读不到 profile 就是空列表，不报错也不编：那说明这台机器上内核还没装配过。

### 模型路由：本机网关 magpie

右栏默认不联外网，走本机网关 **magpie**（`/Applications/magpie.app`，监听
`127.0.0.1:3425`，OpenAI 兼容：`/v1/chat/completions`、`/v1/messages` 都有）。
装配层里有两条与之相关的配置：

```yaml
# ① 内核侧的路由：pi-ai 的手工路由，不碰 DeepSeek 官方那条
- id: llm-magpie
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      magpie:
        api: openai-completions
        baseURL: http://127.0.0.1:3425/v1
        apiKeyEnv: MAGPIE_API_KEY
        models: [{ id: group/ntars, contextWindow: 1000000 }]

# ② 插件侧的路由：记忆提炼 / 做梦 / 评估都等这条
- id: ondra-llm-gateway
  config:
    sources: [{ id: magpie-local, kind: local, provider: magpie,
                model: group/ntars, priority: 10, timeoutMs: 120000 }]
```

三个容易踩的点：

1. **`apiKeyEnv` 必须有值**，哪怕 magpie 根本不校验密钥。pi-ai 的手工路由
   会先解析凭据，空值直接失败在 `No API key for provider: magpie`。
   应用侧在子进程环境里注入占位值 `MAGPIE_API_KEY=local-loopback`
   （语义是「本机环回，不需要钥匙」），配置文件里不出现任何真密钥。
2. **`provider` / `model` 只在 initialize 那一刻生效**。换模型必须重起内核，
   所以设置里换默认模型时 `main.dart` 会停掉旧进程、按新路由重连一次。
3. **正文没有增量事件**。内核一步结束才给一条 `assistant/message`，
   整段正文在 `event.data.message.content` 里。界面看到的是「一步一段」，
   不是逐字流——那是协议如此，不是传输层少解析了一层。

想换一家网关（LiteLLM、One API、Ollama）：改 ①的 `baseURL` 与 `models`，
②的 `provider` 指向 ①里的路由键，再把 `StdioDshTransport` 的
`provider` / `modelId` 默认值换成新的。三处对齐即可，别的地方不用动。

### 装配层：三个「静默失灵」的坑

插件装上、`initialize` 也返回 ok，不代表它们在工作。下面三种情况都**不报错**，
只会让功能安静地退回内存态或「不可用」——本机最初 `ondra.db` 25 张表全零行，
就是踩在这上面。

**① 软依赖在 `apply` 里同步取服务，而 loader 是并发 apply 的。**
`path-layout` / `store-sqlite` / `memory-core` 是 L0–L1 的地基，其余插件几乎都
`ctx.get('ondra-path-layout')` 一下——取不到就「退回内存模式」，只留一行 WARN。
把地基排在列表最前**不够**：并发加载下顺序不等于 YAML 顺序。实测把
`path-layout` 放在第 49 位时，前面 22 个插件全部退化成内存态。

**② `ctx.provide` 放在 `ctx.effect` 里。**
`effect` 的回调晚于同期插件的 `apply`，于是下游那一刻 `get` 到的是 `undefined`。
表现是日志偶发不落盘（同一条链两次启动一次写一次不写）。

**③ 修法：在装配层声明 `inject`，并让地基同步 provide。**

```yaml
    - id: ondra-memory-audit
      name: '@ondra/cordis-plugin-ondra-memory-audit'
      inject:                # 加载器会等这些服务就绪再 apply
        - ondra-memory-core
        - ondra-store-sqlite
```

`inject` 是 patch 条目的一等字段（`--dump-config` 里能看到），不用改插件代码。
配合把 `provide` 从 `effect` 提到 `apply` 内（本机改了 `path-layout`、
`store-sqlite`、`memory-core` 三个包的 `lib/index.js`），审计 / 衰减 / 判重 /
做梦 / 召回 / 图谱 / 人设拼装这些一次全部就位。

验证方式不看日志段落，直接问库：

```bash
sqlite3 ~/.ondra/user/ondra.db "select count(*) from memory_raw; select count(*) from memory_fact;"
```

数字不涨就是没落盘，跟界面有没有画出来无关。

> 三处 `lib/index.js` 的改动在 `~/.ondra/dsh/profiles/ondra/node_modules/` 里，
> 属于本机 profile 的副本，**重装插件包会被覆盖**。装配层的 `inject` 与顺序
> 写在 `cordis.patch.yml`，重装后仍然有效。

## 备份：内容寻址的快照与时间线

`~/.ondra/backups` 下只有两样东西：

```
objects/3d/3d9f…a1        ← 文件内容，同名同内容只存一次
snapshots/20261117-210305/
  manifest.json           ← 这份快照的文件清单：路径 → 指纹
```

**为什么不是「每次整个目录复制一份」。** 一轮对话下来 `sessions/` 里几十个文件
一个字节都没变，整目录复制等于把同样的内容存十遍——十份备份占十倍空间，用户
会在第三次之后关掉这个功能。内容寻址之后「第 10 次备份只多写了 3 个文件」是
可验证的，页面上「去重节省」这个数字就是它的直接读数，不是估算。

指纹是两条 32 位 FNV 变体并成的 16 位十六进制（`_fingerprint`）：这里要回答的是
「两份文件是不是同一份内容」，不是「有没有被篡改」。SHA-256 每字节几十次位运算，
在这个场景纯属浪费。

**备份范围**（`BackupEngine._trees`）：`user/` `sessions/` `storages/` `profiles/`
`prefs.json`，加 `dsh/profiles/*/` 里的五个配置文件。三类东西**明确不收**：

| 不收 | 理由 |
|---|---|
| `logs/` `cache/` `tmp/` | 追加写的排障材料与可重建缓存，回滚回去只会把上小时的错误盖回来 |
| `dsh/profiles/*/node_modules/` | 17 MB 依赖树，随时能重装 |
| `.credentials.yaml` | 密钥不进快照：备份目录是 0700，但复制成 N 份、每份都可能被导出到别处，风险与收益不成比例 |

**恢复**（`BackupEngine.restore`）是**可后悔**的：动手之前先给现在的状态存一份
`preRestore` 快照。手册里只做两件事——覆盖快照里有的文件（先写 `.ondra-restore`
临时文件再改名，断电不会留半截），以及**保留**快照里没有、当前存在的文件。
删除是不可逆的，而「快照里没有」既可能是当时没这个文件，也可能是它根本不在
备份范围内；分不清就不删。

**自动备份**（`BackupScheduler`）只在应用活着的时候工作：空谷是随用随开的桌面
伴体，它不在跑的时候也没有新数据产生。做成开机常驻的守护进程，会为了「数据没变
也每小时存一份」付一份始终在跑的代价。

### 时间线：把「回到某一次」做成一屏

左侧入口卡点进去，整个窗口被接管（`ShellState.timelineOpen` + `chassis` 的
Stack 顶层），换成一片星场：前方那扇白窗是选中的那一刻，比它新的版本在身后一档
档缩小、变暗、往上退，右侧一条时间轴从「现在」排到最旧的一份。

- 位移是**递减**的（`40 / (1 + (i-1) * 0.40)`），等距排会让影子像一串等间距的
  卡片，不像退到远处的窗口；
- 最多 6 层：再往后的影子缩到看不清，只会把画面糊成一团；
- 滚轮 / `↑↓←→` 穿梭，`⏎` 恢复，`esc` 退出；
- 前景窗会把这份快照的内容读出来（分组 + 文件清单），不是一张占位卡。

命名上刻意避开 Apple 的「时间机器」：这一屏的交互模型属于那个产品，但**名字**
不该跟它撞。叫「时间线」，说的也正是它表达的东西——一份份时刻连成一条线。

## 记忆的进出口

这一页只做一件事：让记忆与偏好**离开这台机器也能读**，并且能回来。

**导出是明文。** Markdown 一条一段，段首藏一行注释：

```markdown
## 用户名叫小林。

<!-- ondra:memory id=m-a8f1fdb5c240 category=person salience=62.0 created_at=1794920555011 -->

- 类别：person
- 显著度：62
- 记录于：2026-11-17 21:42
- 原话：「我叫小林」
```

那行注释是给程序看的：有它，导回来就能和原记忆对上 id；删掉也不影响阅读，
导回来时当成新记忆（id 由正文指纹生成）。**手写的 Markdown 也能导入**——
用户拿一份清单过来，不该被要求先学一种格式。

**导入会真的写库，所以先存一份底。** 每写一次 `memory_fact` 之前都调一次
备份引擎；备份失败不阻断（挡住导入比冒一次险更糟），但会在结果里说出来。

去重是两道：id 相同的由 `insert or ignore` 拦掉；正文相同的在写之前先比一遍——
不同来源导出的同一句话 id 会不一样，只靠主键会让一件事在记忆里长出两条。
本机实测：把导出的 JSON 原样导回两次，两次都是 0 新增、10 条跳过，库里仍是 10 条。

**写库走 stdin 而不是命令行参数。** SQL 里带换行与引号，拼进 argv 迟早会在
某条记忆上炸掉；整批包在一个事务里，中途失败不会留下半批。

**只读查询要给 WAL 留一条退路。** `ondra.db` 是 WAL 模式，`sqlite3 -readonly`
需要能同时打开 `-wal` / `-shm`；这两个文件缺失（进程刚被杀、或库是从别处拷来的）
时会报 `CANTOPEN: unable to open database file`，看起来像「没有记忆」。所以两处
读库都做了降级：`-readonly` 失败就退回 `file:…?mode=ro` 读主库，宁可少一条
刚落盘的，也不该把「读不到」显示成「没有」。

### 状态面板说的是哪种「空」

三种空态在这个应用里必须分开说，混起来会误导：

| 空 | 怎么说 | 用户该做什么 |
|---|---|---|
| 这个环境看不到 | 「浏览器预览读不到本机数据库」 | 打开桌面版 |
| 还没产生过 | 「情绪还没有第一次落定」 | 去聊几句 |
| 读到 0 | 直接显示 `0`，不解释 | 什么都不用做 |

情绪那一块尤其如此：`emotion_state` 零行不是故障，是靠对话真的被触动才会产生的
第一份状态。写「等待数据源接入」会把「你还没用过」说成「我们还没做好」。

**第四种空：内核装配的降级。** 内核有三十多个插件，每个都可以「取不到依赖就
转不可用」——这是刻意的设计（宁可降级也不 PENDING），代价是失败只写日志，
界面上一点痕迹都没有。状态面板因此多了一块「内核装配」：从 `ondra-code.log`
尾部取最近一次启动的日志窗口，把降级项摆出来（同因合并、错误在前）。

**本机当前的读数就是问题本身**：`memory-pool` / `snapshot` / `memory-graph`
等十几个插件都报「存储端口缺席」，而 `store-sqlite` 自己显示「存储就绪」——
两边说的是同一件事的两个时刻：loader 对所有 entry **并发 apply**，而
store-sqlite 在 `apply` 里要先打开数据库再 `provide`，几十毫秒的窗口足够让
几十个同步的 `ctx.get()` 落空。装配层 YAML 里的 `inject` 只对「服务已存在」的
声明起作用（cordis 的 `Inject.resolve` 只做归一化，等待机制挂在服务注册的
`notify` 上），对「尚未 provide 的服务」不阻塞——这是 dsh 这版 loader 的时序
限制，修法是让消费方用 `ctx.inject(['ondra-store-sqlite'], …)` 延迟取用，
属于内核侧的重构，已列为下一轮工作。

**比例条不能用 `FractionallySizedBox`。** `Stack` 里的非定位子组件拿不到紧约束，
`ColoredBox` 没有子节点时尺寸收缩为 0——表现是「整条轨道不见了」，而且不报错。
两处都改成 `LayoutBuilder` 量一次父宽、按比例给实宽（备份页的容量条也是同一个坑）。

## 启动时序：一个补丁修掉 18 个「静默降级」

内核有三十多个插件，每个都按「取不到依赖就转不可用」写——这是**对的**设计：
声明 `inject` 后上游缺席会让整插件 PENDING，那是最难查的失败形态。代价是失败
只写日志，界面上一片安静。

问题在 loader：它对一个入口树是**并发 apply** 的，而 `ondra-store-sqlite` 要先
开库再 `ctx.provide`。那几十毫秒里，所有同步 `ctx.get('ondra-store-sqlite')`
的插件都拿到 `undefined`。本机日志里能直接看到这个次序：

```
23:17:19 WARN [ondra.memory-pool] 没有可用存储端口（…都缺席）
23:17:19 INFO [ondra.store-sqlite] 存储就绪：~/.ondra/user/ondra.db
```

同一秒，一前一后。结果是记忆衰减、判重、召回、识别、图谱、做梦、提炼、
八池、快照、注入全部注册成「不可用」，而且**永不自愈**——它们不会回头再查一次。

### 为什么改 YAML 没用

装配层 `- id: xxx` 下的 `inject:` 会被 loader 采用（`cordis-plugin-loader` 里
有 `Inject.resolve(fiber.entry.options.inject, fiber.inject)`），但 cordis 的
`Inject.resolve` 只把数组归一化成 `{name: null}`，等待机制挂在「服务注册时的
`notify`」上——对**尚未 provide 的服务不阻塞**。实测：`ondra-memory-pool` 明明
写了 `inject: [ondra-store-sqlite]`，仍然在 store 之前 apply。调整 YAML 顺序
也没用，因为 apply 是并发的。

### 补丁怎么做（`ondra-boot-settle`）

1. `ctx.inject([store, core, llm], cb)` —— cordis 的**回调式注入**，三个服务都
   就绪时才执行回调（这是另一套机制，不受上面那条限制）；
2. 宽限 600ms 让首轮 apply 走完（restart 一个正在 apply 的 fiber 会把卸载与重载撞上）；
3. 按**入口 id** 找到那些插件的 fiber，`await fiber.restart()` —— dispose 再
   reload，第二轮 apply 时依赖都在。

入口 id 在树里会带命名空间（`include:ondra-memory-pool`），所以比较最后一段；
同时留一条按 fiber 名字比的后路。`runtime.name` 不能用——所有插件入口都叫
`apply`，它多半是 `undefined`。

名单由装配层显式给，只收「依赖 store-sqlite / memory-core / llm」的那些。
`asr`（没 privacy）、`installer`（没 manifest）、`persona-loader`（没有随包人设）
依赖本来就不存在，重启一万次也一样，不在名单里。

机制单独验证过（`tool/boot_settle_probe.mjs`）：慢存储 50ms 后才 provide，
消费者先 apply 得到 `available: false`，重启后变 `true`，再重启一次仍然 `true`。

### 结果

本机同一次启动：**18 个插件重启成功，启动日志里的降级从 55 条（28 个插件）降到 0 条**。记忆衰减/判重/
召回/识别/图谱/做梦/提炼/八池/快照/注入全部变成「就绪」。

顺带修掉一个被它暴露的既有缺陷：`ondra-multimodal-memory` 的
`schema.register()` 没有挂在 `ctx.effect` 上，插件被重启时第二遍会撞上
「段键已被自己登记」，配置段从此退回实例配置。已改成 effect 包裹（`register`
本来就返回 disposer）。**另外五个插件有同样写法**（`asr` / `vision` /
`install-doctor` / `organ-gate` / `organ-host`），当前不在重启名单里所以没触发，
已记录待办。

## 模块机制

一个模块 = 侧栏一项 + 一个页面。装配表在 `ondra-ui/ui/registry.dart`：

```dart
OndraModule(
  id: 'memory',
  label: '记忆星图',
  glyph: Glyphs.navMemory,
  group: OndraGroup.primary,
  build: (_) => const MemoryPage(),
)
```

- 枚举顺序即侧栏顺序：概览（状态 / 记忆）→ 空谷生命（回看 / 扩展 / 保底 / 搬家 / 学会）
  → 日志（三本账垫底）。
- 第一个模块是启动后的默认页（状态面板）。
- 右栏不在模块里声明：它是**聊天窗口**，全应用只有一个，切页不换名字、不换建议。
- 缺席靠 `--dart-define=ondra_absent=a,b`，缺席的模块只是不出现，不改代码。

## 视觉约定

- **单色界面**：强调色是近黑（`#1C1F28`），状态色只用语义红 / 橙；涨跌类色另行约定。
- **线**：10%（标题栏下缘）/ 8%（卡片描边）/ 4%（列表行）。**右栏左缘单独一档**：
  `divider = #E9EBF0`（对齐参考应用 `--miclaw-color-border-light`），绝对色、1px；
  用半透明黑会因底色不同算出两个灰度，同屏看就是一粗一细。
  **左栏右缘不画线**——那里是 4px 玻璃缝，缝本身就是分界。
- **明暗两套角色**：`OndraSkin.light` / `OndraSkin.dark`，页面只写角色名（`s.ink` / `s.surface`），
  不写 `Brightness` 判断；模式本身由设置里的三选一决定（`ShellState.themeMode`）。深色不是「浅色调暗」：面层更深、字更浅，`bubbleInk` /
  `answerInk` / `hintInk` 三个角色专门管对话里的文字——同一个 10% 蓝气泡上，
  浅色用黑字、深色必须用浅字，否则完全读不出来。
- **字重**：基准 **330**（参考应用 `body{font-weight:330}`），阶梯 330 正文 / 380 次标 /
  450 标题 / 500 控件（`font-medium`，参考里的高频档）/ 600 强调。走 `FontVariation` 轴值，
  不用 `fontWeight` 请求，避免可变字体被合成加粗。
- **清单不套卡**：列表页是一条清单 + 行间发丝线 + hover 4% 底；卡片只用于仪表盘型页面。
- **分隔线让出图标**：左内距 = 8 内距 + 30 图标 + 12 间距 = 50。
- **空态**：一句说明「这里将来会出现什么、由谁写入」，不摆示例数据。
- 字号：正文 12–14、说明 11、页面标题 20/600（`text-[20px] font-semibold leading-7`）；
  左栏表头 48、菜单项 32/圆角 8/左内距 8、分组标题 11/700/40%，与参考应用逐项对齐。

### 细节层：动效、光学与浮层

这一层不改变布局与配色，只管「用起来是否像一件成品」。取值来自
[`Caho1/open-claude-ui`](https://github.com/Caho1/open-claude-ui)（Claude Design System
的逆向取证手册），只有被验证过、且能落到 Flutter 上的那几条被采纳：

| 项 | 取值 | 落点 |
|---|---|---|
| 时间常数 | 70ms 触觉 / 120ms 咬合 / 150ms 悬停 / 300ms 面板 | `OndraMotion`（`lib/design/motion.dart`） |
| 曲线 | `SHARP_PRESS(.32,.72,0,1)`、`EASE_OUT_EXPO(.16,1,.3,1)`、`OVERSHOOT(.34,1.3,.64,1)`、`DECEL(.165,.84,.44,1)` | 同上 |
| 按压 | `scale(0.98)` + 前景 4% 黑（深色 6% 白） | `OndraPressable`（`lib/design/pressable.dart`） |
| 深色字重逆补偿 | 500→465、600→560（`wght`） | `OndraOptics`，由 `ondraText` 统一应用 |
| 滚动渐隐 | 7 档非线性 α：15%→5.1%、30%→14.9%、45%→30.2%、60%→50.2%、75%→70.2%、87%→85.1% | `OndraScrollFade`（对话流） |
| 浮层 | 双环：浅色外环 1px + 12%/8% 双层投影；深色内环 1px 白 10% + 65%/45% 投影 | 右栏二级菜单，120ms 从按钮侧放大入场 |
| 分段滑片 | 单一滑片 120ms 位移，宽度按文字现量（三格不等宽） | 设置 → 主题 |

**没有采纳的两条**，理由记在这里，免得下次又被搬进来：

- **0.5px 发丝线**：参考实现靠 CSS 的像素吸附，0.5px 稳定落在 1 个物理像素上。
  Flutter 的边框不做吸附，0.5 逻辑像素落在非整数位置时会摊成两条半透明行，比 1px 更脏。
  统一保持 1 逻辑像素（视网膜屏上是 2 物理像素），这是「清晰」与「细」之间的取舍。
- **行内图标 `-.125em`**：那是 CSS 基线对齐的补丁。Flutter 的 `Row` 默认按中心对齐，
  同样的视觉结果，不需要负边距。

### 右栏的四条开合路径

收纳、展开、进沉浸、退沉浸是**四个动作**，但只该有**一个连续量**：右栏宽度。
实现是一条宽度轨道（`chassis.dart` 的 `_RailTrack`），状态切换只是改目标值：

| 路径 | 目标宽度 | 中间态 |
|---|---|---|
| 收纳 | `0` | 逐帧收窄，贴右裁切 |
| 展开 | `280` | 逐帧变宽 |
| 进沉浸 | 纸宽（窗宽 − 左栏 − 8） | 从中途连续长到满宽 |
| 退沉浸 | `280` | 从满宽连续收回 |

三条设计约束，都是「不这么做就难看」的硬需求：

- **中途改主意要能折返**。起点取**当前宽度**而不是上一个目标，所以收到一半点展开
  是从半路往上走；若先把宽度补回 0 再展开，那 200ms 里会先「退回去一下」，像卡了一帧。
- **任何一栏都不许变形**。右栏窄于 280 时内容按 280 排版再裁左（否则表头会挤到
  只剩「空…」、输入盒从 140 缩成一条线）；右栏宽于 280 时中栏按三栏宽度冻结再被
  盖住（否则页面会先重排成畸形再消失）。整个过渡里只有栏在让位，没有内容在抽搐。
- **拖窗口不参与动画**。窗口尺寸变化时宽度直接落位；若也补间，每一帧都会重新起一次
  动画，右栏永远慢纸宽半拍。

收纳键也是同一套逻辑的一部分：右栏本来就贴着纸的右边缘，栏内 `right:14` 与栏外
`right:14` 是同一个点，所以它不随开合移动，只在半程换一身皮（白底 + 投影 ↔ 透明底，
120ms 过渡）。收起后整栏仍在树上（保住滚动位置与输入草稿），但被 `ExcludeFocus`
挡住键盘——否则 Tab 会走进一个宽 0 的输入框，打得进去、看不见。

## 现状

| 能力 | 状态 |
|---|---|
| 三栏外壳 / 左栏十项 / 启动屏 | 完成 |
| 纸片层（玻璃上圆角 12 + 4px 缝） | 完成 |
| 深色模式（跟随系统，原生玻璃同步） | 完成；设置面板导航条与主题行已适配 |
| 右栏四态（收纳 / 展开 / 进沉浸 / 退沉浸） | 完成；共用一条宽度轨道，可中途折返；左栏开合不受影响，沉浸内容限宽 720 |
| 设置面板 5 类（通用 / 模型基座 / 通道 / 人设 / 关于） | 结构与取值完成；对话、记忆、语音并在人设里，隐私、反馈并在关于里 |
| 模型基座 | 按 DSH 的 provider / model 字段复刻；六类来源（官方 / 合作 / 免费 / 自定义 / 本地部署 / 本地网关）+ 预设 + 端点检测。写钥匙串待平台层 |
| 右栏对话 | **能说话**：`dsh --profile ondra` 子进程（JSON-RPC over stdio），默认路由到本机网关 magpie（`127.0.0.1:3425`），不填密钥、不联外网；`dsh_sidecar_test` 实测取回正文与用量 |
| 人设 | 内置哦鲸鲸；加载 / 热切换 / 重载走 `ondra-persona` 投影；自定义包与偏好走导入导出页，落 `~/.ondra/user/personas/` |
| 本地部署 | 真实能力：`ondra-llama` 找 `llama-server`、下 GGUF（带进度）、起停进程、轮询 `/v1/models` 判定就绪，并把地址回填给 provider。需要本机 `brew install llama.cpp` |
| 网页浏览 | `ondra-browser`：白名单 + 系统 WKWebView 平台视图。**被动出现**（左栏无入口），从设置的白名单或其它功能的打开请求进来 |
| 历史对话 | 完成；读内核会话库 `~/.ondra/dsh/sessions/**/session.v4.jsonl`，标题取第一句用户消息，按最后活动倒序（本机实测 35 条） |
| 插件扩展 | 完成；随包清单 18 条 + profile 装配层 75 条，扩展插件可开关（改装配层注释，下次连内核生效） |
| 记忆星图 | 完成；读 `~/.ondra/user/ondra.db` 的 `memory_fact` / `memory_link`（走 `/usr/bin/sqlite3 -json`，不引原生包），坐标按 id 哈希确定性排布，本机实测 10 条事实 |
| 三类日志 | 完成；对话→`transport.log`、插件→`ondra-code.log`、系统→`window.log`，从尾部倒读 200 行，UTF-8 解码 |
| 备份还原 | **完成**：内容寻址对象库（`~/.ondra/backups`），本机实测 32 个文件 / 437 KB：第二份快照与第一份内容全同，新增 0 字节；恢复前自动存底、只覆盖不删除；超额裁剪 + 孤儿对象回收 | 
| 时间线（备份回看） | 完成：整窗接管的纵深界面，星场 + 快照窗堆叠 + 右侧时间轴，滚轮 / ↑↓ 穿梭、`⏎` 恢复、`esc` 退出。**不叫「时间机器」**，避免与 Apple 的商标撞名 |
| 导入导出 | **完成**：记忆导出 Markdown / JSON（真读 `memory_fact` + `memory_link`）、人设与偏好导出成目录、整包导出复用备份引擎；导入会**真写库**，写前自动存底，id + 文本双重去重（本机实测：10 条记忆 / 55 条原文，导出 JSON 3.7 KB；原样导回两次都是 0 新增、10 条跳过，库里仍是 10 条） |
| 状态面板 | **完成**：记忆 / 活跃 / 沉淀三条体征、情绪两条轴、三份日志作监测源、网关 `127.0.0.1:3425` 探活，外加「内核装配」体检（读最近一次启动日志里的降级项，同因合并、错误在前）。零数据时说的是「情绪还没有第一次落定」，不是「等待数据源接入」 |
| 插件（TS 源码） | 旧插件包 76 个已装进 `~/.ondra/dsh/profiles/ondra`，`initialize` 实测通过；`tool/typecheck_plugins.sh` 做类型自检 |
| 启动时序补丁 | **完成**：新增 `ondra-boot-settle`，等 `store-sqlite` / `memory-core` / `llm` 真的就绪后，把抢跑注册成「不可用」的 18 个插件重启一遍。本机实测启动日志降级条数 **55 → 0**（28 个插件 → 0）（`lexicon` 那条是它自己延迟回调的误报，首轮已落盘成功） |

### 自检

```sh
flutter analyze
flutter test                    # 96 项，含 dsh 子进程集成测试（含经 magpie 取回正文与用量）、备份引擎与导入导出的真目录读写（含「导出→另一台机器→导入」的往返）、状态读数、时间线的键盘导航、光学补偿取值锁、渐隐梯度、右栏动画中间态守卫、装配层开关读写
tool/typecheck_plugins.sh       # 插件源码类型自检（stub 版 cordis 声明）
node tool/boot_settle_probe.mjs # 启动时序补丁的最小验证（慢存储 → 重启 → 拿到依赖）
```

## 版权与许可

Copyright (c) 2024-2026 星玖工作室 Ntarstudio

本项目按目录分层授权，**只使用 Apache License 2.0 与 MIT 两种宽松许可证**，全文见 [LICENSE](LICENSE)（Apache-2.0）与 [LICENSE-MIT](LICENSE-MIT)（MIT），分层说明见 [LICENSING.md](LICENSING.md)。

| 路径 | 许可 |
|---|---|
| `lib/plugins/ondra-core/` `ondra-extensions/` `ondra-custom/` `dsh-base/` | Apache-2.0 |
| `lib/app/` `lib/design/` `lib/main.dart` `tool/` `test/` | MIT |
| `assets/brand/` `assets/personas/` `assets/icons/` 与品牌界面 | 保留所有权利 |

**为什么插件宿主用 Apache-2.0**：它比 MIT 多给两样东西——明示专利授权（第 3 条）与 NOTICE 保留义务（第 4 条 d 项）。插件作者最在意专利风险，这一条把它拆掉。同时两种许可都**无传染性**，第三方插件可以闭源，不必公开自己的实现。

`lib/plugins/cordis/` 是上游 [Cordis](https://github.com/cordiverse/cordis) 4.1.0 的发行包副本，许可证为 **MIT**，版权归其作者，不适用本仓库的分层授权。本项目原样引入，不改写。

**商标**。「空谷」「Ondra」「星玖工作室」「Ntarstudio」等名称与标识归星玖工作室所有；代码许可只给代码权利，不给商标权。衍生作品不得暗示其由 Ntarstudio 出品或获得背书。

**禁止引入 copyleft 组件**（GPL / LGPL / AGPL / MPL）：宽松许可无法反向吸收 copyleft，一旦引入，整个项目将被要求以该 copyleft 许可分发。

第三方组件、字体与图标的完整披露见 [NOTICE](NOTICE)。

**字体不入库**：`assets/fonts/MiSans-Ondra.ttf` 是 MiSans 子集，受《MiSans 字体知识产权许可协议》约束（第 2 条第 2 款禁改编、第 3 款禁分发副本），因此已从版本控制移除。需要 MiSans 字形时自行生成：

```bash
tool/subset_font.sh          # 自动找系统字体目录或 ~/Downloads 里的 MiSansVF.ttf
```

**没有字体也能跑**：构建与全部功能不受影响，应用自动降级到系统中文字体（苹方 / 冬青黑 / 微软雅黑 / 思源黑）。实现见 `lib/design/font_face.dart` 与 `tokens.dart` 的 `ondraFontFallback`，验收见 `test/font_fallback_test.dart`。
