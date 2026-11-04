# ondra-weather

> O-047 · L4 生活感（第 9 组第 3 项）· 档位〔复〕 · 服务键 `ondra-weather`

外面冷不冷、要不要带伞。**只认显式坐标，取不到就不提。**

---

## 一、职责

| 能力 | 方法 | 手册依据 |
|---|---|---|
| 当前实况（气温 / 体感 / 湿度 / 风速 / 降水 / 现象） | `snapshot()` | §3.7「生活层要知道外面什么天」 |
| 今日最高最低、降水概率 | `snapshot()` | 同上 |
| 给提示词的一句话 | `text()` / `facts()` | §2.6 注入（由 O-036 取，本插件不注入） |
| 缓存与手动刷新 | 自动 / `refresh()` | — |
| 面板读状态 | `available` / `reason` / `configured` / `stats()` | §7.7 状态可视化 |

**唯一一条硬规矩**：`facts()` 取不到就返回 `undefined`。调用方据此**不提天气**，而不是拿到空对象自己编。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 定位、猜城市、按 IP 推断位置 | 不做。手册要求「需显式坐标」 |
| 写提示词、决定提不提 | `ondra-prompt-inject`（O-036）/ `ondra-dialogue`（O-033） |
| 用天气影响情绪 | `ondra-emotion-core`（O-026）；本插件只给事实 |
| 存历史天气、做趋势 | 不做。存了就要迁移、要清理、要解释「为什么上周的数据没了」 |
| 定时播报天气 | 主动链（O-042/O-043）；本插件零定时器 |
| 注册 `weather` 工具 | 不做。理由见 `src/index.ts` 文件头 |

## 三、服务键与方法

```
ondra-weather      ← 连字符，不是 ondra:weather
```

| 成员 | 说明 |
|---|---|
| `available` | 服务本身能不能工作：开关 + 坐标合法 + 有网络出口 |
| `reason` | 不能工作的原因（20 个码里的 8 个，见下） |
| `configured` | 坐标是否已配且合法（与 `available` 分开：配了坐标但被关掉时，两者不同） |
| `snapshot(at?)` | 取快照，走缓存。**永不抛出** |
| `refresh(at?)` | 强制重取，忽略缓存（面板「刷新」） |
| `facts(at?)` | 精简事实；取不到 `undefined` |
| `text(at?)` | 一句话；取不到 `undefined` |
| `clear()` | 清缓存（换城市后调用） |
| `stats()` | `calls` / `hits` / `failures` / `lastOkAt` / `lastError` / `cacheAgeMs` |

**`WeatherView`**：`available` / `reason` / `observedAt` / `fetchedAt` / `place?` / `tempC?` / `feelsC?` / `humidity?` / `windKph?` / `precipMm?` / `precipProb?` / `code?` / `phenomenon?` / `day?` / `highC?` / `lowC?`

**原因码（`WeatherReason`，9 个）**：`ok` / `disabled` / `no-coords` / `bad-coords` / `no-transport` / `network` / `timeout` / `http` / `payload`

九个码**每一个都有分支发出**。刻意没有「`internal`」这一档：内部异常在 `Transport` 里已被归成 `network`，再加一个永不发出的码，读者会以为存在一条兜底路径（纪律 84）。

## 四、口径与裁决

1. **坐标是一个 `lat,lon` 字符串，不是两个数字字段。** 两个字段必然出现「纬度填了、经度还是 0」的半对状态，而它不报错——它会安静地给出几内亚湾的天气。一个字段只有一个坏法：解析不出来 → 不提。
2. **`0,0` 判 `bad-coords`。** 那是数字输入框的残留值，真实含义几乎总是「没填」。真在几内亚湾海上，填 `0.1,0.1`。
3. **失败不给「陈旧兜底」。** 两小时前的实况当现在说，用户一开窗就知道不对，而插件每个字段都合格、日志全绿。缓存只活 `ttlMinutes`（默认 10，上限 180），过期即作废。
4. **并发去重。** 面板、对话链、提示词可能在同一秒各调一次；不去重就是三次同样的请求，接口按 IP 限流，症状是「越刷新越取不到」。
5. **主机与路径写死。** 只有 `https://api.open-meteo.com/v1/forecast`，只 GET，响应体封顶 64 KiB。坐标与地点名都**不能**影响主机——否则这个插件就是一个任意请求器。
6. **同一个失败原因只告警一次。** 轮询面板时每次失败都打一行，日志会被 `network` 刷满，真正的第一条反被埋掉。
7. **气温越界当格式错。** 允许 −90–60 ℃，越界说明单位被换了（例如变成华氏度），那时报出去的每个数字都是错的。

