# 插件布局（定稿）

## 一、四个分类目录（`lib/plugins/` 根下）

| 目录 | 加载 | 可关闭 | 装什么 |
|---|---|---|---|
| `ondra-core/` | 随包默认 | **否** | 空谷核心插件（UI 全在这里） |
| `ondra-extensions/` | 随包默认 | 是 | 随包附带、可开关的插件 |
| `dsh-base/` | 随包默认 | **否** | dsh 内核（官方名，原样引入） |
| `ondra-custom/` | 运行时按需 | 是 | 用户自装插件（如 `dsh-xxx`），与框架 `cordis/` 无关 |

框架本体 `cordis/` 保留在 `lib/plugins/cordis/`，不属于上面四类中的任何一类（它是宿主）。

## 二、文件树

```
lib/plugins/
├─ cordis/                              框架本体（官方名，原样引入）
├─ ondra-core/                          随包默认、不可关闭
│  ├─ ondra-ui/                         UI 总层（注册表 / 壳状态 / 三栏外壳）
│  │  ├─ ui/                            chassis · side_rail · boot_screen
│  │  │                                 module · registry · shell_state
│  │  ├─ ondra-status/                  状态面板
│  │  ├─ ondra-memory/                  记忆星图
│  │  ├─ ondra-history/                 历史对话
│  │  ├─ ondra-backup/                  备份还原
│  │  ├─ ondra-transfer/                导入导出（数据 / 人设 / 配置，不含插件）
│  │  ├─ ondra-guide/                   使用教程
│  │  ├─ ondra-plugins/                 插件管理：导入 / 安装 / 卸载 / 导出
│  │  ├─ ondra-chat/                    右栏整块（直连 dsh 内核）
│  │  ├─ ondra-beichen-api/             合作 API：预设目录，整包可替换
│  │  ├─ ondra-llama/                   本地模型：GGUF 下载 + llama-server 生命周期
│  │  ├─ ondra-browser/                 网页浏览：白名单 + WKWebView（被动出现，无导航项）
│  │  ├─ ondra-model/                   模型网关（运行时侧：解析 / 校验 / 默认模型）
│  │  ├─ ondra-store/                   存储：原子写 / 快照 / 迁移
│  │  ├─ ondra-runtime/                 运行时守护：启动 / 健康 / 退避重启
│  │  ├─ ondra-channel/                 通道接口：QQ / 飞书 / 邮件适配 + 投递策略
│  │  ├─ ondra-voice/                   语音：朗读计划 / 音色 / 识别
│  │  ├─ ondra-emotion/                 情绪：状态 / 表现 / 在场 / 呼吸
│  │  ├─ ondra-relationship/            关系与主动：阶段 / 信任 / 主动额度
│  │  ├─ ondra-onboarding/              初始引导（OnboardingGate，首次启动一屏说明）
│  │  ├─ ondra-font/                    字体声明（实现在 design/font_face.dart）
│  │  ├─ ondra-locale/                  语言声明（实现在 app/i18n.dart + assets/locales）
│  │  ├─ ondra-logs/                    日志容器（共用骨架）
│  │  │  ├─ ondra-log-dialog/           对话日志
│  │  │  ├─ ondra-log-plugin/           插件日志
│  │  │  └─ ondra-log-system/           系统日志
│  │  └─ ondra-settings/                设置容器（5 类，一条清单不分段）
│  │     ├─ ondra-general/              1 通用设置
│  │     ├─ ondra-models/               2 模型基座（六类来源 + 预设 + 检测）
│  │     ├─ ondra-channels/             3 通道接口（QQ 机器人等）
│  │     ├─ ondra-persona/              4 人设设定（含对话 / 记忆 / 语音）
│  │     └─ ondra-about/                5 关于空谷（含隐私 / 反馈）
└─（ondra-flutter / ondra-knowledge 已删除：无实现的目录不留在树里）
├─ ondra-extensions/                    随包默认、可关闭（当前为空）
├─ dsh-base/                            dsh 内核（真身在随包运行时里，见 README 7.4）
└─ ondra-custom/                        用户自装插件（当前为空）

## 五、两套侧的对应关系（易混淆）

`lib/plugins/*/src/` 是 **TS 实现**（运行在内核里），`*/ui/` 是 **Flutter 投影**。
channel / emotion / model / relationship / runtime / store / voice 七个目录
只有 src 没有 ui——它们在内核里干活，界面上没有自己的页面，**不是占位**。
内核侧实际运行的是 `plugin-profile/`（77 个 @ondra 包的快照），见 `README 7.4`。
```

## 二·五、已写好的插件（11 个 TS 实现 + 15 条清单）

