# ondra-dev-rebrand

> O-084 · L7 系统与交付 · 档位**〔薄〕**（台账原标〔研〕，本轮按手册 §1.8 下调，理由见「十」）· 服务键 `ondra-dev-rebrand` · 状态 **done（静态自检通过，未实装运行）**

改名点位地图 + 逐层重签清单 + 残留审计。**不执行命令、不读应用包、不改 `desktop/`**。

---

## 一、职责

1. **点位地图**（`spec.ts` 的 `SITES`）：12 个承载产品名的位置，逐个标「是不是单一真源」。
   最有用的是 `singleSource` 这一列——它把「单一真源」从口号变成可查的布尔值。
2. **逐层重签清单**（`LAYERS`）：9 层，由内向外编号，其中 3 层标 `skip` / `sealed`（**不许碰**）。
3. **改名计划**（`plan()`）：两条分支各编一套有序步骤，`applied` 恒 `false`。
4. **残留审计**（`audit()`）：拿一份包事实（plist 字段、图标文件、品牌词、签名输出）回来对，
   报出「旧名还在」「图标指不到」「预签子树被重签」这类**不会报错**的问题。
5. **签名契约转换**（`judgeSignature()`）：把 `codesign --display --verbose=4` 原文翻成结构化问题。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| **真的执行改名 / 重签 / 打包** | 打包链（`scripts/package-target.ts` → electron-builder → `afterSign`） |
| 读 `.app` 里的 Info.plist | 调用方（壳侧或打包链）。解析 plist 要另写一套格式解析器 |
| 跑 `codesign` / `stapler` / `spctl` | 调用方。**执行外部命令不属于插件进程**（本轮边界：不实装运行） |
| 签名参数本身 | `scripts/verify-macos-signature.mjs`（上游已有，本包只引用其判定字段） |
| 开发包改名与 ad-hoc 签 | `scripts/development-app.ts`（上游已有，本包只指出它漏了图标） |
| 安装器九步流水线 | O-079 `ondra-installer` |
| 首启引导 | O-082 `ondra-onboarding` |
| 进程托管 | O-080 `ondra-process-host` |

### 三条刻意的「不做」

1. **不抄一份产品名当默认值。** 真源在上游 `product-name.mjs` 的 `PRODUCT_NAME`。
   在这里给个 `'空谷 Ondra'` 的默认值，仓库里就多一份名字，漂移的表现是「审计说没问题、菜单还是旧名」——
   那正是本插件要消灭的东西，不能自己先犯一遍。
2. **不写「照抄就能跑」的签名脚本。** 上游的签名链带 `afterSign` 回验，手工那条没有。
   给出第二条能跑通的路径，等于给「绕过校验」留了个后门。
3. **不用 `--deep` 签。** 见不变量 `never-deep-sign-release`。

## 三、服务键与方法

```
ondra-dev-rebrand        ← 连字符，不是带冒号的写法
```

| 方法 | 语义 | 会不会抛 |
|---|---|---|
| `spec()` | 点位 12 处 + 层 9 个 + 不变量 7 条 | 否 |
| `plan()` | 改名 + 重签 + 校验的有序步骤（`applied` 恒 `false`） | 否 |
| `audit(facts)` | 包事实 → `pass / fail / unverifiable` + 问题清单 | 否 |
| `judgeSignature(details, expected?)` | 签名原文 → 结构化问题（`expected` 缺省取配置） | 否 |
| `stats()` | `specs / plans / audits` 三个独立计数 | 否 |
| `dispose()` | 只翻标志位（没有句柄、没有定时器、没有写入） | 否 |

### 原因码

