/**
 * 页面注册表与白名单判定 —— **纯逻辑，不碰 ctx、不碰网络**。
 *
 * 单独成文件的理由：白名单是整个插件的安全边界，而它必须能被单独推理与核对。
 * 混在 `apply()` 里就只能靠「读一遍代码觉得没问题」来验收，那不是验证。
 */

import {
  EXTERNAL_ALLOWLIST,
  LOCAL_PATH_PREFIXES,
  BrowserPaneError,
  type AllowResult,
  type PaneOpen,
  type PanePage,
} from './types.js'

/** 页 id 的形状：小写、连字符、2–64 位。 */
const PAGE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/

/** 页面注册表 + 待处理打开请求。 */
export class PaneRegistry {
  private readonly byId = new Map<string, PanePage>()
  private pending: PaneOpen | undefined
  /** 常量白名单 + 用户额外放行的域名，构造时合并一次，判定时不再拼接。 */
  private readonly domains: readonly string[]

  /**
   * @param extraHosts 用户在配置里额外放行的域名（已校验、已小写）。
   */
  constructor(extraHosts: readonly string[] = []) {
    this.domains = [...EXTERNAL_ALLOWLIST, ...extraHosts]
  }

  /**
   * 登记一个页面。
   * @param page 页面描述。
   * @returns 撤销函数。
   * @throws BrowserPaneError id 不合规 / 路径越界 / 重复登记。
   */
  registerPage(page: PanePage): () => void {
    if (!PAGE_ID_RE.test(page.id)) {
      throw new BrowserPaneError(`页 id 不合规：${page.id}（需匹配 ${PAGE_ID_RE.source}）`, 'bad-page')
    }
    if (!page.path.startsWith('/') || !LOCAL_PATH_PREFIXES.some(prefix => page.path.startsWith(prefix))) {
      throw new BrowserPaneError(
        `页 ${page.id} 的 path 必须落在 ${LOCAL_PATH_PREFIXES.join(' / ')} 之下，收到 ${page.path}`,
        'bad-page',
      )
    }
    if (this.byId.has(page.id)) {
      throw new BrowserPaneError(`页 ${page.id} 已被 ${this.byId.get(page.id)?.plugin ?? '未知插件'} 登记`, 'duplicate')
    }
    const stored: PanePage = Object.freeze({ ...page })
    this.byId.set(page.id, stored)
    return () => {
      // 只在「当前这条就是我当时登记的那条」时才删。
      // 用对象引用比较而不是 id 比较：撤销函数可能被延迟调用，
      // 那时同一个 id 也许已经被另一个插件重新登记了，按 id 删会误删别人的。
      if (this.byId.get(stored.id) === stored) this.byId.delete(stored.id)
    }
  }

  /** 当前页清单（登记顺序）。 */
  pages(): readonly PanePage[] {
    return [...this.byId.values()]
  }

  /**
   * 追加一次打开请求。
   * @param pageId 页 id。
   * @returns 请求记录。
   * @throws BrowserPaneError 页未登记。
   */
  open(pageId: string): PaneOpen {
    const page = this.byId.get(pageId)
    if (page === undefined) {
      throw new BrowserPaneError(`没有名为 ${pageId} 的页，先 registerPage 再来 open`, 'unknown-page')
    }
    const record: PaneOpen = Object.freeze({ page: page.id, title: page.title, at: Date.now() })
    this.pending = record
    return record
  }

  /** 取走待处理请求（取走即清空）。 */
  consume(): PaneOpen | undefined {
    const record = this.pending
    this.pending = undefined
    return record
  }

  /** 只看不取（诊断用）。 */
  peek(): PaneOpen | undefined {
    return this.pending
  }

  /**
   * 判定一个地址是否允许在本面板内加载或跳转。
   *
   * 规则三条，按序判定：
   *
   * 1. 协议只认 `http` / `https`。`file:` / `data:` / `javascript:` 一律拒——
   *    前两个能读本机文件，第三个能执行脚本，都不该出现在一个展示第三方注册页的容器里。
   * 2. 本机地址（`127.0.0.1` / `localhost`）必须**同端口**且落在 `/pane/` 或 `/beichen/` 下。
   *    只看主机名不看端口的话，本机任何一个别的服务都能被这个面板打开。
   * 3. 远程地址只认白名单域名（含子域），且必须是 https。
   *
   * @param url 待判地址。
   * @param hostPort 宿主端口；未知时本机地址一律拒绝（宁可不给，不给错）。
   * @returns 判定结果。
   */
  allow(url: string, hostPort: number | undefined): AllowResult {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { allowed: false, reason: 'scheme' }
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: 'scheme' }
    }

    const hostname = parsed.hostname.toLowerCase()

    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
      if (hostPort === undefined) return { allowed: false, reason: 'host' }
      if (parsed.port !== String(hostPort)) return { allowed: false, reason: 'host' }
      if (!LOCAL_PATH_PREFIXES.some(prefix => parsed.pathname.startsWith(prefix))) {
        return { allowed: false, reason: 'path' }
      }
      return { allowed: true, kind: 'local' }
    }

    if (parsed.protocol !== 'https:') return { allowed: false, reason: 'scheme' }

    const hit = this.domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
    return hit ? { allowed: true, kind: 'external' } : { allowed: false, reason: 'host' }
  }
}
