# ondra-tts

> O-050 · L4 表达（第 10 组第 1 项）· 档位〔复〕 · 服务键 `ondra-tts`

把一段文字变成声音。**三条通道并存，只做接线与降级，不重写任何合成机制。**

---

## 一、职责

| 能力 | 方法 | 手册依据 |
|---|---|---|
| 合成并出声 | `speak(text, opts?)` | §1.7 语音合成（102 个插件，复用档） |
| 只合成（发语音条、导出、试听） | `synth(text, opts?)` | 同上 |
| 19 个音色 / 8 套预设 | `voices()` / `presets()` / `presetOf()` | §1.7「19 音色 + 8 套预设：温柔/活泼/播音/东北/陕西/粤语/台湾/English」 |
| 通道探测（装完 CLI 后） | `probe()` | master-plan §14.2「当前生效分支必须可观测」 |
| 面板读状态 | `available` / `reason` / `engine` / `stats()` | §7.7 状态可视化 |

**唯一一条硬规矩**：任何失败都返回 `ok=false` + 原因码，**绝不抛错**（§9.4 失败策略）。朗读是增强能力，它挂了主对话必须还能跑（master-plan §3.3-3）。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 判断「这次要不要出声」 | `ondra-tts-gate`（O-051）四道闸门 |
| 六态语速（雀跃 +10% / 蔫 −15%） | `ondra-emotion-express`（O-031）算，`ondra-tts-gate` 传进来 |
| 改写口语（加语气词、拆长句、删动作描写） | `ondra-oral`（O-041）。本插件只**剥离**代码/表格/链接，不改写 |
| 切分句读、决定停顿 | `ondra-rhythm`（O-037） |
| 往会话里发消息、主动说一句 | 主动链（O-042/O-043）。本插件**无事件监听、无周期定时器**（只有单次合成的超时计时器，用完即清） |
| 注册 `speak` 工具 | 不做。理由见 `src/index.ts` 文件头 |

## 三、服务键与方法

```
ondra-tts          ← 连字符，不是 ondra:tts
```

| 成员 | 说明 |
|---|---|
| `available` / `reason` | 现在能不能合成；不能的原因（`disabled` / `no-engine` / `not-configured`） |
| `engine` | 当前生效通道：`gpt-sovits` / `macos-say` / `edge-tts` / `none` |
| `voices()` | 19 条音色（`id` / `zh` / `locale` / `gender`） |
| `presets()` / `presetOf(id)` | 8 套预设（`id` / `zh` / `voice` / `alt` / `locale`） |
| `speak(text, opts?)` | 合成 + 播放；`opts.play=false` 或配置 `playback=off` 时只合成 |
| `synth(text, opts?)` | 只合成，返回音频路径 |
| `probe(at?)` | 重建通道集合并逐条报「就绪 / 不可用 + 原因」 |
| `clear()` | 清空 `cache/tts` 下的音频 |
| `stats()` | `calls` / `ok` / `failures` / `cachedHits` / `played` / `lastOkAt` / `lastError` / `engine` / `cacheFiles` |

**`Utterance`**：`ok` / `reason` / `text`（净化后真正送进引擎的）/ `engine` / `voice?` / `preset?` / `audioPath?` / `bytes?` / `rate` / `rateApplied` / `cached` / `played` / `elapsedMs` / `at`

**原因码（`TtsReason`，13 个，每个都有分支真的发出）**：`ok` / `disabled` / `no-engine` / `empty` / `too-long` / `voice-unknown` / `not-configured` / `timeout` / `network` / `http` / `payload` / `spawn` / `playback`

`ok=true` 且 `reason='playback'` 是一个**合法组合**：音频已经合成好了、也落在缓存里，只是没放出声（没有输出设备、系统静音策略）。面板据此显示「可重播」，而不是「合成失败」。

## 四、口径与裁决