| 插件 | 位置 | 一句话 |
|---|---|---|
| ondra-memory | `ondra-ui/ondra-memory` | 去重 / 关联 / 衰减 / 淘汰，一份记忆点 |
| ondra-emotion | `ondra-ui/ondra-emotion` | 情绪 / 表现 / 在场，一份状态 |
| ondra-persona | `ondra-ui/ondra-settings/ondra-persona` | 切包即换提示词段 |
| ondra-relationship | `ondra-ui/ondra-relationship` | 信任曲线 + 主动三道闸 |
| ondra-channel | `ondra-ui/ondra-channel` | 适配器 + 一条投递队列 |
| ondra-voice | `ondra-ui/ondra-voice` | 朗读计划（只念前两段） |
| ondra-beichen-api | `ondra-ui/ondra-beichen-api` | 合作 API 预设（地址 / 密钥变量名 / 模型目录），整包可换 |
| ondra-llama | `ondra-ui/ondra-llama` | 本地部署：找 llama-server、下 GGUF、起停进程、读 `/v1/models` |
| ondra-browser | `ondra-ui/ondra-browser` | 白名单 + 内嵌 WKWebView；**被动出现**，不占左栏 |
| ondra-model | `ondra-ui/ondra-model` | provider / model 解析与校验 |
| ondra-store | `ondra-ui/ondra-store` | 原子写 / 坏文件回落 / 快照 |
| ondra-runtime | `ondra-ui/ondra-runtime` | 状态机 + 指数退避 |
| ondra-plugins | `ondra-ui/ondra-plugins` | 导入 / 安装 / 卸载 / 导出 |
| ondra-chat | `ondra-ui/ondra-chat` | 右栏整块：会话流 + 内核接线 |

界面侧的 15 条清单在 `assets/plugins/manifest.json`（插件扩展页的数据源）。

## 三、单个插件内部结构

```
ondra-xxx/
├─ plugin.json      id / name / layer / closable / owner / provides / depends
├─ README.md        职责 / 对外契约 / 依赖谁
├─ src/             Cordis 插件（TS）：数据与服务
└─ ui/              Flutter：只读投影 + 页面
```

## 四、规矩

1. 依赖单向：`ui/` → 投影 → 插件服务；插件之间不 import 彼此的 `ui/`。
2. `ondra-ui` 不认识任何具体页面，只认注册表条目。
3. 共享代码只有 `lib/design/` 与 `lib/data/`（纯数据）。
4. 设置面板 5 类，全部在 `ondra-settings` 下，**不分段、无分割线**：
   通用 / 模型基座 / 通道 / 人设设定 / 关于空谷。对话偏好、记忆与数据、语音并入人设；
   隐私与安全、问题反馈并入关于。「插件设置」类已删除（插件管理在 `ondra-plugins`）。
5. `ondra-transfer` 只管数据 / 人设 / 配置，插件的导入导出归 `ondra-plugins`。

## 合并原则（旧 78 个包 → 新的一批）

旧版把一件事拆成十几个包（记忆 15 个、情绪 9 个），新版**按「是否共用一份状态」合并**：
共享同一份数据的，必须在一个插件里，否则「谁最后写」只能靠猜。

| 新插件 | 合并自（旧包） | 为什么能合 |
|---|---|---|
| `ondra-memory` | memory-{core,extract,dedupe,decay,graph,dream,heal,intake,pool,recall,recognition,vector,audit,humanlike,multimodal} | 全都是同一份记忆点的增删改查 |
| `ondra-emotion` | emotion-{core,diffuse,express,project,stage}, breath, absence, crisis | 情绪、表情、在场共用一份状态 |
| `ondra-persona` | persona-{core,loader,vars,assemble,evolve} | 人设的读写与拼装是同一个对象 |
| `ondra-relationship` | first-meet, identity, worldbook, proactive-{gate,quota,reason}, rhythm, rhythm-typing | 都是「关系与主动性」的判定 |
| `ondra-channel` | dsh-client, desktop-bridge, 未来的 QQ / 飞书 | 一条通道一种适配，共用投递 |
| `ondra-voice` | asr, tts, tts-gate, oral | 听到说是一条链路 |
| `ondra-model` | llm-gateway, 模型选择 | 出口只有一个 |
| `ondra-store` | store-{json,sqlite}, snapshot, data-migrate, path-layout | 一份状态只能有一个写入者 |
| `ondra-runtime` | process-host, sandbox, port-picker, startup-check, install-doctor, installer | 都是「把进程拉起来并看着它」 |
| `ondra-plugins` | installer, install-doctor 的安装部分 | 导入 / 安装 / 卸载 / 导出 |
| `ondra-settings` | config-schema, store-json 的配置部分 | 10 个设置分类的容器与取值 |

图标：所有插件统一用 `icon.svg`（取自 `ondra-breath`），dsh 侧插件沿用官方图标。
