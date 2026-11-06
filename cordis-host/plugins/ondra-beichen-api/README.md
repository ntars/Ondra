# ondra-beichen-api

> L9 运行时治理与扩展 · 〔研〕自研 · 服务键 **`ondra-beichen-api`**（连字符，非 `ondra:beichen`）

北辰注册入口的本地铸币与跳转。用户点「去注册」时，应用不会把一条带邀请码的
链接交给界面——它先在本地铸一枚有时效的令牌，界面只拿到本地入口页地址，
真正的邀请码只在服务端 302 那一跳被拼出来。

## 职责

- 在数据目录生成并保管一枚主密钥（32 字节随机，base64），文件权限 0600。
- 按 v1 分钟级格式铸令牌，有效期可配（默认 30 分钟）。
- 提供三条本地路由：入口页、跳转、健康检查。
- 提供 `ondra-beichen-api` 服务，供界面读取「是否就绪 / 密钥指纹 / 入口句柄 / 密钥原文」。

## 明确不负责

- **不显示链接**：入口页里没有 `<a>` 裸链接、没有「复制链接」、没有脚注 URL。
  用户能看到的只有一句说明和一个按钮。
- **不提供 `registerUrl()` 这类接口**。任何能直接拿到带邀请码链接的方法，
  都会让「不显示链接」这条要求作废。跳转只发生在 HTTP 路由里。
- **不记录跳转目标**：日志进了文件、诊断视图和用户可导出的报告，一旦写了目标地址，
  邀请码就散落到所有导出物里。要排查只看 `/beichen/health` 的状态。
- **不把邀请码做成配置项**。做成配置项就等于允许改归因，而且改完没有任何报错。
- **不做注册页本身**：注册、登录、发 Key 全在北辰站点完成，本插件只负责把用户送过去。
- **不做按 IP 限流**：铸币本身无副作用，真实注册流程在北辰页面且有 Turnstile 兜底。

## 服务键

| 方向 | 键 | 说明 |
|---|---|---|
| 提供 | `ondra-beichen-api` | 唯一归属 |
| 消费 | `ondra-path-layout` | **软依赖**（取密钥文件路径；缺席回退 `~/.ondra/user/beichen/`） |
| 消费 | `ondra-identity` | **软依赖**（只为取日志命名空间） |
| 消费 | `ondra-config-schema` | **软依赖**（四层合并；缺席走本地校验） |
| 消费 | `webServer` | **软依赖**（Electron 壳没有它，此时服务仍注册、路由不挂） |

## 文件分层

| 文件 | 职责 | 约束 |
|---|---|---|
| `src/types.ts` | 契约、邀请码常量、错误类 | 常量与类型，无逻辑 |
| `src/token.ts` | v1 签名 / 验签 | **纯函数**：不碰 ctx、不读盘、不联网，可单独核对 |
| `src/secret.ts` | 密钥生成、读写、指纹 | 只经 `prepareFile()` 收权限，不自己 chmod |
| `src/pages.ts` | 入口页与失效页 HTML | 不加载任何外部资源，不出现网址 |
| `src/routes.ts` | 三条路由 | 跳转目标不进日志 |
| `src/settings.ts` | 配置单一真源 | 一张声明表，三处消费 |

`token.ts` 单独成文件的理由：这是整个链路里唯一「算错了也照样跑」的一段。
签错了，页面照样能开、302 照样会跳，只是邀请码缺失；验错了，用户只看到 410。
两者都不抛异常，所以必须能脱离宿主单独核对。

## 配置（全部有默认值）

| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `enabled` | `true` | 布尔 | 总开关。关掉后不铸币、不挂路由 |
| `ttlMinutes` | `30` | 1–1440 | 令牌有效期 |
| `siteBaseUrl` | `https://beichenapi.com` | `https://` 开头 | 站点根地址，不含尾部斜杠 |
| `registerPath` | `/register` | 斜杠开头、不带尾斜杠 | 注册页路径 |
| `openInPane` | `true` | 布尔 | 是否请求内置浏览器窗口打开入口页 |

**没有邀请码字段**，见上。

## 签名格式（v1）

```
master   = sha256(MASTER_SECRET)
分钟密钥  = HMAC-SHA256(master, "beichen-entry-v1|<分钟序号>")
token    = v1.<分钟序号>.<过期毫秒>.<12 字节 nonce>.<签名前 22 字符>
```

文档没写死、由本实现决定的三处细节：

1. **nonce 用 base64url 无填充编码**，12 字节 → 16 个字符；
2. **签名对 `v1.<分钟>.<过期>.<nonce>` 整段原文做 HMAC-SHA256**，
   再 base64url 无填充编码 → 43 个字符，**取前 22 个**；
3. **验签用令牌自带的分钟序号重算密钥**，不要求等于当前分钟——
   否则跨过整分钟的那一秒，刚铸出的币就废了。

## 自检向量（必须跑通才能说「两边互验」）

固定输入，任何人照算法都应得到同一输出：

