import 'dart:async';
import 'dart:ui' show PlatformDispatcher;

import 'package:material_ui/material_ui.dart';

import 'app/crash_log.dart';
import 'app/home_dir.dart';
import 'app/ondra_app.dart';
import 'app/runtime_seed.dart';
import 'app/window_geometry.dart';
import 'design/font_face.dart';
import 'plugins/ondra-core/ondra-ui/ondra-settings/ondra-persona/ui/persona_client.dart';
import 'plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_client.dart';
import 'plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport.dart';
import 'plugins/ondra-core/ondra-ui/ondra-plugins/ui/plugins_client.dart';
import 'plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_engine.dart';
import 'plugins/ondra-core/ondra-ui/ondra-settings/ui/settings_client.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // 全局错误捕获。没有这两个钩子，「崩溃上报」这个开关无论怎么设都不会
  // 有任何东西被上报——它连触发点都没有。
  //
  // 这里**不联网**：只写本地日志（`~/.ondra/logs/crash.log`）并弹一条通知。
  // 报给谁、报什么、走不走网，是「隐私与安全」里的开关决定的；
  // 而那个开关默认是关的。本地留一份堆栈是底线——用户来问「为什么闪退」时，
  // 没有这份东西就只能猜。
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    _logCrash('FlutterError', details.exception, details.stack);
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    _logCrash('PlatformDispatcher', error, stack);
    return true; // 已处理：不要让它在控制台再抛一次
  };

  // 字体要在 runApp 之前装：字体族一旦被首帧用过，中途注册会让已排好版的
  // 文字按旧字体测量、按新字体绘制，出现一次跳变。装不上就降级到系统字体。
  // 安卓的持久数据目录要在任何数据落盘之前定好（prefs / 密钥 / 模型清单
  // 都以 ondraUserHome 为根）。桌面平台是空操作。
  await initAndroidHome();
  await OndraFont.load();
  // 桌面端在这里把窗口定成 960×600；web 上是空实现。
  await applyWindowGeometry();

  // 偏好在首帧之前读回来：字号与语言一旦晚一步，界面会先按默认值排一次版
  // 再重排，肉眼能看见一次抖。文件只有几百字节，同步读不会拖慢启动。
  settingsClient.load();

  // 运行时（Cordis 宿主）接通前，先把内置人设包读进来，首帧就有名字。
  // 接上运行时后这一行换成 personaClient.connect()，界面不用动。
  await personaClient.load();
  // 插件清单读的是 `~/.ondra/dsh/profiles/ondra`，所以种子必须在它之前铺。
  // 装在包里的是**首次运行的种子**：目录已存在就原样不动，用户自己更新过的
  // 插件不会被包里的旧快照盖掉（见 lib/app/runtime_seed.dart）。
  seedRuntimeProfile();
  await pluginsClient.load();

  // 模型基座先读回上一次的提供商与默认模型，再建传输层——
  // 顺序反了的话，传输层会拿着出厂默认选路，读完配置又得重连一次。
  modelClient.load();

  // 右栏接内核：桌面端起 `dsh --profile ondra` 子进程；Web 端如实报错。
  // connect 失败不算启动失败——应用照常起，右栏会显示具体原因。
  // 桌面端这个构造不是 const（要持有进程与订阅），Web 端的空实现才是；
  // 条件导出让两边同名，所以这里不能用 const。
  final runtimeBinding = ModelRuntimeBinding(
    models: modelClient,
    chat: chatClient,
  );
  // 首帧不等内核：连接慢或失败都不该让窗口空着。
  await runtimeBinding.start().timeout(
    const Duration(seconds: 8),
    onTimeout: () {},
  );

  runApp(const OndraApp());

  // 自动备份在首帧之后才开始：开机第一秒不该和首帧抢磁盘。
  // 它只在应用活着的时候工作——空谷不常驻后台，见 `BackupScheduler` 的注释。
  backupScheduler.start();
}

/// 模型配置/密钥的变更统一串行应用。保存时不杀正在生成的聊天：
/// pending 状态立即可见，队列清空后重连；UI 也可调用 applyPendingRuntime。
class ModelRuntimeBinding {
  ModelRuntimeBinding({
    required this.models,
    required this.chat,
    this._createTransport,
  });


  final ModelClient models;
  final ChatClient chat;
  final StdioDshTransport Function(Future<void>?)? _createTransport;
  StdioDshTransport? _transport;
  String? _lastAttempt;
  bool _applying = false;
  bool _disposed = false;

  Future<void> start() {
    models.addListener(_changed);
    chat.addListener(_changed);
    models.runtimeReconnect = reconnect;
    return reconnect();
  }

  void _changed() {
    if (_disposed || _applying || _lastAttempt == models.runtimeFingerprint) {
      return;
    }
    models.reportRuntimeState(pending: true, applying: false);
    // 不在 ChatClient 的 onDone 通知栈里切 transport；排队的下一轮优先完成。
    scheduleMicrotask(() {
      if (!_disposed &&
          !_applying &&
          !chat.busy &&
          chat.queued.isEmpty &&
          _lastAttempt != models.runtimeFingerprint) {
        unawaited(reconnect());
      }
    });
  }

  Future<void> reconnect() async {
    if (_disposed || _applying) return;
    if (chat.busy || chat.queued.isNotEmpty) {
      _lastAttempt = null; // 显式重连（包括外部钥匙串更新）也可排到空闲后。
      models.reportRuntimeState(pending: true, applying: false);
      return;
    }
    _applying = true;
    _lastAttempt = models.runtimeFingerprint;
    models.reportRuntimeState(pending: true, applying: true);
    try {
      final previousClosed = _transport?.close();
      final next =
          _createTransport?.call(previousClosed) ??
          StdioDshTransport(
            modelConfig: models.currentRuntimeConfig,
            secretResolver: models.readProviderSecret,
            previousClosed: previousClosed,
            resumeSessionId: _transport?.sessionId,
          );
      _transport = next;
      // 先同步换到带 barrier 的传输，重连期间新发送也只能等旧进程退出。
      chat.useTransport(next);
      await chat.connect();
      models.reportRuntimeState(
        pending: !chat.connected || _lastAttempt != models.runtimeFingerprint,
        applying: false,
        error: chat.offlineReason,
      );
    } catch (error) {
      models.reportRuntimeState(
        pending: true,
        applying: false,
        error: '$error',
      );
    } finally {
      _applying = false;
      _changed();
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    models.removeListener(_changed);
    chat.removeListener(_changed);
    models.runtimeReconnect = null;
    await _transport?.close();
  }
}

/// 记一次崩溃。
///
/// 只写本地（`~/.ondra/crash/`），没有「往外发」的开关——接收端还不存在，
/// 留一个永远发不出去的开关等于让用户以为有人在看。用户来问「为什么闪退」
/// 时，把这份堆栈发出来就够了。
void _logCrash(String scope, Object error, StackTrace? stack) {
  CrashLog.write(scope, error, stack);
}
