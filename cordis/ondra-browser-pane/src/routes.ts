/**
 * 面板的四条路由。
 *
 * | 路径 | 行为 |
 * |---|---|
 * | `GET /pane/state` | 可用页清单 + 待处理打开请求（界面轮询这一条） |
 * | `GET /pane/view/<id>` | 302 到该页真实路径；页未登记则 404 |
 * | `GET /pane/allow?url=` | 白名单判定（界面在导航前问一次） |
 * | `GET /pane/health` | 状态摘要 |
 *
 * ## 为什么界面要轮询 `/pane/state`
 *
 * 宿主（Node）与渲染进程之间没有通用的推送通道——`webServer` 只提供 HTTP。
 * 为一次「打开面板」建一条 WebSocket 不值当，而本地面板的状态查询是微秒级开销。
 * 所以用轮询：界面在可见时每 800ms 问一次，失焦时停。
 *
 * 轮询只在面板打开期间发生，不做常驻心跳——常驻轮询会让一个「默认不用」的功能
 * 持续消耗 CPU，这在笔记本上能直接看出来。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PaneRegistry } from './registry.js'
import { PANE_SERVICE_KEY, type PanePage } from './types.js'

/** 发 JSON。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(JSON.stringify(payload))
}

/** 发纯文本（错误用）。 */
function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/** 只接受 GET / HEAD。 */
function allowGet(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  res.statusCode = 405
  res.setHeader('Allow', 'GET, HEAD')
  res.end()
  return false
}

/** 对外只暴露诊断需要的字段，`path` 不出去——界面不需要知道真实路径。 */
function publicPage(page: PanePage): { id: string; title: string; plugin: string } {
  return { id: page.id, title: page.title, plugin: page.plugin }
}

/** 路由依赖。 */
export interface PaneRouteOptions {
  /** 页面注册表。 */
  readonly registry: PaneRegistry
  /** 宿主端口取值。 */
  readonly port: () => number | undefined
  /** 日志。 */
  readonly log: { warn(message: string, ...args: unknown[]): void }
}

/**
 * 造 `/pane` 前缀的总处理器。
 *
 * 用 prefix 而不是给每条路由单独注册：`/pane/view/<id>` 是动态段，
 * webServer 的 exact 匹配不支持通配，注册一堆 exact 就得穷举 id。
 * @param options 路由依赖。
 * @returns node:http 处理器。
 */
export function createPaneHandler(options: PaneRouteOptions) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!allowGet(req, res)) return

    let pathname: string
    let search: URLSearchParams
    try {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
      pathname = parsed.pathname
      search = parsed.searchParams
    } catch {
      sendText(res, 400, '请求地址无法解析')
      return
    }

    if (pathname === '/pane' || pathname === '/pane/') {
      sendJson(res, 200, {
        service: PANE_SERVICE_KEY,
        pages: options.registry.pages().map(publicPage),
      })
      return
    }

    if (pathname === '/pane/state') {
      sendJson(res, 200, {
        pages: options.registry.pages().map(publicPage),
        pending: options.registry.peek() ?? null,
      })
      return
    }

    if (pathname === '/pane/allow') {
      const target = search.get('url') ?? ''
      sendJson(res, 200, options.registry.allow(target, options.port()))
      return
    }

    if (pathname === '/pane/health') {
      sendJson(res, 200, {
        ok: true,
        port: options.port() ?? null,
        pageCount: options.registry.pages().length,
      })
      return
    }

    if (pathname.startsWith('/pane/view/')) {
      const id = pathname.slice('/pane/view/'.length)
      const page = options.registry.pages().find(entry => entry.id === id)
      if (page === undefined) {
        // 不告诉请求方「有哪几个 id 可用」：那等于把内部页面清单播给任何人。
        sendText(res, 404, '页面不存在')
        return
      }
      res.statusCode = 302
      // 只跳站内路径：`page.path` 在登记时已经过前缀校验，这里不会出现外部地址。
      res.setHeader('Location', page.path)
      res.setHeader('Cache-Control', 'no-store')
      res.end()
      return
    }

    options.log.warn('未处理的面板路径：%s', pathname)
    sendText(res, 404, '未知路径')
  }
}
