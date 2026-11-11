//! 内置简易浏览器（只用于展示固定网页）。
//!
//! # 为什么要有它
//!
//! 应用里有几处必须把用户带到外部内容：官网、仓库、更新日志、许可与致谢。
//! 交给系统浏览器（`open_url`）能用，但有三个问题：
//!
//! 1. **跳出应用**——用户正在会话里，点一下"查看更新"就再也回不到原处，
//!    除非自己切回来；小窗陪伴类应用的注意力本来就是被切走的。
//! 2. **不可控**——系统浏览器可能是任何东西，也可能根本没配置。
//! 3. **不可信**——从桌面应用里突然弹出一个浏览器窗口，是钓鱼的经典形态。
//!
//! 所以这里做一个**只认白名单**的内置窗口：标题栏是我们的、地址不可编辑、
//! 站外链接一律转交系统浏览器。
//!
//! # 为什么是独立窗口而不是主窗口里的一块
//!
//! Tauri 的 WebView 只能嵌进原生窗口，没有"页面里的 iframe"这条路
//! （CSP 与 `X-Frame-Options` 都会拦）。要在主窗口里显示网页，只剩下
//! `add_child` 这条不稳定 API，代价是自绘标题栏、自己处理层级与缩放——
//! 为几个静态页面值得吗？不值得。独立窗口在这里反而是**正确**的形态：
//! 它有自己的最小化与关闭，用户不需要时可以放到一边。
//!
//! # 为什么用系统装饰
//!
//! 主窗口隐藏系统红绿灯是因为要换成自绘的一整套（§2.4）。这里没有
//! 自绘的必要：它就是一个浏览网页的窗口，系统那三个按钮最自然，
//! 也不会和主窗口的自绘逻辑打架——`hide_system_traffic_lights` 已按窗口收窄。

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

/// 浏览器窗口的 label。
pub const LABEL: &str = "browser";

/// 允许在这个窗口里直接打开的站点。
///
/// # 为什么是一份白名单而不是"任意 URL"
///
/// 这个窗口的用途是"展示我们自己的固定页面"。允许任意地址就等于给应用
/// 内置了一个通用浏览器：用户可以拿它登录任何账号，而窗口的标题栏写着
/// 「空谷 Ondra」——那是把我们的品牌借给别人的网页。白名单把这件事锁死。
///
/// 站外链接不是打不开，而是**转交系统浏览器**（见 `on_navigation`）：
/// 用户想去哪儿都能去，只是那时他清楚地知道自己在系统浏览器里。
const ALLOWED_HOSTS: &[&str] = &[
    "ai.ntars.cn",
    "github.com",
    "docs.github.com",
    "raw.githubusercontent.com",
];

/// 判断一个地址是否允许在窗口内打开。
fn allowed(url: &tauri::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    match url.host_str() {
        Some(host) => ALLOWED_HOSTS.iter().any(|item| host == *item),
        None => false,
    }
}