| 码 | 含义 | 下一步 |
|---|---|---|
| `ok` | 没有缺口 | 照步骤做 |
| `disabled` | `enable=false` | 打开开关（`spec()` / `audit()` 不受影响） |
| `disposed` | 插件已卸载（`available === false`） | 重新装载 |
| `no-brand-name` | `displayName` 为空 | 配 `display-name`；**本包不替你编名字** |
| `no-bundle-id` | `bundleId` 为空 | 配 `bundle-id`，否则判不了「有没有顺手改了它」 |
| `bad-bundle-id` | 不是 reverse-DNS 形状 | 与上游 `resolveDesktopAppId` 同一条正则 |
| `no-app-path` | `manual` 分支缺目标路径 | 配 `app-path`，否则命令里只有占位符 |
| `no-signing-identity` | 没配证书限定名 | 配 `signing-identity`（**不带** `Developer ID Application:` 前缀） |
| `no-team-id` | 没配 Team ID | 配 `team-id` |

> 只报**第一个**缺口。一次列五条，人会挑最容易的那条改，然后以为改完了。

## 四、点位地图与出处

| 点位 | 文件 | 是不是真源 | 说明 |
|---|---|---|---|
| `display-name` | `scripts/product-name.mjs` | **是** | `PRODUCT_NAME`，`productName` / 协议名 / 冒烟脚本都从这取 |
| `bundle-id` | `scripts/desktop-release-environment.mjs` | **是** | 值来自 `ONDRA_DESKTOP_APP_ID`，仓库里没有；**不要改** |
| `about-panel` | `src/main.ts` | 否 | `setAboutPanelOptions({ applicationName })` 硬编码 |
| `locale-brand` | `src/locale.ts` | 否 | 8 种语言，`Ondra` 全文件出现 103 次 |
| `dev-bundle` | `scripts/development-app.ts` | 否 | `CFBundleName` / `DisplayName` / `Executable` 仍是 `Harness Dev` |
| `dev-bundle-path` | 同上 | 否 | 目录名 `Harness Dev.app` 也是写死的 |
| `dev-icon` | 同上 | **是** | **`CFBundleIconFile` 这个键压根不存在**，图标沿用 Electron 的 |
| `scheme` | `scripts/electron-builder-config.mjs` | 否 | `schemes: ['ondra']`，另有一份在 `development-app.ts`；**不要改** |
| `artifact-prefix` | 同上 | 是 | `artifactName: 'ondra-…'` |
| `microphone-usage` | 同上 | 是 | `NSMicrophoneUsageDescription` 的句子里写着产品名 |
| `icon-assets` | `resources/` | 是 | `icon-macos.png` / `icon-windows.png` / `tray-windows.ico` |
| `userdata` | `src/paths.ts` | 是 | `$ONDRA_HOME/electron`，**已与名字解耦，不要改回去** |

## 五、逐层重签与三层不碰

由内向外（`order` 10 → 90）：

