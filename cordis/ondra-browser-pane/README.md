# ondra-browser-pane

> L9 运行时治理与扩展 · 〔研〕自研 · 服务键 **`ondra-browser-pane`**（连字符，非 `ondra:pane`）

只给内置插件用的极简浏览器，宿主半身。页面由插件登记，域名白名单硬约束，
不显示地址、不接受输入。

## 职责

- 维护页面登记表：插件调 `registerPage()` 把调试页 / 引导页交上来。
- 提供 `/pane` 前缀的四条路由：状态、跳转、白名单判定、健康。
- 提供 `ondra-browser-pane` 服务：`registerPage` / `pages` / `open` / `consume` / `allow`。

## 明确不负责

- **不渲染任何界面**。Cordis 插件跑在 Node 进程，渲染不了东西。界面半身在
  `desktop/packages/client/ui-browser-pane/`，这是插件体系的硬约束，不是拆分偷懒。
- **不做通用浏览器**。不能打开任意 https。白名单是硬约束，不是默认值：
  一个能打开任意网页的容器，用途由当时页面上的链接决定，而不是由设计意图决定。
- **不显示地址、不做输入框、不做书签历史**。这三样一旦有，用户就能改地址，
  「不能改链接」立刻失效。
- **不转发页面内容给模型**。面板里看到的东西不进任何提示词。
- **不做下载、不做打印、不做 PDF 导出**。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-browser-pane` | 唯一归属 |
| 消费 | `ondra-identity` | **软依赖**（日志命名空间） |
| 消费 | `ondra-config-schema` | **软依赖**（四层合并） |
| 消费 | `webServer` | **软依赖**（Electron 壳没有它，此时服务仍注册、路由不挂） |
| 被消费 | `ondra-beichen-api` | 登记 `beichen-entry` 页 |

**加载顺序**：本插件应排在 `ondra-beichen-api` 之前。后者用软依赖取本服务，
取不到会降级成「没有面板」，不会崩，但那是异常形态。

## 文件分层

| 文件 | 职责 | 约束 |
|---|---|---|
| `src/types.ts` | 契约、白名单常量、错误类 | 常量与类型，无逻辑 |
| `src/registry.ts` | 页面表 + 白名单判定 | **纯逻辑**，不碰 ctx、不联网，可单独核对 |
| `src/routes.ts` | 四条路由 | 不向请求方泄漏可用页清单 |
| `src/settings.ts` | 配置单一真源 | 只有两项，且都保守 |
| `src/index.ts` | 接线、服务实现 | 无 webServer 时也注册服务 |

白名单单独成文件的理由：它是这个插件的安全边界。混在 `apply()` 里就只能靠
「读一遍觉得没问题」验收，那不是验证。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `extraHosts` | `[]` | 额外放行的外部域名（含子域）。每加一条都扩大范围 |

**没有「允许任意 https」这种开关**，见上。

## 路由

| 路径 | 行为 |
|---|---|
| `GET /pane` | 服务名 + 可用页清单 |
| `GET /pane/state` | `{ pages, pending }` —— 界面轮询这一条取「该打开哪页」 |
| `GET /pane/view/<id>` | 302 到该页真实路径；页未登记 404 |
| `GET /pane/allow?url=` | `{ allowed, kind }` 或 `{ allowed:false, reason }` |
| `GET /pane/health` | `{ ok, port, pageCount }` |

## 白名单规则（三条，按序）

1. **协议**只认 `http` / `https`。`file:` / `data:` / `javascript:` 一律拒——
   前两个能读本机文件，第三个能执行脚本，都不该出现在一个展示第三方注册页的容器里。
2. **本机地址**（`127.0.0.1` / `localhost` / `::1`）必须**同端口**，且落在 `/pane/`
   或 `/beichen/` 下。只看主机名不看端口的话，本机任何一个别的服务都能被这个面板打开。
3. **远程地址**只认 `beichenapi.com`（含子域）与 `extraHosts`，且必须是 https。

拒绝时返回具体 `reason`（`scheme` / `host` / `path`），界面要把它显示出来——
静默失败会让用户以为「点了没反应」。

## 技术来源

- 路由注册：复用宿主 `webServer.register({ kind: 'prefix' })`，先例是
  `desktop/packages/experimental/webhook-github/src/index.ts`。
- 界面半身：见 `desktop/packages/client/ui-browser-pane/README.md`。

## 已知限制

1. **面板只能由插件登记，用户不能自己输网址**（无地址栏是设计，不是缺功能）。想开一个新站点，
   必须有一个插件在 `apply` 里调 `registerPage({ id, title, path })`。
2. **路径前缀写死** `'/pane/'` 或 `'/beichen/'`，不做通配。要放开第三条前缀得改源码，
   不是配置能解决的。
3. **远程只放行 `beichenapi.com`**（含子域），其余走 `extraHosts` 并在每次调用时过 `HOST_RE`。
   这条白名单不做持久化，进程重启后从配置重读。
4. **没有 `webServer` 就没有页面**：服务照常注册、路由不挂载，日志给一条 warn。
   Electron 壳下这是正常态，不是故障。
5. **注册表在内存**：进程退出即清零，不做持久化，也不跨会话继承。撤销靠对象引用比较，
   后注者无法用同名页顶掉先注者的页。

## 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有 `ondra-beichen-api`——它是全仓唯一消费方
   （`ctx.get('ondra-browser-pane')`）。关掉后面板登记失败，北辰注册入口拿不到可挂载的页面；
   对话、记忆、通道、端侧全不受影响。本插件不被 import，任何包都不会编译失败。
2. **我的状态存在哪？** 只在内存，一个 `Map<string, PanePage>`（`src/registry.ts:22`）。
   不落盘、不进数据库、进程退出即失效。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.browser-pane`
   （有 O-001 时走 `identity.loggerName('browser-pane')`）。未登记的 view 一律 404，
   且 404 响应**不列出已登记清单**——报错也不能变成信息泄漏。
4. **我依赖谁？缺席时我怎么降级？** `webServer` 是硬依赖：缺席时**服务照常注册、路由不挂载**，
   并 warn 一次（见 `src/index.ts:177`）。`ondra-identity` / `ondra-config-schema` 全软，
   缺席时日志名回退、配置用实例值。**刻意不声明插件级 `inject`**：声明后依赖缺席会停在
   PENDING，是最难查的失败形态。
5. **我和同域的谁共享了可变状态？** 没有。注册表 `Map` 是本插件私有的唯一可变状态，
   对外只经 `registerPage()` 的返回句柄撤销，交给宿主的只有路由回调。
