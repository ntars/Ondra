# ondra-llm-gateway

> O-035 · L3 对话链 · 〔薄〕薄封装 · 服务键 **`ondra-llm-gateway`**（连字符）

空谷 Ondra 的**模型供给**：一张来源清单（在线 API / 本地 / 免费），按优先级选路，
卡首块与块间隔超时，在**首块之前**重试与跨来源降级，并把用量记下来。

它是**全仓阻塞项**——`O-011` 记忆提炼、`O-014` 检索扩展、`O-019` 做梦都等这条路径。

```
调用方（提炼 / 做梦 / 评估）
   ↓  gateway.complete({ messages })
ondra-llm-gateway   来源清单 · 选路 · 超时 · 重试 · 降级 · 记账
   ↓  ctx.llm.stream({ provider, model, messages, signal })
上游适配器（llm-deepseek / llm-pi-ai …）  SSE 解码 · 重放状态 · 模型目录
   ↓
模型服务商
```

## 职责

- **来源清单**：`sources` 是一个数组，每条声明 `id / kind / provider / model / priority`。
  `kind` 只有三种：`remote`（在线 API）、`local`（本地大模型）、`free`（免费模型）。
- **可用性判定**：`probe()` 只读上游注册表，核对每条来源的 `provider` 路由是否真的注册了。
  没注册的来源标 `provider-missing` 并跳过——**不发起一次注定失败的请求**。
- **选路**：`resolve()` 按 `priority` 升序取第一条可用来源；`request.source` 可以点名指定。
- **首块超时**：从发请求到第一个块，默认 20000ms。
- **块间隔超时**：两个块之间最长能等多久，默认 60000ms。
- **重试**：同一条来源内按可重试码重试，默认最多 2 次尝试，指数退避 + 对称抖动。
- **跨来源降级**：一条来源用尽后换下一条（`allowFallback`，默认开）。
- **用量记账**：从 `usage` 块累计输入/输出/缓存命中，`stats()` 给快照。只记账，不判价。
- **非流式便捷口**：`complete()` 把正文拼起来一次给，内部仍走 `stream()`。

## 明确不负责

- **不写 provider 适配器**：SSE 解码、重放状态、模型目录、图片投影全归上游 `llm-*` 适配器。
  在这里再实现一遍协议编解码，等于把协议层自研一次（§1.8 违规）。
- **不注入密钥**：见下面「关键取舍 1」。配置里只有**引用名**，值永不出凭据域。
- **不拼提示词**：`messages` 原样透传，一个字都不改（§8.5 前缀缓存）。
- **不做会话**：不建 Session、不写 `app_session_log`、不管历史裁剪（那是 O-033 的事）。
- **不缓存响应**：任何形式的响应缓存都会让「所有来源共享一份可变状态」，违背 §14.2。
- **不算钱**：单价与折算归 `token-meter` 与界面；网关只报 token 数。
- **不落盘**：统计只在内存，卸载即清零。
- **不做网络探测**：探一次模型就是一次真实计费请求，不放启动路径。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-llm-gateway` | 唯一归属 |
| 消费 | 上游 `llm`（`ctx.llm`） | **硬能力**；缺席时服务仍注册但 `available=false` |
| 消费 | 上游 `credentials`（`ctx.credentials`） | 软；缺席则跳过凭据预检 |
| 消费 | `ondra-config-schema` | 软；有它则配置走四层合并与来源追溯 |
| 消费 | `ondra-identity` | 软；只取日志命名空间 |

契约定义在 `src/types.ts`：`LlmGatewayService` / `SourceSpec` / `SourceState` / `SourceIssue` /
`GatewayRequest` / `GatewayChunk` / `GatewayUsage` / `GatewayCompletion` / `GatewayTrace` /
`GatewayStats` / `SourceStat` / `GatewayFailureCode` / `GatewayError`。

## 配置（全部有默认值）

默认值只存在一处：`src/settings.ts` 的 `FIELD_SPECS`。运行期默认值、交给 O-005 的段声明、
本地校验三处**都由它派生**，不手写第二份（O-005 那轮裁定过的双真源问题）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `sources` / `sources` | `[]` | 来源清单。**刻意空**，理由见取舍 2 |
| `timeoutMs` / `timeout-ms` | `20000` | 首块超时；夹 1000–600000 |
| `idleTimeoutMs` / `idle-timeout-ms` | `60000` | 块间隔超时；夹 1000–600000 |
| `maxAttempts` / `max-attempts` | `2` | 每条来源的最大尝试次数（含首次）；夹 1–5 |
| `backoffMs` / `backoff-ms` | `500` | 退避基数；夹 0–10000 |
| `maxBackoffMs` / `max-backoff-ms` | `8000` | 退避上限；夹 0–60000 |
| `retryableCodes` / `retryable-codes` | `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT` | 与上游 `llm` 包逐字一致 |
| `allowFallback` / `allow-fallback` | `true` | 是否跨来源降级 |
| `checkCredential` / `check-credential` | `true` | 是否做凭据存在性预检 |

> 表格写成「camel / kebab」是因为**同一个配置有两个合法名字**：
> 插件实例配置走 camelCase，交给 O-005 的段字段走 kebab-case。
> 用户写哪个都认，理由与代价见取舍 11。

来源清单示例（`provider` 必须是**你自己装了的**适配器路由键，这里只是形状示例）：

```yaml
sources:
  - id: remote-main
    kind: remote
    provider: deepseek            # 由 llm-deepseek 注册的路由键
    model: deepseek-chat
    priority: 10
    credentialRef: DEEPSEEK_API_KEY   # 只是环境变量名，不是密钥
  - id: local-first
    kind: local
    provider: local-llama          # 由 llm-pi-ai 的 providers.* 声明的路由键
    model: qwen2.5-14b-instruct
    priority: 20
    timeoutMs: 60000               # 本地首次加载慢，单独放宽
  - id: free-model
    kind: free
    provider: free-route
    model: ondra-free
    priority: 30
    credentialRef: ONDRA_FREE_KEY
    maxAttempts: 1                 # 免费额度紧，重试一次就够
