/**
 * Vite 客户端的资产类型声明。
 *
 * `vite/client` 已经声明了大多数资产模块，但只覆盖它认识的扩展名，
 * 而且仓库根目录的 `icon.svg` 在 `src/` 之外——TypeScript 不会把它当成
 * 模块来解析。这里补一条声明，让 `import logoUrl from '../icon.svg'` 成立。
 *
 * 声明成 `string`：Vite 对小于 4KB 的 SVG 会内联成 data URI，
 * 对更大的会返回一个 URL 字符串。两种情况都是字符串，类型无需区分。
 */

declare module '*.svg' {
  const url: string
  export default url
}

/**
 * 构建期注入的应用版本号，形如 `v2.0.1`。
 *
 * 值由 `vite.config.ts` 的 `define` 从 package.json 读入并替换成字面量，
 * 因此运行时它就是一个普通字符串常量，不产生任何查找开销。
 */
declare const __APP_VERSION__: string
