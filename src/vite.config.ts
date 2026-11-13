import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 读 package.json 里的版本号，注入成一个编译期常量。
 *
 * 为什么不直接在界面里手写字符串：版本号已经在三处出现
 * （package.json、tauri.conf.json、安装包文件名），再多一处手写就一定会
 * 出现"界面显示 2.0.1、包里其实是 2.0.2"这种情况。这里从单一来源读，
 * 构建期替换成字面量，运行时没有额外开销。
 */
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

/**
 * 把仓库根的 `icon.svg` 送成页面图标。
 *
 * ## 为什么需要一个插件
 *
 * `index.html` 在 `src/` 下，图标在仓库根——两者不在同一个 root 里，
 * 没法用普通的 `<link href="../icon.svg">`：vite 会把 root 外的引用
 * 当成错误，就算侥幸解析成功，产物里也没有那个文件。
 *
 * 而**复制一份到 `src/` 是另一个坑**：那会造出第二个真源，下次有人改
 * 了 `icon.svg`，`src/` 里那份不会跟着变（`gen-brand.mjs` 校验的是
 * `src/brand/mark.ts`，管不到它）。所以这里在构建期读根目录那一份，
 * 直接 emit 进产物。
 *
 * ## 为什么连开发态也要挂
 *
 * 不挂的话，`index.html` 里声明了 `./icon.svg` 而开发服务器没有这个路由，
 * 浏览器控制台每次都会多一条 404。混在真正的错误里，久了就没人看控制台了。
 */
function faviconFromBrand(): Plugin {
  /** 缓存读过的内容：一次构建里可能被 build 与 serve 各读一次。 */
  let cached: Buffer | null = null
  const read = (): Buffer => {
    cached ??= readFileSync(new URL('../icon.svg', import.meta.url))
    return cached
  }

  return {
    name: 'ondra-favicon',
    transformIndexHtml() {
      return [{
        tag: 'link',
        attrs: { rel: 'icon', type: 'image/svg+xml', href: './icon.svg' },
        // 放在 head 最前：图标早一步开始加载，标签页不会先空一下。
        injectTo: 'head-prepend',
      }]
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'icon.svg', source: read() })
    },
    configureServer(server) {
      server.middlewares.use('/icon.svg', (_request, response) => {
        response.setHeader('content-type', 'image/svg+xml')
        response.end(read())
      })
    },
  }
}

/**
 * 前端构建配置。
 *
 * `base: './'` 是必需的：Tauri 在生产态用 `tauri://localhost` 加载本地文件，
 * 绝对路径 `/assets/...` 会被解析到协议根而找不到资源。相对路径在两种
 * 加载方式（开发态 HTTP、生产态自定义协议）下都成立。
 */
/**
 * 是否构建手机端（本地模式）。
 *
 * ## 为什么是一个环境变量而不是自动探测
 *
 * 第一版靠「检测不到 Tauri 内部对象」推断，结果把桌面端测试打挂了：
 * 测试注入的是一个假壳，它不设那个对象，于是被判成本地模式，测试数据
 * 一条都没被读到。
 *
 * 「检测不到 A」不等于「应该走 B」——测试、预览、桌面都可能检测不到 A，
 * 但只有手机该走 B。所以改成显式：`ONDRA_LOCAL=1 pnpm build:web` 才开。
 */
const localMode = process.env.ONDRA_LOCAL === '1'

export default defineConfig({
  plugins: [react(), faviconFromBrand()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(`v${version}`),
    /*
     * 注入成**字面量**而不是运行时查环境：`define` 在构建期做文本替换，
     * 产物里是 `true` / `false`，运行时没有分支判断开销，也不会因为
     * 用户改了什么全局变量而失效。
     */
    __ONDRA_LOCAL_MODE__: JSON.stringify(localMode),
  },
  // Vite 默认在 root 下找 index.html。前端工程的 root 就是 src/，
  // 因此把 index.html 也算作 src 内的入口文件。
  root: import.meta.dirname,
  // 产物输出到仓库根的 dist/，与 tauri.conf.json 的 frontendDist 一致。
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // 不生成 sourcemap：安装包里带源码映射既增大体积，
    // 也把实现细节暴露给最终用户。
    sourcemap: false,
    target: 'safari15',
  },
  server: {
    port: 5173,
    // 端口被占用时直接失败，而不是自动换端口：Tauri 的 devUrl 写死了 5173，
    // 换了端口会导致壳加载到一个不存在的地址，表现为白屏。
    strictPort: true,
  },
})