```

## 关键取舍（每条都有代价，写在这里防后人踩回去）

1. **「密钥注入」改成「凭据存在性预检 + 引用登记」。**
   台账原写「密钥注入」。但手册 §6 禁令 6 是「密钥绝不写进配置文件」，而上游
   `ctx.credentials` 的语义是**每次操作现解析**：适配器自己按同一个引用名取值。
   网关若把值解析出来再塞给适配器，等于凭空造出**第二条密钥通路**——值会进网关内存、
   进错误上下文、进而有进日志的风险，而收益只是省掉一次失败请求。
   所以 `credentialRef` 只做两件事：判「有没有」，以及给界面一个「这条来源要哪个环境变量」的说明。
   **值永不出凭据域**。代价：密钥写错（有值但无效）仍要等首次真实调用的 `AUTH` 才发现——
   这是唯一可信的答案，前置探测反而会伪造安全感。

2. **来源清单默认空，不编一个「看起来能用」的默认。**
   `provider` 路由键由具体适配器声明（`llm-deepseek` 的 route、`llm-pi-ai` 的 `providers.*`），
   写死任何一个都会在别人机器上变成 `provider-missing`。一个必然失效的默认不是「默认给好」，
   是 §17-6 明令禁止的**假开关**。空清单时服务照常注册，`resolve()` 返回 `no-source`，
   并给一句能直接照做的话（「请填写 sources，provider 必须是已安装适配器的路由键」）。

3. **首块之后，绝不重试、绝不换来源。**
   已经吐出去的字收不回来。重放会让用户看到两遍开头——流式场景下这是最难查的重复文本来源，
   因为日志上一切正常，只有屏幕上是错的。`GatewayError.partial` 就是这个事实的机器可读版本：
   为真时调用方也不该自己重放。

4. **卡「首块超时」与「块间隔超时」，不卡「总时长」。**
   流式回复的总时长不可预测（长回答、慢模型、思考模式），卡总时长会砍掉**正常的长回复**，
   而且砍在句中。真正要防的两种卡死是「一个块都不来」和「吐到一半停住」，各给一个闸。

5. **重试在换来源之前。**
   一失败就换来源，会让「在线 API 偶发限流」变成「悄悄切到本地模型」，
   而用户只会觉得「她今天说话变笨了」，永远查不到原因。先在同一条来源上扛，
   扛不住才降级，且降级打一条 warn。

6. **显式指定来源时不做任何降级。**
   用户点名了就不该偷偷换。`request.source` 一给，候选链就只有这一条。

7. **`retryableCodes` 与上游逐字一致，不另立一套。**
   两套可重试码意味着「同一个错误，走 agent loop 会重试、走网关不会重试」，
   这种不一致只能靠事后翻日志发现。默认值就是上游 `DEFAULT_RETRYABLE_CODES`。

8. **用量先扣着，成功才记账。**
   `usage` 块在上游协议里出现在 `finish` 之前。首块前失败时网关不写账，
   否则「没花出去的钱」也会进报表，成本曲线会出现无法解释的尖峰。

9. **统计只在内存。**
   网关是所有域插件的上游，它一旦落盘，就把「存储域崩了会不会连带模型调用崩」绑在一起。
   代价：重启后报表归零，需要长期趋势请从 `session_log` 侧统计。

10. **不声明插件级 `inject`。**
    声明了 `inject: ['llm']` 后，上游缺席会让整个插件停在 PENDING（静默不加载，
    手册点名的「最隐蔽的失败」）。改成「照常注册 + `available=false`」，
    下游能明确区分「没装网关」与「装了但上游没就绪」。`probe()` 每次都现取 `ctx.llm`，
    所以上游晚装载也能自愈，不必重载本插件。

11. **Config 是 camelCase，交给 O-005 的段字段键必须是 kebab-case——这两套名字必须显式映射。**
    这不是风格问题，是**会直接抛错的硬冲突**：§8.4 要求配置键匹配 `^[a-z][a-z0-9_-]{1,63}$`
    （没有大写字母），而 Cordis 插件实例配置历来是 camelCase（`cordis.yml` 里就长这样，
    O-001~O-009 全部如此）。把 `FIELD_SPECS` 直接当 `SectionDecl.fields` 交出去，
    O-005 的 `checkFieldSpec()` 会在注册期抛 `bad-field-spec`，
    表现是「配置段注册失败，四层合并与来源追溯全部静默不可用」——
    而且日志里只有一句 warn，很容易被当成噪音跳过。
    解法是 `settings.ts` 里的 `KEY_PAIRS`：**一张双向唯一的映射表**，
    段声明由它派生、用户层归一化由它做、解析结果回填也由它做。
    用户写 `timeoutMs` 或 `timeout-ms` 都认。
    代价：加一个 Config 字段要动两处（`FIELD_SPECS` + `KEY_PAIRS`），
    所以自检里加了「两张表键集合相等 + 值双射」两条机械检查，漏一处会立刻报。

## 边界

- 属于 L3，零第三方依赖：只用 `@ntars/cordis` 的类型与 Node 内建（`setTimeout` / `AbortController`）。
  不碰网络、不碰数据库、不碰文件系统。
- 与上游方向**单向**：本插件 → `ctx.llm` / `ctx.credentials`。上游不知道本插件存在。
- 与 O-005 方向：本插件 → O-005（注册一个配置段 + 读回解析结果）。O-005 不知道本插件是谁。
- **不涉器官 ABI**：网关不是器官——它不提议状态（无 `feedback()`）、不消耗能量、
  不申报提示词片段，是纯粹的基础设施。C1/C2/C3 三条在这里没有对应物，
  所以本插件既没有 `EnergyReceipt` 也没有 `order/ttl/confidence`。
- **遵守前缀缓存三原则**：`messages` 引用原样透传，重试与降级都复用同一个数组，
  绝不重建、绝不裁剪、绝不插入。网关是唯一有能力「悄悄改提示词」的层，所以它偏偏什么都不改。
- 服务键用连字符（手册 §8.4）；`ondra-master-plan.md` §3.1/§6 仍写 `ondra:<短名>` 的旧写法，
  该文档口径冲突已在台账登记，本仓一律以手册为准。

## 已知限制

1. **不做模型目录探测**：`resolve()` 不校验 `model` 是否存在。模型名写错要到首次调用才报错，
   且报的是适配器的错。理由是探测模型列表要走网络（部分 provider 要额外权限）。
2. **不区分「凭据有值但无效」**：见取舍 1。这属于 provider 侧事实，只能由 `AUTH` 回答。
3. **块间隔超时无法强制打断上游**：超时通过 `AbortController` 通知上游，协议要求适配器
   尊重 `signal`；若某个适配器不尊重，网关会等到它自己结束。**不硬做**（在网关层强杀
   会让上游的用量记账与重放状态错位）。
4. **流内 `finish{kind:'aborted'}` 不重试**：那是调用方取消或上游主动中止，
   重试等于违背用户意图。
5. **统计无持久化**：重启归零（取舍 9）。
6. **一个进程内只有一个网关实例**：服务键单一归属（§15.4）。要「按场景隔离来源」请用
   `request.source` 点名，而不是装第二个网关。
7. **与 `llm-retry` 不叠加**：本插件的重试只覆盖「直接调网关」的请求。
   若调用方在 agent loop 内，请把 `maxAttempts` 配成 1。
8. **段字段键与 Config 键两套名字**：见取舍 11。写 `sources` 配置时用户层两种写法都认，
   但 O-005 的 `section()` 快照里露的是 kebab 键（`timeout-ms`）。
9. **`kind` 只是标签**：不参与任何控制流。若将来某种来源需要真正的差异化流程
   （例如免费模型必须排队 + 每日额度），按 §14.2 拆分支，不要在 `stream.ts` 里加 `if (kind)`。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| provider 注册表与流式协议 | 上游宿主 `packages/llm/llm`（`ctx.llm`） | 同仓 `desktop/packages/llm/llm` | 与本项目同许可（AGPL-3.0） | `StreamChunk` 的七种块、`usage` 必须在 `finish` 之前、`finish` 之后不得再有内容 | 只调用 `ctx.llm.stream()`，不复制任何解码逻辑；块类型用**结构对位**声明，不 `import` | 否 |
| 可重试码集合 | 上游 `packages/llm/llm/src/retry-policy.ts` | 同上 | 同上 | `DEFAULT_RETRYABLE_CODES` 的五个码与「指数退避 + 对称抖动」的形态 | 默认值逐字照抄，退避自写（`stream.ts` 的 `backoffFor`） | 否 |
| 密钥引用而非值 | 上游 `packages/credentials/credentials` | 同上 | 同上 | 「配置只存引用名，值由凭据域持有，per-operation 解析」 | 只调 `credentials.resolve()` 判存在性，值不落地（`credentialCheck`） | 否 |
| 多来源路由与失败转移 | LiteLLM | github.com/BerriAI/litellm | MIT（据其仓库 LICENSE，未逐行核对） | 「按优先级选路 + 首块前失败转移 + 每次转移可观测」的分层思路 | 自研 `sources.ts` + `stream.ts`；不引入代码（它是独立代理服务，形态与本插件完全不同） | 否 |
| 首块超时 / 空闲超时 | 上游 `llm-retry` 的 `backoff` 与常见流式客户端实践 | 同仓 `desktop/packages/llm/llm-retry` | 与本项目同许可 | 「超时要分阶段，不能只有一个总时长」 | 自研两个闸（`first-chunk-timeout` / `idle-timeout`），各自可被来源覆盖 | 否 |

**档位判定（§1.8）**：〔薄〕薄封装。
协议编解码、适配器注册、重试策略、模型解析、密钥存储**全部复用上游**；
本插件只做契约转换与护栏（选路、超时、降级、记账），四件事都是上游刻意不管的
（它面向会话，不面向「产品要选哪条链路」）。**没有自研任何一项已有成熟实现的能力**。

## 多方案分支说明（§12）

涉及多方案：**模型来源 —— 在线 API / 本地 / 免费模型**（手册 §1.10 需求五，宣传片 03 章承诺）。

处理方式是 **§12.1「能融会贯通 → 融」，不做三分支**：

| 方案 | 结论 | 理由 |
|---|---|---|
| 在线 API（`kind: remote`） | 同一条实现，参数化 | 三者协议层**没有区别**：都是 `ctx.llm.stream({provider, model})`。差异只在默认参数（超时、重试次数、要不要凭据） |
| 本地大模型（`kind: local`） | 同上 | 同上；差异是「首块更慢、通常不要密钥」，落在 `timeoutMs` 与 `credentialRef` 两个参数上 |
| 免费模型（`kind: free`） | 同上 | 同上；差异是「额度紧、重试要少」，落在 `maxAttempts` |

**为什么这不是「把三个分支揉进一个函数」**（§14.4 禁止项）：揉进去的是**同一套逻辑**，
不是三套逻辑靠 `if (kind === ...)` 分流。`kind` 在本插件里只影响**默认参数与展示文案**，
不影响任何一行控制流——`stream.ts` 里没有一处按 `kind` 分支。

若将来真出现语义冲突（例如免费模型必须走「排队 + 每日额度」而在线 API 不需要），
按 §14.2 拆分支：同一 `LlmGatewayService` 接口，每分支一个文件，`sources.ts` 里加
`strategy` 字段选实现，**默认选最稳的那支**，各分支独立降级、不共享缓存。

| 要求 | 落地 |
|---|---|
| 接口唯一 | 只有一个 `LlmGatewayService`，加分支不改调用方 |
| 文件隔离 | 选路在 `sources.ts`、单次尝试与重试在 `stream.ts`、统计与门面在 `service.ts`、配置真源在 `settings.ts` |
| 默认最稳 | 首块前重试 + 跨来源降级 + 首块后收手；不追求「最快切过去」 |
| 独立降级 | 每条来源独立判可用、独立计尝试次数；一条挂了不影响下一条被选中 |
| 可观测 | `sources` 给每条来源的 `available` / `reason` / `detail`；`stats()` 给 `fallbacks` / `credentialSkips` / `lastFailureCode` |
| 不共享状态 | 每次 `stream()` 新建一个 `Runner`；来源之间不共享缓存、连接、定时器 |

## 隔离五问（§16.4）

1. **关掉我，谁受影响？** 所有需要模型的插件（提炼、检索扩展、做梦、评估）拿不到
   `ondra-llm-gateway`，必须自己降级：跳过模型调用或直连 `ctx.llm`。主对话若走 O-033，
   也会因为没有模型供给而不可用——**这是本插件作为阻塞项的唯一「越界」影响，且是设计意图**。
   已完成的存储、日志、时钟类插件完全不受影响。
2. **我的状态存在哪？** 仅在内存：`LlmGateway` 里的几个计数器与来源状态快照，卸载即清零。
   没有文件、没有数据库、没有定时器、没有 socket。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.llm-gateway`（有 O-001 时经
   `loggerName('llm-gateway')` 拼）。运行期可读 `stats()`：`available` / `reason` /
   `lastFailureCode` / `fallbacks` / `credentialSkips` 五项足以回答「是没配、没装、还是被拒」。
