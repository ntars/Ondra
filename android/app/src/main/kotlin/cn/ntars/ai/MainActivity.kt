package cn.ntars.ai

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream

/**
 * 原生能力通道全集。每个通道对应 Dart 侧一个 *_io.dart 的抽象：
 *
 * - ondra/native        内核运行时位置（libnode.so 的 nativeLibraryDir）
 * - ondra/avatar        换头像：系统选图 → 居中裁方 → 缩 512 → PNG 落盘
 * - ondra/notify        系统通知（API 33+ 需要 POST_NOTIFICATIONS 运行时授权）
 * - ondra/platform      阻止空闲睡眠（FLAG_KEEP_SCREEN_ON）
 *
 * 通道名与 Dart 侧 *_io.dart 的常量一一对应，改一边必须改另一边。
 */
class MainActivity : FlutterActivity() {
    private var notificationPermissionCallback: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        // ── 内嵌浏览器（安卓系统 WebView，与 macOS WKWebView 同协议）────
        flutterEngine.platformViewsController.registry
            .registerViewFactory("ondra/webview", OndraWebViewFactory(flutterEngine.dartExecutor.binaryMessenger))

        // ── 内核运行时通道 ──────────────────────────────────────────────
        // node 二进制伪装成 libnode.so 放在 jniLibs 里，安装后被系统提取
        // 到 nativeLibraryDir——那是安卓 10+ 上唯一允许 exec 的应用位置
        // （数据目录被 W^X 禁了）。Dart 侧从这里拿启动路径。
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "ondra/native",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "nativeLibraryDir" -> result.success(applicationInfo.nativeLibraryDir)
                else -> result.notImplemented()
            }
        }

        // ── 头像通道 ────────────────────────────────────────────────────
        // Dart 侧只读 `~/.ondra/avatar.png`；写入（裁切/缩放/编码）由原生
        // 侧完成，与 macOS 壳的 NSOpenPanel 流程同一协议。
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "ondra/avatar",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "pick" -> pickAvatarImage(result)
                else -> result.notImplemented()
            }
        }

        // ── 系统通知通道 ────────────────────────────────────────────────
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "ondra/notify",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "show" -> showNotification(call.arguments, result)
                "supported" -> result.success(true)
                else -> result.notImplemented()
            }
        }

        // ── 阻止睡眠通道 ────────────────────────────────────────────────
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "ondra/platform",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                // FLAG_KEEP_SCREEN_ON 只在窗口可见时生效，不需要权限，
                // 也从不失效——离开前台系统自动恢复正常睡眠策略。
                "beginPreventSleep" -> {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    result.success(true)
                }
                "endPreventSleep" -> {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
    }

    // ── 头像：选图 → 裁方 → 缩 512 → PNG ────────────────────────────────

    private fun pickAvatarImage(result: MethodChannel.Result) {
        // 保存回调，onActivityResult 里把结果送回 Dart。
        pendingAvatarResult = result
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        startActivityForResult(
            Intent.createChooser(intent, "选择头像图片"),
            REQUEST_PICK_AVATAR,
        )
    }

    private var pendingAvatarResult: MethodChannel.Result? = null

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_PICK_AVATAR) return
        val result = pendingAvatarResult
        pendingAvatarResult = null
        if (result == null) return
        if (resultCode != RESULT_OK || data?.data == null) {
            result.success(false) // 用户取消：不是失败，UI 不提示
            return
        }
        try {
            val uri = data.data!!
            val raw = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
            val bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.size)
                ?: throw IllegalStateException("图片解码失败")
            // 居中裁方。
            val side = minOf(bitmap.width, bitmap.height)
            val square = Bitmap.createBitmap(
                bitmap,
                (bitmap.width - side) / 2,
                (bitmap.height - side) / 2,
                side,
                side,
            )
            // 短边缩到 512 以内（放大不缩小的 bitmap 保持原样即可）。
            val scaled = if (side > 512) {
                Bitmap.createScaledBitmap(square, 512, 512, true)
            } else {
                square
            }
            // 与 Dart 侧 readAvatarBytes 的路径严格一致：ondraUserHome
            // 在安卓 = 应用私有 files 目录，即 filesDir/.ondra/avatar.png。
            val out = File(File(filesDir, ".ondra"), "avatar.png")
            out.parentFile?.mkdirs()
            FileOutputStream(out).use { s -> scaled.compress(Bitmap.CompressFormat.PNG, 100, s) }
            result.success(true)
        } catch (e: Exception) {
            result.error("avatar", "头像处理失败：${e.message}", null)
        }
    }

    // ── 系统通知 ────────────────────────────────────────────────────────

    private fun showNotification(args: Any?, result: MethodChannel.Result) {
        val map = args as? Map<*, *>
        val title = map?.get("title") as? String ?: ""
        val body = map?.get("body") as? String ?: ""
        val sound = map?.get("sound") as? Boolean ?: true

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "任务提醒", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        // API 33+ 需要 POST_NOTIFICATIONS 运行时授权：没授权就先请求并
        // 挂起 result，授权回调里再真正发送。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionCallback = result
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQUEST_NOTIFY_PERMISSION,
            )
            return
        }
        notifyNow(manager, title, body, sound)
        result.success(true)
    }

    private fun notifyNow(manager: NotificationManager, title: String, body: String, sound: Boolean) {
        val id = (System.currentTimeMillis() and 0x7FFFFFFF).toInt()
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setSilent(!sound)
            .setAutoCancel(true)
        manager.notify(id, builder.build())
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_NOTIFY_PERMISSION) return
        val result = notificationPermissionCallback
        notificationPermissionCallback = null
        if (result == null) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            result.error("notify", "通知权限未授予，通知不会显示", null)
            return
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notifyNow(manager, "空谷 Ondra", "通知已启用", true)
        result.success(true)
    }

    companion object {
        private const val REQUEST_PICK_AVATAR = 4001
        private const val REQUEST_NOTIFY_PERMISSION = 4002
        private const val CHANNEL_ID = "ondra_tasks"
    }
}
