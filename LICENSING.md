# 分层许可说明

> 本文件是人类可读的分层路由表。`LICENSE` 是 Apache-2.0 全文，`LICENSE-MIT` 是 MIT 全文。
> GitHub 只按 `LICENSE` 识别仓库主许可，因此显示为 Apache-2.0；MIT 覆盖的部分见下表。

本仓库按目录分层授权，只使用两种宽松许可证：**Apache License 2.0** 与 **MIT**。
许可全文见 [`LICENSE`](./LICENSE)（Apache-2.0）与 [`LICENSE-MIT`](./LICENSE-MIT)（MIT）。

Copyright (c) 2024-2026 星玖工作室 Ntarstudio

---

## 零、默认归属（先看这条）

**下表未列出的、由本项目编写的文件，一律适用根 [`LICENSE`](./LICENSE)，即 Apache-2.0。**

这条兜底规则是必须的。只列目录而不写默认值，克隆者面对 `pubspec.yaml`、
`analysis_options.yaml` 这类根级配置就无从判断归属，法律上等于没有授权。
需要相反结果的路径，必须显式写进下表——**不存在「靠猜」的路径**。

第三方文件与「保留所有权利」的内容不适用本兜底条款，它们按第二、三节处理。

---

## 一、分层映射

| 路径 | 许可 | 说明 |
|---|---|---|
| `lib/plugins/ondra-core/` | **Apache-2.0** | 插件宿主核心、投影与状态管理 |
| `lib/plugins/ondra-extensions/` | **Apache-2.0** | 插件扩展 API 与契约 |
| `lib/plugins/ondra-custom/` | **Apache-2.0** | 内置插件实现 |
| `lib/plugins/dsh-base/` | **Apache-2.0** | 内核适配层（仅接口定义） |
| `plugin-profile/` | **Apache-2.0** | 内核插件装配快照（77 个首方插件包的编译产物，由 `tool/sync_plugin_profile.mjs` 生成，非独立源码） |
| `assets/plugins/manifest.json` | **Apache-2.0** | 插件清单，属插件体系元数据 |
| `lib/app/` | **MIT** | 三栏界面、导航、页面装配 |
| `lib/design/` | **MIT** | 设计令牌与主题 |
| `lib/main.dart` | **MIT** | 应用入口 |
| `tool/` | **MIT** | 构建与开发脚本 |
| `test/` | **MIT** | 测试 |
| `docs/` | **MIT** | 架构与平台说明 |
| `assets/locales/` | **MIT** | 界面文案资源 |
| `pubspec.yaml` `pubspec.lock` `analysis_options.yaml` `.metadata` | **MIT** | 根级工程配置 |
| `android/` `ios/` `macos/` `windows/` `linux/` `web/` `ohos/` | **随上游模板 / 本项目改动随根许可** | 平台脚手架由 Flutter 与 OpenHarmony 模板生成，模板本身随各自 SDK 的 BSD-3-Clause；本项目对其的修改不单独主张 |
| `assets/brand/` 品牌名称、Logo、界面设计 | **保留所有权利** | 不随代码许可授予 |
| `assets/personas/` 人设包文本 | **保留所有权利** | 创作内容，非代码 |
| `assets/icons/` | **保留所有权利** | 其中 30 枚取自 Lucide（ISC），见 [`NOTICE`](./NOTICE) 第五节 |
| `assets/fonts/` | **不含字体文件** | 只有 `.gitkeep` 占位，见 §2.1 |

## 二、第三方框架

`lib/plugins/cordis/` 是上游 [Cordis](https://github.com/cordiverse/cordis) 的发行包副本，
版权归其作者，**许可证为 MIT**，不适用本仓库的分层授权。其 `LICENSE` 文件已随目录保留。
本项目不打散、不改写其代码，仅原样引入以便与上游一比一同步。

### 2.1 字体不在本仓库中

`assets/fonts/` 只有 `.gitkeep` 占位，**不含任何字体文件**。

界面字体 MiSans 的许可协议第 2 条第 2、3 款禁止「改编或二次开发」与「单独再分发
字体软件或其任何副本」；子集化与随公开仓库分发同时触碰这两条。因此字体由使用者
在本机用 `tool/subset_font.sh` 生成，生成结果已被 `.gitignore` 排除。

缺少字体时应用自动降级到系统中文字体，构建与功能不受影响。细节见
[`NOTICE`](./NOTICE) 第四节。

## 三、Apache-2.0 的两条额外义务

插件宿主与扩展 API 选 Apache-2.0 而非纯 MIT，是因为它多给两样东西：

1. **明示专利授权**（第 3 条）：贡献者授予你使用其专利的许可。插件作者最担心这一点。
2. **NOTICE 保留义务**（第 4 条 d 项）：再分发时须保留 [`NOTICE`](./NOTICE) 中的归属声明。

除此之外与 MIT 一样宽松：可商用、可闭源、可修改、可再许可，**没有传染性**。
**这一点对插件生态是决定性的**：第三方插件可以是闭源的，不必公开自己的实现。

## 四、商标

「空谷」「Ondra」「星玖工作室」「Ntarstudio」等名称、Logo 与界面设计归星玖工作室所有。
代码许可只授予**代码**权利，不授予商标权，也不授予「暗示获得原作者背书」的权利。
修改版请更换品牌标识，或明确标注为非官方版本。

## 五、再分发时须一并保留的文件

| 文件 | 依据 |
|---|---|
| `LICENSE`（Apache-2.0 全文） | Apache-2.0 第 4 条 a 项 |
| `LICENSE-MIT`（MIT 全文） | MIT 正文「须包含上述版权声明与许可声明」 |
| `NOTICE` | Apache-2.0 第 4 条 d 项 |
| `lib/plugins/cordis/LICENSE` | 上游 MIT 声明 |
| 各源文件中已有的版权与许可声明 | Apache-2.0 第 4 条 b 项 |

本仓库**没有** `LICENSES/` 目录，许可全文只有根目录这两个文件。

## 六、禁止引入 copyleft 组件

宽松许可可以吸收宽松许可，但**不能反向吸收 copyleft**。
一个 GPL / LGPL / AGPL / MPL 组件一旦引入，整个项目将被要求以该 copyleft 许可分发，
Apache-2.0 与 MIT 的授权随之失效。引入新依赖前请核对 `NOTICE` 的兼容性表。