## 五、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 天气数据 | Open-Meteo（免费、**无需 key**） | github.com/open-meteo/open-meteo | AGPL-3.0（服务端）/ CC-BY-4.0（数据） | 接口字段命名、`timezone=auto` 口径、`current` + `daily` 两段取数 | `src/transport.ts` 的 `buildRequest()`、`src/payload.ts` | 否（只用 HTTP 协议，不引 SDK） |
| 天气码翻译 | WMO 4677（世界气象组织码表） | wmo.int（公开标准） | 公共标准 | 28 个码的语义 | `src/wmo.ts` 的 `WMO_TABLE`（自写中文口径，全仓唯一） | 否 |
| 超时与取消 | Node 标准库 / WHATWG Fetch | nodejs.org | MIT（Node 自身） | `AbortController` + `race` 双保险的取舍 | `src/transport.ts` | 否（只用内置能力） |
| 失败即沉默 | 手册 §3.7「取不到不提」 | —（手册内） | — | 「宁可少一句话，不可说错天气」 | `src/service.ts` 的 `facts()` 返回 `undefined` | 否 |

**档位判定：〔复〕。** 天气取数是手册 §1.8 明确列入「复用」的一类（生态里成熟的天气接口一大把），本插件**只做接线、配置与降级**：没有一行气象计算、没有一行历法、没有自建缓存层之外的东西。唯一的自写部分是 WMO 码的中文翻译——它是枚举翻译，不是算法，且必须全仓一份，否则同一场雨在不同插件里会有三个名字。

**为什么选 Open-Meteo 而不是 `wttr.in`**：`wttr.in` 返回的是给人看的文本（要再解析一遍自然语言），且默认带 ASCII 图；Open-Meteo 返回结构化的 `current` / `daily`，字段稳定、无需 key、有明确的 `timezone=auto`。两者都不需要密钥，选结构化那一个。

## 六、多方案说明（§12）

**本插件是单方案，不是分支插件。** 判断依据：§12.1「能融就融」——不同天气源之间的差异全部落在 `src/payload.ts` 的解析与 `src/transport.ts` 的地址拼装上，属于**参数化差异**，不是两套机制。若日后要接第二个源，做法是给 `Transport` 加一个 `source` 字段并在 `payload.ts` 里并列两个解析函数，**不新开插件、不复制服务键**。

刻意没做的两件事：①不做「多源对拍」（天气没有唯一真值，对拍只会产生一个永远吵不完的面板）；②不做「主源失败切备源」（两个免费接口同时挂的概率极低，而切源会让「今天几度」在两个源之间跳）。

## 七、隔离五问

1. **关掉我，谁受影响？** 只有我自己。`facts()` 消失后，提示词里少一句天气，其余链路不受影响（消费方都按 `undefined` 处理）。
2. **我的状态存在哪？** **只在内存**：一份 10 分钟的缓存 + 六个计数。卸载走 `ctx.effect` 的 disposer 清缓存（坐标是隐私，不该跟着模块变量留着）。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.weather`；`available` / `reason` / `stats().lastError` 三处都能读到原因码，面板不必猜。
4. **我依赖谁？缺席时我怎么降级？** `ondra-clock`（软，退回 `Date.now()`）、`ondra-config-schema`（软，退回本地校验）、`ondra-identity`（软，退回固定命名空间）；运行时 `fetch`（缺席 → `no-transport`，一句都不提）。
5. **我和同域的谁共享了可变状态？** 没有。不读别人的状态、不写任何人的文件。

## 八、已知限制

1. **宿主没有可消费的 HTTP 服务键。** `desktop/packages` 与 `desktop/docs` 全仓检索无 http / fetch / net 服务键，因此本插件用 `globalThis.fetch` **直连**，**不走 `ondra-http-proxy`**。宿主若配了代理，这里的请求会绕过它。替换点收在 `src/transport.ts` 一个文件，`FetchLike` 即接口。
2. **没有定位。** 必须手填坐标；这是刻意的（猜错城市会连着几天说错天气，且看起来一切正常）。
3. **只有当天。** `forecast_days=1`，不做三日/七日预报——「明天可能有雨」属于提醒，提醒归主动链，不归事实层。
4. **没有离线可验证性。** 本轮禁止实装运行，接口的真实返回**没有跑过一次**；解析按 Open-Meteo 公开文档的字段写，字段改名即 `payload` 失败（会说出来，不会静默给错数）。
5. **`observedAt` 的时区口径依赖 `timezone=auto`。** 接口给的是不带偏移的本地时间，`Date.parse` 按宿主本地时区解释；跨时区使用时这个时刻可能偏几小时（不影响温度，只影响「这条数据几点的」）。

## 九、自检结论

九项机械自检 + 语言五项全过，逐项结果见本轮简报。结构：`package.json` / `tsconfig.json` / `cordis.patch.yml` / `src/{index,types,settings,wmo,payload,transport,service}.ts` / `locale/{en,zh}.json` / `icon.svg` / `README.md`，共 14 个文件。
