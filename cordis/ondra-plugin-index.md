# Ondra 插件台账 v2（手册对齐版）

> **唯一依据**：`material/Ondra-dev-handbook.md`（2026-10-31 版，5202 行；第一～十二部分为规范）。
> 规则真源：`ondra-master-plan.md`（分层、依赖、参数速查、开源纪律、多方案纪律、隔离规范、交叉防控、自检清单）。
> 本版取代 v1（已备份至 `.backup/ondra-plugin-index-v1-*.md`）。v1 的 27 个插件产物已清空并移入废纸篓，备份在 `.backup/cordis-plugins-before-reset-*.tar.gz`。
> 状态取值：`pending` / `doing` / `done` / `blocked` / `skeleton`（占位，必须显式提示未实现）。

**统计**：核心 96 项 + 分支 3 项 + 手册新增 21 项 + 扩展池 24 项 = **144 项**。已完成 0。

---

## 0. 与 v1 的四处结构性修正（全部来自手册）

| # | 修正 | 手册依据 | 影响 |
|---|---|---|---|
| 1 | **服务键改用连字符**：`ondra-memory-core`，不用 `ondra:memory-core` | §8.4 第六条：必须匹配 `^[a-z][a-z0-9_-]{1,63}$` | v1 全部 27 个插件服务键不合规，已随清空作废 |
| 2 | **每个插件必须有 `cordis.patch.yml` + `package.json` 的 `dsh.bundle.patch`** | §8.3-1：漏了宿主只在 stderr 打一行 `declares no dsh.bundle`，**插件永远不加载** | v1 的 27 个插件 0 个有 patch 文件，等于全部白做 |
| 3 | **三档复用**：复用 / 薄封装 / 自研，**自研压到 15 个以内** | §1.8 | 通道、语音、视觉、桌宠、市场、图标、农历、记忆底层不再自研 |
| 4 | **新增 21 项**（O-124~O-144），**O-145 不建**（一次性盘点任务，不是插件） | §1.5 / §1.6 | 清单从 123 → 144 |

**档位标记**：〔复〕复用（生态成熟，只做接线与降级）｜〔薄〕薄封装（包一层适配与护栏）｜〔研〕自研（生态没有，允许写厚）。
**判定纪律**：动手前必须查生态并在 README「技术来源」表写明档位与依据；**能复用却自研 = 违规**。

---

## 1. 执行批次（按手册 §12.2 + §12.1 P0 优先序）

> 手册原话：「**如果只能做三件：①寿命计算（11 类基线乘积式）②召回不按条数砍（dropped 恒为 0）③禁止报数铁律。** 这三件决定她"像不像记得"，比立绘、语音、界面都更早被用户感知。」
> **阻塞关系**：先建 `ondra-llm-gateway`（O-035），`O-011` extract / `O-014` recall 扩展 / `O-019` dream 全部等它的模型调用路径。

| 批次 | 名称 | 包含编号 | 说明 |
|---|---|---|---|
| **B0** | 基座 | O-001 ~ O-005 | 命名、路径、时钟、配置、日志，无依赖 |
| **B1** | 存储与模型网关 | O-006 ~ O-009、**O-035** | **O-035 是全仓阻塞项，优先做** |
| **B2** | 记忆纵深（P0） | O-010 ~ O-019、O-131、O-140、O-142、O-136 | 寿命 11 类基线、八池、RRF、证据门控、注入去重、评估集 |
| **B3** | 人格与情绪（P0） | O-020 ~ O-032、O-123、O-129、O-130 | 阈值漂移、缺口池、七阶、PAD、化学池、内感受铁律 |
| **B4** | 表达 | O-036 ~ O-041、O-050 ~ O-054、O-137 | 九步过滤、语感统计、TTS 双通道、立绘复用 |
| **B5** | 主动与节制 | O-042 ~ O-049、O-134、O-135 | 照抄 dsh-proactive、防封六道闸、爬楼、叙事日志 |
| **B6** | 运行时治理 | O-132、O-133、O-138、O-139、O-141、O-143、O-144 | 器官 ABI、schema 门控、失败归因、零常驻、反射弧 |
| **B7** | 通道 | O-055 ~ O-067 | 以复用为主，只自研"人格一致性 + 节制" |
| **B8** | 界面 | O-085 ~ O-096、O-124、O-125 | 三栏、成长面板、提示词预览 |
| **B9** | 多模态 | O-126 ~ O-128 | 视觉、ASR、多模态记忆 |
| **B10** | 端侧 | O-068 ~ O-075 | adb/scrcpy、MCP、GUI、桌宠（复用生态） |
| **B11** | 系统与交付 | O-076 ~ O-084 | 隐私、自检、安装器、进程托管 |
| **B12** | 多方案分支 | O-121 ~ O-123 | 备用保障，主分支出问题时切换 |
| **B13** | 扩展池 | O-097 ~ O-120 | 核心完成后接续 |

**每轮 2 个，同批内编号相邻**（防交叉见 master-plan §15）。

---

## 第 1 组 · L0 基座（5 项）

