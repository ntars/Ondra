/**
 * 内置浏览器面板，宿主半边。
 *
 * 纯界面插件：真正的宿主职责（页面登记、白名单、`/pane` 路由）在
 * `cordis/ondra-browser-pane`。这里留一个空 `apply` 只是为了让本包
 * 出现在宿主的 cordis 入口树里——界面代码通过 `exports["./client"]`
 * 与 `package.json` 的 `ondra.client` 声明被发现，不走这个入口。
 *
 * 为什么不在这个入口里注册任何东西：宿主的 Node 进程里没有 React，
 * 也没有 `slots` 服务。在这里写逻辑只会得到一个永不执行的空转插件。
 */

/** 宿主半边：无行为。 */
export function apply(): void {}
