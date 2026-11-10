# ondra-vision

> O-126 · 〔复〕复用 · 手册 §9.4 / 语料·第一编 2.3 · P1 · 批次 B9（多模态）
> 服务键 **`ondra-vision`**（连字符，符合 §8.4）

## 一、职责

把「一张图」变成**一段可以入库的中文描述**，或者图里的字，或者「某个东西在哪」的方框；
把「一个视频」抽成 4 帧。

手册的原话只有一句半：

```
| O-126 | `ondra-vision` | 图片理解 / OCR / 物体定位 / 视频抽帧，provider 可插拔，默认关 |
```

语料补了落点：「走『可插拔 provider』（云端 OpenAI 兼容 / 本地 Ollama / 通义千问），
**默认关闭**，与 `ondra-privacy` 联动（出站前提示）」。

| 手册词组 | 本包 | 它回答什么 |
|---|---|---|
| 图片理解 | `describe()` | 这张图里有什么？能用中文说清吗？ |
| OCR | `ocr()` | 图里的字是什么？逐字，不改、不译 |
| 物体定位 | `locate()` | 「红色的按钮」在图的哪个位置？ |
| 视频抽帧 | `frames()` | 这段视频大概在讲什么？（抽 4 帧给人看） |

**档位判定〔复〕**：识别能力归 provider，本包只做接线、配置、超时、降级、出站许可。
自己写一个视觉模型 = 违规（§1.8「能复用却自研 = 违规」）。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| **不做入库**：不写 `memory_fact`、不建表、不决定 `kind` / `importance` / `pool` | O-128 `ondra-multimodal-memory`（本包只交 `MultimodalDraft`） |
| 不做写入门控（引文、逐字校验、数字出处） | O-140 `ondra-evidence-gate` |
| **不做出站裁决**：不判断「该不该发」 | O-076 `ondra-privacy`（本包只问、只听） |
| 不做密钥管理：配置里只有**环境变量名**，值归凭据域 | 上游 `credentials` 服务 / O-035 口径 |
| 不压缩、不裁剪、不转码图片 | 调用方。压了会改内容，而「描述的是原图」是它唯一的证据价值 |
| 不接管消息序列、不建会话、不写 `app_session_log` | O-033 `ondra-dialogue` / 应用外壳 |
| 不装定时器、不做后台扫描 | 没有「周期性看图」这件事；每次调用都是有人问 |
| **不做界面：不画方框图、不做预览面板、不做 Toast、不定义设计令牌与主题** | **应用外壳（`desktop/`）。L8 界面 14 个插件（O-085~O-096、O-124、O-125）已于 2026-11-03 整批下线，永久不再新建 `ondra-ui-*`** |
| 不做语音 | O-127 `ondra-asr`（同轮，互不 import） |

### 三条刻意的「不做」

1. **不猜模型名。** `model` 默认空串，空着就 `no-model`。填一个「看起来对」的名字
   会在它下线那天变成「视觉坏了」，而配置里明明写着一个名字。
2. **不发工具。** 手册给的是四个词组，不是四个函数签名。凭空定参数 = 让模型照一份
   编出来的说明书调用。调用方是代码：通道适配器收到图，先存盘，再问本包「这是什么」。
   这条与 O-143 同一套推理。
3. **不缓存描述。** 同一张图两次描述得到两段文字（模型有随机性），缓存会让第二次
   拿到第一次的旧结论；而「这张图现在是什么样」本来就不该有第二份答案。

## 三、服务键与调用面

```ts
const vision = ctx.get('ondra-vision')            // VisionService | undefined

vision?.available                                // 开关 + 模型 + 运行时出口
vision?.reason                                   // 'disabled' | 'no-model' | 'bad-base' | 'no-transport'
vision?.provider                                 // 'ollama' | 'openai' | 'qwen'

await vision?.describe({ path: '/…/a.png' })     // → { ok, text, chars, draft?, reason, detail? }
await vision?.ocr({ path: '/…/a.png' })          // → 同上
await vision?.locate({ path: '/…/a.png', target: '红色的按钮' })
                                                 // → { ok, boxes, reason, detail? }
await vision?.frames({ path: '/…/a.mp4', count: 4 })
                                                 // → { ok, frames: [绝对路径…], dir }
await vision?.probe()                            // → { ok, status, reason }（只探地址，不证明会看图）
vision?.stats() / vision?.dispose()
```