| 编号 | 插件 | 档位 | 职责 | 依赖 | 状态 |
|---|---|---|---|---|---|
| O-001 | `ondra-identity` | 〔研〕 | 产品名/进程名/pidfile/环境变量前缀唯一真源 | — | pending |
| O-002 | `ondra-path-layout` | 〔研〕 | 数据根解析、目录创建、0700/0600 | `ondra-identity` | pending |
| O-003 | `ondra-clock` | 〔研〕 | 统一时间源与自然日判定 | — | pending |
| O-004 | `ondra-log-zh` | 〔研〕 | 中文日志双层、4MB×3 轮转、**单进程写放大保护**（同错每秒 1000 条去重，§8.3） | `ondra-path-layout` | pending |
| O-005 | `ondra-config-schema` | 〔研〕 | 配置四层结构与默认值真源 | — | pending |

## 第 2 组 · L1 存储（4 项）

| 编号 | 插件 | 档位 | 职责 | 依赖 | 状态 |
|---|---|---|---|---|---|
| O-006 | `ondra-store-sqlite` | 〔薄〕 | SQLite 端口：WAL/外键/建表/补列/chmod | `ondra-path-layout` | pending |
| O-007 | `ondra-store-memory` | 〔研〕 | 内存兜底（SQLite 不可用） | — | pending |
| O-008 | `ondra-data-migrate` | 〔研〕 | 幂等初始化与版本迁移 | `ondra-store-sqlite` | pending |
| O-009 | `ondra-snapshot` | 〔研〕 | `VACUUM INTO`、KEEP=3、显式 restore | `ondra-store-sqlite` | pending |

## 第 3 组 · L2 记忆域（10 项）

| 编号 | 插件 | 档位 | 职责 | 依赖 | 状态 |
|---|---|---|---|---|---|
| O-010 | `ondra-memory-core` | 〔研〕 | 双层表 + **寿命 11 类基线乘积式**（§2.4）：`S(h)=baseHours×(0.45+salience/100×1.25)×(1+arousal×0.65)`；三通道 4d/12d/180d 作第二层调制，**先类别后通道相乘** | `ondra-store-*` | pending |
| O-011 | `ondra-memory-extract` | 〔研〕 | LLM 提炼 + **来源类别 + 逐字引文校验**（§1.7） | `ondra-llm-gateway` | pending |
| O-012 | `ondra-memory-dedupe` | 〔研〕 | 去重裁决；合并阈值按裁决⑥（包含度 0.4，**不与其他口径互搬**） | `ondra-memory-core` | pending |
| O-013 | `ondra-memory-decay` | 〔研〕 | 衰减 + **SM-2 间隔复习**（§1.7）；只衰减条目，边归 O-015（裁决⑪） | `ondra-memory-core` | pending |
| O-014 | `ondra-memory-recall` | 〔研〕 | **五因子** `语义.18+关键词.46+图谱.11+重要.14+新鲜.11`；BM25 `k1=1.2,b=0.75`；新鲜度 `0.5^(距上次想起÷半衰期)`；**RRF 融合**；三路径（字面/向量/recognition）；**召回不按条数砍，`dropped` 恒为 0**（P0） | `ondra-memory-core` | pending |
| O-015 | `ondra-memory-graph` | 〔研〕 | 图谱四边建边与 1 跳扩散 | `ondra-memory-core` | pending |
| O-016 | `ondra-memory-prospective` | 〔研〕 | 承诺/待办：锁原文、反向权重、kept/broken 结算 | `ondra-memory-core` | pending |
| O-017 | `ondra-memory-audit` | 〔研〕 | 遗忘可解释：强度/半衰期/剩余、钉住/忘掉、**四态删除**（forget/seal/沉底/revise） | `ondra-memory-core` | pending |
| O-018 | `ondra-memory-humanlike` | 〔研〕 | 三通道视图 + 随机回顾骰子 | `ondra-memory-core` | pending |
| O-019 | `ondra-memory-dream` | 〔研〕 | **闸式做梦为默认**（只补带出处的事实）；`lightweight: true` 分支：空闲 2 分钟浅睡 / 5 分钟深睡，纯规则挖五类卡片（pitfall/playbook/hotspot/unresolved/fact），未用卡片 168h 半衰期、归档不删（§1.7）；**荒诞联想 + 梦话为独立分支，与闸式不可兼得**（裁决⑤） | `ondra-memory-core`、`ondra-llm-gateway` | pending |

## 第 4 组 · L2 人格域（6 项）

