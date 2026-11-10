# ondra-identity

> O-001 · L0 基座 · 〔研〕自研 · 服务键 **`ondra-identity`**（连字符，非 `ondra:identity`）

空谷 Ondra 的**身份真源**：产品叫什么、进程叫什么、pidfile 叫什么、环境变量前缀是什么、
数据根下五个一级目录叫什么、日志命名空间的根是什么——**只在这里回答一次**。

其他插件一律经 `ctx.get('ondra-identity')` 读取，不得各自写死；一旦需要改名，
改这一处即可，不必全仓搜字符串。

## 职责

- 提供 `ondra-identity` 服务，暴露五组只读事实：`product`（品牌与法务）、`env`（环境变量名）、
  `dirs`（一级目录名）、`files`（具名文件名）、`processName` / `logNamespace`。
- 提供四个纯函数：`envKey()` 拼变量名、`isValidKey()` / `assertKey()` 校验命名硬约束、
  `loggerName()` 拼日志命名空间、`pidFileIn()` / `lockFileIn()` 拼文件名完整路径（路径由调用方给定）。
- 加载即就绪：零依赖、零 IO、零定时器，注册本身走 `ctx.effect()`，卸载即撤下服务。

## 明确不负责

- **不解析数据根、不创建目录、不做 `0700` / `0600`**——那是 O-002 `ondra-path-layout`。
- **不读写任何文件**，包括 pidfile 本身：本插件只给「文件名」，落盘归 `ondra-process-host`。
- **不判断用户是谁、不碰记忆与情绪**：L0 基座不认识任何上层业务。
- 不反向依赖任何人：本插件 `inject` 为空。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-identity` | 唯一归属（台账「提供服务键」列即登记表） |
| 消费 | 无 | 无 `ctx.get`，故无降级分支 |

契约定义在 `src/types.ts`（`IdentityService`），消费方按结构对位读取，**不 import 本包源码**。

## 配置（全部有默认值，不配置即可用）

| 字段 | 默认 | 说明 |
|---|---|---|
| `productName` | `Ondra` | 英文名 |
| `productNameZh` | `空谷` | 中文名（`fullName` 由两者拼成「空谷 Ondra」） |
| `slogan` | `于无声处，听见共鸣` | 标语 |
| `homepage` | `ai.ntars.cn` | 官网域名 |
| `version` | `1.0` | 版本号 |
| `license` | `AGPL-3.0` | 许可证标识（与仓库 LICENSE 一致） |
| `appId` | `ondra` | 应用标识：数据目录名与包名前缀共用 |
| `processName` | `ondra` | 进程名 |
| `pidFileName` | `ondra.pid` | pid 文件名 |
| `lockFileName` | `ondra.lock` | 互斥锁文件名 |
| `apiTokenFileName` | `api-token` | 界面令牌文件名（相对 `user/`） |
| `envPrefix` | `ONDRA_` | 环境变量前缀，须大写并以 `_` 结尾 |
| `logNamespace` | `ondra` | 日志命名空间根 |
| `userDirName` | `user` | 用户数据目录名 |
| `logsDirName` | `logs` | 日志目录名 |
| `cacheDirName` | `cache` | 缓存目录名 |
| `tmpDirName` | `tmp` | 临时目录名 |
| `backupDirName` | `backups` | 备份目录名 |
| `strictKeys` | `true` | 键名不合规时是否抛错（正式版必须 true） |

配置校验器以**标准 schema 形状**（`~standard`）导出，宿主在启动前调用；缺项补默认，
类型不符或语义不符直接报一条中文问题，插件不启动——**不带错配置跑**。

## 边界

- 本插件属于 L0，崩溃后果是「谁也不知道出了什么问题」，因此保持极简：无 IO、无网络、无状态演进。
- 命名硬约束（手册 §8.4）：`^[a-z][a-z0-9_-]{1,63}$`。`appId` / `processName` / `logNamespace`
  与本服务键自身都受此约束；`assertKey()` 用于**在本地先拦**，绝不把不合规的键传给模型侧。
- 品牌值有改动时，改本插件 `Config` 默认值并同步手册 §1.1，不在下游插件打补丁。

## 已知限制

1. **`Config` 是手写的标准 schema，不是 `@ntars/schemastery`**。本轮交付禁止 `pnpm install`，
   引入一个无法核实版本的依赖比手写 60 行校验更危险；等到全仓依赖清单（手册 §6.7）落定后，
   可无痛替换为 schemastery，服务契约不变。
2. **`env.profile` / `env.profileDir` 只是变量名**。宿主确实会注入 `ONDRA_PROFILE` 与
   `ONDRA_PROFILE_DIR`（见 `desktop/packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md`），
   但手册正文没有写它们的行为语义，本插件只登记名字，不解释取值。
3. **不校验「产品名是否与安装包名一致」**：安装包名归 `package.json`，两者一致性由
   O-133 `ondra-install-doctor` 在安装自检里核，本插件不做跨文件断言。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 服务注册与生命周期 | Ondra（`@ntars/cordis`） | github.com/ntars/Ondra | MIT | `ctx.provide(key, value)` + `ctx.effect()` 的可逆注册模式（`desktop/docs/cordis-api/*.zh.md`） | 自研常量服务，零依赖 | 否 |
| 命名硬约束校验 | 本仓手册 §8.4 | 同仓 `Ondra-dev-handbook.md` | AGPL-3.0 | 正则 `^[a-z][a-z0-9_-]{1,63}$` 与「本地先拦」三层修复思路 | 自研 `assertKey()`，用 `RegExp(字符串源)` 构造 | 否 |
| 标准 schema 形状 | standard-schema 规范 | github.com/standard-schema/standard-schema | MIT | `~standard.validate()` 的返回形状（`{value}` / `{issues}`） | 手写实现，未引入包 | 否 |

**档位判定（手册 §1.8）**：〔研〕自研。生态里没有「身份常量真源」这种插件——
它是本项目命名纪律的载体，不是可复用能力，也没有可包裹的上游实现。

## 多方案分支说明（§12）

本插件不涉及多方案：身份常量是**单值事实**，不存在两种口径并存的合法场景。
若将来出现「多品牌皮肤」，正确做法是新增 `brand` 配置段并以参数化方式统合，
**不得**新增第二个身份服务键（违反 §15.4 服务键单一归属）。

## 隔离五问（§16.4）

1. **关掉我，谁受影响？** 只有我自己。所有消费方都写成 `const id = ctx.get('ondra-identity'); if (!id) return`，
   取不到即安静退化到各自的内置默认值（`ondra-path-layout` 会额外打一条「降级」中文日志）。
2. **我的状态存在哪？** 仅在内存，且是 `Object.freeze` 后的只读快照；无文件、无数据库、无全局变量。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.identity`（`ondra.<feature>` 规则），
   崩溃表现为服务缺失 + 该命名空间下的错误行；界面侧由 O-077 `ondra-startup-check` 汇总呈现。
4. **我依赖谁？缺席时怎么降级？** 不依赖任何人，因此无降级分支；反过来说，我缺席时下游必须有降级（见第 1 问）。
5. **我和同域的谁共享可变状态？** 没有。与 O-002 只共享「只读名字表」，且方向单一（O-002 读我）。

## 自检（master-plan §16.1 九项 + §16.2 语言五项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（6 必需 + icon） | 过（8 文件齐） |
| 2 | 清单合法（可解析 / `ondra-*` / `type: module` / `main`+`types`+`exports`+`files` / cordis 双声明） | 过 |
| 3 | 编译配置（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） | 过 |
| 4 | 入口契约（`name` 字符串 + `apply` 函数 + `Config` 全字段有默认值） | 过 |
| 5 | 服务键唯一 | 过（`ondra-identity` 全仓仅本插件 provide） |
| 6 | 依赖可解析 | 过（无 `ctx.get`，判为不适用） |
| 7 | 无越界 import | 过（无 `from 'ondra-`） |
| 8 | 降级到位 | 过（无外部服务可判空；服务注册走 `ctx.effect` 可撤销） |
| 9 | 交付物齐全（技术来源表 / 多方案说明 / 隔离五问） | 过 |
| 语言 1–5 | 括号配平 / 无残留半句 / `import type` 正确 / 无 TODO / UTF-8 无 BOM | 过 |
