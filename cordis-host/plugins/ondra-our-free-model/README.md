# ondra-our-free-model

> L9 运行时治理与扩展 · 〔复〕复用为主 · 服务键 **`ondra-our-free-model`**（连字符，非 `ondra:free-model`）

免费模型的**渠道目录与策略层**。回答三个问题：有哪些渠道、这个渠道长什么样、它现在能不能用。
**不回答第四个**：怎么把 token 流解出来——那归 `@ntars/ondra-llm-pi-ai`。

## 职责

- 随包分发 76 家聚合渠道、502 个模型的注册表（技术字段：endpoint、协议、认证方式、模型清单）。
- 定义两条免密车道：OpenCode（`Bearer public`）与 Kilo 免费池。
- 把任意一家渠道 / 一条车道翻成 pi-ai 的 provider profile。
- 探测模型清单是否可达、判定出口地区。
- **默认零出站**：`freeLanes` 默认 `false`，关闭时不探测、不判定、不生成车道 profile。

## 明确不负责

- **不写协议层**。仓库里已有 pi-ai 适配器，支持 `openai-completions` / `openai-responses` /
  `anthropic-messages` 三种线协议与「手写声明的网关」。再写一遍 SSE 解码等于自我复制（手册 §1.8）。
- **不持有凭据**。聚合渠道的 Key 归 `credentials` 域。本插件只写 `apiKeyEnv` 引用名，
  探测聚合渠道时需要调用方把认证头传进来。
- **不做降级链（combo）**。多条来源之间的切换归 `ondra-llm-gateway` 的选路，
  在渠道层再串一条链会出现两套优先级，谁生效看运气。
- **不做省 token 压缩**。RTK 工具输出压缩与提示词瘦身跟调用链耦合，
  塞进渠道层会让「渠道」这个概念的边界消失。
- **不做用量看板**。用量归 `token-meter`，界面归应用外壳。
- **不做应用内自升级**。与 Ondra 的统一升级器冲突：两个升级器同时改同一份文件，
  恢复路径会互相踩。
- **不搬公告与推荐位**。上游的 feed 与「推荐项目」页属于推广，与产品无关，已整体去掉。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-our-free-model` | 唯一归属 |
| 消费 | `ondra-identity` | **软依赖**（日志命名空间） |
| 消费 | `ondra-config-schema` | **软依赖**（四层合并；缺席走本地校验） |
| 协作 | `@ntars/ondra-llm-pi-ai` | **非服务依赖**：本插件产出 profile，应用把它写进 pi-ai 的 `providers` |

## 文件分层

| 文件 | 职责 | 约束 |
|---|---|---|
| `src/types.ts` | 契约 | 只有类型与常量 |
| `src/lanes.ts` | 两条免密车道的定义与风险文案 | 风险原文逐字保留，不改写 |
| `src/registry.json` | 76 家渠道注册表 | 上游 MIT 数据，去 `website` |
| `src/registry.ts` | 读表、逐条校验、丢弃坏条目 | 坏一条丢一条，不整体失败 |
| `src/probe.ts` | 模型清单探测、地区判定 | 超时 + 结构化失败，绝不抛到调用链 |
| `src/settings.ts` | 配置单一真源 | 三个开关分层，不合并 |
| `src/index.ts` | 接线、服务实现、定时探测 | 默认零出站 |

## 配置（全部有默认值）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关。关掉后不加载渠道、不注册服务 |
| `freeLanes` | **`false`** | 免密车道总开关。打开之前不产生任何出站请求 |
| `laneIds` | `["ofm-opencode","ofm-kilo"]` | 允许使用的车道（仅 `freeLanes=true` 时生效） |
| `channels` | `[]` | 聚合渠道白名单。空数组 = 一家都不启用 |
| `probeOnStart` | `false` | 启动时探一次车道清单 |
| `probeIntervalMinutes` | `30` | 定时探测间隔，`0` = 不探 |
| `probeTimeoutMs` | `5000` | 单次探测超时 |

三个开关**刻意不合并**：`enabled` 关掉是「连清单都不提供」；`freeLanes` 关掉是
「清单给你，但我不发请求」。合成一个布尔之后，「装了但不想知道它存在」
和「装了、我知道、但不用免费额度」就分不开了，而这两种状态真实存在。

## 接到 pi-ai（这是使用本插件的唯一方式）

本插件不注册 LLM adapter，只产出 profile。应用（或用户）把 profile 写进
`@ntars/ondra-llm-pi-ai` 的 `providers` 字典：

```yaml
- name: '@ntars/ondra-llm-pi-ai'
  config:
    providers:
      ofm-opencode:
        displayName: OpenCode 免费车道
        api: openai-completions
        baseURL: https://opencode.ai/inference/v1
        headers:
          Authorization: Bearer public
        models: []
