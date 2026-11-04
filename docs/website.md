# 官网与开通入口（EdgeOne 部署）

线上地址：`https://ai.ntars.cn`

> **状态说明（2026-11-03 核对，勿删）**
>
> 本文描述的是**线上已部署形态**与设计口径。核对结论如下，写在这里是因为下文有
> 两处指向的文件在本仓库里并不存在：
>
> 1. **`edge-functions/` 目录不在仓库里**。`git log --all -- edge-functions` 为空、
>    `git ls-files` 命中 0，说明它从未进入过版本控制（很可能只存在于部署平台侧）。
>    下文「目录结构」里的 `edge-functions/*` 应读作「线上形态示意」，不是本仓库现状。
>    `index.html`、`edgeone.json`、`tools/build-site.mjs` 三个是真实存在的。
> 2. **`cordis/ondra-beichen-api/server/index.mjs` 不存在**。该目录现在只有
>    Cordis 插件本体（`src/*.ts`），见下文「与自建服务版的关系」的修订说明。
> 3. 因此「已发出的链接不会失效」这一条，**只对线上自己签发的 token 成立**。
>    本地插件是重写版，格式对齐、但密钥各不相同（本地随机生成），默认互不认。
>    要让两边互验，必须把本地 `secret` 文件的内容填进线上 `MASTER_SECRET`。

## 目录结构

```
Ondra/
├── index.html              # 官网首页（仓库根目录）
├── icon.svg                # 白底品牌图标（矢量源），页头与标签页共用
├── favicon.ico             # 16/32/48 三档，给不认 SVG 的浏览器兜底
├── assets/
│   ├── favicon-16.png      # 标签页小图标（单独简化过，见「图标体系」）
│   ├── favicon-32.png      # 高 DPI 标签页
│   └── favicon-180.png     # iOS 主屏图标（满白底，无透明角）
├── edgeone.json            # 构建配置：outputDirectory → ./dist
├── tools/build-site.mjs    # 构建时把官网静态文件收进 dist/
└── edge-functions/         # 边缘函数（V8，无 Node 依赖）
    ├── _lib/               # 下划线前缀：不生成路由，供入口文件 import
    │   ├── token.js        # 签名 / 验签（Web Crypto）
    │   ├── env.js          # 环境变量读取与跳转目标拼接
    │   └── page.js         # 落地页 / 失效页模板
    ├── start.js            # GET /start     铸 token → 302 /e/<token>
    ├── health.js           # GET /health    配置自检
    ├── e/[token].js        # GET /e/<token> 落地页
    ├── r/[token].js        # GET /r/<token> 验签后 302 到注册页（带邀请码）
    └── d/[token].js        # GET /d/<token> 验签后 302 到控制台（不带邀请码）
```

**为什么发布时多一个 `dist/`**：`index.html` 放在仓库根目录好找好改，但根目录还有
24,173 个被跟踪文件（`desktop/` 一个目录就 9 GB）。把根目录直接当静态输出，既会
超过平台限制，也会把整个 Electron 工程的源码当成静态资源暴露出去。

所以构建时跑 `tools/build-site.mjs`，只把 `index.html`、`icon.svg`、`favicon.ico`
和 `assets/` 整目录复制进 `dist/`，`edgeone.json` 的 `outputDirectory` 指向 `./dist`。
`dist/` 已在 `.gitignore` 里，不参与版本控制。

## 图标体系

一份矢量源（`icon.svg`：白底圆角方块 + 黑色手写标记）派生出所有位图。分成多个文件
不是冗余，是因为**不同浏览器认的格式不一样**：

| 文件 | 谁在用 | 为什么要单独出 |
|---|---|---|
| `/icon.svg` | Chrome、Firefox、Edge | 矢量，任意 DPI 都清晰，首选 |
| `/assets/favicon-32.png` | 高 DPI 标签页、Safari | **Safari 不支持 SVG favicon** |
| `/assets/favicon-16.png` | 低 DPI 标签页、书签栏 | 16px 下原图会糊，单独把圆角从 5.5 收到 3.2、标记描边加 0.28，笔画才连得住 |
| `/favicon.ico` | 老浏览器、Windows 快捷方式、RSS 阅读器 | 浏览器默认探测 `/favicon.ico`，缺了会在日志里报 404 |
| `/assets/favicon-180.png` | iOS「添加到主屏幕」 | iOS 会把透明区域填黑，所以这一张是**满白底**、不带圆角 |