| 编号 | 插件 | 档位 | 职责 | 依赖 | 状态 |
|---|---|---|---|---|---|
| O-020 | `ondra-persona-loader` | 〔研〕 | 读 `ondra-persona-skills/*.skill.zip` 注册可用人设（人设包只读）；**出厂人格为鲸鲸，夏柠柒为示例包**（§1.1） | `ondra-path-layout` | pending |
| O-021 | `ondra-persona-core` | 〔研〕 | L1 内核 + 五关系变体 + 六槽位 | `ondra-persona-loader` | pending |
| O-022 | `ondra-persona-vars` | 〔研〕 | 变量替换与浓度提示 | `ondra-persona-core` | pending |
| O-023 | `ondra-persona-assemble` | 〔研〕 | 四段拼装 + 预算裁剪 + `overBudget` 上报 | `ondra-persona-core` | pending |
| O-024 | `ondra-worldbook` | 〔研〕 | 六层预算：总 1600（L1 350 / L2 180 / L3 100 / L4 500 / L5 200 / L6 150），撞限整条丢 | `ondra-persona-core` | pending |
| O-025 | `ondra-worldbook-scenes` | 〔研〕 | 场景卡数据、关键词触发、同层互斥、递归 ≤3 | `ondra-worldbook` | pending |

## 第 5 组 · L2 情绪域（7 项）

| 编号 | 插件 | 档位 | 职责 | 依赖 | 状态 |
|---|---|---|---|---|---|
| O-026 | `ondra-emotion-core` | 〔研〕 | **PAD 三维 + 10 固定标签**（单条上限 0.12 / 标签上限 0.6 / 标签半衰期 45min / 心情 6h）；六维指数回归；**化学池三激素**（dopamine 50/45min、cortisol 20/30min、serotonin 50/120min；stress −1.5/min、recover +0.8/min）；气质四旋钮；动态激素 ≤12 种；**存档缺字段补基线 50 不补 0**（§3.2） | `ondra-store-*` | pending |
| O-027 | `ondra-emotion-diffuse` | 〔研〕 | 跨会话弥散 `(mood−baseline)×0.4×(1−familiarity×0.5)` | `ondra-emotion-core` | pending |
| O-028 | `ondra-emotion-stage` | 〔研〕 | **七阶底座**（敌意→试探→心动→占有→病态→献祭→落定）+ 防跃迁 + 冲突锁；五阶段与六段 0–1000 为只读映射，**病态/献祭不进默认 UI**（裁决③） | `ondra-emotion-core`、`ondra-clock` | pending |
| O-029 | `ondra-emotion-stress` | 〔研〕 | **应激注意力倍率**（§3.8）：cortisol≥80 危机 ×3 / 日常 ×0.1；60 时 ×2 / ×0.55；≤40 均为 ×1；≥80 时系统提示词最前注入行为指令 | `ondra-emotion-core` | pending |
| O-030 | `ondra-emotion-conflict` | 〔研〕 | 冲突锁：tension+0.15、压 mood、禁撒娇/不主动/回复变短；解锁 = 致歉或连续 2 次正向且 mood 回升 | `ondra-emotion-core` | pending |
| O-031 | `ondra-emotion-express` | 〔研〕 | **六态映射**（雀跃/软和/平静/蔫/炸毛/困），**与宣传片 05 章完全一致，不得增删改名**；同接 prompt / rhythm / tts 三处 | `ondra-emotion-core`、`ondra-emotion-stage` | pending |
| O-032 | `ondra-emotion-project` | 〔研〕 | 情感投影；**内感受铁律：禁报数**（P0，§4.3），只给"我有点累"这类主观表述 | `ondra-emotion-core` | pending |

## 第 6 组 · L3 对话链（5 项）

| 编号 | 插件 | 档位 | 职责 | 依赖 | 状态 |
|---|---|---|---|---|---|
| O-033 | `ondra-dialogue` | 〔研〕 | 编排：取上下文→组装→流式→收尾；**不建 Session、不写 session_log**；**会话内冻结前缀**（稳定段在头、易变段追加尾部，禁止每轮重拼，§8.5） | 全部 L2 + `ondra-llm-gateway` | pending |
| O-034 | `ondra-dialogue-protocol` | 〔研〕 | 五帧：`text-delta`/`text-replace`/`crisis`/`usage`/`done` | — | pending |
| O-035 | `ondra-llm-gateway` | 〔薄〕 | **全仓阻塞项**：模型供给、密钥注入、超时重试、三来源切换（在线 API / 本地 / 免费模型，§1.10 需求五） | `ondra-config-schema` | pending |
| O-036 | `ondra-prompt-inject` | 〔研〕 | **首轮一次大块 + 正文留盘按需展开**（§1.7）；**装箱制**（装不下跳过继续试，段标题写"另有 N 条未展开"）；预算三档 2600/24000/1200，默认 2600（§2.6） | `ondra-persona-assemble`、`ondra-memory-recall` | pending |
| O-037 | `ondra-filter-chain` | 〔研〕 | **九步过滤链**（§4.1，P0）+ **事后评审回环**：独立模型 1–100 分，低于阈值带反馈 steer 回去，每轮最多 2 轮（§1.7） | `ondra-persona-core`、`ondra-emotion-express` | pending |

## 第 7 组 · L4 节奏与拟人（4 项）