```

三条必须说清的细节：

1. **`Authorization` 走 `headers`，不走 `apiKeyEnv`**。车道的 `Bearer public` 不是用户凭据，
   写成凭据引用会让 pi-ai 在请求前去解析一个不存在的环境变量，直接 `MISSING_CREDENTIAL`。
2. **`Authorization` 不会被归因头覆盖**。pi-ai 只把 `user-agent` 列为保留名，
   其余头原样透传（`llm-pi-ai/src/adapter.ts` 的 `reserved` 集合）。
3. **`models` 为空时选择器可能是空的**。pi-ai 的 GUI 要求模型属于目录成员，
   所以实际使用前要先探测一次拿回模型 id，再写入 `models`。

## 免密车道的风险（原样保留，不改写）

**OpenCode**：使用公开免密额度（`Bearer public`），不消耗用户自己的 Key，
但请求经第三方网关中转。对话内容是否留存由对方策略决定，本应用无法控制。

**Kilo**：模型卡原文写着

> Not suitable for production or sensitive data workloads

并声明 prompt 可能被记录用于改进服务。

这两段话原样带进隐私告知。它们是免费额度的对价，不是可以被「概括成请注意隐私」的提示。
只适合闲聊与试玩。

## 技术来源（数据来源与改动）

- 注册表取自 `Ebony-Vinyl/ondra-our-free-model`（MIT）的 `src/providers/registry.json`。
- 保留：`id` / `name` / `category` / `baseUrl` / `format` / `auth` / `models` / `local`。
- 去掉：`website`（官网推广位）、`feed` 公告、`notes` 里的推荐文案。
- 转换：`openai-chat` → `openai-completions`（pi-ai 的取值），其余两个同名直传。
- 未搬运：`adapter.js`（协议层）、`token-saver/`（省 token）、`combos.js`（降级链）、
  `updater.js`（自升级）、`src/feed.js`（公告）、UI 半身（界面归应用外壳）。

## 已知限制

1. **502 个模型里有一部分是地区受限的**。上游按出口 IP 决定可用性，本插件只报「可达 / 不可达」，
   不做地区映射表——那张表每天都在变，写死就等于造谣。
2. **聚合渠道不自动探测**。要 Key，而本插件不持有凭据，自动探测只会换回一串 401 把日志刷成噪声。
3. **`probeOnStart` 默认关闭**。开机就打第三方接口不是好默认值。
4. **渠道注册表是快照**。上游新增渠道需要更新本包；这与「模型清单动态拉取」是两件事，
   后者永远实时。

## 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 没有插件消费本服务键——全仓 `ctx.get('ondra-our-free-model')`
   命中 0。本插件产出 pi-ai 的 `ProviderProfile`，由调用方（用户配置或未来的网关层）取用，
   不存在「装了就自动生效」的链路。关掉后只是少了一组可选的免费车道，对话、
   记忆、通道都不受影响；本插件不被 import，任何包都不会编译失败。
2. **我的状态存在哪？** 没有运行时状态需要保存。`src/registry.json` 是随包发布的
   **只读**数据（76 家渠道、502 个模型，51,300 字节），运行时不改写；探测结果只进内存与日志，
   不落盘。车道开关来自配置，不写文件。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.our-free-model`
   （有 O-001 时走 `identity.loggerName('our-free-model')`）；注册表坏一条丢一条并记账，
   被丢掉的那条会在日志里点名。车道总开关关闭时**零出站**——连地区判定都不发。
4. **我依赖谁？缺席时我怎么降级？** 只有两个软依赖：`ondra-config-schema`（缺席则用实例配置）
   与 `ondra-identity`（缺席则日志名回退）。没有硬依赖，也没有第三方 SDK 依赖。
   **刻意不声明插件级 `inject`**：声明后依赖缺席会停在 PENDING，是最难查的失败形态。
5. **我和同域的谁共享了可变状态？** 没有。注册表是启动时载入的只读数组，`channels()`
   每次都返回**同一个引用**（调用方只读、不得改写）；`lanes()` 每次按当前配置重新算一遍数组。
   本插件不持有凭据、不缓存 token，聚合渠道探测必须由调用方自带认证头。
