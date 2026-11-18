# ondra-models · 模型基座（设置页）

**配置逻辑与 DSH 的模型设置一致，界面按空谷的风格做。** 运行时侧的解析与校验
在 `ondra-ui/ondra-model/`（同名插件、不同职责：界面编辑，插件解析）。

## 来源分类（六类）

添加提供商是「分类 → 预设 → 配置」三步。分类不是视觉分组，是**六种不同的处境**：

| 分类 | 预设 | 地址 | 密钥 | 说明 |
|---|---|---|---|---|
| 官方 API | DeepSeek / OpenAI / Anthropic / Kimi / 智谱 / 通义 | 官方地址 | 需要 | 按 token 计费 |
| 合作 API | 由 `ondra-beichen-api` 插件提供 | 合作方给 | 需要 | 换合作方只改插件里的目录 |
| 免费 API | our-free-model | 部署方给 | 需要 | 官方目录的精简版，模型 id 与官方一致（目录在 `provider_catalog.dart` 的 `freePresets`；等它需要独立更新节奏时再拆成插件） |
| 自定义 API | 无（空表单） | 自己填 | 视服务 | 中转站、自部署、协议兼容即可 |
| 本地部署 | llama.cpp / Ollama / LM Studio | `127.0.0.1` 常见端口 | 不需要 | 模型跑在本机 |
| 本地网关 | Magpie / LiteLLM / One API | 自己填 | 视网关 | 一个端口转发多家 |

分类只决定「模型在哪」，不决定协议——本地与网关同样是 OpenAI 兼容接口，
换过去不用改提示词。

## 本地部署与检测连接

`ui/probe.dart`（条件导出：桌面走 `dart:io`，Web 如实报错）请求 `{地址}/models`：

- 通了：把端点里的模型 id 合进模型目录（只补缺的，不动用户改过的条目）；
- 没通：把原因写在「连接」那一段下面，不重试、不猜端口。

llama.cpp 的 `llama-server`、Ollama、LM Studio、LiteLLM 都实现了这个路由，所以一个
探测覆盖「本地部署 + 本地网关」两类。本地预设还带一条启动命令提示
（`llama-server -m <模型>.gguf --port 8080`），不执行，只告诉你怎么起。

## 字段映射（与上游 settings.yaml 同名）

provider：`id` · `name` · `baseURL` · `apiKey`（secret，只写不读）· `apiKeyEnv` · `models[]`
model：`id` · `name` · `contextWindow` · `maxTokens` · `input[]`（text/image）· `reasoningEfforts[]`

推理档位每档是 `{label, apiValue}`——`apiValue` 是写进请求的推理强度字段值
（如 OpenAI 的 `reasoning_effort`），「关闭思考」档为空。

## 行为（照 DSH）

| 行为 | 规则 |
|---|---|
| 添加提供商 | 内置目录（OpenAI / Anthropic / Kimi…）或自定义模型 API |
| 自定义 API | 地址必填、至少一个模型、标识小写开头且唯一 |
| 内置提供商 | 只能编辑，不能删 |
| 删除提供商 | 连密钥一起清，默认模型回退到第一个可用 |
| 模型校验 | ID 非空且同提供商内不重复；容量写数字可带 K/M |
| 恢复目录 | 回到适配器自带的模型列表 |
| 密钥 | 只写不读；未存则回退 `apiKeyEnv` 环境变量 |

## 界面

列表页（提供商行 + 添加入口 + 默认模型）→ 编辑页（接入 + 模型目录，可展开进阶）→
添加页（目录选择一个 / 自定义表单）。

## 文件

- `ui/model_types.dart` · `ui/model_client.dart`
- 页面在 `../ui/console_sheet.dart` 的 `_model` / `_providerList` / `_CatalogPicker` /
  `_CustomProviderForm` / `_ProviderEditor`

## 未做

写钥匙串、联网「获取可用模型」——都要等平台层与运行时。