| 编号 | 插件 | 档位 | 职责 | 依赖 | 状态 |
|---|---|---|---|---|---|
| O-038 | `ondra-rhythm` | 〔研〕 | 分条与停顿纯函数：`long_pause_p 0.20`、停顿 [3000,9000]ms、首字延迟 [800,2000]ms、`self_correct_p 0.05`、深夜系数 1.6、上限 4 条 | — | pending |
| O-039 | `ondra-rhythm-typing` | 〔研〕 | 打字速度、首条延迟、长停顿、自我修正 | `ondra-rhythm` | pending |
| O-040 | `ondra-oral` | 〔研〕 | 口语化：口头禅池、语气词、不完整句、标点习惯 | `ondra-emotion-express` | pending |
| O-041 | `ondra-breath` | 〔研〕 | 「正在输入」与呼吸感动作，单日上限 2 | `ondra-rhythm-typing` | pending |

## 第 8 组 · L4 主动（3 项）

| 编号 | 插件 | 档位 | 职责 | 依赖 | 状态 |
|---|---|---|---|---|---|
| O-042 | `ondra-proactive-gate` | 〔薄〕 | **照抄 dsh-proactive 全套**（§1.7）：模型自排闹钟（一次/间隔/cron+抖动）、session resume 唤醒冷会话、静默时段+每日投递预算双门控、`proactive_reclaim` 收尾并折叠 tombstone、`min_idle_seconds`、声明式 schedule 幂等同步、Web 面板；叠加**防封六道闸**（§5.3） | `ondra-memory-prospective`、`ondra-emotion-core` | pending |
| O-043 | `ondra-proactive-reason` | 〔研〕 | 话由排序（承诺 > 待办 > 近期事件 > 时间线 > 环境）+ **她自己在惦记**（缺口池，§3.13）+ 72h 话题冷却 | `ondra-memory-prospective`、`ondra-live`、`ondra-drive-gap` | pending |
| O-044 | `ondra-proactive-quota` | 〔研〕 | 额度、间隔、35% 放弃率、连续无回应衰减；**群聊不主动、一键静音**（§5.8） | `ondra-proactive-gate` | pending |

## 第 9 组 · L4 生活感（5 项）

| 编号 | 插件 | 档位 | 职责 | 依赖 | 状态 |
|---|---|---|---|---|---|
| O-045 | `ondra-diary` | 〔研〕 | 每日 02:00–04:00 第一人称日记，一天一 Markdown，不打扰 | `ondra-memory-core` | pending |
| O-046 | `ondra-live` | 〔复〕 | 日期事实；**lunar-javascript / tyme4ts 双分支直接复用对拍**（§1.7） | — | pending |
| O-047 | `ondra-weather` | 〔复〕 | 天气（需显式坐标），取不到不提 | `ondra-config-schema` | pending |
| O-048 | `ondra-life-rhythm` | 〔薄〕 | **生活层并入本插件**（§3.7）：独立脚本进程、随机六类活动、兴趣权重+标签、10% 探索、笔记分长期/临时、心情差优先放松型；**能量与作息**（§3.3）：清醒 +0.2/min、深睡/深夜 +1/min、`naturalCap=60`、冻结不恢复、分段积分 5min、睡醒缓冲取走即清零 | `ondra-rhythm`、`ondra-clock` | pending |
| O-049 | `ondra-onthisday` | 〔研〕 | 那年今日回忆 | `ondra-memory-graph` | pending |

## 第 10 组 · L4 表达（5 项）

| 编号 | 插件 | 档位 | 职责 | 依赖 | 状态 |
|---|---|---|---|---|---|
| O-050 | `ondra-tts` | 〔复〕 | **双通道**：GPT-SoVITS（本地）/ Edge TTS（19 音色 + 8 套预设：温柔/活泼/播音/东北/陕西/粤语/台湾/English）（§1.7） | `ondra-path-layout` | pending |
| O-051 | `ondra-tts-gate` | 〔研〕 | 四闸门：开关 / 6–30 字 / 情绪强度 ≥0.15 / 3 秒频控 + 连续两条后强制文本 | `ondra-tts`、`ondra-emotion-core` | pending |
| O-052 | `ondra-expression-decide` | 〔研〕 | 正文 → 表情标记（规则版） | `ondra-emotion-express` | pending |
| O-053 | `ondra-sticker` | 〔研〕 | 贴纸包读取分发，文件名即标签，缺失回退内置 | `ondra-path-layout`、`ondra-persona-core` | pending |
| O-054 | `ondra-avatar` | 〔复〕 | **不必自研**：airi（50.9k★）/ dsh-whale-girl-live2d（§1.7），只做接线与静态降级 | `ondra-emotion-express` | pending |

## 第 11 组 · L5 通道（13 项）

> **隔离铁律**：一通道一插件 + 独立 Config + 独立凭据 `user/channels/<id>.json`(0600) + 独立日志命名空间 + 独立探针 + 独立启停。
> **手册裁决**：QQ 这一路**完全不自己写**（≥5 个成熟 QQ 通道），只自研"人格一致性"与"节制"（§1.7）。

### 11.1 通道公共层（3 项）