1. **三条通道是分支，不是三套逻辑。** 一个 `SpeechEngine` 接口，`branches/{gpt-sovits,macos-say,edge-tts}.ts` 各一份实现，配置 `provider` 选择。默认 `auto`：按手册 §9.4 的优先级（local > macos-say > 云端）取第一条「同步就绪」的。
2. **`auto` 与「默认选最稳」并不冲突。** master-plan §14.3 把 macOS `say` 写成默认最稳，说的是**失败率**不是排位；干净机器上没有 GPT-SoVITS，`auto` 自然落到 `say`。显式指定 `provider` 时**不回退**——用户点的是那一条，悄悄换掉等于面板在说谎。
3. **预设只换音色，不换语速。** 手册给过的语速数字（+10% / −15%）只属于六态。把语速也塞进预设，同一句话就有两个语速来源，而两处都不报错。
4. **长度超出直接拒绝，不截断。** 30 字的闸门在 O-051；这里是最后一道兜底（默认 300 字）。截断会让她把一句话念一半就停，听起来像卡带。
5. **GPT-SoVITS 不传 `speed_factor`。** `api_v2` 有这个东西，但它与参考音频的音色耦合、各版本口径不一。于是该分支恒报 `rateApplied=false`——面板要能看见「设了语速但这次没生效」。
6. **`macos-say` 不认 Edge 的音色 id。** `say -v` 只吃系统音色名，所以这一支用配置里的 `sayVoice`，并在结果里报**真正用到的**那个名字。不这么做，面板显示「晓晓」、耳朵听到「婷婷」，两边都不报错。
7. **缓存内容寻址 + 按数量淘汰。** 文件名是 `sha256(通道|音色|语速|音量|文本)` 的前 16 位；第二次同文直接命中，不再起进程。淘汰按「最多留 N 个（默认 200）」而不是按时间：一周没说过的一句还能命中。
8. **先写 `.part` 再改名。** `say` / `edge-tts` 都是边合成边写，进程被杀会留下「能播放但只念一半」的文件。半截音频进了缓存，症状是「她说到一半没声了」，而缓存逻辑一切正常。
9. **音频落 `cache/`，不落 `user/`。** 它可再生。这也让「清缓存」不必担心删掉要紧东西。

## 五、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 本地神经网络 TTS | GPT-SoVITS（6.4 万星） | github.com/RVC-Boss/GPT-SoVITS | MIT | `api_v2` 的 `/tts` 请求体字段（`text` / `text_lang` / `ref_audio_path` / `prompt_text` / `media_type`）与 15s 超时口径 | `src/branches/gpt-sovits.ts`（只发 HTTP，不引 SDK） | 否 |
| 系统语音 | macOS `say` / `afplay` | 系统自带（`man say`） | 随系统 | `-f` 读文件、`-v` 音色、`-r` 词/分钟、`--file-format=WAVE` 的用法 | `src/branches/macos-say.ts`、`src/player.ts` | 否 |
| 19 音色 + 8 预设 | `blacksunshy/coopanion-fatfish`（手册 §1.7 标注的来源） | github.com/blacksunshy/coopanion-fatfish | 未见许可证声明（手册未给） | **只借鉴「19 音色 + 8 套预设」这个产品结构**，不取它的任何代码或素材 | `src/voices.ts`（自写数据表，名单口径见「已知限制」） | 否 |
| Edge TTS | `rany2/edge-tts` | github.com/rany2/edge-tts | 以其仓库声明为准（本仓未逐字核对） | CLI 参数形态：`--voice` / `--rate=+10%` / `--volume` / `--text` / `--write-media` | `src/branches/edge-tts.ts`（外部进程对接，**不引代码**，遵循「不复制、只调用」的迁移纪律） | 否 |
| 内容寻址缓存 | 通用工程实践（非某个项目） | — | — | 哈希命名 + `.part` 原子替换 + 按数量淘汰 | `src/cache.ts` | 否 |

**档位判定：〔复〕。** 手册 §1.8 明确把「语音合成（102 个）」列入复用档。本插件**没有一行音频编解码、没有一行 WSS 握手**：三条通道全部交给外部实现（HTTP 服务 / 系统命令 / 外部 CLI），自己只做选路、参数换算、缓存与降级。自写部分只有三样：19 条音色数据、可朗读净化（一块正则）、缓存淘汰。

## 六、多方案说明（§12）

这是**分支插件**，按 §14.2 落实：