**所有方法永不抛错。** 失败一律 `ok=false` + `reason` + `detail`；`text` 恒为空串
（失败时填占位文案会被下游当成描述入库）。

## 四、配置

| 键 | 默认 | 说明 | 出处 |
|---|---|---|---|
| `enable` | `false` | 总开关 | **手册 §9.4：vision 默认关闭** |
| `provider` | `ollama` | `ollama` / `openai` / `qwen` | 手册点名的三家 |
| `base-url` | `''` | 覆盖默认接入点；留空用该家默认 | 工程取值 |
| `model` | `''` | **必填**，空着即 `no-model` | 工程取值（手册未给模型名） |
| `credential-ref` | `''` | 凭据的**环境变量名**；留空用该家默认 | 与 O-035 / O-076 同口径 |
| `detail` | `auto` | 图片细节档，只对 OpenAI 兼容端点有意义 | 工程取值 |
| `timeout-ms` | `30000` | 单次请求超时 | 工程取值（视觉比文本慢） |
| `max-image-bytes` | `8388608` | 单张图片字节上限 | 工程取值 |
| `max-output-chars` | `2000` | 正文上限，超了截断并标 `truncated` | 工程取值 |
| `video-frames` | `4` | 视频抽几帧 | **手册语料：视频→4 帧** |
| `ffmpeg-path` | `ffmpeg` | 按 PATH 找 | 工程取值 |
| `cloud-without-privacy` | `false` | 没有 O-076 时是否仍允许云端出站 | 工程取值（保守档） |
| `verbose` | `true` | 降级时打一行日志 | 工程取值 |

三家默认接入点（**真实地址，不是编的**）：

| provider | base | 凭据变量 |
|---|---|---|
| `ollama` | `http://127.0.0.1:11434` | 不需要 |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |

## 五、出站纪律（本包最要紧的一条）

```
读图 → 格式/大小合格 → gate() → 解析凭据 → 发请求
```

**顺序不能换**：图不合格就不该去问「能不能发」。否则用户会被问一次
「要不要把这张图发出去」，而这张图根本发不出去。

`gate()` 的三条分支：

| 情形 | 处置 | 理由 |
|---|---|---|
| 本机（`127.0.0.1` / `localhost` / `::1`） | 直接放行 | 手册要求的是「**出站**前提示」，本机没有出站 |
| 云端 + 有 O-076 | 听 `evaluate()` 的 `allow / ask / deny` | 三态必须分开：`ask` 报 `egress-consent`，不是 `deny` |
| 云端 + 没有 O-076 | 默认**不发**（`egress-denied`），除非 `cloud-without-privacy=true` | 出站必须有人替我说能不能发 |

**裁决器自己崩了也不放行。** 用一次崩溃换一次泄漏，是这笔账里最亏的一笔。

## 六、坐标与方框

- 一律**归一化到 0–1**，原点左上。像素坐标离不开尺寸，尺寸一被缩放过就对不上。
- 模型回了像素值 → 用**真实宽高**换算（PNG 的 IHDR / JPEG 的 SOFn / GIF / WebP 三种变体）。
- 尺寸解析不出来 + 坐标像像素 → **整批拒收**（`no-boxes`）。给一批假框比给 0 个框更糟：
  下游会把它画进记忆。
- **数组形式的方框整批拒收。** `[x, y, w, h]` 与 `[x1, y1, x2, y2]` 在数值上无法区分：
  `[0.1, 0.2, 0.3, 0.4]` 若是前者，右下角是 (0.4, 0.6)；按角点解释只到 (0.3, 0.4)，
  框会整体缩小三成，而且不报错。曾经以为「两种写法按角点解释恰好等价」——
  **那是错的，纯逻辑对拍当场抓出来**（见第十三节）。所以只认对象形式，
  提示词里也明写「不要写成四个数字的数组」。

## 七、多模态入库契约（O-128 用）

`MultimodalDraft` 的**真源在 `src/types.ts`**（§15.3 契约先行：本轮 O-126 是先做方）。
O-127 做结构对位镜像（不 import），O-128 只按字段名消费。

```
modality: 'image' | 'audio' | 'video'
sourcePath, text, title, at, provider, model?, chars, truncated
fingerprint = fnv1a64(modality + '\0' + sourcePath + '\0' + text)   // 16 位十六进制
spans? / boxes? / frames? / degraded?
```

**指纹不含时间。** 同一张图描述两次必须得到同一个指纹，否则 O-128 会把它当成两条新记忆，
而它们说的是同一件事。

