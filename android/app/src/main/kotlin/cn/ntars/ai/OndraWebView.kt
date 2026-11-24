package cn.ntars.ai

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

/**
 * 安卓内嵌浏览器：与 macOS 的 WKWebView 实现同一套协议。
 *
 * - 视图类型 `ondra/webview`，creationParams：{url, allowedSites}
 * - 每视图通道 `ondra/webview/<id>`：原生 → Dart 发 `navigationRejected` /
 *   `loadFailed`（{reason}）；Dart → 原生调 `start` / `stop`
 * - 白名单是**严格 origin 相等**（scheme + host + port，默认端口归一化），
 *   与 macOS 的 OndraBrowserOrigin 对齐；HTTPS → HTTP 降级拒绝
 */
class OndraWebViewFactory(private val messenger: BinaryMessenger) :
    PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    override fun create(context: Context, viewId: Int, args: Any?): PlatformView {
        return OndraWebPlatformView(context, viewId, args, messenger)
    }
}

/** 白名单 origin：与 Dart / macOS 的校验规则保持同源，不靠 Uri 的宽松归一化。 */
internal data class BrowserOrigin(val scheme: String, val host: String, val port: Int) {
    companion object {
        fun parse(text: String?): BrowserOrigin? {
            if (text == null || text.isBlank()) return null
            if (text.any { it.isWhitespace() || it == '\\' || it.isISOControl() }) return null
            // Uri 会解码 %xx 后再给 host；必须在原始 authority 上拒绝编码，
            // 否则 https://%65xample.com 会变成合法白名单条目。
            val authority = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]*)")
                .find(text)?.groupValues?.get(1) ?: return null
            if (authority.contains('@') || authority.contains('%')) return null
            val uri = try {
                Uri.parse(text)
            } catch (_: Exception) {
                return null
            }
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            // 不接受带凭据的 URL（user:pass@host）。
            if (!uri.userInfo.isNullOrEmpty()) return null
            val host = uri.host?.lowercase() ?: return null
            if (host.isEmpty()) return null
            if (!host.matches(Regex("^\\[[0-9a-f:]+\\]$"))) {
                if (host.length > 253) return null
                val labels = host.split(Regex("\\."))
                if (!labels.all {
                    it.matches(Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"))
                }) return null
                // 不给模糊数字 IP 留空间：0177.0.0.1 / 127.1 都不能过。
                if (host.matches(Regex("^[0-9.]+$"))) {
                    if (labels.size != 4 || !labels.all {
                        (it.length == 1 || !it.startsWith('0')) &&
                            (it.toIntOrNull() ?: 256) <= 255
                    }) return null
                }
            }
            val port = if (uri.port == -1) (if (scheme == "https") 443 else 80) else uri.port
            if (port !in 1..65535) return null
            return BrowserOrigin(scheme, host, port)
        }
    }
}

private class OndraWebPlatformView(
    context: Context,
    viewId: Int,
    args: Any?,
    messenger: BinaryMessenger,
) : PlatformView {
    private val channel = MethodChannel(messenger, "ondra/webview/$viewId")
    private val webView: WebView
    private val allowedOrigins: List<BrowserOrigin>
    private val initialUrl: Uri?
    private var started = false
    private var stopped = false
    private var requiresHTTPS: Boolean

    init {
        val dict = args as? Map<*, *>
        val sites = dict?.get("allowedSites") as? List<*> ?: emptyList<Any>()
        allowedOrigins = sites.mapNotNull { BrowserOrigin.parse(it as? String) }
        initialUrl = (dict?.get("url") as? String)?.let { Uri.parse(it) }
        requiresHTTPS = initialUrl?.scheme?.lowercase() == "https"

        @SuppressLint("SetJavaScriptEnabled")
        webView = WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    // 子资源与主框架全部走白名单；拒绝时不加载并回传原因。
                    val url = request.url
                    if (!stopped && permit(url)) return false
                    reject("已阻止导航：目标的协议、主机或端口不在白名单里。")
                    return true
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    // 与 macOS 的导航回调一致：加载过 HTTPS 后，本视图后续
                    // 不再允许任何 HTTP 导航，包括重定向与页面内跳转。
                    if (BrowserOrigin.parse(url)?.scheme == "https") {
                        requiresHTTPS = true
                    }
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError,
                ) {
                    if (request.isForMainFrame) {
                        channel.invokeMethod(
                            "loadFailed",
                            mapOf("reason" to "页面加载失败：${error.description ?: "未知错误"}"),
                        )
                    }
                }
            }
        }
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    if (!started && !stopped) {
                        started = true
                        if (permit(initialUrl)) {
                            webView.loadUrl(initialUrl.toString())
                        }
                    }
                    result.success(null)
                }
                "stop" -> {
                    stopped = true
                    webView.stopLoading()
                    result.success(null)
                }
                else -> result.success(null)
            }
        }
    }

    /** 不回传完整 URL，避免把 URL 里的潜在凭据显示到错误栏。 */
    private fun reject(reason: String) {
        channel.invokeMethod("navigationRejected", mapOf("reason" to reason))
    }

    private fun permit(url: Uri?): Boolean {
        if (stopped) return false
        val origin = BrowserOrigin.parse(url?.toString() ?: "")
        if (origin == null) {
            reject("已阻止导航：只允许合法且不含凭据的 http(s) 地址。")
            return false
        }
        if (origin.scheme == "http" && requiresHTTPS) {
            reject("已阻止导航：不允许从 HTTPS 降级到 HTTP。")
            return false
        }
        if (origin !in allowedOrigins) {
            reject("已阻止导航：目标的协议、主机或端口不在白名单里。")
            return false
        }
        // 导航被放行后才升级锁定；被拒绝的 HTTPS 不能反过来收紧页面。
        if (origin.scheme == "https") requiresHTTPS = true
        return true
    }

    override fun getView(): View = webView

    override fun dispose() {
        channel.setMethodCallHandler(null)
        webView.stopLoading()
        webView.destroy()
    }
}