16px 那版是唯一的例外：它和矢量源长得不完全一样（圆角更小、笔画略粗）。小尺寸下
简化是图形设计的常规做法，直接缩会得到一团灰。其余尺寸都与矢量源严格一致。

改图标时重出位图的步骤（需要本机有 Chrome 和 sips）：

```bash
# 1. 渲染 1024 底图：圆角版给 favicon，方角满白底版给 apple-touch
# 2. sips -z <尺寸> <尺寸> 逐档缩小
# 3. 分别打包成 favicon.ico（16/32/48，PNG 内嵌）与 assets/*.png
```

## 路由

| 路径 | 行为 |
|---|---|
| `GET /` | 官网首页（静态） |
| `GET /start` | 铸一枚 token（30 分钟有效），302 到 `/e/<token>` |
| `GET /e/<token>` | 落地页；签名不符、过期、跨密钥签发 → `410` |
| `GET /r/<token>` | 「去注册」按钮：验签后 302 到注册页，**邀请码在这一步才拼出来** |
| `GET /d/<token>` | 「去控制台」按钮：验签后 302 到控制台，不带邀请码 |
| `GET /health` | `{"ok":true,"ttlMinutes":30,"affConfigured":true,"site":"..."}` |
| `GET /icon.svg` | 品牌图标（静态，缓存 7 天） |
| `GET /favicon.ico` | 16/32/48 三档图标（静态，浏览器默认探测） |
| `GET /assets/*` | favicon 位图（静态，缓存 7 天） |

## 必须配置的环境变量

在 **EdgeOne 控制台 → 项目 → 项目设置 → 环境变量** 里添加。**不要写进仓库**——
这个仓库是公开的，写进去等于把邀请码印在源码上。

| 变量 | 必填 | 说明 |
|---|---|---|
| `MASTER_SECRET` | ✅ | 签名主密钥，32 字节以上随机串。**线上必须固定**：换一个，所有已发出的链接立刻失效 |
| `AFF` | ✅ | 邀请码。只在服务端持有，任何响应里都不出现 |
| `SITE` | | 北辰站点根地址，默认 `https://beichenapi.com` |
| `TTL_MINUTES` | | token 有效期，默认 `30` |
| `REGISTER_PATH` | | 注册页路径，默认 `/register` |
| `DASHBOARD_PATH` | | 控制台路径，默认 `/dashboard` |

生成主密钥：

```bash
openssl rand -base64 32
```

没配 `MASTER_SECRET` 时，`/start` 与 `/e/*` 会返回 500 并提示「入口服务还没配置签名密钥」，
不会静默降级成不安全的形态。

## 部署

推送到 GitHub 的 `main` 分支即触发自动构建。控制台里需要确认两项：

| 配置项 | 值 |
|---|---|
| 安装命令 | `true`（根 `package.json` 是 Electron 工程，**绝对不能让它跑 `npm install`**） |
| 构建命令 | `node tools/build-site.mjs` |
| 输出目录 | `dist`（以上两项 `edgeone.json` 已声明，控制台可覆盖） |

函数目录由平台自动发现（`edge-functions/`），不需要额外配置。
如果控制台仍是旧版 Pages（只认 `functions/`），把目录整体改名即可，代码不用动。

## 部署后验证

```bash
curl https://ai.ntars.cn/health
# {"ok":true,"ttlMinutes":30,"affConfigured":true,"site":"https://beichenapi.com"}

curl -sI https://ai.ntars.cn/start | grep -i location
# location: /e/v1.29xxxxxx.17xxxxxxxxxx.xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxx

curl -sI https://ai.ntars.cn/r/<上一步的 token> | grep -i location
# location: https://beichenapi.com/register?aff=你的邀请码

curl -s -o /dev/null -w '%{http_code}\n' https://ai.ntars.cn/e/<把末位改掉的 token>
# 410

# 图标：四个都必须是 200
for p in /icon.svg /favicon.ico /assets/favicon-16.png /assets/favicon-32.png /assets/favicon-180.png; do
  curl -s -o /dev/null -w "$p %{http_code} %{content_type}\n" "https://ai.ntars.cn$p"
done
# 缺任何一个，标签页都会是空白或 404
```

