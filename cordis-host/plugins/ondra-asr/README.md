# ondra-asr

> O-127 · 〔复〕复用 · 手册 §1.5 / 语料·第一编 2.3 · P1 · 批次 B9（多模态）
> 服务键 **`ondra-asr`**（连字符，符合 §8.4）

## 一、职责

把一段语音转成**带时间戳的中文**：本地 whisper 优先，转不出来才走云端。

手册三件事，三种落实：

| 手册 | 本包 | 结论 |
|---|---|---|
| 时间戳 | `spans[]`，**毫秒整数** | 做。两种单位（毫秒 / 微秒）统一换算 |
| 本地优先、云端兜底 | `provider: local` + `allow-cloud-fallback: true` | 做，且兜底能关 |
| 说话人分离 | `diarized` 恒 `false`，`speaker` 没有就缺省 | **做不了，也不假装做** |

**为什么说话人分离这条要单列**：whisper.cpp 与 OpenAI 的 `whisper-1` 都不做
diarization（真正做的是 pyannote / NeMo 那一类，要额外模型与流水线）。本包既不能
装依赖，也不该把「听不出来」写成「说话人一」。手册 §2.2 的原话是
**「归属错误比记不住更伤信任」**——把用户说的话记成她说的话，比漏掉一句更糟。

**档位判定〔复〕**：转写能力归 whisper / 云端接口，本包只做接线、配置、超时、
格式转换、降级、出站许可。自己训一个模型 = 违规（§1.8）。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| **不做入库**：不写 `memory_fact`、不建表、不决定 `kind` / `importance` / `pool` | O-128 `ondra-multimodal-memory`（本包只交 `MultimodalDraft`） |
| 不做写入门控（引文、逐字校验、数字出处） | O-140 `ondra-evidence-gate` |
| **不做出站裁决** | O-076 `ondra-privacy`（本包只问、只听） |
| 不做说话人分离（也不做 `diarize` 假开关） | 无（生态里没有可复用且不装依赖的实现） |
| 不做翻译、不做摘要、不做关键词 | 转写只做一件事：把声音变成字 |
| 不切片长音频 | 调用方（切了会截断句子，而本包不知道句子在哪） |
| 不做视频（抽帧归 O-126，音轨要调用方先分离出来） | O-126 `ondra-vision` + 调用方 |
| 不接管消息序列、不建会话、不写 `app_session_log` | O-033 `ondra-dialogue` / 应用外壳 |
| 不装定时器、不做后台扫描 | 转写是「有人发来一段语音」触发的，不是周期任务 |
| **不做界面：不做波形、不做转写预览、不做 Toast、不定义设计令牌与主题** | **应用外壳（`desktop/`）。L8 界面 14 个插件（O-085~O-096、O-124、O-125）已于 2026-11-03 整批下线，永久不再新建 `ondra-ui-*`** |
| 不做看图 | O-126 `ondra-vision`（同轮，互不 import） |

## 三、服务键与调用面

```ts
const asr = ctx.get('ondra-asr')                  // AsrService | undefined

asr?.available / asr?.reason                      // 至少一条来源可用
asr?.localReady / asr?.cloudReady                 // 两条路各自就绪没有
asr?.provider                                     // 首选来源：'local' | 'cloud'

await asr?.transcribe({ path: '/…/v.m4a' })
// → { ok, text, spans[], language?, provider, model?, chars, truncated,
//     diarized, tried[], elapsedMs, detail?, draft? }
await asr?.transcribe({ path: '/…/v.m4a', language: 'zh' })
asr?.stats() / asr?.dispose()
```

**永不抛错。** 失败一律 `ok=false` + `reason` + `detail` + `tried`。
`tried` 逐条列出走过的路（`local:no-binary` / `cloud:no-credential`），
因为用户只会看到「转写失败」四个字，而修法完全取决于走的是哪条路。

## 四、配置

| 键 | 默认 | 说明 | 出处 |
|---|---|---|---|
| `enable` | `true` | 总开关 | 工程取值 |
| `provider` | `local` | 首选来源 | **手册：本地 whisper 优先** |
| `binary` | `whisper-cli` | whisper 可执行文件（按 PATH 找） | 工程取值 |
| `model-path` | `''` | **必填**，whisper 的 `-m` 没有默认值 | 工程取值 |
| `language` | `''` | 留空即自动检测 | 工程取值 |
| `threads` | `4` | whisper `-t` | 工程取值 |
| `ffmpeg-path` | `ffmpeg` | 转 16k 单声道 WAV 用 | 工程取值 |
| `timeout-ms` | `180000` | 本地转写超时 | 工程取值 |
| `cloud-base-url` | `https://api.openai.com/v1` | 云端接入点 | 工程取值 |
| `cloud-model` | `whisper-1` | 云端模型 id | 工程取值 |
| `credential-ref` | `OPENAI_API_KEY` | 凭据的**环境变量名** | 与 O-035 / O-076 同口径 |
| `allow-cloud-fallback` | `true` | 本地失败时走云端 | **手册：云端兜底** |
| `cloud-without-privacy` | `false` | 没有 O-076 时是否仍允许出站 | 工程取值（保守档） |
| `max-audio-bytes` | `26214400` | 音频上限（云端 25 MB 硬限） | 工程取值 |
| `max-chars` | `20000` | 正文上限，超了截断并标 `truncated` | 工程取值 |
| `quiet` | `true` | 失败不打 warn | **手册：失败静默** |
| `verbose` | `false` | 成功也打一行日志 | 工程取值 |