| 层 | 路径 | 动作 | 依据 |
|---|---|---|---|
| `pak` | `Contents/Resources/**/*.pak` | `sealed` | 由外层 bundle 封签（`signIgnore` 含 `\.pak$`） |
| `runtime` | `Contents/Resources/runtime/primary-runtime` | **`skip`** | 预签子树（`signIgnore`） |
| .ondra. | `Contents/Resources/app.asar.unpacked.ondra. | **`skip`** | 预签子树（`signIgnore`） |
| `helpers` | `Contents/Frameworks/*.app` | `sign` | 嵌套 app，通识 |
| `frameworks` | `Contents/Frameworks/*.framework` | `sign` | 嵌套 bundle，通识 |
| `dylibs` | `Contents/Frameworks/**/*.dylib` | `sign` | 独立 Mach-O，通识 |
| `executable` | `Contents/MacOS/<CFBundleExecutable>` | `sign` | 改名后路径变了 |
| `bundle` | `<App>.app` | `sign` | 改过 Info.plist 必须重签（签名覆盖其哈希） |
| `dmg` | `ondra-<version>-<os>-<arch>.dmg` | `sign` | `dmg.sign: !unsigned` |

**为什么 `skip` 那两层碰不得**：它们不是「还没签」，而是「已经签过了、由别的流程负责」。
`codesign --deep` 会把它们一起重签，把供应商签名换成自己的；后果不是「多签一次」，
而是.ondra.的哈希清单对不上、运行时自检失败，**而错误信息指向一个跟签名无关的模块**。

**为什么顺序由内向外**：外层签名覆盖内层代码的 cdhash。顺序反了，`codesign --verify`
只会说「签名无效」，不会说「你顺序反了」。这一条是平台通识，本仓库没有手工重签的先例可抄。

## 六、七条不变量

| # | 不许动 | 动了会怎样 |
|---|---|---|
| 1 | `CFBundleIdentifier` | 更新通道、TCC 授权、单实例锁都按它认 → 等于换了个 App |
| 2 | `CFBundleURLSchemes`（`ondra`） | 已发布的深链全部 404，报错在别人的浏览器里 |
| 3 | userData 路径 | 上游注释写明：跟名字走时**每次改名都孤立一次旧配置** |
| 4 | 发布包不用 `--deep` 签 | 预签子树被覆盖，`--verify --deep --strict` 反而过不了 |
| 5 | 重签必带 `--entitlements` | JIT 权限丢了渲染进程起不来，报错指向别处 |
| 6 | 重签必带 `--timestamp --options runtime` | 上游校验脚本逐字检查这两个字段 |
| 7 | 换图标必改 `CFBundleIconFile` | 只换图不改键，Dock 还是旧图且**不报错** |

## 七、配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enable` | `true` | 关掉只让 `plan()` 报 `disabled` |
| `branch` | `builder` | `builder` = 交给 electron-builder（默认）；`manual` = 打包后逐层重签 |
| `display-name` | **空** | 新显示名。**空 = 未声明**，计划只给「先声明品牌名」一步 |
| `bundle-id` | **空** | 期望的 reverse-DNS。空 = 不判「是否被改」 |
| `scheme` | `ondra` | 护栏基线（抄上游现值），只用于判「有没有被顺手改掉」 |
| `artifact-prefix` | `ondra-` | 同上 |
| `signing-identity` | **空** | 证书限定名：**不含** `Developer ID Application:` 前缀，但通常含 `(TEAMID)` 后缀（整行严格相等） |
| `team-id` | **空** | Apple Team ID |
| `app-path` | **空** | `manual` 分支的目标 `.app` 绝对路径 |
| `verbose` | `false` | 每次 `plan()` / `audit()` 一行日志 |

## 八、边界

**隔离自检五问（master-plan §16.4）**

