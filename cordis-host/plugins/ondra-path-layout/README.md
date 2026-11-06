# ondra-path-layout

> O-002 · L0 基座 · 〔研〕自研 · 服务键 **`ondra-path-layout`**（连字符）

空谷 Ondra 的**数据根与目录权限唯一入口**：数据根在哪儿、五个区域目录叫什么路径、
目录是不是 0700、私有文件是不是 0600——**只在这里回答一次**。

其他插件一律经 `ctx.get('ondra-path-layout')` 取路径，不得自己拼 `~/.ondra`，
也不得自己 `chmod`。

## 职责

- 解析数据根，优先级：**配置 `root` > 环境变量 `$ONDRA_HOME` > `~/.ondra`**（与上游
  `@ntars/ondra-home-paths` 的 `resolveOndraHome()` 口径一致）。
- 创建并收紧五个区域：`user` / `logs` / `cache` / `tmp` / `backups`，目录 0700。
- 提供 `resolve()` / `area()` / `fileIn()` 拼路径（不创建），`ensure()` 建子目录，
  `prepareFile()` 建 0600 私有文件，`exists()` / `isInside()` 做判断。
- `display` 只给用户可见写法：默认根显示 `~/.ondra`，被环境变量改写显示 `$ONDRA_HOME`，
  **绝不把机器绝对路径塞进界面**（沿用上游 `ondraHomeDisplay()` 的隐私口径）。

## 明确不负责

- **不决定目录叫什么名字**：五个区域名归 O-001 `ondra-identity` 的 `dirs` 表，本插件只读取。
- **不管 pid 文件内容**：只提供 `prepareFile()` 建出一个 0600 空文件，写 pid 归 O-080 `ondra-process-host`。
- **不做数据库初始化**：建目录可以，建表归 O-006 / O-008。
- **不做日志轮转**：`logs/` 目录交给 O-004 `ondra-log-zh`。
- **不改任何既有目录的祖先权限**（见下方「关键取舍」第 2 条）。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-path-layout` | 唯一归属 |
| 消费 | `ondra-identity` | **软依赖**（`ctx.get` 判空，不走 `inject`） |

契约定义在 `src/types.ts`：`PathLayoutService` / `PathAreas` / `IdentityLike`。

## 配置（全部有默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| `root` | `''`（自动解析） | 数据根；支持 `~` 前缀；留空则走 `$ONDRA_HOME` → `~/.ondra` |
| `tightenPermissions` | `true` | 是否收紧到 0700 / 0600（仅调试时关） |
| `createRoot` | `true` | 启动时是否创建数据根与五个区域（`false` 只解析，用于只读体检） |

## 关键取舍（每条都有代价，写在这里防后人踩回去）

1. **不用 Cordis `inject`，改运行时 `ctx.get` 判空。**
   `inject` 是硬依赖：O-001 缺席时本插件保持 PENDING，**静默不加载**。而路径是 L0 命脉，
   一旦 PENDING，下游全部拿到 `undefined`，现象是「什么都没写出来，也没报错」。
   代价是失去加载顺序保证——用一条中文 warn 换可观测性，值得。

2. **chmod 只对自己创建的目录生效，绝不动祖先。**
   对已有目录无条件 `chmod 0700` 会把 `~` 改成 0700（连带 ssh、钥匙串、浏览器 profile 一起锁死），
   把文件系统根改成 0700，最坏情况把 `/Library` 动手。所以：
   - `mkdirSync(recursive)` 建中间目录时**不设 mode**（父目录继承默认权限）；
   - 只对数据根、五个区域、以及 `ensure()` / `prepareFile()` 的**目标**执行 chmod；
   - 越界路径直接抛 `PathEscapeError`，不静默跳过。

3. **`isInside()` 用「补分隔符再前缀比较」**，不用朴素 `startsWith`。
   否则 `/data/ondra-evil` 会被误判成在 `/data/ondra` 内部——这是一个真实的权限提权面。

4. **Windows 跳过权限收紧**。`chmod` 在 NTFS 上只改只读位，硬设 0700 可能把目录变只读。
   `process.platform === 'win32'` 时 `tighten()` 直接返回，不假装成功。

5. **建目录失败就整插件不注册服务**，不提供半残服务。
   路径是 L0 命脉，宁可让下游明确拿到 `undefined`（配一条 error 日志），
   也不要给一个「部分区域存在」的假服务——那会让存储层把库建在奇怪的地方。

## 边界

- 属于 L0，崩溃后果是「谁也不知道出了什么问题」，因此**不引入任何运行时依赖**，
  只用 `node:fs` / `node:os` / `node:path`。
- 与 O-001 的依赖方向单一：本插件读 O-001 的 `dirs` / `env` / `loggerName`，反向禁止。
- 数据根只有一个：不做「多根并存」，需要迁移用 `root` 配置切换，不做双写。

## 已知限制

1. **`prepareFile()` 不做原子替换**。它只保证「文件存在 + 0600」，不含临时文件 + rename
   的原子写；需要原子写的插件（如 O-042 主动状态、O-088 api-token）应在自己内部完成
   `write tmp → fsync → rename`，本插件只负责目录与权限。
2. **不处理符号链接逃逸**。`isInside()` 做的是字符串层面的路径判断；如果数据根内部有指向
   外部的软链，写入会穿透到目标。本轮不引入 `realpathSync`——它要求路径已存在，
   与「先拼路径后创建」的用法冲突，且会在挂载点抖动时抛错。**风险已登记**：
   若将来数据根由用户可写的外部目录提供，应由 O-076 `ondra-privacy` 补一道 `realpath` 校验。
3. **`env` 覆盖只认 `$ONDRA_HOME`**。上游另有 `$ONDRA_AGENTS_HOME`（agents 配置根），
   那是 agent 指令树、不属本插件的五个区域，故本插件不解析它；需要时由 O-001 补字段后另行接入。
4. **`root` 配置不做存在性预检**。指定的根不可写时，错误在建目录那一刻抛出并记 error 日志，
   而不是在配置校验阶段。理由：配置校验发生在宿主侧、拿不到稳定的文件系统上下文。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 数据根解析口径 | `@ntars/ondra-home-paths`（本仓 `desktop/packages/util/home-paths`） | github.com/ntars/Ondra | MIT | `ONDRA_HOME_DIR_NAME='.ondra'`、`ONDRA_HOME_ENV='ONDRA_HOME'`、优先级「显式 > $ONDRA_HOME > 默认」、空白值视为未设、`~` 展开、`ondraHomeDisplay()` 的符号化显示 | 自研 `resolveRoot()` / `displayOf()`，只对齐口径不复制源码；不依赖该包（它不建目录、不管权限、不读 O-001 目录名） | 否 |
| 可逆服务注册 | `@ntars/cordis` | 同上 | MIT | `ctx.provide()` + `ctx.effect()` 的 effect 生命周期 | 同左 | 否 |
| 目录权限收紧 | POSIX 惯例 + Node 文档 | — | — | `0700` 目录 / `0600` 私有文件；`mkdirSync` 的 mode 只作用于新建的最末一级 | 自研 `ensureDir()` / `tighten()`，含「不动祖先」防护 | 否 |

**档位判定（§1.8）**：〔研〕自研。上游 `home-paths` 只算路径，**建目录与权限收紧没有可用实现**；
本插件的核心价值恰恰在那两个缺失部分，因此不构成「能复用却自研」。

## 多方案分支说明（§12）

不涉及多方案。数据根是**单值事实**，多根并存会让「库在 A、日志在 B、备份在 C」成为常态，
比任何便利都危险。若将来需要「便携模式」，正确做法是把 `root` 指向 U 盘路径，
**不得**新增第二个路径服务键（违反 §15.4）。

## 隔离五问（§16.4）

1. **关掉我，谁受影响？** 所有依赖路径的插件（O-004 日志、O-006 存储、O-009 快照、
   O-020 人设读取…）全部 `ctx.get` 取到 `undefined`，按各自契约降级或跳过；主对话不受影响。
2. **我的状态存在哪？** 磁盘上只有**目录本身**与权限位，没有状态文件；进程内是
   `Object.freeze` 的只读服务对象。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.path-layout`；
   初始化失败会打一条 `error`（含具体路径与原因），并由 O-077 `ondra-startup-check` 汇总。
