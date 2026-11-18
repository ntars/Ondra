# ondra-model · 模型网关（运行时侧）

与设置页的 `ondra-models`（Flutter 侧）**共用同一套字段**，职责不同：
界面编辑，这里解析与校验。字段名照 DSH：`id / name / baseURL / apiKeyEnv / models[]`，
model 是 `id / name / contextWindow / maxTokens / input[] / reasoningEfforts[]`。

## 对外

`ctx.modelBase`：`setProviders(list)` / `providers()` / `resolve()` / `timeout()`。

## 校验（照官方提示语）

- 提供商 id：小写开头，可含数字与短横线，唯一。
- 自定义 API：地址必填、至少一个模型。
- 模型 id：非空、同提供商内不重复；容量写数字可带 K/M。

## 不做

不发起请求、不存密钥：请求由内核的 LLM 适配器发，密钥由平台层写钥匙串。