| 编号 | 插件 | 档位 | 职责 | 状态 |
|---|---|---|---|---|
| O-055 | `ondra-router` | 〔研〕 | 唤醒判断、多会话排队、能力查询；**唤醒身份纪律 P0**（§5.4，只在私聊唤醒） | pending |
| O-056 | `ondra-channel-kit` | 〔研〕 | 公共段纯函数：`callPersona`/`chunkText`/`PeerHistory` 工厂；不落盘、不限流、不持状态 | pending |
| O-057 | `ondra-channel-health` | 〔研〕 | 每通道独立探针，只读日志命名空间；**不依赖被观测进程存活** | pending |

### 11.2 合规通道（7 项）

| 编号 | 插件 | 档位 | 传输 | 状态 |
|---|---|---|---|---|
| O-058 | `ondra-adapter-qq-official` | 〔复〕 | QQ 开放平台 OpenAPI v2 + WS | pending |
| O-060 | `ondra-adapter-wechat-official` | 〔复〕 | 公众号 Webhook + 5 秒降级 + 客服消息 48h | pending |
| O-061 | `ondra-adapter-wechat-kf` | 〔复〕 | 微信客服 `sync_msg` 拉取 | pending |
| O-063 | `ondra-adapter-wecom` | 〔复〕 | 企业微信回调 + 应用消息 | pending |
| O-064 | `ondra-adapter-feishu` | 〔复〕 | 飞书事件订阅 | pending |
| O-065 | `ondra-adapter-dingtalk` | 〔复〕 | 钉钉 Outgoing + sessionWebhook | pending |
| O-066 | `ondra-adapter-telegram` | 〔复〕 | `getUpdates` 长轮询 | pending |

### 11.3 高危与补充（3 项）

| 编号 | 插件 | 档位 | 说明 | 状态 |
|---|---|---|---|---|
| O-059 | `ondra-adapter-qq-napcat` | 〔复〕 | NapCat 反向 WS；高危独立区块 + 二次确认 | pending |
| O-062 | `ondra-adapter-wechat-personal` | 〔复〕 | **wxauto 有成熟实现但风险更高**（§1.7）；双闸门 `enabled`+`confirmed` | pending |
| O-067 | `ondra-adapter-discord` | 〔复〕 | Gateway WS v10 | pending |

## 第 12 组 · L6 端侧（8 项）

| 编号 | 插件 | 档位 | 职责 | 状态 |
|---|---|---|---|---|
| O-068 | `ondra-adb` | 〔复〕 | **scrcpy 能力更强（投屏+控制）**（§1.7），插件做封装与只读默认 | pending |
| O-069 | `ondra-device-mcp` | 〔研〕 | 手机只读 MCP（notifications/sms/contacts/battery/foreground） | pending |
| O-070 | `ondra-desktop-mcp` | 〔研〕 | 电脑只读 MCP（进程/窗口/剪贴板类型长度/文件检索/系统状态） | pending |
| O-071 | `ondra-browser` | 〔复〕 | 浏览器自动化（生态成熟，只做接线） | pending |
| O-072 | `ondra-gui-agent` | 〔研〕 | 单步决策环 + 四级风险 + 表单红线 + 审计；**手册补：三层安全网必须落地**（危险区黑名单 / App 白名单 / 动作确认阈值） | pending |
| O-073 | `ondra-minecraft` | 〔复〕 | Mineflayer 接入（占位） | pending |
| O-074 | `ondra-pet` | 〔复〕 | **复用 dsh-pet / agentpet（MIT）**（§1.7），不自研 | pending |
| O-075 | `ondra-pet-mobile` | 〔复〕 | 占位，钉住三端技术前提 | pending |

## 第 13 组 · L7 系统与交付（9 项）

| 编号 | 插件 | 档位 | 职责 | 状态 |
|---|---|---|---|---|
| O-076 | `ondra-privacy` | 〔研〕 | 合规告知、风控三层提醒、出站清单 | pending |
| O-077 | `ondra-startup-check` | 〔研〕 | 自检十项（§8.3），**第十项：验证"宿主会不会真的加载我"**；只判定不拦启动 | pending |
| O-078 | `ondra-market` | 〔复〕 | **dsh-market 生态已有**（§1.7），只做接线 | pending |
| O-079 | `ondra-installer` | 〔研〕 | 九步流水线；**清单制 Bootstrap：每组件独立 sha256 + 记账文件 + `bootstrap-ok` 自检**（§8.3） | pending |
| O-080 | `ondra-process-host` | 〔研〕 | 子进程托管：detached + pidfile + 组杀 + 重启 1 次 | pending |
| O-081 | `ondra-window` | 〔研〕 | hiddenInset、44px 拖动区、红绿灯避让 | pending |
| O-082 | `ondra-onboarding` | 〔研〕 | 四段首启引导；**宣传片 01 章验收基线**（§1.11） | pending |
| O-083 | `ondra-port-picker` | 〔研〕 | 9060–9079 回环挑端口 | pending |
| O-084 | `ondra-dev-rebrand` | 〔研〕 | Dev.app 改名换图标并逐层重签 | pending |

## 第 14 组 · L8 界面（12 项）

