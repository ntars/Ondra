/**
 * ondra-browser：内嵌浏览器与白名单。
 *
 * 只做两件事：**谁能打开、打开什么**。真正的渲染在平台层（WKWebView），
 * 白名单判定放在这里，后续「读网页」的工具也要走同一个判定。
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'ondra-browser'

export interface AllowedSite {
  host: string
  note?: string
}

class BrowserService extends Service {
  private sites: AllowedSite[] = []

  constructor(ctx: Context) {
    super(ctx, 'browser')
  }

  list(): AllowedSite[] {
    return [...this.sites]
  }

  add(url: string): string | null {
    const host = normalize(url)
    if (!host) return '地址不合法'
    if (this.sites.some(s => s.host === host)) return '已在白名单里'
    this.sites.push({ host })
    return null
  }

  remove(host: string): void {
    this.sites = this.sites.filter(s => s.host !== host)
  }

  /** 只有白名单里的 host 才允许加载；子域按后缀匹配。 */
  allows(url: string): boolean {
    const host = normalize(url)
    if (!host) return false
    return this.sites.some(s => host === s.host || host.endsWith(`.${s.host}`))
  }
}

function normalize(url: string): string | null {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`)
    return u.host
  } catch {
    return null
  }
}

export function apply(ctx: Context): void {
  void new BrowserService(ctx)
}