## 五、兜底顺序（写死在 `service.ts`）

```
读音频 → 本地（若就绪）→ 失败且允许兜底 → 出站裁决 → 云端
```

三个「不」：

1. **不因为本地没装就报错**：`allow-cloud-fallback` 开着就去云端——这是手册
   「云端兜底」那半句的落实。否则那句「兜底」等于没有。
2. **不把两条路的失败揉成一个原因**：`tried` 逐条列出。
3. **不把 `ask` 说成 `deny`**：`egress-consent` 是「去点个头就行」，
   `egress-denied` 是「这条路走不通」。合成一个，用户只能猜。

## 六、格式与转码

- 按**魔数**判八种：WAV / MP3 / OGG / FLAC / M4A / WEBM / AIFF / AMR。不看扩展名。
- 本地路径要求 **16 kHz / 单声道 / 16 位** WAV（whisper.cpp 的命令行规格）。
  不是就用 ffmpeg 转一份（`-vn -ac 1 -ar 16000 -c:a pcm_s16le`）。
- **没有 ffmpeg 也仍然直接试一次**：有些构建自带解码支持。提前放弃等于替用户判死。
  真失败了会把 whisper 的 stderr 尾巴带在 `detail` 里。
- 转出来的 wav 与 whisper 写的 json 都在 `tmp/asr-work/a-<序号>/`，用完即删；
  `dispose()` 清掉本包建过的所有目录（**只清自己建的那些**）。

## 七、多模态入库契约（O-128 用）

`MultimodalDraft` 的**真源在 O-126 `ondra-vision/src/types.ts`**（本轮它先做）。
本包是**结构对位镜像**（不 import，§15.5）：字段名、类型、语义、指纹算法逐字一致。

```
modality: 'audio'（本包恒为它）
sourcePath, text, title, at, provider, model?, chars, truncated
fingerprint = fnv1a64(modality + '\0' + sourcePath + '\0' + text)   // 16 位十六进制
spans?          // 毫秒时间戳
degraded?       // 例如「没有转码，直接喂了原文件」
```

**指纹不含时间。** 同一段音频转两次必须得到同一个指纹，否则 O-128 会当成两条记忆。

**刻意不含** `kind` / `importance` / `pool`：那是记忆域自己的判断（O-010 / O-131）。

## 八、隔离五问（§16.4）

1. **关掉我，谁受影响？** 只有「听语音」这一件事。用户发语音时对话链拿不到转写，
   按「没听清」处理。不影响对话、不影响记忆、不影响看图。
