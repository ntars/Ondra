/**
 * 打开外部链接。
 *
 * ## 为什么走内置浏览器而不是系统浏览器
 *
 * 应用里的外部链接只有几处：官网、仓库、更新日志、许可与致谢。交给系统
 * 浏览器能用，但用户点一下"查看更新"就离开了这个应用——小窗陪伴类产品的
 * 注意力本来就是被切走的。内置窗口只认白名单，站外链接由壳转交系统浏览器。
 *
 * ## 为什么不在浏览器开发态报错
 *
 * `pnpm dev:web` 下没有桌面壳，`open_browser` 不存在。那时退回
 * `window.open` 就够了：开发者要的只是"这个地址能打开"，不是"用哪个窗口"。
 */

import { invokeShell, isDesktopShell } from './shell.ts'

/**
 * 在应用内打开一个地址。
 *
 * @throws 地址不在白名单内、或壳拒绝建窗时抛出可读原因。调用方负责显示它——
 *   静默失败会让用户以为点击没生效。
 */
export async function openLink(url: string): Promise<void> {
  if (!isDesktopShell()) {
    globalThis.open(url, '_blank', 'noopener')
    return
  }
  await invokeShell<null>('open_browser', { url })
}