/// 注入到网页里的工具栏脚本（U7）。
///
/// 内置浏览器用的是系统 WebView，没有原生地址栏与导航控件。这里在页面加载
/// 完成后注入一段脚本，自行绘制一个固定顶栏：显示当前地址，并提供
/// 后退 / 前进 / 刷新 / 停止。
///
/// 三个细节：
/// - `PageLoad` 触发时 `document.body` 可能还不存在，所以带重试；
/// - 顶栏是 `fixed` 定位，会给页面顶部让出等高留白，避免遮住网页自己的导航；
/// - 单页应用改地址不发 `popstate`，因此同时挂 `pushState`/`replaceState` 钩子。
///
/// 用 `history.back/forward` 走 WebView 自身的历史栈，`window.stop` 中断加载，
/// 比壳层去调并不稳定的历史 API 更可靠。
pub const TOOLBAR_JS: &str = r#"
(function () {
  var BAR_ID = 'ondra-browser-bar';
  var HEIGHT = 36;
  if (document.getElementById(BAR_ID)) return;

  function install() {
    if (document.getElementById(BAR_ID)) return;
    if (!document.body) { setTimeout(install, 60); return; }

    var bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:' + HEIGHT + 'px;z-index:2147483647;' +
      'background:rgba(22,22,26,0.94);color:#e8e8ea;display:flex;align-items:center;gap:6px;padding:0 10px;' +
      'font:12px/1 -apple-system,BlinkMacSystemFont,sans-serif;border-bottom:1px solid rgba(255,255,255,0.1);' +
      'backdrop-filter:blur(8px)';

    function mk(label, title, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.cssText = 'background:transparent;border:0;color:#e8e8ea;cursor:pointer;font-size:15px;' +
        'line-height:1;padding:5px 7px;border-radius:5px';
      b.onmouseenter = function () { b.style.background = 'rgba(255,255,255,0.12)'; };
      b.onmouseleave = function () { b.style.background = 'transparent'; };
      b.onclick = fn;
      return b;
    }

    var url = document.createElement('span');
    url.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.85';

    function upd() {
      if (!url.isConnected) return;
      url.textContent = location.href;
    }

    bar.appendChild(mk('\u2190', '后退', function () { history.back(); }));
    bar.appendChild(mk('\u2192', '前进', function () { history.forward(); }));
    bar.appendChild(mk('\u27f3', '刷新', function () { location.reload(); }));
    bar.appendChild(mk('\u2715', '停止加载', function () { window.stop(); }));
    bar.appendChild(url);
    document.body.appendChild(bar);

    // 给网页自身内容让出顶栏高度，否则会被盖住。
    var html = document.documentElement;
    var current = parseFloat(getComputedStyle(html).paddingTop) || 0;
    html.style.paddingTop = (current + HEIGHT) + 'px';

    upd();
    window.addEventListener('popstate', upd);
    window.addEventListener('hashchange', upd);
    document.addEventListener('click', function () { setTimeout(upd, 120); }, true);

    // 单页应用的前端路由不触发 popstate，这里包一层历史 API。
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name];
      if (typeof original !== 'function' || original.__ondraWrapped) return;
      var wrapped = function () {
        var out = original.apply(this, arguments);
        setTimeout(upd, 60);
        return out;
      };
      wrapped.__ondraWrapped = true;
      history[name] = wrapped;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
"#;

/// 打开（或唤出）内置浏览器。
///
/// 已存在时**导航到新地址**而不是忽略：用户点了另一个链接，窗口却停在
/// 上一页，会让人以为点击没生效。
pub fn open<R: Runtime>(app: &AppHandle<R>, raw: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(raw).map_err(|error| format!("地址格式不对：{error}"))?;
    if !allowed(&parsed) {
        return Err(format!("这个地址不在内置浏览器的白名单里：{}", parsed.host_str().unwrap_or(raw)));
    }

    if let Some(window) = app.get_webview_window(LABEL) {
        window.navigate(parsed).map_err(|error| format!("导航失败：{error}"))?;
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    // 克隆一份句柄给导航回调：拦截站外地址时发一条通知，让用户明确知道
    // "这个地址离开内置浏览器、改由系统浏览器打开"，而不是毫无提示地跳走。
    let app_handle = app.clone();

    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(parsed.clone()))
        .title("空谷 Ondra · 浏览")
        .inner_size(980.0, 700.0)
        .min_inner_size(640.0, 480.0)
        /*
         * 每次页面加载完成都重新注入工具栏。
         *
         * 整页导航会清空上一页的 DOM，顶栏随之消失；而这个回调注册在
         * WebView 上、不是一次性钩子，后续每次导航（包括对已有窗口
         * `navigate`）都会再次触发，因此不需要在 `open` 里额外补注入。
         */
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = window.eval(TOOLBAR_JS);
            }
        })
        /*
         * 站外链接：先发通知说明去向，再转交系统浏览器并取消本次导航。
         *
         * 返回 `false` 会拦住导航，所以必须在拦之前把地址交出去——
         * 顺序反了就是"点了没反应"。通知用壳已初始化的通知插件发送，
         * 不需要额外的系统弹窗权限。
         */
        .on_navigation(move |next| {
            if allowed(next) {
                return true;
            }
            let _ = app_handle
                .notification()
                .builder()
                .title("已在系统浏览器中打开")
                .body(format!("该地址不在内置浏览器白名单内：{next}"))
                .show();
            let _ = tauri_plugin_opener::open_url(next.as_str(), None::<&str>);
            false
        })
        .build()
        .map(|_| ())
        .map_err(|error| format!("打开浏览器窗口失败：{error}"))
}