2. **我的状态存在哪？** 只有两处，都**不持久**：计数在内存；转码产物在
   `tmp/asr-work/`，用完即删、`dispose()` 兜底。**没有库表、没有配置文件、没有落盘的正文。**
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.asr`；
   `available` / `reason` / `localReady` / `cloudReady` / `stats().byReason` / `stats().fallbacks`。
   注意 `quiet: true` 时**日志里看不到失败**，这是手册要的「失败静默」——
   排查要看 `stats()`，不是看日志。
4. **我依赖谁？缺席时怎么降级？** `ondra-privacy`（软：不在就保守拒绝云端）、
   `ondra-config-schema`（软）、`ondra-identity`（软）、`ondra-clock`（软）、
   `ondra-path-layout`（软：退回系统临时目录）。五个全软。
5. **我和同域的谁共享了可变状态？** 没有。O-126 是另一个服务，两包互不 import；
   唯一交汇点是 `MultimodalDraft` 这个**只读结构**。临时目录也各用各的子目录
   （`asr-work` vs `vision-frames`）。

## 九、多方案分支说明（§12）

| 能力 | 方案 | 处理 |
|---|---|---|
| 本地引擎 | A whisper.cpp 命令行（本包） / B 绑 Node 包 / C 云端优先 | **A**。B 要装依赖、要编译；C 违反手册「本地优先」 |
| 非 WAV 输入 | A ffmpeg 转码（本包） / B 直接拒 / C 自己解容器 | **A**。B 让真实语音（amr/silk/mp3）全废；C 是「难度极高、体量巨大」那一类 |
| 时间戳单位 | A 毫秒整数（本包） / B 秒浮点 | **A**。秒浮点会被每一处下游重复解释一次（`3.5` 是 3.5 秒还是 3500 毫秒） |
| 兜底时机 | A 本地失败才走云端（本包） / B 两条路都跑取较优 | **A**。B 会把每段语音都发出去一次，而「本地优先」的意义就是不出去 |
| 说话人 | A 留字段不填（本包） / B 编 `speaker-1` | **A**。B 是编造，且是最伤信任的一种编造 |

## 十、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 本地语音转写 | whisper.cpp | `github.com/ggerganov/whisper.cpp` | MIT | 命令行参数形状（`-m` / `-f` / `-oj` / `-of` / `-l` / `-t`）与 `-oj` 的 JSON 结构（`transcription[].offsets`） | 只起子进程 + 解析 JSON，**不引入源码** | 否 |
| 云端转写接口 | OpenAI Audio API | `platform.openai.com` | — | `POST /audio/transcriptions`、`multipart/form-data`、`response_format=verbose_json` 的分段结构 | `cloud.ts` 按此形状拼 FormData | 否（协议形状） |
| 音频格式转换 | ffmpeg | `ffmpeg.org` | LGPL/GPL（**外部进程调用，不链接、不并入**） | `-vn -ac 1 -ar 16000 -c:a pcm_s16le` 这条标准转码 | 起子进程 | 否 |
| 子进程收尾与 PATH 探测 | 本仓 O-050 `ondra-tts` | `cordis/ondra-tts` | 随仓 | 「起过的子进程集中收尾」与 `whichSync()` 只查文件不执行 | `local.ts` 同构 | 否 |
| 出站三层裁决 | 本仓 O-076 `ondra-privacy` | `cordis/ondra-privacy` | 随仓 | `declare()` / `evaluate()` 语义与「一个码一种处境」 | 直接消费（**复用**） | 否（只调服务） |
| 多模态条目契约 | 本仓 O-126 `ondra-vision` | `cordis/ondra-vision` | 随仓 | `MultimodalDraft` 字段与指纹算法 | 结构对位镜像（不 import） | 否 |

**档位判定：〔复〕复用。** 转写能力归 whisper 与云端接口，本包一个模型、一行推理都没写。

## 十一、已知限制

1. **说话人分离没有。** 见第一节。`diarized` 恒 `false`，`spans[].speaker` 恒缺省。
   要这条能力，得引入 pyannote 一类的东西——那是新依赖，需要一条裁决。
2. **本地要自己装 whisper。** 本包不下载模型、不编译二进制。没有就 `no-binary`，
   靠云端兜底；云端也没有就转不了。
3. **本地只吃 16 kHz 单声道 WAV**（除非构建自带解码）。本包用 ffmpeg 转，
   没有 ffmpeg 时退回「直接试一次」——成功率取决于那个构建。
4. **长音频不切片。** 超过 `max-audio-bytes` 直接拒（`too-large`）。
   一小时录音在云端也超 25 MB；要转先自己切。
5. **`-oj` 依赖 whisper.cpp 的版本。** 老版本可能不写 json，本包会报
   `payload` 并说「这个版本可能不支持 -oj」。
6. **`quiet: true` 时日志里看不到失败。** 这是手册要的「失败静默」，
   但意味着排查必须看 `stats().byReason`。这一条在面板上要能被看见，
   否则运维会以为「一切正常」。
7. **`empty` 不是故障也不是成功。** 静音、纯噪音、模型认为没人说话——都归它。
   若把它当成功，记忆里会多一条空记忆；若当失败，用户会被告知「出错了」。
8. **`spans` 可能为空而 `text` 不为空。** 某些构建只写顶层 `text`。
   本包**不补假时间戳**——补出来的时间会让下游以为「这句话在第 3 秒」。

## 十二、待裁决

1. **十五个工程默认值没有手册出处**（只有 `provider local`、`allow-cloud-fallback true`、
   `quiet true` 三条来自手册）。`binary whisper-cli` / `threads 4` / `timeout-ms 180000` /
   `cloud-model whisper-1` / `max-audio-bytes 25 MiB` 都是估的。
2. **`whisper-cli` 的命名。** whisper.cpp 新版叫 `whisper-cli`，旧版叫 `main`。
   默认选了新版；老机器要改配置。要不要做「两个都找一遍」？现在是只找一个名字。
3. **没有 O-076 时云端到底该不该发？** 现在默认不发。改 `cloud-without-privacy: true`
   即可，但那一改等于默认允许把语音传出去。
4. **要不要做长音频切片？** 现在不做（切了会截断句子）。若做，得先能检测静音段。
5. **`max-chars 20000` 与记忆条目的 200 字上限（§2.2）的关系。** 本包给全文，
   截到 200 字是 O-128 / O-140 的事。若主人希望本包直接给 200 字摘要，
   那需要一次额外的模型调用——与「转写不调生成模型」这条边界冲突。
6. **`ffmpeg` 是外部进程依赖，许可证是 LGPL/GPL。** 本包只起进程、不链接、不并入，
   按 §12.3 的口径属「动态链接式引入」的下限；但若主人要求零 GPL 接触，
   就得改成「只接受 16k 单声道 WAV」。

## 十三、自查

见 `ondra-plugin-index.md` 的「产出登记（第 76 轮）」。9 项机械自检 + 语言 5 项全过；
图标与仓库根 `icon.svg` 一致；交叉扫描 0 环、0 越界、服务键 0 冲突、0 冒号键。