```text
MASTER_SECRET = ondra-beichen-self-check-v1
now           = 1700000000000        （2023-11-14T22:13:20Z）
ttlMinutes    = 30
nonce         = 00 01 02 03 04 05 06 07 08 09 0a 0b

master(hex)   = 4e76a635afaddb286892017367a966256d80239b5bfc712c98ff7e1924799c63
分钟序号       = 28333333
过期毫秒       = 1700001800000
nonce(base64url) = AAECAwQFBgcICQoL
签名          = cSXZDqqxJCHx9aLhJLPO-p
token         = v1.28333333.1700001800000.AAECAwQFBgcICQoL.cSXZDqqxJCHx9aLhJLPO-p
指纹（前 16 位） = 4e76a635afaddb28
```

**与原实现的关系**：`docs/website.md` 描述过一套 EdgeOne 边缘函数版，但截至
2026-11-03，仓库里**不存在** `edge-functions/`，也不存在 `cordis/ondra-beichen-api/server/index.mjs`。
所以本文件是当前唯一的 v1 实现。将来的边缘版必须逐字复刻上面三行派生规则
并跑通这组向量，才谈得上「互验」；只对着文档抄格式、算法细节自己发挥，
第一次跨端验签就会全量 410。

## 密钥与 EdgeOne 对齐

本地首次启动会生成密钥。要让「本地签的 token 在线上也认」，需要两处同值：

1. 应用设置里读出本机密钥（服务方法 `secret()`，界面应提供一键复制）；
2. 在 EdgeOne 控制台 → 项目设置 → 环境变量，把 `MASTER_SECRET` 填成同一个值。

核对是否同值只看指纹，不必比对明文：本地 `/beichen/health` 返回的 `fingerprint`
应等于 `sha256(MASTER_SECRET)` 的前 16 个十六进制字符。

**注意**：换密钥会让所有已发出的入口立刻失效。线上必须固定，别每次部署重生成。

## 已知限制与风险（必须知道）

1. **邀请码在公开仓库里**。它硬编码在 `src/types.ts`，仓库是公开的，
   拿到源码的人能读出这串字符。所以本插件防的是「误触、随手转发、界面截图」，
   不是「有心人看源码」。真正的防护是：邀请码只在服务端 302 出现，页面与日志里都没有。
2. **v1 是分钟级，同一分钟内令牌可复用**。这是「与文档格式兼容」的代价；
   随机 nonce 保证同分钟内的多枚令牌彼此不同，但不保证一次性。
3. **本地密钥与线上默认不互验**。不按上一节对齐，两边签的 token 互不认识——
   本地入口页能开、能跳，但线上 `/e/<token>` 会判 410。
4. **本地令牌只能本地验**。入口页与跳转都在本机完成，不依赖线上服务；
   这也意味着线上边缘函数暂时没有参与这条链路。

## 路由

| 路径 | 行为 |
|---|---|
| `GET /beichen/entry` | 铸币，返回入口页（200） |
| `GET /beichen/go?t=<token>` | 验签通过 302 到注册页；任一失败 410 并说明原因 |
| `GET /beichen/health` | `{ ok, ttlMinutes, fingerprint, site }` |

三条路由都只接受 GET / HEAD，响应带 `Cache-Control: no-store`、
`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`。
最后一条是防「钓鱼页套壳」——被嵌进别人页面后，用户会以为还在本应用里点击。

## 技术来源

- 格式与派生规则：`docs/website.md`（文字描述，无对应代码）。
- 权限处理：复用 O-002 `ondra-path-layout` 的 `prepareFile()`，不自己 chmod。
- 配置四层合并：复用 O-005 `ondra-config-schema`，缺席时本地校验。

## 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 没有插件消费本服务键——全仓 `ctx.get('ondra-beichen-api')` 命中 0。
   本插件提供的是三条 HTTP 路由，不是给其他插件调的服务。影响面在外部：`/beichen/entry`
   变成 404，扫码进不来。对话、记忆、通道、端侧全不受影响；本插件不被 import，
   任何包都不会编译失败。
2. **我的状态存在哪？** 一个文件：`~/.ondra/user/beichen/master-secret`（`0600`），内容是
   `sha256(secret)`，**明文密钥不落盘**。有 O-002 时走 `pathLayout.prepareFile()`，
   缺席时 `writeFileSync` 自带 `mode: 0o600`。分钟密钥与令牌全部即时计算，不存储、不缓存。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.beichen`
   （有 O-001 时走 `identity.loggerName('beichen')`）；`/beichen/health` 返回
   `{ ok, ttlMinutes, fingerprint, site }`，`fingerprint` 是密钥指纹，对齐密钥时靠它核对。
   宿主没有 `webServer` 时**服务仍注册、路由不挂载**，并 warn 一次（Electron 壳下属正常）。
4. **我依赖谁？缺席时我怎么降级？** `webServer` 是硬依赖：缺席则没有可用页面，但服务照常注册。
   `ondra-browser-pane`（软，页面登记半身）、`ondra-path-layout`（软，回退默认路径）、
   `ondra-config-schema` / `ondra-identity`（软）。**刻意不声明插件级 `inject`**：声明后
   依赖缺席会停在 PENDING，是最难查的失败形态。
5. **我和同域的谁共享了可变状态？** 没有。密钥文件独占 `user/beichen/` 目录，不与其他插件
   共用；邀请码是 `src/types.ts` 里的常量，运行时不改写；不缓存任何跨插件对象。
