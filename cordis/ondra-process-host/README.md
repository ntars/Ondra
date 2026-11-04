# ondra-process-host

> O-080 · L7 系统与交付 · 档位〔复〕 · 服务键 `ondra-process-host` · 状态 **done（静态自检通过，未实装运行）**

子进程托管：**接上游的托管进程范围（组杀）+ 一次重启 + 状态文件**。一行进程控制代码都不写。

---

## 一、职责

1. **托管启动**（`host.ts` 的 `#spawn`）：把 `argv / cwd / stdio / graceMs` **显式**交给上游 `ctx.subprocess.spawn()`。上游 seam 的契约是「applies no defaults」，所以本包不给默认值留空档——`stdio` 三个流全部写明，漏一个就会变成子进程继承父 fd，输出混进宿主日志、排查时找不到源头。
2. **一次重启**（`decideRestart`）：崩了重放原请求，`maxRestarts` 默认 **1**（台账值），用完即 `crash-limit`，界面能看见，人再决定。
3. **组杀**（`stop()`）：`handle.terminate()` + `waitForExit(signal)`，**并且把「发出了组杀」与「确认静默」分开报**（`confirmed`）。
4. **状态文件**（`state.ts`）：`user/process-host/<name>.json`，0600，同目录临时文件 + `rename` 原子写。重启预算靠它跨进程存活。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 挑端口 | O-083 `ondra-port-picker`（本包只接管 `argv`，不猜端口） |
| 装运行时组件 | O-079 `ondra-installer`（本包不复制、不校验哈希） |
| 装/卸插件包 | O-078 `ondra-market` + 宿主 `pluginManager` |
| 首启引导 | O-082 `ondra-onboarding` |
| 常驻守护（launchd / systemd / 开机自启） | **谁都不做**。master-plan §12.4 禁止常驻后台服务 |
| 收集输出的解析 | 本包只让上游收集（有上限），**不读、不转日志** |
| 判断「这个进程该不该活」 | 调用方。本包只执行与如实报状态 |

### 四条刻意的「不做」

1. **不自己 `kill`。** 上游 `terminate()` 作用于 provider 托管的整个范围（POSIX scope / win32 job object）。自研要处理进程组是否存在、Windows 没有进程组、孙进程、TERM→KILL 分级——这是「杀不干净就留一堆孙进程」的那一层。
2. **不做「父死子活」。** 见「六」第 1 条。
3. **不写假 pid。** 上游句柄不暴露 pid，拿不到就不建文件（`pidfile-skipped`）。
4. **不在退出回调里重启已经换代的东西。** 见「五」第 2 条（世代号）。

## 三、服务键与方法

```
ondra-process-host        ← 连字符，不是带冒号的写法
```

| 方法 | 语义 | 会不会抛 |
|---|---|---|
| `start(request)` | 启动并托管；同名在跑 → `duplicate` 拒绝 | 否 |
| `stop(name, opts?)` | 组杀并等静默；`confirmed: false` = 静默未确认 | 否 |
| `restart(name)` | 停再起（原样重放原请求，不重新解析入参） | 否 |
| `get(name)` / `list()` | 只读快照 | 否 |
| `stateFileOf(name)` | 状态文件路径；只在内存时为空串 | 否 |
| `stats()` | `starts / restarts / exits / terminations / refusals` | 否 |
| `dispose()` | 逐个组杀后清空 | 否 |

### 原因码