| 要求 | 落实 |
|---|---|
| 接口唯一 | `types.ts` 的 `SpeechEngine`，三个分支只实现它，不各自定义返回形状 |
| 文件隔离 | `src/branches/{gpt-sovits,macos-say,edge-tts}.ts`，没有 `if (mode === ...)` 铺开 |
| 默认最稳 | `auto` 落到 `macos-say`（零依赖、无网络）；`gpt-sovits` 只在配置齐时抢先 |
| 独立降级 | 每条分支自带失败路径与原因码，A 挂了不影响 B 被选中 |
| 可观测 | `engine` getter + `probe()` 的逐条报告 + `stats().lastError` |
| 不共享状态 | 三条分支共享的只有「缓存目录」与「进程出口」，没有共享的缓存键、连接或定时器 |

**刻意没做的两件事**：①**不做多通道对拍**（合成音频没有唯一真值，对拍只会得到一个永远吵不完的面板）；②**不做「失败即自动切通道重试」**——`say` 失败多半因为系统没声音、`edge-tts` 失败多半因为断网，盲切只会让一次失败变成两次，用户听到的是「过一会儿突然出声」。

## 七、隔离五问

1. **关掉我，谁受影响？** 只有我自己。O-051 的闸门读到 `unavailable` 后一律返回 `speak:false`（消息照常作为文字发出），对话链不受影响、不弹错。
2. **我的状态存在哪？** 内存里五个计数 + 进行中的合成表；磁盘上只有 `cache/tts/` 的音频（内容寻址，可随时清）。`user/` 一个字节都不写。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.tts`；`available` / `reason` / `stats().lastError` / `probe()` 四处都能读到原因码，面板不必猜。
4. **我依赖谁？缺席时我怎么降级？** `ondra-path-layout`（软，退到系统临时目录并打一行）、`ondra-config-schema`（软，退到本地校验）、`ondra-clock`（软，退到 `Date.now()`）、`ondra-identity`（软，退到固定命名空间）。没有上游服务键是硬的。
5. **我和同域的谁共享了可变状态？** 没有。不读情绪、不读闸门状态、不写任何人的文件。

## 八、已知限制

1. **19 音色的名单未能逐条核实。** 手册只写「19 音色 + 8 套预设」并指向 `coopanion-fatfish`，该仓库在本仓没有副本。因此名单按 8 套预设能覆盖的语言**反推**组成：普通话 8 + 粤语 3 + 台湾 3 + 英文 3 + 日 1 + 韩 1。音色 id 本身是 Edge 的公开标识，且整张表是可替换数据（`src/voices.ts`），换表不动逻辑。**若主人手上有上游原表，只需替换这一个文件。**
2. **GPT-SoVITS 参考文本可空这条口径未验证。** `prompt_text` 传空串在多数版本可用、少数版本 400。本插件不猜：空就传空串，真 400 就报 `http` 并把服务端错误体带回（`src/http.ts` 已识别 JSON 错误体）。
3. **`edge-tts` 需用户自行安装。** 本轮禁装依赖，本插件不代装、不下载。没装就是 `no-engine`，日志会写明「找不到 edge-tts」。
4. **没有离线可验证性。** 三条通道一次都没有实跑（本轮禁止实装运行）。参数按各自公开文档写；一旦某个参数改名，对应的分支会以 `spawn` / `http` 失败并留下 stderr 尾部，不会静默产出错音频。
5. **`macos-say` 没有音量参数。** `say` 只有 `-v` / `-r` / `-o` / `-f` 那一套；`volume` 在这一支被忽略，不会失败也不会生效。
6. **播放只走 `afplay`（macOS）。** 其它平台 `synth()` 可用但不出声（`played=false`、`reason=playback`）。跨平台播放器属 O-064 语音通道的职责，不在本插件。
7. **`edge-tts` 以 `-` 开头的文本可能被 argparse 误判。** 净化已剥掉行首列表符（`- `），残留概率极低；真遇到会以 `spawn` 失败并留下 stderr。

## 九、自检结论

九项机械自检 + 语言五项全过，逐项结果见本轮简报。结构：`package.json` / `tsconfig.json` / `cordis.patch.yml` / `src/{index,types,settings,voices,speakable,exec,http,cache,player,service}.ts` / `src/branches/{macos-say,edge-tts,gpt-sovits}.ts` / `locale/{en,zh}.json` / `icon.svg` / `README.md`，共 20 个文件。