| 编号 | 插件 | 档位 | 职责 | 状态 |
|---|---|---|---|---|
| O-085 | `ondra-ui-shell` | 〔研〕 | 三栏骨架 272/1fr(≥520)/300、滚动规则、栏显隐 | pending |
| O-086 | `ondra-ui-tokens` | 〔研〕 | 设计令牌：品牌 `#6E56E0`（白字 5.16:1）、字号 7 档、圆角 6 档、密度三档 | pending |
| O-087 | `ondra-ui-icons` | 〔复〕 | **morphicons 直接 vendor**（44 图标 + 12 组 morph）（§1.7） | pending |
| O-088 | `ondra-ui-api` | 〔研〕 | `/api/ntdpet` 核心 19 + 扩展 40+ 路由；`X-Ondra-Token`；**前缀单点声明**（§7.8 404 根因） | pending |
| O-089 | `ondra-ui-chat` | 〔研〕 | 对话渲染、SSE、时间分隔、富消息 | pending |
| O-090 | `ondra-ui-sessions` | 〔研〕 | 会话列表、搜索、右键菜单 | pending |
| O-091 | `ondra-ui-panel` | 〔研〕 | 右栏卡片；**六态光球可视化**（宣传片定案） | pending |
| O-092 | `ondra-ui-settings` | 〔研〕 | 设置面板 + **必须补出的 9 个入口**（§7.3）+ 设置 15 条（§7.4） | pending |
| O-093 | `ondra-ui-a11y` | 〔研〕 | aria、键盘、焦点、对比度 | pending |
| O-094 | `ondra-ui-theme` | 〔研〕 | 系统深浅色 + 日出日落 + 主题色自定义 | pending |
| O-095 | `ondra-ui-toast` | 〔研〕 | 分级 Toast、空态、骨架、错误重试 | pending |
| O-096 | `ondra-ui-logs` | 〔研〕 | 中文简易日志视图 + 开发者代码日志 | pending |

## 第 15 组 · 手册新增（21 项，O-124 ~ O-144）

| 编号 | 插件 | 档位 | 职责 | 关键参数 | 优先级 | 状态 |
|---|---|---|---|---|---|---|
| O-124 | `ondra-ui-growth` | 〔研〕 | 成长面板 9 view（情绪/情绪曲线/性格/记忆/记忆星图/好感/学习/花费/体检），只读快照 | 一份大 snapshot；60s 刷新；preload 只暴露 5–7 方法 | P1 | pending |
| O-125 | `ondra-ui-prompt-preview` | 〔研〕 | 提示词预览：返回模型这轮真正收到的文本与工具清单 | `GET /api/prompt-preview`，只读脱敏 | P1 | pending |
| O-126 | `ondra-vision` | 〔复〕 | 图片理解/OCR/物体定位/视频抽帧，provider 可插拔，默认关 | 云端 OpenAI 兼容 / 本地 Ollama / 通义千问；与 privacy 联动出站提示 | P1 | pending |
| O-127 | `ondra-asr` | 〔复〕 | 语音转写（时间戳 + 说话人分离），本地 whisper 优先 | 失败静默；转写文本按普通记忆入库 | P1 | pending |
| O-128 | `ondra-multimodal-memory` | 〔研〕 | 视觉描述/转写入库，带 `modality` 与 `source_path` | 图片→描述；语音→转写；视频→4 帧+音轨 | P1 | pending |
| O-129 | `ondra-drive-gap` | 〔研〕 | 缺口池与张力：三源生成、幂等张力、去重加压、闭合连坐 | `tension = clamp(base + h×rate − relief)`；相似度 ≥0.6 只 +10；唤醒门槛 tension≥80 | **P0** | pending |
| O-130 | `ondra-persona-evolve` | 〔研〕 | 由经历改写人格：特质分、漂移日志、阈值漂移 | `threshold = base×(1+0.6×min(1,n/5000))`，上限 +60%；`explainThreshold()` | **P0** | pending |
| O-131 | `ondra-memory-pool` | 〔研〕 | 八池分层与宽限/半衰期/归档（"铁律"独立成池） | core ∞/上限 32、skillRule 730d、skillExp 60d、dailyCore 60d、dailyPartial 20d、emotion 1d、hippocampus 1d 永不注入；**标签未命中不猜→海马体** | **P0** | pending |
| O-132 | `ondra-organ-host` | 〔研〕 | 器官 ABI + 宿主：装载拓扑、能力白名单、能量会计、反馈仲裁、提示词拼装、遥测 | C1/C2/C3；default-deny；`order/ttl/confidence`；疤痕 −1e4 | **P0** | pending |
| O-133 | `ondra-install-doctor` | 〔研〕 | 安装自检：算出入口树、报告被跳过的 bundle 与告警 | 移植 `parsePatchYaml/applyEntryPatches/composeEntries` | P1 | pending |
| O-134 | `ondra-climb` | 〔研〕 | 爬楼：群未读积压补读（摘要+时间+人+群号），带上限 | 「40 条没看」→逐条摘要；唤醒只在私聊 | P2 | pending |
| O-135 | `ondra-narrative-log` | 〔研〕 | 回复决策解释：「她为什么这么回」 | 只读追加，供 UI 与 audit 查 | P1 | pending |
| O-136 | `ondra-recall-eval` | 〔研〕 | 检索评估：20–40 条真实问法，输出 recall@1/@3/MRR | 含换说法集；报告落盘；**改一次跑一次，先于任何调参** | P1 | pending |
| O-137 | `ondra-lexicon` | 〔研〕 | 语感统计：最近 300 条真人消息算中位句长/无标点率/语气词 | 注入约 130 字；只统计不覆盖人格；注入块带 marker | P2 | pending |
| O-138 | `ondra-organ-gate` | 〔研〕 | 工具 schema 门控 + 意图路由（确定性规则） | 实测 55,154→8,433 token（84.7%） | **P0** | pending |
| O-139 | `ondra-failure-attrib` | 〔研〕 | 八类失败归因 + 处方表 + 伤口闭合判定 | `arg_error` 永不自动重试；5 分钟未闭合标 chronic | P1 | pending |
| O-140 | `ondra-evidence-gate` | 〔研〕 | 记忆写入门控：四类引文、逐字校验、数字必须有 `[TOOL]` 来源 | 无 `[USER]` 引文的归功断言拒绝 | **P0** | pending |
| O-141 | `ondra-memory-recognition` | 〔研〕 | recognition 检索分支：全索引进 prompt + 小模型挑 slug + `[[links]]` 游走 | 500 条≈6k token，走 prefix cache；与向量并列，默认仍倒排 | P1 | pending |
| O-142 | `ondra-inject-dedupe` | 〔研〕 | 注入去重：首轮大块 + 已见 id 记账 + 压缩信号释放已见 + 只推增量 | 实测事故：每次唤醒重复注入，一次多背 13000+ 字 | P1 | pending |
| O-143 | `ondra-zero-residence` | 〔研〕 | 零常驻上下文：确定性指针替换常驻内容，被遮字节可从 session log 逐字恢复 | `zr_compact/recall/ledger/fast`；压缩前状态先写 SQLite | P1 | pending |
| O-144 | `ondra-reflex` | 〔研〕 | 反射弧自写 + 链路结晶，全部零模型调用 | 同工具×同因失败 3 次→`R-auto-<cause>-<tool>`；跨器官 ≥3 步成功链固化 skill | P1 | pending |

