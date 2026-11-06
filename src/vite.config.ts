import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
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
 * 前端构建配置。
 *
 * `base: './'` 是必需的：Tauri 在生产态用 `tauri://localhost` 加载本地文件，
 * 绝对路径 `/assets/...` 会被解析到协议根而找不到资源。相对路径在两种
 * 加载方式（开发态 HTTP、生产态自定义协议）下都成立。
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(`v${version}`),
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