| 码 | 含义 | 谁的问题 |
|---|---|---|
| `disabled` | `enable=false` | 配置 |
| `no-subprocess` | 宿主没有 `subprocess` 服务 | 环境（装 .ondra.subprocess`） |
| `duplicate` | 同名已在跑 | 调用方 |
| `bad-name` | 名字不合 `^[a-z][a-z0-9_-]{1,63}$` | 调用方 |
| `no-argv` | `argv` 为空 | 调用方 |
| `spawn-failed` | 起不来（路径/权限/参数） | 调用方或环境 |
| `crash-limit` | 重启次数用完 | 被托管程序 |
| `timeout` | 组杀已发，静默未确认 | 被托管程序或 provider |
| `not-found` | 没这个托管项 | 调用方 |
| `disposed` | 插件已卸载 | 生命周期 |

## 四、配置

| 字段 | 默认 | 理由 |
|---|---|---|
| `enable` | `true` | 关掉后 `start()` 拒绝，`stop()` 仍能收尾 |
| `maxRestarts` | **`1`** | 台账值。第二次重试的价值接近 0，代价是无限重启烧 CPU |
| `restartDelayMs` | `1500` | 给端口与文件锁留释放时间 |
| `minUptimeMs` | `5000` | 只影响话术（「只活了 300 毫秒」），**不放宽预算** |
| `graceMs` | `3000` | 交给上游 provider 的终止程序 |
| `stopTimeoutMs` | `8000` | 等静默上限；超时如实报 `confirmed: false` |
| `stateDir` | `''` | 空 = `user/process-host`（走 O-002，0600） |
| `cwd` | `''` | 空 = 宿主工作目录。**不猜项目路径** |
| `writePidFile` | `true` | 拿得到才写；拿不到就不建文件 |
| `collectBytes` | `65536` | 每流收集上限，只留诊断尾巴 |
| `verbose` | `false` | 每次状态变化一行日志 |

## 五、边界与实现要点

1. **组杀只有一个入口**（`terminate()`）。全包 `grep -c 'kill('` 为 0，所以「会不会杀错进程」这个问题有确定答案。
2. **世代号防迟到回调**。重启是异步的：旧句柄的 `done` 可能在新进程起来之后才 settle（收集器要抽干管道）。若回调只看名字，就会把「新进程在跑」改成「已崩溃」，然后无限重启。每次 `spawn` 递增 `generation`，回调先比世代号。
3. **`done` 的 reject 也走收尾**。上游说 `done` 在 spawn / provider 失败时会 reject；不处理就会让托管项永远停在 `running`。
4. **`stop()` 先立旗再杀**。`stopping = true` 必须在 `terminate()` 之前，否则退出回调会先跑、判定成「崩溃」、安排一次重启——用户按了停止，进程又起来了。
5. **状态文件原子写**。非原子写留下的半个 JSON，会让「上次崩了」变成「没有记录」，重启预算被清零——崩溃循环就此绕过限制。
6. **pid 只读一次，且不参与控制流**。`probePid()` 读不到就是 `null`；即使读到的值是错的，也不会拿去 `kill`。
7. **定时器全部 `unref()`**（用 `typeof unref === 'function'` 探测，浏览器/Worker 返回数字会抛）。否则一个待重启的 1.5 秒定时器会拖住宿主退出。
8. **不进提示词、不碰会话、不写 `app_session_log`**（master-plan §6 禁令 5）。

## 六、已知限制

1. **「父进程退出后子进程继续活」没有实现，而且刻意不做。** master-plan §12.4 明令成品只能是插件包、禁止常驻后台服务；一个脱离父生命周期的子进程，在插件卸载 / 宿主重启之后**没有任何人负责收尸**：端口被占、pid 文件过期、下次启动 `EADDRINUSE`，而日志里全是「启动成功」。上游 disposal 的语义（「terminates all still-running managed processes and awaits their exit」）反而更安全，本包顺着它做，与手册 §3.3-4「可逆注册」一致。
2. **pidfile 可能永远不写。** 上游 `SubprocessHandle` 只有 `stdin/stdout/stderr/control/collected/done/terminate/waitForExit`，`subprocess-local` 里也搜不到 `pid`。所以本包用防御式探测：实现挂了 `pid` 就写，没挂就 `pidfile-skipped`。**这是待裁决项**：要真 pid 需要上游补一个 `SubprocessHandle.pid`（或在 spec 里给 `detached`），本包不硬做。
3. **「detached」只实现了可观测的那一半。** 台账四个词里，`detached` 的可观测语义是「不占父终端、输出不混进父 stdout」——这一半由 `stdio` 全显式声明 + 收集器满足；「脱离父生命周期」那一半见第 1 条。
4. **不读子进程输出。** 上游收集器有上限、有 spill，但本包**刻意不转进日志**：一个会喷日志的子进程能把 4MB×3 的日志轮转在几秒内刷完（手册 §4.5 日志限额）。要看输出请由调用方自己 `readFrom`。
5. **不判「进程健康」。** 本包只认退出事件，不做心跳、不探端口。一个僵而不死的进程在本包里一直是 `running`——这是调用方要自己判的事。
6. **状态文件读不懂时按「没有记录」处理。** 代价是重启预算可能被重置一次。选择「读不懂就当没有」而不是「拒绝启动」，是因为前者最坏是多重启一次，后者最坏是应用起不来。
7. **`crash-limit` 之后不会自己恢复。** 要恢复得显式 `start()` 或 `restart()`。刻意不做「冷却后自动重试」——那就是把无限重启包一层。
8. **未实装运行**：本轮禁 `pnpm install` / `build` / `tsc` / 启动 app。全部结论来自静态检查与纯逻辑对拍。

## 七、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 托管进程范围与组杀 | 上游 `@ntars/ondra-subprocess`（`desktop/packages/subprocess/subprocess`） | github.com/ntars/Ondra | MIT | `SubprocessHandle.terminate()` 作用于整个托管范围、`waitForExit()` 观察同一范围、「provider 文档化其信号与可观测上限」 | `host.ts` 只调这两个方法 | 否（只经 `ctx.subprocess`） |
| 显式 stdio / 无默认值 | 同上（`SubprocessSpawnSpec` 的注释：`This seam applies no defaults`） | 同上 | MIT | 「每个流、每个上限、每个目录都显式」 | `SpawnSpecLike` + `#spawn` 里三流全写 | 否 |
| 重启预算与熔断 | 手册 §8.2「防爆仓：三次跳闸」 | — | — | 「写坏一次是手滑，写坏三次是死循环烧钱——必须有失败计数与熔断」 | `decideRestart()`：预算用完即 `crash-limit`，不冷却重试 | 否 |
| 原子写（临时文件 + rename） | 本项目 O-076 / O-078 / O-079 的同类做法 | 自有 | 自有 | 同目录临时文件 + rename | `state.ts#write` / `writePid` | 是（自有资产） |
| 两阶段记账 / 状态机 | 本项目 O-079 的 `pending → installed` | 自有 | 自有 | 「先记中间态再记终态」 | `HostPhase` 的 `restarting` 中间态 | 是（自有资产） |
| 四值式如实报「判不了」 | 本项目 O-075 / O-077 / O-079 | 自有 | 自有 | 判不了就说判不了 | `pid: null` / `confirmed: false` / `pidfile-skipped` | 是（自有资产） |

