/**
 * 通道回调的接入面（宿主侧 `webServer` 服务）。
 *
 * ## 为什么必须有这一层
 *
 * 8 条对外通道里有 4 条是**回调式**（钉钉 / 飞书 / 微信公众号 / 企业微信），
 * 它们的 `apply()` 里都写着同一行：
 *
 * ```ts
 *   const webServer = ctx.get('webServer')
 *   if (webServer === undefined) → log.error('没有 webServer：这个通道完全收不到消息')
 * ```
 *
 * 而宿主此前**从未 `provide('webServer')`**。所以哪怕把适配器加进装载名单，
 * 它也只能在日志里喊一句「收不到」，然后什么都没挂上——而这一句 error
 * 在默认的 info 级日志里根本不会出现。症状是「装了、界面也能配、就是没反应」，
 * 与本仓反复踩的「静默降级」同形。
 *
 * ## 为什么这些路径不校验宿主令牌
 *
 * 宿主其余接口都要求 `Authorization: Bearer <启动时随机令牌>`，那是给**本机
 * 前端**用的：令牌只交给壳，别的进程拿不到。
 *
 * 但飞书 / 钉钉的服务器**不可能**带我们的令牌——它压根不知道它存在。
 * 所以回调路径必须绕开令牌校验，改成各适配器自己的鉴权：
 *
 * | 通道 | 适配器侧的鉴权 |
 * | --- | --- |
 * | 飞书 | `header.token` 对 `verificationToken` + `app_id` 比对 |
 * | 钉钉 | `timestamp + appSecret` 签名比对 |
 * | 微信公众号 | `signature` = sha1(sort(token, timestamp, nonce)) |
 * | 企业微信 | `msg_signature` + 解密 |
 *
 * 这条边界必须写清：**回调路径的安全性由适配器负责，不由宿主负责。**
 * 因此这里只做两件事：路径匹配、把原始请求原样交出去；绝不替适配器
 * 做任何校验，也绝不把未注册的路径放行。
 *
 * ## 为什么 `register` 只认 exact / prefix 两种
 *
 * 适配器传的就是这两种（当前 4 条全部用 `exact`）。加第三种（如正则）
 * 意味着两个进程要就一整套语法达成一致，而真实的收益是零。
 */

/** 一条已挂上的通道回调。 */
export interface ChannelRoute {
  /** 匹配方式。`exact` 全等，`prefix` 前缀。 */
  readonly kind: 'exact' | 'prefix'
  /** 绝对 pathname（以 `/` 开头）。 */
  readonly path: string
  /** 处理函数。原始请求原样交出去，由适配器自己读体、自己鉴权。 */
  readonly handler: ChannelRouteHandler
}

/**
 * 通道回调的处理函数。
 *
 * 参数形状与适配器 `types.ts` 里的 `HttpRequestLike` / `HttpResponseLike`
 * 结构对位，但**不 import 插件的类型**（§15.5：不得跨包 import）。
 * 形状分叉时这里会立刻报类型错，这正是要的。
 */
export interface ChannelRouteHandler {
  (req: ChannelRequestLike, res: ChannelResponseLike): void | Promise<void>
}

/** 请求（node:http 的 IncomingMessage 满足这个形状）。 */
export interface ChannelRequestLike {
  /*
   * 三个字段都写成 `| undefined`。
   *
   * 项目开了 `exactOptionalPropertyTypes`：`method?: string` 的语义是
   * 「可以没有这个键，但有了必须是 string」，而 node 的 `IncomingMessage`
   * 声明是 `method: string | undefined`（键存在、值可能是 undefined）。
   * 两者不兼容，`dispatch(req)` 会直接报类型错——这正是「形状对位」
   * 该抓到的差异，不要用 `as` 绕过去。
   */
  readonly method?: string | undefined
  readonly url?: string | undefined
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** 响应（node:http 的 ServerResponse 满足这个形状）。 */
export interface ChannelResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** `register()` 的返回值：调用即摘掉这条路由。 */
export type ChannelRouteDispose = () => void

/**
 * 通道回调的注册表。
 *
 * 一个实例随宿主存活；插件在 `ctx.effect` 里注册，卸载时由 disposer 摘掉。
 */
export class ChannelWebServer {
  /** 按注册顺序保存。同路径重复注册时**后者覆盖前者**（见 `register`）。 */
  private readonly routes: ChannelRoute[] = []

  /**
   * 挂上一条回调。
   *
   * ## 为什么同路径重复注册是覆盖而不是报错
   *
   * 插件被卸载再装载（改配置后重启某通道）时，旧的那条可能还没摘干净。
   * 此时报错会让「改一下配置」变成「必须重启整个应用」，而覆盖只是
   * 让最后一条生效——语义上正是我们想要的：一个路径只该有一个主人。
   *
   * 路径不以 `/` 开头时补一个：适配器配置里用户可能填 `feishu/callback`，
   * 那会被 `URL.pathname` 匹配成 `/feishu/callback`，不补就永远匹配不上。
   *
   * @param route 回调定义。
   * @returns 摘除函数，可重复调用。
   */
  register(route: ChannelRoute): ChannelRouteDispose {
    const path = route.path.startsWith('/') ? route.path : `/${route.path}`
    const entry: ChannelRoute = { kind: route.kind, path, handler: route.handler }

    // 同路径同 kind 的先摘掉，实现「后者覆盖」。
    const existing = this.routes.findIndex((item) => item.path === path && item.kind === entry.kind)
    if (existing !== -1) this.routes.splice(existing, 1)
    this.routes.push(entry)

    return () => {
      const at = this.routes.indexOf(entry)
      if (at !== -1) this.routes.splice(at, 1)
    }
  }

  /**
   * 找一个能处理该路径的回调。
   *
   * 精确匹配优先于前缀：用户既能挂 `/callback`，也能挂 `/callback/*`，
   * 前者更具体，先问它。前缀之间按**注册顺序**取第一个命中（不按长度排序：
   * 排序会让「后注册的更具体那条」赢，与注册者的直觉相反）。
   *
   * @param pathname 请求路径（已去掉 query）。
   */
  match(pathname: string): ChannelRoute | undefined {
    const exact = this.routes.find((item) => item.kind === 'exact' && item.path === pathname)
    if (exact !== undefined) return exact
    return this.routes.find((item) => item.kind === 'prefix' && pathname.startsWith(item.path))
  }

  /**
   * 把请求交给对应回调。
   *
   * @returns 处理了返回 true；没有匹配的回调返回 false（调用方继续走令牌校验）。
   */
  async dispatch(req: ChannelRequestLike, res: ChannelResponseLike, pathname: string): Promise<boolean> {
    const route = this.match(pathname)
    if (route === undefined) return false
    await route.handler(req, res)
    return true
  }

  /** 已挂上的回调清单。诊断接口与启动日志用它报现状。 */
  list(): readonly { kind: 'exact' | 'prefix'; path: string }[] {
    return this.routes.map((item) => ({ kind: item.kind, path: item.path }))
  }

  /** 已挂上的条数。 */
  get size(): number {
    return this.routes.length
  }
}