1. **关掉我，谁受影响？** 只有我自己。没有任何插件消费 `ondra-dev-rebrand`。
2. **我的状态存在哪？** 只在内存（三个计数 + 一个卸载标志）。没有文件、没有句柄、没有定时器。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.rebrand`（或 `identity.loggerName('rebrand')`）；
   所有方法都是纯函数且不抛，崩的方式只有一种——`available === false`。
4. **我依赖谁？** `ondra-identity`（软，日志前缀）、`ondra-config-schema`（软，配置段）。
   两者缺席时退回本地默认值与 `ondra.rebrand` 前缀，功能不减。
5. **我和同域的谁共享了可变状态？** 没有。

## 九、已知限制

1. **不执行任何命令。** 改名与重签发生在打包链里；本包只出步骤与判定，`applied` 恒 `false`。
2. **审计吃事实，不读 `.app`。** 调用方要先把 plist 字段、图标文件、品牌词、签名输出读出来喂进来。
   这样这一层是纯函数，可离线对拍；代价是调用方多做一步。
3. **`scheme` / `artifact-prefix` 的默认值抄自上游现值。** 上游真改了这两处，这里要同步。
   它们是护栏基线，不是产品真源（产品名归上游，基线归本包）。
4. **签名判定的四个字段与上游重复**（`Authority=` / `TeamIdentifier=` / `Timestamp=` / `flags=…(runtime)`）。
   重复的是四条字符串，不是整个签名流程；上游改了字段集，这里要同步。
   另有一条容易踩的：`Authority=` 是**整行严格相等**，所以 `signing-identity` 要写全
   `公司名 (TEAMID)`——少写括号那段会判「证书不对」，而证书其实是对的（证据里会打出实际的 Authority 行）。
5. **逐层顺序标 `通识`。** 本仓库没有手工重签的先例，顺序来自 Apple 平台的通用约束，不是抄来的。
6. **改包后公证票据必然作废。** 票据绑定 cdhash，`stapler validate` 失败是正确行为，不是回归。
7. **开发包用的是 `codesign --force --deep --sign -`**（上游现值，ad-hoc）。本包不改它，
   只指出「它是可再生的一次性包，所以 deep + ad-hoc 可以接受；发布包不行」。
8. **未实装运行。** 本轮只做静态自检。

## 十、技术来源

| 用途 | 来源 | 档位 | 依据 |
|---|---|---|---|
| 显示名真源 | `scripts/product-name.mjs` | **复用** | 只引用其语义（「真源在这一行」），**不复制值** |
| 签名参数与身份断言 | `scripts/verify-macos-signature.mjs` | **复用** | `--force --sign --timestamp --options runtime --entitlements` 逐字对齐；判定字段照抄，流程不重写 |
| 打包签名配置 | `scripts/electron-builder-config.mjs` | **复用** | `identity` / `hardenedRuntime` / `entitlements` / `signIgnore` / `dmg.sign` / `afterSign` 全在上游 |
| 开发包改名 | `scripts/development-app.ts` | **复用** | 三处 plist 值与目录名的现成写法，本包只指出漏了图标 |
| userData 解耦 | `src/paths.ts` + `src/main.ts` 注释 | **复用** | 注释里的历史事故原文即不变量 3 的依据 |
| 重签顺序 | 无（平台通识） | **自研** | 上游没有手工重签先例，只能按 Apple 约束写 |
| 残留审计 | 无 | **自研** | 上游没有「改名残留」这个概念；实现只是纯数据比对，不重写机制 |

**档位裁定**：台账标〔研〕，本包下调为**〔薄〕**。手册 §1.8 的纪律是「能复用却自研 = 违规」，
而重签这件事上游已经写全（含 `afterSign` 回验）。本包只做契约转换与护栏，
不重写任何一条签名命令——这符合〔薄〕的定义「保留外部实现，插件负责契约转换与护栏」。
**此项已回写台账，并在简报中列为口径裁定。**

## 十一、多方案分支说明（master-plan §12）

「改名之后怎么签」有两条真实可行的路，按 §14.2 各一个文件、一个接口、默认选最稳：

| 分支 | 文件 | 什么时候用 | 为什么不是默认 |
|---|---|---|---|
| `builder`（默认） | `branch-builder.ts` | 正常发版 | — |
| `manual` | `branch-manual.ts` | **必须在打包后**才改 bundle 名 | 没有 `afterSign` 回验，签名坏了没人知道 |

两条分支**不共享缓存、不共享步骤**，`service.ts` 只按 `branch` 分派。降级路径：
`manual` 缺 `app-path` 时不给命令（只给占位符），不会给出「看起来能跑」的半成品。

## 十二、与文档的口径差异（必须留痕）

1. **手册对本项只有一句话**：「Dev.app 改名换图标并逐层重签」，**没有任何展开**。
   本包的点位、层、不变量全部来自上游源码与平台通识，逐条标了出处档位，**不假装出自手册**。
2. **档位从〔研〕改〔薄〕**，理由见「十」。这是与台账的差异，不是与手册的差异（手册要求复用优先）。
3. **`scheme` / `artifact-prefix` 给了默认值，`display-name` 没有。** 看似不一致，实为两种东西：
   前者是「不许改」的护栏基线（归本包），后者是「改成什么」的产品真源（归上游）。
   同一个字段给默认值，性质完全不同。