> **O-145 不建**：手册明写「生态盘点（一次性任务，不是插件）」。已从清单删除。

## 第 16 组 · 多方案分支（3 项）

| 编号 | 插件 | 档位 | 职责 | 默认分支 | 状态 |
|---|---|---|---|---|---|
| O-121 | `ondra-store-json` | 〔研〕 | JSONL 持久化后端（无 SQLite 或库损坏时兜底），原子写 | 否（SQLite 默认） | pending |
| O-122 | `ondra-memory-vector` | 〔研〕 | 向量检索分支 + 混合检索 | 否（倒排默认）；**何时建按裁决④**：<300 纯字面 / 300–1000 混合 / >1000 向量+ANN | pending |
| O-123 | `ondra-emotion-hormone` | 〔研〕 | 激素维度扩展，与核心三维并存只读叠加 | 否（关闭） | pending |

## 第 17 组 · L9 扩展池（24 项，B13 批次）

| 编号 | 插件 | 来源方案 | 状态 |
|---|---|---|---|
| O-097 | `ondra-grow` | 养成系统 | pending |
| O-098 | `ondra-persona-workshop` | 人格包工坊 | pending |
| O-099 | `ondra-memory-git` | 记忆 Git 化 | pending |
| O-100 | `ondra-memory-heal` | 记忆自愈 | pending |
| O-101 | `ondra-time-capsule` | 时间胶囊 | pending |
| O-102 | `ondra-trust-dashboard` | 信任仪表盘 | pending |
| O-103 | `ondra-forget-right` | 被遗忘权 | pending |
| O-104 | `ondra-redteam` | 红队评测 | pending |
| O-105 | `ondra-digital-health` | 数字健康护栏 | pending |
| O-106 | `ondra-crisis` | 危机干预分级 | pending |
| O-107 | `ondra-first-meet` | 初见剧本 | pending |
| O-108 | `ondra-absence` | 空窗期礼仪 | pending |
| O-109 | `ondra-screen-sense` | 屏幕感知 | pending |
| O-110 | `ondra-dev-companion` | 开发者陪伴 | pending |
| O-111 | `ondra-ambient` | 键鼠反应 | pending |
| O-112 | `ondra-theater` | 多角色剧场 | pending |
| O-113 | `ondra-weekly` | 周报 | pending |
| O-114 | `ondra-webhook-inbox` | 事件播报 | pending |
| O-115 | `ondra-ritual` | 节气仪式 | pending |
| O-116 | `ondra-study` | 学伴 | pending |
| O-117 | `ondra-cocreate` | 共创 | pending |
| O-118 | `ondra-consistency-bench` | 人格评测 | pending |
| O-119 | `ondra-sandbox` | 能力分级沙箱 | pending |
| O-120 | `ondra-daily-brief` | 晨间简报 | pending |