4. **我依赖谁？缺席时我怎么降级？** 上游 `ctx.llm`（硬，缺席则注册但 `available=false`，
   `probe()` 每次现取所以能自愈）；`ctx.credentials`（软，缺席则跳过预检并打一条 warn）；
   O-005（软，缺席则退回插件实例配置）；O-001（软，日志命名空间退化）。
   五处 `ctx.get` 全部先判 `undefined`，取不到一律安静降级，不抛。
5. **我和同域的谁共享可变状态？** 没有。与上游只读 `listProviders()` 与 `stream()`；
   与 O-005 只注册一个段并读回解析结果；每次调用新建 `Runner`，连自己的统计都不跨调用共享可变引用。

## 自检（master-plan §16.1 九项 + §16.2 语言五项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（7 必需 + icon） | 过（13 文件：7 必需 + `src/types.ts` / `src/settings.ts` / `src/sources.ts` / `src/stream.ts` / `src/service.ts` + `icon.svg`） |
| 2 | 清单合法 | 过（JSON 可解析、`ondra-*`、`type: module`、`main`/`types`/`exports`/`files` 齐、cordis 双声明、`ondra.bundle.patch` 在且文件真实存在） |
| 3 | 编译配置 | 过（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） |
| 4 | 入口契约 | 过（`name` + `apply(ctx, config)` + `Config` 九字段全有默认值；`FIELD_SPECS` / `DEFAULT_CONFIG` / `KEY_PAIRS` 三张表键集合逐一对齐，段字段键双射且全部匹配 §8.4） |
| 5 | 服务键唯一 | 过（`ondra-llm-gateway` 全仓仅本插件 `provide`） |
| 6 | 依赖可解析 | 过（`ondra-config-schema` / `ondra-identity` 台账有提供方；`llm` / `credentials` 是上游服务） |
| 7 | 无越界 import | 过（无 `from 'ondra-`；对 O-005 / O-001 / 上游 LLM 一律结构对位） |
| 8 | 降级到位 | 过（五个 `ctx.get` 全部判空；上游缺席 → 注册但 `available=false`；配置错 → 逐字段回退默认） |
| 9 | 交付物齐全 | 过（技术来源表 / 多方案说明 / 隔离五问齐） |
| 语言 1–5 | 括号配平 / 无残留半句 / `import type` 正确 / 无 TODO / UTF-8 无 BOM | 过 |

> 判定由静态脚本产出（只读文件 + JSON 解析 + 括号配平 + 标识符交叉核对），
> 未执行 `tsc` / `build` / `pnpm install`（§16.3 禁止实装运行）。
