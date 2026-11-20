[简体中文](README.md) | [English](README_EN.md)

# 空谷 Ondra

**全插件式桌面 AI 陪伴体：界面只读插件投影出来的状态，情绪、记忆与上下文是三个核心机制，数据全部留在这台机器上。**

![Status](https://img.shields.io/badge/status-alpha-fb8500?style=flat-square)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha-8957e5.svg?style=flat-square)](#)
[![GitHub license](https://img.shields.io/github/license/ntars/Ondra?style=flat-square)](./LICENSE)
[![Flutter](https://img.shields.io/badge/Flutter-desktop-02569B.svg?style=flat-square&logo=flutter&logoColor=white)](https://flutter.dev/)
[![Local](https://img.shields.io/badge/data-local--only-2ea44f.svg?style=flat-square)](#)
[![Tests](https://img.shields.io/badge/tests-96%20passing-2ea44f.svg?style=flat-square)](#)

---

## 一、项目名称与定位

**名称**：空谷 Ondra。应用名（窗口标题、Web 标题、关于页）写全名；界面里的品牌锁定只用短名「空谷」——侧栏仅 200 宽，全名会把菜单挤窄。

**一句话定位**：一个把「陪伴」拆成可装卸插件的桌面应用——同一份插件代码在桌面与手机上都跑，数据不离开本机。

**仓库描述**：`空谷 Ondra —— 全插件式桌面 AI 陪伴体：Cordis 插件体系，情绪、记忆、上下文三大机制，数据全留本机 | A plugin-first desktop AI companion: Cordis plugins with emotion, memory and context, all data kept on your machine.`

**话题标签**（20 个，仅英文）：`ai-companion`、`virtual-companion`、`ai-persona`、`emotional-ai`、`affective-computing`、`digital-life`、`long-term-memory`、`plugin-architecture`、`plugin-system`、`cordis`、`llm`、`local-llm`、`local-first`、`privacy-first`、`text-to-speech`、`speech-recognition`、`flutter`、`dart`、`typescript`、`desktop-app`

| 项 | 内容 |
|---|---|
| 版本 | 2.0.0-alpha |
| 状态 | 内测阶段：macOS 可构建可运行，Web 可构建，Windows 可构建但发布包尚未自带运行时 |
| 平台 | macOS（可运行）· Web（可构建）· Windows（可构建，构建中） |
| 仓库 | <https://github.com/ntars/Ondra> |
| 许可 | Apache-2.0 / MIT（按目录分层） |

**没有后端，也没有演示数据。** 清单里有几条插件就画几条；记忆、会话、备份、日志没有数据源时显示空态，不摆一组看起来像真的示例条目。

---

## 二、项目简介

### 2.1 背景

多数「AI 陪伴」产品的形态是一个聊天框加一句人设提示词。人设靠每轮重新描述维持，记忆靠把历史对话全塞进上下文，情绪靠形容词。三者都不可累积，换个会话就归零。

### 2.2 要解决的问题

把陪伴拆成**可分别工程化的机制**：情绪是带惯性的状态量，记忆是有链路的沉淀，上下文是有预算的装配；并且让这些机制能被第三方以插件形式替换，而不是焊死在应用里。

### 2.3 核心思路

界面是运行时客户端，不是插件框架。插件体系只有一套（Cordis），界面与插件之间只有**投影**一层；每个页面只读投影出来的状态，不直接持有插件内部数据。

### 2.4 适用场景

- 需要在本地运行、数据不出机器的桌面陪伴类应用；
- 需要插件化架构、希望第三方能替换记忆或情绪实现的场景；
- 需要同一份插件代码在桌面与移动端复用。

### 2.5 不适用场景

- 需要多用户账号与云端同步：本项目数据全在本机，也没有账号体系；
- 需要开箱即用的公网服务：没有后端；
- 需要移动端完整体验：三栏在窄屏退化为抽屉，属非目标形态。

### 2.6 优势与局限

| 优势 | 依据 |
|---|---|
| 插件即一切 | 能力、页面、服务都由插件提供，核心不可关闭但可替换实现 |
| 数据可验证地留在本机 | 默认走本机网关 `127.0.0.1:3425`，不填密钥、不联外网 |
| 备份内容寻址 | 第二份快照与第一份内容全同时新增 0 字节（本机实测） |
| 单一 UI 出口 | 页面不写死色值与字号，全部走 `lib/design/` |
| 诚实空态 | 零数据时说「情绪还没有第一次落定」，不说「等待数据源接入」 |

| 局限 | 影响范围 | 规避方式 |
|---|---|---|
| macOS 关闭沙箱 | 无法上架 Mac App Store | 直接分发 `.dmg`，README 与构建脚本均写明 |
| Web 端无子进程 | 右栏无法连本机内核，如实报错 | 用桌面端体验完整功能 |
| 窄屏形态非目标 | iOS / Android 三栏退化为抽屉 | 作为预览端，不作主力 |
| 钥匙串写入未完成 | 模型密钥需环境变量 | 用 `DEEPSEEK_API_KEY` / `MAGPIE_API_KEY` 注入 |

---

## 三、核心功能

| 功能 | 触发条件 | 结果 |
|---|---|---|
| 三栏外壳 | 启动 | 左栏 200 导航 + 中栏 480 起页面 + 右栏 280 聊天，窗口内容 960×600 |
| 右栏对话 | 在输入盒发送消息 | 拉起 `dsh --profile ondra` 子进程，JSON-RPC over stdio，默认路由到本机网关 |
| 插件扩展页 | 打开「插件」 | 合并随包清单 18 条与装配层 78 条，可开关（改 YAML 注释，下次连内核生效） |
| 记忆星图 | 打开「记忆」 | 读 `~/.ondra/user/ondra.db` 的 `memory_fact` / `memory_link`，按 id 哈希确定性排布 |
| 历史对话 | 打开「历史」 | 读内核会话库，标题取第一句用户消息，按最后活动倒序 |
| 备份与时间线 | 打开「备份」 | 内容寻址快照；时间线整窗接管，滚轮/↑↓ 穿梭、`⏎` 恢复、`esc` 退出 |
| 记忆导入导出 | 打开「导入导出」 | 导出 Markdown / JSON，导入真写库，id + 文本双重去重 |
| 状态面板 | 打开「状态」 | 三条体征、情绪两轴、三份日志、网关探活、内核装配体检 |
| 本地部署 | 设置「模型基座」 | 找 `llama-server`、下 GGUF、起停进程、轮询 `/v1/models` 判定就绪 |
| 网页浏览 | 白名单内打开请求 | 系统 WKWebView 平台视图，左栏无入口 |
| 设置真写内核 | 拨任一设置开关 | 变化项写进 `~/.ondra/dsh/settings.json`（`{user:{段:{kebab 字段}}}`），启动时全量对齐一次 |
| 系统侧开关 | 开机自启 / 阻止睡眠 / 通知 | 分别动 launchd 登录项、`caffeinate` 进程、`osascript display notification` |
| 繁忙时发送 | 生成中再发一句 | 「排队」攒到本轮结束依次发（带「N 句排队中」提示），「插话」停掉当前轮立刻发 |
| 回车发送 | 输入框回车 | 开：回车即发、⇧⌥ 换行；关：回车换行、⌘ 回车发送 |

---

## 四、插件清单（两套侧，各自真实现）

### 4.0.1 界面侧（Flutter，`lib/plugins/`）

| 插件 | 功能 | 状态 |
|---|---|---|
| ondra-ui | 三栏外壳、注册表、引导挂载点 | ✓ |
| ondra-onboarding | 首次启动引导（一屏，prefs 判据） | ✓ |
| ondra-status | 状态面板：真读 ondra.db / 日志 / 端口探活 | ✓ |
| ondra-memory | 记忆星图：真读 memory_fact / memory_link | ✓ |
| ondra-history | 历史对话 + 会话行点开只读详情 | ✓ |
| ondra-plugins | 插件管理：清单 18 项 + 装配层，开关真改 YAML | ✓ |
| ondra-backup | 备份还原：真文件 + 时间线 + 平台守卫 | ✓ |
| ondra-transfer | 导入导出：真文件 + sqlite，导出回读校验 | ✓ |
| ondra-guide | 使用教程（5 条问答） | ✓ |
| ondra-logs | 三类日志：真读 transport/ondra-code/window.log，档位接线 | ✓ |
| ondra-chat | 右栏聊天：附件真发内核、新建真换会话、离线常驻提示 + 重连 | ✓ |
| ondra-settings | 5 类设置：模型基座落盘 models.json、密钥真写钥匙串、人设记住选择 | ✓ |
| ondra-model | 模型基座投影：UI id → 内核路由翻译（kernelRouteOf） | ✓ |
| ondra-store / runtime | TS 内核实现（src/），无 Dart UI | ✓ |
| ondra-beichen-api / browser / voice / channel / emotion / relationship / font / locale | 内核侧 TS 实现（src/），浏览器白名单已落盘 | ✓ |

**设置的落点**：真生效的位置是 `~/.ondra/dsh/profiles/ondra/cordis.patch.yml`
里各条目的 `config` 块（内核装配时传给 `apply(ctx, config)`）。设置页改动
写这里，下一次内核启动生效；`settings.json` 是历史形状，内核不读它。

### 4.0.2 内核侧（TS，运行在 `plugin-profile/` 的 77 个 @ondra 包）

旧版 78 包按「是否共用一份状态」合并成 14 个新版（memory/emotion/persona/
relationship/channel/voice/model/store/runtime 等）；运行清单见
`lib/plugins/LAYOUT.md`。chat 链路上游 `deepseek-official` 与 `magpie`
两条路由由装配层声明，无路由的提供商在「设为默认」时被拦截并说明。

## 五、核心特性

### 5.1 插件即一切

界面不实现任何业务能力。`ondra-core/` 随包默认且不可关闭，`ondra-extensions/` 可开关，`ondra-custom/` 由用户自装；框架 `cordis/` 是宿主，不属于插件。

### 5.2 情绪是状态量，不是形容词

情绪带惯性：上一轮的状态会影响这一轮，而不是每轮重新描述一次。界面上两条轴显示的是落定后的值，零数据时显示「还没有第一次落定」。

### 5.3 记忆是链路，不是向量库

记忆从采集、提炼、判重、衰减、召回到注入是一条完整链路，每一环都是独立插件，可以单独替换或关闭。

### 5.4 上下文有预算

冻结前缀 + 增量注入 + 预算装箱：每轮重拼 system prompt 会让成本成倍上升，冻结前缀是成本敏感部分的解法。

### 5.5 备份内容寻址

`~/.ondra/backups` 下只有对象库与快照清单；相同内容只存一次，本机实测 32 个文件 / 437 KB，第二份快照新增 0 字节。

### 5.6 启动时序自愈

内核三十多个插件按「取不到依赖就转不可用」写，而 loader 是并发 apply。新增 `ondra-boot-settle` 在依赖真正就绪后重启抢跑的插件，本机实测启动降级条目 **55 → 0**。

---

## 六、设计细节与工程取舍

完整推演见 [docs/design-notes.md](docs/design-notes.md)，此处只留关键决定。

| 决定 | 理由 |
|---|---|
| 无系统标题栏，内容正好 960×600 | 三栏各有表头，再叠一条系统标题栏就成了两条；用 `frameRect(forContentRect:)` 换算外框，避免内容矮 32pt |
| 纸片圆角 12、四周让出 4px | 4px 是全部通透感的来源：纸与窗缘留缝，桌面从缝里透出来。纸必须实色，半透明会让缝与面糊成一片 |
| 右栏四态共用一条宽度轨道 | 收纳 / 展开 / 进沉浸 / 退沉浸可中途折返；收起后整栏仍留在树上以保住滚动位置与草稿，但用 `ExcludeFocus` 挡住键盘 |
| 默认走本机网关 magpie | 右栏不联外网；`apiKeyEnv` 必须有值，否则 pi-ai 的手工路由在凭据解析阶段直接失败 |
| 装配层开关改注释而非数据库 | 装配层是内核唯一入口，改动必须可回滚：写前留 `.bak`，先写临时文件再改名 |
| 恢复只覆盖不删除 | 「快照里没有」既可能是当时没这个文件，也可能不在备份范围；分不清就不删，且恢复前先存 `preRestore` 快照 |
| 字体不入库 | MiSans 子集受字体许可限制（禁改编、禁分发副本），构建时可选生成，缺失时降级到系统字体 |

---

## 七、技术栈与依赖清单

| 层 | 技术 | 版本约束 |
|---|---|---|
| 界面 | Flutter（桌面 + Web） | Dart SDK ^3.14.0 |
| 插件框架 | Cordis（`@deepseek-ai/cordis`） | 4.1.0，原样引入，MIT |
| 内核 | dsh（`@deepseek-ai/dsh`） | 全局安装，子进程 JSON-RPC over stdio |
| 插件源码 | TypeScript | 随 `~/.ondra/dsh/profiles/ondra` |
| 本地存储 | SQLite（经 `/usr/bin/sqlite3 -json` 读取） | 不引入原生包 |
| 模型网关 | magpie（OpenAI 兼容） | `127.0.0.1:3425` |
| 测试 | `flutter test` | 96 项 |

完整第三方披露（含字体与图标）见 [NOTICE](NOTICE)。

---

## 八、安装与部署

### 8.1 环境要求

| 项 | 要求 | 用途 |
|---|---|---|
| Flutter | 3.32+（Dart 3.14+） | 构建桌面与 Web |
| Xcode | 完整安装 | macOS 构建 |
| Node.js | 18+ | 安装 dsh 内核与插件 |
| llama.cpp | 可选，`brew install llama.cpp` | 本地模型部署 |

### 8.2 安装与运行

```sh
git clone https://github.com/ntars/Ondra.git
cd Ondra && flutter pub get
flutter run -d macos
```

### 8.2.1 安卓端的现状（如实）

**内核在安卓上可以跑起来了（v3.0.0-alpha.5 起）**。做法是业界标准的
jniLibs 路线：node 二进制（Termux 编译的 bionic ELF，node 26）伪装成
`libnode.so` 放进 jniLibs——安卓 10+ 只禁数据目录的 exec，nativeLibraryDir
允许执行；node 的动态依赖（openssl/icu/sqlite 等 9 个库）同源同包，DT_NEEDED
的版本号在打包时用 pyelftools 原地改短（APK 只收 lib*.so 结尾）。dsh 依赖
闭包打 assets，首次启动解压到应用私有目录，MANIFEST 按构建号幂等。

已知边界（真机验证前如实记录）：
- node-pty / koffi / sharp 等原生模块没有 android-arm64 编译件——对话链路
  不依赖它们，用到时会按插件加载失败降级；
- **尚未在真机/模拟器上跑过端到端握手**（本机与 CI 都没有安卓运行环境），
  第一次真机启动请看 logcat 里的 transport 日志确认内核握手；
- universal 包含全部 ABI，arm64 包只含 arm64。

安卓版可用的是**界面与本地数据**：聊天外壳、主题/语言/字号、模型与密钥的
CRUD、状态/记忆/历史/日志/插件页的展示与空态、反馈、备份的本地创建。

**v3.0.0-alpha.8 补齐的原生能力**：换头像（系统选图 + 原生裁切落盘）、
系统通知（API 33+ 运行时授权）、阻止空闲睡眠（FLAG_KEEP_SCREEN_ON）、
内嵌浏览器（系统 WebView，白名单协议与桌面一致）。

**仍不可用且已在界面上如实提示**：导入导出与打开目录（没有系统文件面板）、
llama 本地模型、开机自启（安卓没有系统级 API）。

时间线两栏折叠、触控 44dp、教程文案分派已在 v3.0.0-alpha.4 完成。

**签名与包名**：包名 `cn.ntars.ai`（域名反推，自 v3.0.0-alpha.7 锁定，
不再变更）。签名从 v3.0.0-alpha.3 起用固定的 release keystore（仓库不存
密钥，CI 经 secrets 注入）。指纹 `04:D5:19:FF:…:3D:7F`——所有版本一致。

**覆盖安装的分界线**：v3.0.0-alpha.6 及更早是旧包名 `com.example.ondra`，
与现包名互不覆盖——装 alpha.7 前要先卸载旧版；alpha.7 起内部互相覆盖安装。
旧版卸载会带走其私有数据目录，需要保留数据的先用应用内备份导出再装新版。

**产物名**：构建产物与 CI artifact 里是 `空谷 Ondra-<版本>-<架构>.apk`；
GitHub Release 会把非 ASCII 的资产名转写成 `Ondra-<版本>-<架构>.apk`
（平台对 asset name 的限制），下载下来的 APK 安装后桌面图标名仍是「空谷 Ondra」。

### 8.3 直接下载

三端安装包在 [Releases](https://github.com/ntars/Ondra/releases) 里，附 `SHA256SUMS.txt`：

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS（通用二进制） | `Ondra-3.0.0-alpha-macos-universal.dmg` | Intel 与 Apple Silicon 同一个包 |
| Windows（x64） | `Ondra-3.0.0-alpha-windows-x64.zip` | 解压后运行 `ondra.exe`，必须整目录解压 |
| Android | `Ondra-3.0.0-alpha-android-arm64.apk` | 常规手机；`-universal.apk` 含 32 位与模拟器 |

校验：`shasum -a 256 -c SHA256SUMS.txt`。三个包都没有正式签名，首次打开按发行版说明处理系统拦截。

### 8.4 构建与分发

**先装配运行时，再打包。** 应用自带 Node 与内核，这两步不能省——只跑
`flutter build` 出来的包里没有任何运行时，装到别人机器上会连不上内核。

装配脚本是 `tool/assemble_runtime.mjs`（node 实现，macOS / Windows / Linux 同一份）。
`tool/assemble_runtime.sh` 只是转发。**必须在目标平台上跑**：node 二进制与
原生模块（node-pty / koffi）都是平台相关的，不能交叉产出。

```sh
# 1. 装配随包运行时 → runtime/<平台>-<架构>/
#    从本机已装的 node 与 @deepseek-ai/dsh 拷一份裁剪过的闭包，
#    连同 profile 种子，用真实握手自检。
node tool/assemble_runtime.mjs
# 产物内容约 180MB（node 108 + dsh 67 + profile 4.3；小文件多，磁盘占用约 198MB）
# Windows 另加 sqlite3.exe 4MB

# 2. macOS：构建 + 塞进 .app + 重签
tool/bundle_macos.sh
# → build/macos/Build/Products/Release/空谷 Ondra.app（约 245MB）
#   加 --sign "Developer ID Application: 你的名字 (TEAMID)" 可出可分发签名
```

#### 装配的输入是仓库里的 `plugin-profile/`

内核的插件树（77 个 `@ondra/cordis-plugin-*`）原本只存在于
`~/.ondra/dsh/profiles/ondra`，而那条目录是靠「在本机跑过一次应用、且
`~/Downloads/plugins` 里有插件源码」才有的。拿它当装配输入，等于让出包依赖
本机的偶然状态：CI runner 上永远没有，不同机器打出的包内容也各不相同。

所以装配默认读仓库内的 `plugin-profile/`。它是一份**构建输入快照**
（`package.json` + `cordis.patch.yml` + 77 个包编译产物，4.3MB / 596 个文件），
由 `tool/sync_plugin_profile.mjs` 从真实 profile 固化：

```sh
# 插件改了之后（先重新装进 ~/.ondra/dsh/profiles/ondra，再同步）
node tool/sync_plugin_profile.mjs
git diff --stat plugin-profile      # 先看包数量与装配结构的变化合理不合理
```

装配时会比对「快照」与「本机 profile」：不一致就警告并打出差异，但**打的是快照**
（这样本地与 CI 的包始终对应同一份提交）。要临时用本机那份：
`ONDRA_PROFILE_SRC=~/.ondra/dsh/profiles/ondra node tool/assemble_runtime.mjs`。

Windows 的运行时由 CMake 在 `flutter build windows --release` 期间拷进
`build\windows\x64\runner\Release\runtime\windows-x64\`（见
`windows/CMakeLists.txt`）。**缺了它构建会直接失败**，不是警告：Windows 上
不存在可退回的系统 dsh，少了这一份，装出来的应用双击后连不上内核。
确实只需要界面时，设环境变量 `ONDRA_ALLOW_NO_RUNTIME=1` 跳过（`flutter build`
不转发自定义 `-D` 给 CMake，所以走环境变量）。Windows 没有系统
`sqlite3`，装配脚本会从 sqlite.org 取官方 `sqlite3.exe`（SHA3-256 校验）；
内网环境可用 `ONDRA_SQLITE3_BIN` 指向本机副本，或 `ONDRA_SKIP_SQLITE=1` 跳过。

`runtime/` 不进版本库（见 `.gitignore`）：它是二进制，而且必须与本机内核
同版本，提交进去会让「打进包的内核」和「测试过的内核」悄悄分叉。
`plugin-profile/` 相反，**必须提交**——它是文本与小型编译产物，正是为了让
装配在任何机器上可重现。

```sh
# macOS：出 zip 与 dmg
ditto -c -k --norsrc --noextattr --keepParent "空谷 Ondra.app" Ondra-macos.zip
hdiutil create -volname "空谷 Ondra" -srcfolder "空谷 Ondra.app" -ov -format UDZO Ondra-macos.dmg

# Android：arm64 单架构 18.6 MB，全架构 52.7 MB
flutter build apk --release --target-platform android-arm64

# Web：静态产物，连不上本机内核
flutter build web --release     # → build/web
```

`ditto` 必须用 `--norsrc --noextattr`。`--sequesterRsrc` 会把扩展属性塞进 `__MACOSX/`，
解压端多出几百个 `._*` 叶文件，WinRAR 与部分解压工具还会误判为损坏。

**Windows 只能在 Windows 上构建**（MSVC 没有交叉编译），走 `.github/workflows/release.yml`：
Actions → Release build → Run workflow，结束后在 Artifacts 取 `ondra-windows`。

Windows 的构建前置比 macOS 多一步，而且**不能省**：`flutter build windows` 之前
必须先 `node tool\assemble_runtime.mjs`，否则 CMake 会因为找不到
`runtime\windows-x64\node.exe` 直接失败。

⚠️ 而这一条在干净的 CI runner 上跑不通：装配脚本的 profile 种子取自
`%USERPROFILE%\.ondra\dsh\profiles\ondra`，那是**应用跑过一次之后**才有的东西
（插件包由安装器下发）。所以要么让 Windows 发布包在「跑过一次应用的机器」上出，
要么把 `runtime\windows-x64\` 作为构建缓存（`actions/cache`）在 job 之间传递。
两者都还没接进 workflow——现在的 `release.yml` 里没有这两步，打出来的 Windows
包不含运行时。

四条硬约束：关闭 App Sandbox（要拉起本机子进程）、不引入原生插件、GUI 应用自行探测 `dsh` 路径、数据目录独立（`DSH_HOME=~/.ondra/dsh`）。

### 8.5 升级与卸载

升级：替换 `.app`，数据目录不动。卸载：删除应用与 `~/.ondra/`（含会话、记忆、备份、日志），删除后不可恢复，操作前建议先用备份页导出一份。

### 8.6 容器化

桌面应用不做容器化；Web 构建产物为静态文件，可部署到任意静态托管，但无法连本机内核。

---

## 八、快速开始

```sh
flutter run -d macos            # 桌面：能起 dsh 子进程，右栏可真的说话
flutter run -d chrome           # 浏览器预览：无法起子进程，右栏如实报错
tool/dev.sh                     # 开发预览：9060 起，带热重载（终端 r / R / q）
```

桌面上让右栏真的生成回复，需要两件事：

```sh
npm i -g @deepseek-ai/dsh       # 内核
export DEEPSEEK_API_KEY=sk-...  # 模型密钥
```

预期结果：启动屏显示「空谷 · 记得住，也帮得上」，进入三栏外壳；左栏十项可切换；右栏发送消息后返回正文与用量。

调试参数（仅 Web）：`?page=plugins` 直达某页、`?settings=1` 开设置、`?boot=hold` 停住启动屏。

---

## 九、配置说明

| 键名 | 类型 | 默认值 | 必填 | 作用 |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | 环境变量 | 无 | 右栏对话时需要 | 模型密钥 |
| `MAGPIE_API_KEY` | 环境变量 | 应用注入占位值 `local-loopback` | 否 | 本机网关凭据；空值会让手工路由直接失败 |
| `DSH_HOME` | 环境变量（子进程注入） | `~/.ondra/dsh` | 否 | 内核数据目录 |
| `ONDRA_DSH_HOME` | 环境变量 | 无 | 否 | 覆盖 `DSH_HOME` |
| `--dart-define` | 构建参数 | 无 | 否 | 构建期常量注入 |

数据与日志位置：`~/.ondra/user/ondra.db`（记忆）、`~/.ondra/dsh/`（会话与装配层）、`~/.ondra/backups/`（快照）、`~/.ondra/logs/transport.log`（传输）、`ondra-code.log`（插件）、`window.log`（窗口）。

热更新：插件装配层改动在下次连接内核时生效，正在运行的进程不会重读 YAML，界面会如实提示。

---

## 十、API 与模块说明

| 接口 | 形态 | 说明 |
|---|---|---|
| `plugin.json` | 清单 | 字段：`id` / `layer` / `closable` / `owner` / `provides` / `depends` |
| 插件 id 规则 | 命名 | `ondra-` 前缀 + 连字符；Dart 文件名仍用 snake_case |
| 注入 | `ctx.inject([...], cb)` | 回调式注入，服务全部就绪后执行；普通 `inject` 对未 provide 的服务不阻塞 |
| 投影 | `*_client.dart` | 界面与插件之间唯一一层，页面不直接 import 插件内部 |
| 模块注册 | `OndraModule` | 一个模块 = 侧栏一项 + 一个页面，装配表在 `ondra-ui/ui/registry.dart` |
| 内核协议 | JSON-RPC over stdio | 子进程 `dsh --profile ondra`，初始化握手与消息流 |

第三方内核（`cordis`、`dsh-base`）保留官方名，便于与上游一比一同步。

---

## 十一、目录结构

```text
Ondra/
├── lib/
│   ├── main.dart                 唯一入口：读人设 / 插件清单 → 接内核 → runApp
│   ├── app/                      根组件、窗口能力、版本与调试端口
│   ├── design/                   颜色 / 圆角 / 间距 / 字重、主题、页框、基元
│   └── plugins/                  一切能力都是 Cordis 插件
│       ├── cordis/               框架本体（4.1.0，原样引入）
│       ├── dsh-base/             内核
│       ├── ondra-core/           随包默认、不可关闭（UI 全在 ondra-ui/ 下）
│       ├── ondra-extensions/     随包默认、可关闭
│       └── ondra-custom/         用户自装
├── macos/                        原生窗口入口（无标题栏、960×600）
├── assets/                       品牌、人设、图标
├── docs/                         design-notes.md、platforms.md
├── tool/                         dev.sh、icons.sh、subset_font.sh、typecheck_plugins.sh
└── test/                         96 项测试
```

---

## 十二、性能表现

已实测指标（本机 macOS）：

| 项 | 结果 | 条件 |
|---|---|---|
| 启动降级条目 | 55 → 0 | 加入 `ondra-boot-settle` 后，18 个插件重启成功 |
| 备份去重 | 第二份快照新增 0 字节 | 32 个文件 / 437 KB，内容全同 |
| 记忆导入去重 | 原样导回两次均 0 新增、10 条跳过 | 10 条记忆 / 55 条原文 |
| 测试 | 96 项全通过 | `flutter test` |
| 插件装载 | 75 / 76 | 唯一失败项需 `node:net` 起端口探测 |

未实测项：帧率、内存占用、冷启动耗时。这些数字未做基准测试前不写入文档。

---

## 十三、安全与隐私

- **默认不联外网**：右栏默认走本机网关 `127.0.0.1:3425`。
- **密钥不进快照**：`.credentials.yaml` 明确排除在备份范围外；`logs/`、`cache/`、`tmp/`、`node_modules/` 同样不收。
- **沙箱关闭的代价**：为拉起本机子进程与读写用户目录，macOS 沙箱关闭，因此不上架 App Store、直接分发。
- **网页浏览有白名单**：`ondra-browser` 仅打开白名单内地址，且被动触发、左栏无入口。
- **第三方插件是受信任代码**：插件在应用进程内运行，不是安全沙箱；安装来源不明的插件前需自行评估。
- **漏洞上报**：见 [SECURITY.md](SECURITY.md)。

---

## 十四、兼容性说明

| 平台 | 状态 | 说明 |
|---|---|---|
| macOS | 可构建、可运行 | 关闭沙箱；无标题栏；960×600 |
| Web | 可构建 | 界面完整，无法起子进程 |
| Windows / Linux | 生成过工程 | 窗口尺寸尚未下沉到原生入口，功能不受影响 |
| iOS / Android / 鸿蒙 | 生成过工程 | 三栏在窄屏退化为抽屉，非目标形态 |

运行环境：Flutter 3.32+ / Dart 3.14+；内核需要 Node.js 18+。字体缺失时自动降级到苹方 / 冬青黑 / 微软雅黑 / 思源黑。

---

## 十五、已知问题与限制

### 15.1 已知问题

| 问题 | 影响范围 | 临时规避 | 跟踪 |
|---|---|---|---|
| 模型密钥只能走环境变量 | 设置页写钥匙串未完成 | `export DEEPSEEK_API_KEY=...` | 待平台层 |
| Web 端无法连内核 | 右栏在浏览器里不可用 | 使用桌面端 | 设计边界 |
| 五个插件 `schema.register()` 未挂 `ctx.effect` | 重启时会撞「段键已登记」 | 当前不在重启名单，未触发 | 已记录待办 |
| 窄屏三栏退化 | 移动端体验受限 | 作预览端 | 未排期 |

### 15.2 未实现功能

| 功能 | 原因 | 计划状态 |
|---|---|---|
| 钥匙串写入 | 需平台层实现 | 计划中 |
| Windows / Linux 窗口尺寸下沉 | 需各平台原生入口 | 计划中 |
| `asr` / `vision` 插件 | 依赖（隐私、清单）未就绪 | 未排期 |
| 多用户与云同步 | 与「数据留本机」定位冲突 | 不做 |

---

## 十六、更新日志

遵循 Keep a Changelog 与语义化版本。

### [2.0.0-alpha] - 2026-11-18

- 变更：前端由 Flutter 重写，三栏外壳、纸片层与右栏四态完成。
- 新增：`ondra-boot-settle` 启动时序补丁，启动降级条目 55 → 0。
- 新增：内容寻址备份与时间线界面，第二份快照新增 0 字节。
- 新增：记忆导入导出（Markdown / JSON），真写库并双重去重。
- 新增：插件扩展页，合并随包 18 条与装配层 78 条。
- 测试：`flutter test` 96 项通过。

---

## 十七、后续路线图

| 计划项 | 目标版本 | 状态 |
|---|---|---|
| 钥匙串写入与密钥管理 | 2.0.0-beta | 计划中 |
| Windows 发布包自带运行时（装配与缓存接入 workflow） | 2.0.0-beta | 构建中 |
| Windows 原生窗口入口 | 2.0.0-beta | 构建中 |
| Linux 原生窗口入口 | 2.0.0-beta | 计划中 |
| 五处 `schema.register()` 改为 effect 包裹 | 2.0.1 | 计划中 |
| 记忆链路端到端可视化 | 2.1.0 | 计划中 |
| 帧率与冷启动基准测试 | 2.1.0 | 计划中 |

均为非承诺计划，按实际需要调整。

---

## 十八、参与贡献

- 开发环境：Flutter 3.32+ / Dart 3.14+ / Node.js 18+。
- 自检三件套：`flutter analyze`、`flutter test`、`tool/typecheck_plugins.sh`。
- 分支模型：`main` 保持可构建；改动走 `feat/`、`fix/` 分支。
- 提交信息：`<type>(<scope>): <subject>`，scope 取 `ui` / `plugin` / `core` / `design` / `docs`。
- 新增插件须提供 `plugin.json` 与 README，并在装配层登记依赖。
- 详细流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- 贡献者及其职责范围见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

---

## 十九、版权与许可

Copyright © 2024-2026 星玖工作室 Ntarstudio. Licensed under Apache-2.0 / MIT.

| 路径 | 许可 |
|---|---|
| `lib/plugins/ondra-core/` `ondra-extensions/` `ondra-custom/` `dsh-base/` | Apache-2.0 |
| `plugin-profile/`（插件装配快照）`assets/plugins/manifest.json` | Apache-2.0 |
| `lib/app/` `lib/design/` `lib/main.dart` `tool/` `test/` `docs/` `assets/locales/` | MIT |
| `assets/brand/` `assets/personas/` `assets/icons/` 与品牌界面 | 保留所有权利 |

**默认归属**：上表未列出的本项目自研文件，一律适用根 `LICENSE`（Apache-2.0）。
逐路径路由、平台脚手架的归属、再分发须保留的文件清单，见 [LICENSING.md](LICENSING.md)。

`lib/plugins/cordis/` 是上游 Cordis 4.1.0 的发行包副本，许可为 MIT，版权归其作者，不适用本仓库分层授权。

「空谷」「Ondra」「星玖工作室」「Ntarstudio」等名称与标识归星玖工作室所有；代码许可只给代码权利，不给商标权。禁止引入 copyleft 组件（GPL / LGPL / AGPL / MPL）。

---

## 二十、NOTICE 开源合规声明

第三方组件摘要：

| 组件 | 用途 | 许可 |
|---|---|---|
| Cordis 4.1.0 | 插件框架（原样引入） | MIT |
| dsh 内核 | 对话与工具调用 | 随上游 |
| Flutter 运行时依赖 | 界面与渲染 | BSD-3-Clause |
| lucide 图标 | 界面图标 | ISC |
| MiSans 子集 | 中文字形（不入库，可选生成） | MiSans 字体许可 |

完整清单、字体限制说明与商标条款见 [NOTICE](NOTICE)。
