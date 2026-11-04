/**
 * 入口页与失效页的 HTML。
 *
 * ## 三条硬要求（对应主人的原话）
 *
 * 1. **页面上不出现任何网址文本**：没有 `<a>` 的裸链接、没有「复制链接」、
 *    没有脚注里的小字 URL。用户能看到的只有一句说明和一个按钮。
 * 2. **按钮指向本地路径**，不是北辰域名。真正带邀请码的 302 发生在服务端，
 *    页面源码里翻不到 `aff`。
 * 3. **不加载任何外部资源**：没有 CDN 字体、没有图标库、没有统计脚本。
 *    一个注册引导页没有理由向外发请求，这既是隐私也是加载速度。
 *
 * ## 视觉
 *
 * 跟随系统深浅色（`prefers-color-scheme`），单位只用 px，字体用系统中文栈，
 * 按钮 12px 圆角、48px 高——按 Apple HIG 的触控目标下限与 macOS 控件尺度取。
 */

/** 把字符串转义成可安全嵌入 HTML 文本与属性的形式。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 公共样式。
 *
 * 刻意写成一份常量而不是模板插值：两个页面必须长得像同一套东西，
 * 一旦各自拼样式，失效页迟早会和入口页分叉。
 */
const SHARED_STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #f5f5f7;
    --card: #ffffff;
    --text: #1d1d1f;
    --muted: #6e6e73;
    --line: rgba(0, 0, 0, 0.08);
    --accent: #0a84ff;
    --accent-text: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000;
      --card: #1c1c1e;
      --text: #f5f5f7;
      --muted: #a1a1a6;
      --line: rgba(255, 255, 255, 0.12);
      --accent: #0a84ff;
      --accent-text: #ffffff;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: 420px;
    padding: 32px 28px 26px;
    border-radius: 18px;
    background: var(--card);
    border: 1px solid var(--line);
    text-align: center;
  }
  .mark {
    width: 44px;
    height: 44px;
    margin: 0 auto 18px;
    border-radius: 12px;
    background: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-text);
    font-size: 20px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  h1 {
    margin: 0 0 10px;
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.2px;
  }
  p {
    margin: 0 0 8px;
    color: var(--muted);
    font-size: 14px;
  }
  .action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 48px;
    margin-top: 22px;
    border-radius: 12px;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 16px;
    font-weight: 600;
    text-decoration: none;
    transition: opacity 160ms ease;
  }
  .action:hover { opacity: 0.88; }
  .action:active { opacity: 0.72; }
  .foot {
    margin: 16px 0 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
`

/**
 * 渲染入口页。
 * @param gotoPath 按钮目标（本地路径，含令牌），**必须以 `/` 开头**。
 * @param ttlMinutes 有效期，用于底部说明。
 * @returns 完整 HTML 文档。
 */
export function renderEntryPage(gotoPath: string, ttlMinutes: number): string {
  if (!gotoPath.startsWith('/')) {
    throw new Error('入口页按钮目标必须是站内路径，不能是完整网址')
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>开通北辰 API</title>
<style>${SHARED_STYLE}</style>
</head>
<body>
  <main class="card">
    <div class="mark">北</div>
    <h1>开通北辰 API</h1>
    <p>北辰提供与 OpenAI 兼容的接口，接入后即可在本应用里直接对话。</p>
    <p>点下面的按钮，用浏览器完成注册，回来把密钥填进设置就行。</p>
    <a class="action" href="${escapeHtml(gotoPath)}" rel="noreferrer">去注册</a>
    <p class="foot">这个入口 ${ttlMinutes} 分钟内有效，过期了回应用里再点一次即可。</p>
  </main>
</body>
</html>
`
}

/**
 * 渲染失效页。
 * @param title 标题。
 * @param detail 说明文字（会转义）。
 * @returns 完整 HTML 文档。
 */
export function renderFailurePage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${SHARED_STYLE}</style>
</head>
<body>
  <main class="card">
    <div class="mark">!</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </main>
</body>
</html>
`
}