4. **我依赖谁？缺席时怎么降级？** 依赖 `ondra-identity`（软）。缺席时降级到内置目录名
   `user/logs/cache/tmp/backups` + 读 `process.env.ONDRA_HOME`，并打一条 warn 说明降级。
5. **我和同域的谁共享可变状态？** 没有。与 O-001 只共享只读名字表，方向单一（我读它）。

## 自检（master-plan §16.1 九项 + §16.2 语言五项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（6 必需 + icon） | 过（8 文件齐） |
| 2 | 清单合法 | 过（JSON 可解析、`ondra-*`、`type: module`、四字段齐、cordis 双声明、`ondra.bundle.patch` 在） |
| 3 | 编译配置 | 过（NodeNext ×2 / strict / rootDir src / outDir lib / declaration） |
| 4 | 入口契约 | 过（`name` + `apply` + `Config` 三字段全有默认值） |
| 5 | 服务键唯一 | 过（`ondra-path-layout` 全仓仅本插件 provide） |
| 6 | 依赖可解析 | 过（唯一 `ctx.get('ondra-identity')`，O-001 已 done） |
| 7 | 无越界 import | 过（无 `from 'ondra-`） |
| 8 | 降级到位 | 过（`identity` 判空后走兜底分支，未直接调用） |
| 9 | 交付物齐全 | 过（技术来源表 / 多方案说明 / 隔离五问齐） |
| 语言 1–5 | 括号配平 / 无残留半句 / `import type` 正确 / 无 TODO / UTF-8 无 BOM | 过 |