---

## 附录 A · 手册强制修订对照（逐条生效，不得遗漏）

| 手册条款 | 修订对象 | 修订内容 | 落在 |
|---|---|---|---|
| §1.7 | 命名 | 服务键/工具名/配置键匹配 `^[a-z][a-z0-9_-]{1,63}$` | 全仓 |
| §1.7 | 桌宠 | 保留为能力入口，复用 dsh-pet / agentpet（MIT） | O-074 |
| §1.7 | 检索接口 | 「索引 + 按需」，不是「检索 + 注入 topK」；增 recognition 第三分支 | O-014 / O-141 |
| §1.7 | O-019 dream | 增 `lightweight: true` 分支（2min 浅睡 / 5min 深睡、五类卡片、168h 半衰期） | O-019 |
| §1.7 | O-011 extract | 补来源类别 + 逐字引文校验 | O-011 / O-140 |
| §1.7 | O-013 decay | 增 SM-2 间隔复习 | O-013 |
| §1.7 | O-042 proactive | 照抄 dsh-proactive 全套 | O-042 |
| §1.7 | O-048 生活感 | 生活日志注入 + `life_react` 写回 | O-048 |
| §1.7 | O-036 注入 | 首轮一次大块 + 正文留盘按需展开 | O-036 |
| §1.7 | O-037 输出 | 事后评审回环（1–100 分，最多 2 轮） | O-037 |
| §1.7 | O-046 live | lunar-javascript / tyme4ts 双分支对拍 | O-046 |
| §1.7 | O-050 tts | GPT-SoVITS + Edge TTS 双通道 | O-050 |
| §1.7 | O-054 / O-074 | 不自研，复用 airi / dsh-whale-girl-live2d / dsh-pet / agentpet | O-054 / O-074 |
| §1.7 | O-055~067 | QQ 完全不自己写，只自研人格一致性与节制 | 通道组 |
| §1.7 | O-068 adb | scrcpy 能力更强 | O-068 |
| §1.7 | O-078 market | dsh-market 生态已有 | O-078 |
| §1.7 | O-087 icons | morphicons 直接 vendor | O-087 |
| §8.3 | 全部插件 | 必须 `cordis.patch.yml` + `dsh.bundle.patch` | 全仓 |
| §8.5 | O-033 dialogue | 会话内冻结前缀，禁止每轮重拼 | O-033 |
| §12.1 | 全仓 | 三件必做：寿命计算 / 召回不砍 / 禁报数 | O-010 / O-014 / O-032 |

## 附录 B · 删除与降级清单（"废弃的直接删掉"）

| 项 | 处理 | 理由 |
|---|---|---|
| O-145 `ondra-eco-audit` | **删除** | 手册明写「一次性任务，不是插件」 |
| 原 v1 附录 C「12 项待确认」 | **删除** | 已被手册 §12.3 裁决台账取代，按推荐值执行 |
| v1 的 27 个插件产物 | **已清空**（备份 + 废纸篓） | 服务键不合规、无 patch 文件、等于不会被加载 |
| 通道类 9 个 adapter 的"自研"定位 | **降级为复用** | §1.8：QQ 一路完全不自己写 |
| O-054 avatar / O-074 pet 的自研定位 | **降级为复用** | §1.7：生态已有成熟实现 |

## 附录 C · 手册裁决 14 条的默认执行值（未拍板前按此）

| # | 裁决点 | 默认执行 |
|---|---|---|
| ① | 人格漂移 | 允许，上限 +60% 封顶 |
| ② | 记忆写入边界 | **证据门控后全自动**（手册推荐默认） |
| ③ | 关系第三套 | 七阶底座 + 六段 0–1000 对外，第三套不进默认 UI |
| ④ | 向量用不用 | 按条数分级：<300 纯字面 / 300–1000 混合 / >1000 向量+ANN |
| ⑤ | 做梦性质 | **闸式为默认**，荒诞联想为独立分支（不可兼得） |
| ⑥ | 合并阈值 | 包含度 0.4（**不与其他口径互搬**） |
| ⑦ | 打分结构 | 五项加权和 `.18/.46/.11/.14/.11`（已落地，不混用） |
| ⑧ | 做梦时间 | 22:00（须 22:30 断网前完成） |
| ⑨ | 检索为空 | 不退回（省 token），但段标题必须写出"未命中" |
| ⑩ | 人设进 system | 可以进；**记忆库绝对不能进 system** |
| ⑪ | 衰减对象 | 衰减条目（O-013），图谱管边（O-015），两不混 |
| ⑫ | LoRA | 废弃，语感走「台词库检索 + 统计」 |
| ⑬ | 资产迁移 | 台词库 2615 条 / 九步过滤链 / 人格语料 / 88 项决策文档，按 B4 批次落 |
| ⑭ | AGPL 边界 | 读思路不复制代码；前代手册与 Coopanion 均 AGPL-3.0 |
