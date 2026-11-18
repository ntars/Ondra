# 分层许可说明

> 本文件是人类可读的分层路由表。`LICENSE` 是 Apache-2.0 全文，`LICENSE-MIT` 是 MIT 全文。
> GitHub 只按 `LICENSE` 识别仓库主许可，因此显示为 Apache-2.0；MIT 覆盖的部分见下表。

本仓库按目录分层授权，只使用两种宽松许可证：**Apache License 2.0** 与 **MIT**。
许可全文见 [`LICENSE`](./LICENSE)（Apache-2.0）与 [`LICENSE-MIT`](./LICENSE-MIT)（MIT）。

Copyright (c) 2024-2026 星玖工作室 Ntarstudio

---

## 一、分层映射

| 路径 | 许可 | 说明 |
|---|---|---|
| `lib/plugins/ondra-core/` | **Apache-2.0** | 插件宿主核心、投影与状态管理 |
| `lib/plugins/ondra-extensions/` | **Apache-2.0** | 插件扩展 API 与契约 |
| `lib/plugins/ondra-custom/` | **Apache-2.0** | 内置插件实现 |
| `lib/plugins/dsh-base/` | **Apache-2.0** | 内核适配层（仅接口定义） |
| `lib/app/` | **MIT** | 三栏界面、导航、页面装配 |
| `lib/design/` | **MIT** | 设计令牌与主题 |
| `lib/main.dart` | **MIT** | 应用入口 |
| `tool/` | **MIT** | 构建与开发脚本 |
| `test/` | **MIT** | 测试 |
| `assets/brand/` 品牌名称、Logo、界面设计 | **保留所有权利** | 不随代码许可授予 |
| `assets/personas/` 人设包文本 | **保留所有权利** | 创作内容，非代码 |
| `assets/icons/` | **保留所有权利** | 见下方说明 |
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

## 五、禁止引入 copyleft 组件

宽松许可可以吸收宽松许可，但**不能反向吸收 copyleft**。
一个 GPL / LGPL / AGPL / MPL 组件一旦引入，整个项目将被要求以该 copyleft 许可分发，
Apache-2.0 与 MIT 的授权随之失效。引入新依赖前请核对 `NOTICE` 的兼容性表。
