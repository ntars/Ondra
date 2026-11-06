/**
 * 三条 HTTP 路由。
 *
 * | 路径 | 行为 |
 * |---|---|
 * | `GET /beichen/entry` | 铸一枚令牌，返回入口页（页面里没有任何网址） |
 * | `GET /beichen/go` | 验签通过后 302 到注册页，**邀请码只在这一跳拼出来** |
 * | `GET /beichen/health` | 返回状态摘要，供自检与界面核对（不含密钥、不含邀请码） |
 *
 * ## 一条刻意的沉默
 *
 * 这里**不记录** 302 的目标地址。日志会进文件、进诊断视图、进用户能导出的
 * 报告——一旦写了目标地址，邀请码就散落到所有导出物里，「不显示链接」
 * 这件事从源头破功。需要排查时看 `health` 的计数就够了。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { renderEntryPage, renderFailurePage } from './pages.js'
import { explainFailure } from './token.js'
import {
  AFFILIATE_CODE,
  type BeichenService,
  type VerifyResult,
} from './types.js'

/** node:http 的收发对象（结构对位，不 import 上游）。 */
export type RouteRequest = IncomingMessage
/** node:http 的响应对象。 */
export type RouteResponse = ServerResponse

/** 路由配置。 */
export interface RouteOptions {
  /** 服务实例。 */
  readonly service: BeichenService
  /** 令牌有效期（分钟）。 */
  readonly ttlMinutes: number
  /** 站点根地址。 */
  readonly siteBaseUrl: string
  /** 注册页路径。 */
  readonly registerPath: string
}

/** 发一段 HTML。 */
function sendHtml(res: RouteResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  // 入口页不需要 referrer，也不允许被任何页面以 iframe 嵌入
  // （防「钓鱼页套壳」：套壳后用户以为还在本应用里，实际点击落到了别处）。
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(body)
}

/** 发一段 JSON。 */
function sendJson(res: RouteResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 从请求里取查询参数。 */
function queryOf(req: RouteRequest): URLSearchParams {
  const base = 'http://127.0.0.1'
  try {
    return new URL(req.url ?? '/', base).searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * 造入口页处理器。
 * @param options 路由配置。
 * @returns `GET /beichen/entry` 的处理器。
 */
export function createEntryHandler(options: RouteOptions) {
  return (req: RouteRequest, res: RouteResponse): void => {
    if (!allowGet(req, res)) return
    const issued = options.service.issue()
    // 按钮指向本地路径，令牌作为参数；页面上不会出现完整网址。
    const gotoPath = `/beichen/go?t=${encodeURIComponent(issued.token)}`
    sendHtml(res, 200, renderEntryPage(gotoPath, options.ttlMinutes))
  }
}

/**
 * 造跳转处理器。
 * @param options 路由配置。
 * @returns `GET /beichen/go` 的处理器。
 */
export function createGotoHandler(options: RouteOptions) {
  return (req: RouteRequest, res: RouteResponse): void => {
    if (!allowGet(req, res)) return
    const token = queryOf(req).get('t') ?? ''
    const result: VerifyResult = options.service.verify(token)
    if (!result.ok) {
      sendHtml(res, 410, renderFailurePage('入口已失效', explainFailure(result.reason)))
      return
    }
    // 邀请码只在这里出现，且只出现在 3xx 的 Location 头里。
    const target = `${options.siteBaseUrl}${options.registerPath}?aff=${encodeURIComponent(AFFILIATE_CODE)}`
    res.statusCode = 302
    res.setHeader('Location', target)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.end()
  }
}

/**
 * 造健康检查处理器。
 * @param options 路由配置。
 * @returns `GET /beichen/health` 的处理器。
 */
export function createHealthHandler(options: RouteOptions) {
  return (req: RouteRequest, res: RouteResponse): void => {
    if (!allowGet(req, res)) return
    sendJson(res, 200, {
      ok: options.service.ready,
      ttlMinutes: options.ttlMinutes,
      // 只报「有没有配」与「是不是同一枚」，不报值。
      fingerprint: options.service.fingerprint,
      site: options.siteBaseUrl,
    })
  }
}

/** 只接受 GET / HEAD，其余一律 405。 */
function allowGet(req: RouteRequest, res: RouteResponse): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  res.statusCode = 405
  res.setHeader('Allow', 'GET, HEAD')
  res.end()
  return false
}