## 本地调试

```bash
edgeone makers dev     # http://127.0.0.1:8088
```

需要先 `edgeone makers link` 登录并关联项目——环境变量从平台拉取，不读本地 `.env`。

## 在客户端里接上

本地插件 `ondra-beichen-api` **不调用线上入口**，也不向 `ai.ntars.cn` 发请求：它用本地
`secret` 文件里的主密钥自己铸 token，验签后一跳 302。两条链路各自独立，唯一的交集是
`MASTER_SECRET` 相同时两边 token 能互验。

配置项（键名以插件 `src/settings.ts` 的 `FIELD_SPECS` 为准）：

| 键（camel / kebab） | 默认值 | 说明 |
|---|---|---|
| `enabled` / `enabled` | `true` | 总开关。关掉后本地入口页与跳转路由都不注册 |
| `ttlMinutes` / `ttl-minutes` | `30` | 令牌有效期，范围 1–1440 |
| `siteBaseUrl` / `site-base-url` | `https://beichenapi.com` | **目的地**根地址，必须以 `https://` 开头。注意它不是线上入口地址 |
| `registerPath` / `register-path` | `/register` | 注册页路径，须以斜杠开头、不以斜杠结尾 |
| `openInPane` / `open-in-pane` | `true` | 是否请求内置浏览器窗口打开入口页 |

早期草稿里写的 `entryBaseUrl` 是错的，本插件没有这个字段。

入口只有两个：

| 路径 | 行为 |
|---|---|
| `GET /beichen/entry` | 铸一枚 token，返回入口页（200，页面里没有任何网址）；按钮指向 `/beichen/go?t=<token>` |
| `GET /beichen/go?t=<token>` | 验签通过 → 302 到注册页（此时才拼邀请码）；失败 → 410 失效页 |
| `GET /beichen/health` | 状态摘要：`ok` / `ttlMinutes` / `fingerprint` / `site`。不返回密钥，也不返回邀请码 |

`fingerprint` 是主密钥的指纹前若干位，用于核对「本地与线上是不是同一枚密钥」，无法反推密钥本身。

页面里不出现任何网址，邀请码不进日志，302 目标也不写进 access log。

## 与自建服务版的关系

**先更正一句事实**：`cordis/ondra-beichen-api/server/index.mjs` **不存在**，本仓库里
从未有过这个文件（`git log --all -- cordis/ondra-beichen-api/server` 为空）。现在该目录
里是 Cordis 插件本体 `src/*.ts`，它按同一套格式独立实现。

格式口径（两边一致）：

```
master   = sha256(MASTER_SECRET)
分钟密钥  = HMAC(master, "beichen-entry-v1|<分钟序号>")
token    = v1.<分钟序号>.<过期毫秒>.<12 字节 nonce>.<签名前 22 字符>
```

原文提到的「已验证双向互验（17 项断言）」是对**边缘版与当时那份 Node 版**做的，
现在没有第二份实现可供复跑，所以这条结论**不能**直接套到插件上。插件这边的自检向量
写在 `cordis/ondra-beichen-api/README.md`：

```
master(hex) = 4e76a635afaddb286892017367a966256d80239b5bfc712c98ff7e1924799c63
token       = v1.28333333.1700001800000.AAECAwQFBgcICQoL.cSXZDqqxJCHx9aLhJLPO-p
```

注意：**token 带分钟序号，所以这枚向量只对 `v1` 的分钟边界有效**，不是可长期复用的样例。
换密钥即换向量。

要让两边互验，唯一条件是 `MASTER_SECRET` 相同；且必须是**同一份 32 字节原始值**——
拿一行 base64 去填另一边的 hex 是通不了的。

边缘版相比插件版少了一样东西：**按 IP 的铸币限流**。边缘函数无状态，内存计数不适用。
影响有限——铸币本身不产生副作用，真实注册流程在北辰页面且有 Turnstile 兜底。
如果确实需要，可以接 KV 做计数。