**档位〔复〕的依据**：台账原标〔研〕。按手册 §1.8「能复用却自研 = 违规」，本包先去查上游——`ctx.subprocess` 已经提供**托管进程范围 + 组杀 + 有界输出收集 + disposal 收尾**，正是台账四个词里最难的那一个。所以本包只做接线 + 一层护栏（重启预算、世代号、状态文件），**一行进程控制代码都不写**。档位差异已在台账备注登记，代码无需改动。

## 八、多方案分支说明

master-plan §14.3 的已知多方案项**无对应项**。本包内两处真分支：

| 能力 | 方案 A（默认） | 方案 B | 处理 |
|---|---|---|---|
| 终止 | 上游 `terminate()`（provider 托管范围） | 自己 `kill(-pid)` | **只做 A**。B 需要 pid，而上游不暴露；且作业对象那一层自研等于重写。B 不做，不是「以后再说」 |
| 状态存放 | 本地文件（`FileStateStore`） | 纯内存（缺 O-002 且未配 `stateDir`） | **同一接口、各一个实现**；内存版让「重启预算不跨进程」成为可观测事实（`persistent === false` 时 `apply()` 会 warn），而不是静默退化 |

端口化不是为测试：它让「有没有绕过托管范围自己杀进程」这个问题有确定答案——`SubprocessPortLike` 只有 `spawn`，没有 `kill`。

## 九、隔离自检五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有「被本包托管的那些进程不再受管」。没有定时器常驻、没有监听端口、不写主会话。`dispose()` 会逐个组杀。
2. **我的状态存在哪？** `user/process-host/<name>.json`（0600，原子写）与可选的 `<name>.pid`；`stats()`、世代号、句柄引用**只在内存**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.process-host`；`list()` 每项带 `phase / reason / detail`；`stats().refusals` 记拒绝次数；`stop()` 的 `confirmed` 单独给。全部方法不抛，所以界面拿到的永远是视图而不是异常。
4. **我依赖谁？缺席时我怎么降级？** 宿主 `subprocess`（缺 → `available=false` / `no-subprocess`，服务照常注册）、`ondra-path-layout`（缺 → 状态只能放内存并 warn）、`ondra-config-schema`（缺 → 本地校验）、`ondra-clock`（缺 → `Date.now`）、`ondra-identity`（缺 → 日志前缀兜底）。**一个都不 `inject`**。
5. **我和同域的谁共享了可变状态？** 没有。与 O-083 的分工是「接管 argv」对「挑端口」，与 O-079 的分工是「装组件」对「跑起来」，与 O-077 的分工是「验加载」对「托管运行」。三者不共享对象，也不共享文件。

## 十、与文档的口径差异（必须留痕）

1. **台账档位〔研〕→ 实际〔复〕。** 依据手册 §1.8 判定纪律（见「七」）。**未改台账的职责描述**，只在状态备注里登记。
2. **「detached」在手册里 0 命中。** 全文检索 `子进程 / pidfile / 组杀 / detached / 进程托管` 全部为 0；这一行规格只存在于 master-plan §5 的 L7 表格与台账。所以本包不去「解释」这四个词，而是逐词对照上游源码，把能做的做实（见「六」第 2、3 条）。
3. **pidfile 是「尽力而为」而不是「必有」。** 这是与台账字面最大的差异，理由见「六」第 2 条。**登记为待裁决**：要么上游补 `SubprocessHandle.pid`，要么承认 pidfile 只在部分 provider 下存在。
4. **新增 `collectBytes` / `stopTimeoutMs` 两个配置**，手册与台账都没有。前者防日志爆仓，后者让「静默未确认」有一个明确的时限。
5. **master-plan §3.1 / §6 仍写 `ondra:<短名>`**，与同文件 §3.3-6、手册 §8.4 冲突；按「手册优先」全仓连字符，**未改 master-plan**。