**刻意不含** `kind` / `importance` / `pool`：那是记忆域自己的判断（O-010 / O-131）。
一个视觉插件没有资格替记忆域定「这条重不重要」。

## 八、隔离五问（§16.4）

1. **关掉我，谁受影响？** 只有「看图」这一件事。用户发图时，对话链拿不到描述，
   按「没看见图」处理（一句「我看看……看不清」比编一段强）。不影响对话、不影响记忆、不影响抽帧以外的一切。
2. **我的状态存在哪？** 只有两处，都**不持久**：统计计数在内存（重启归零）；
   抽出来的帧在 `tmp/vision-frames/f-<指纹>-<序号>/`，`dispose()` 一次清掉。
   **没有库表、没有配置文件、没有落盘的正文。**
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.vision`；
   服务上 `available` / `reason` / `stats().byReason` / `stats().egressBlocked` 四个读数。
   `egressBlocked` 大于 0 是「用户一直没点头」的唯一信号，它不该被当成故障。
4. **我依赖谁？缺席时怎么降级？** `ondra-privacy`（软：不在就按 `cloud-without-privacy` 保守拒绝）、
   `ondra-config-schema`（软：注册失败退回插件实例配置）、`ondra-identity`（软：日志命名空间）、
   `ondra-clock`（软：`Date.now()`）、`ondra-path-layout`（软：退回系统临时目录）。
   五个全软，缺任何一个本包都照常 `apply()`。
5. **我和同域的谁共享了可变状态？** 没有。O-127 是另一个进程内的另一个服务，两包互不 import；
   唯一的交汇点是 `MultimodalDraft` 这个**只读结构**。

## 九、多方案分支说明（§12）

| 能力 | 方案 | 处理 |
|---|---|---|
| 三家 provider | A 一份实现 + 两处参数化（本包） / B 三家各一套分支 | **A**。差别只有路径与图片字段，分三套会让超时、降级、裁决各写三遍，迟早不一致 |
| 默认 provider | A `ollama`（本机） / B `openai`（云） / C `qwen` | **A**。§14.2「默认最稳」：最坏情况是「用不了」，而不是「已经发出去了」 |
| 视频抽帧 | A `ffmpeg -vf thumbnail`（本包） / B 自己解容器 / C 按时间戳 seek | **A**。B 是「难度极高、体量巨大」那一类；C 要先知道时长（多一个 `ffprobe`），还容易抽到黑场 |
| 定位坐标 | A 归一化 0–1（本包） / B 像素 | **A**。像素离不开尺寸，尺寸一缩放就对不上 |
| 模型回非 JSON | A 宽松提取 + 严格校验（本包） / B 直接 `JSON.parse` | **A**。视觉模型对「只输出 JSON」的遵守率约七成，B 在那三成上全灭，表现是「定位不好用」 |

## 十、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 视觉能力编排（分层 + provider 切换） |.ondra.vision-complete | 手册 §9.6 记为 MIT | MIT | 「能力分层 + provider 可插拔」的组织方式，以及十条能力清单的切分（图片理解 / OCR / 定位 / 视频 / 转写…） | 自研 `providers.ts`：一张 provider 表 + 两个整形函数 | 否 |
| OpenAI 兼容的图片消息形状 | OpenAI Chat Completions 文档 | `platform.openai.com` | — | `content: [{type:'text'}, {type:'image_url', image_url:{url, detail}}]` | `buildRequest()` 按此形状拼 | 否（协议形状，非代码） |
| Ollama 的图片字段 | Ollama API 文档 | `github.com/ollama/ollama` | MIT | `messages[].images` 收**裸 base64**（不带 `data:` 前缀） | 同上 | 否 |
| 通义千问兼容端点 | 阿里云百炼文档 | `help.aliyun.com` | — | `compatible-mode/v1` 与 OpenAI 同形状 | 归入 `openai` 分支，只换 base | 否 |
| 出站三层裁决 | 本仓 O-076 `ondra-privacy` | `cordis/ondra-privacy` | 随仓 | `declare()` / `evaluate()` / `grant()` 的语义与「一个码一种处境」纪律 | 直接消费该服务（**复用**，不自己判风险） | 否（只调服务） |
| 子进程收尾与 PATH 探测 | 本仓 O-050 `ondra-tts` | `cordis/ondra-tts` | 随仓 | 「起过的子进程集中成一个集合、`killAll()` 一次收尾」与 `whichSync()` 只查文件不执行 | `frames.ts` 同构实现 | 否 |
| 前缀缓存纪律 | 手册 §8.5 | 同仓 `Ondra-dev-handbook.md` | — | 视觉描述不参与冻结前缀，只在用户回合里产生一次 | 本包不拼提示词、不注入 | 否 |

**档位判定：〔复〕复用。** 生态里视觉/OCR/视频理解有 161 个项目（手册 §1.8），
本包**一个模型都没写**：只做请求整形、配置、超时、降级、出站许可。

## 十一、已知限制

1. **默认关着，装上不等于能用。** 需要三步：`enable: true`、填 `model`、把图发给它。
   手册 §9.4 就是这么要求的。
2. **不压缩图片。** 超过 `max-image-bytes` 直接拒（`too-large`）。压缩会改内容，
   而「描述的是原图」是这条描述唯一的证据价值。手机原图常超 8 MiB，用户需自己调上限或先裁。
3. **只认五种格式**（PNG / JPEG / GIF / WebP / BMP），按**魔数**判、不按扩展名。
   其它格式 `bad-image`——比硬塞给 provider 换一个 400 更诚实。
4. **抽帧要 ffmpeg。** 没有就 `no-ffmpeg`，**不影响看图**。帧是临时产物，`dispose()` 清掉；
   进程被强杀时目录会留在临时目录里（`tmp/vision-frames/`，系统会自己清）。
5. **抽帧不抽音轨。** 手册语料写的是「视频→4 帧 + 音轨转写」，音轨那半在 O-127：
   要先把音轨分离成音频文件（同样靠 ffmpeg），再交给 `ondra-asr`。**本包不做这一步**，
   因为它需要写文件、且失败形态与抽帧不同（一个成、一个败）。
6. **`probe()` 探通不代表会看图。** `/models` 与 `/api/tags` 只证明地址与凭据没错到连不上。
   面板若把绿灯读成「视觉可用」，那是面板的错，不是接口的承诺。
7. **不做多图、不做视频理解（画面 + 时间线）。** 手册的能力清单里有「视频理解」，
   但那要 provider 侧支持视频输入；本包只做「抽 4 帧 → 逐帧描述」这条能落地的路。
8. **`locate()` 的标签是模型自己写的**，本包不翻译、不改写。它可能写成英文、可能是同义词。
9. **并发不排队。** 一次调用用到的全部信息（动作、目标、图、语言）都是参数，不是实例字段，
   所以两次并发不会互相串味。代价是同时发两张图会同时占两个请求位——那是调用方该控的节奏，
   本包不替你排队（排队会把「用户等 3 秒」变成「用户等 6 秒」）。

## 十二、待裁决

1. **八个默认值没有手册出处**：`provider ollama` / `timeout-ms 30000` / `max-image-bytes 8 MiB` /
   `max-output-chars 2000` / `detail auto` / `ffmpeg-path ffmpeg` / `cloud-without-privacy false` /
   `verbose true`。只有 `enable=false`（§9.4）与 `video-frames=4`（语料 2.3）有出处。
2. **`model` 是否该给一个示例默认值？** 现在空着。给默认值的好处是「打开就能用」，
   代价是「半年后它下线，用户以为是插件坏了」。本包选后者（可解释的失败）。
3. **没有 O-076 时云端到底该不该发？** 现在默认不发。若主人认为「最小安装也要能用」，
   把 `cloud-without-privacy` 默认改 `true` 即可——但那一改等于默认允许把截图发出去。
4. **四张提示词是工程取值。** 手册只说「图片理解 / OCR / 物体定位」，没说提示词怎么写。
   现在的版本强调「看不清就说看不清」，理由见 `providers.ts` 文件头。
5. **要不要给模型发工具？** 现在不发（理由见第二节）。若要让模型自己喊「看看这张图」，
   需要先定参数，那要一条新裁决。
6. **`max-tokens` 按 1.5 倍字数估**（`maxTokensOf()`）。中文分词各家不同，估少了会截在半句上，
   而 `finish_reason` 是 `length`、不报错。这个系数需要实测校准。

## 十三、自查

见 `ondra-plugin-index.md` 的「产出登记（第 76 轮）」。9 项机械自检 + 语言 5 项全过；
图标与仓库根 `icon.svg` 一致；交叉扫描 0 环、0 越界、服务键 0 冲突、0 冒号键。
