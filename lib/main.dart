import 'dart:async';
import 'dart:ui' show PlatformDispatcher;

import 'package:material_ui/material_ui.dart';

import 'app/crash_log.dart';
import 'app/background_startup.dart';
import 'app/data_maintenance.dart';
import 'app/bundled_runtime.dart';
import 'app/home_dir.dart';
import 'app/model_warmup.dart';
import 'app/ondra_app.dart';
import 'app/runtime_seed.dart';
import 'app/window_geometry.dart';
import 'design/font_face.dart';
import 'plugins/ondra-core/ondra-ui/ondra-settings/ondra-persona/ui/persona_client.dart';
import 'plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_client.dart';
import 'plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_types.dart';
import 'plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/runtime_model_config.dart';
import 'plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/remote_transport.dart';
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
  // 构建期异常的可视化：release 下 Flutter 默认把异常 widget 画成一块
  // 灰板——用户看到的仍是「白屏/灰屏」，没有任何线索。换成一张可读的
  // 错误卡（本地日志照样写），崩溃至少会自己说话。
  ErrorWidget.builder = (details) {
    FlutterError.presentError(details);
    _logCrash('ErrorWidget', details.exception, details.stack);
    return ColoredBox(
      color: const Color(0xFFFFF3F3),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: SingleChildScrollView(
          child: Text(
            '界面这一块没能画出来，已记录到本地日志。\n'
            '${details.exception}',
            style: const TextStyle(fontSize: 12, height: 1.4),
          ),
        ),
      ),
    );
  };
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    _logCrash('FlutterError', details.exception, details.stack);
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    _logCrash('PlatformDispatcher', error, stack);
    return true; // 已处理：不要让它在控制台再抛一次
  };

  // 只做「首帧必须已经知道」的事。开屏卡死的根因就在这一段：内核连接、
  // 插件扫描和首次解压曾经全部排在 `runApp()` 前面，而 Windows runner
  // 要等第一帧才显示窗口，用户因此只能看到一块不动的启动层。
  //
  // 字体要在首帧前装：字体族一旦被首帧用过，中途注册会让已排好版的文字
  // 按旧字体测量、按新字体绘制，出现一次跳变。装不上就降级到系统字体。
  // 安卓持久数据目录要在任何数据落盘之前定好（prefs / 密钥 / 模型清单都
  // 以 ondraUserHome 为根）。桌面平台是空操作。
  await initAndroidHome();
  await OndraFont.load();
  // 桌面端在这里把窗口定成 960×600；web 上是空实现。
  await applyWindowGeometry();

  // 偏好在首帧之前读回来：字号与语言一旦晚一步，界面会先按默认值排一次版
  // 再重排，肉眼能看见一次抖。文件只有几百字节，同步读不会拖慢启动。
  settingsClient.load();

  // 模型基座先读回上一次的提供商与默认模型，再建传输层——
  // 顺序反了的话，传输层会拿着出厂默认选路，读完配置又得重连一次。
  modelClient.load();

  // 数据维护（备份恢复/清空/迁移）需要先停内核再动用户数据——把聊天
  // 客户端的停机协调接进 DataMaintenance。alpha.10 Windows 审查第 2 项：
  // 未注册时这些入口全部被「未接入内核停机协调」拦下。
  dataMaintenance
    ..pause = chatClient.pauseKernel
    ..closeTransport = chatClient.closeTransport
    ..resume = chatClient.resumeKernel
    ..reload = () async => pluginsClient.load();

  runApp(const OndraApp());

  // 首帧已经交出去了，下面这些才可以慢。`initAndroidRuntimeAssets` 在
  // 安卓首启要解压内核闭包；`seedRuntimeProfile` 要铺插件树；内核连接
  // 最长等 8 秒。任何一个都可能是数秒级，绝不能挡在首帧前面。
  final startup = BackgroundStartup(
    onError: (name, error, stack) => _logCrash('main/init:$name', error, stack),
    steps: [
      const StartupStep('initAndroidRuntimeAssets', initAndroidRuntimeAssets),
      StartupStep('personaClient.load', personaClient.load),
      // 插件清单读的是 `~/.ondra/dsh/profiles/ondra`，所以种子必须先铺。
      // 装在包里的是首次运行的种子：目录已存在就原样不动，用户自己更新过
      // 的插件不会被包里的旧快照盖掉（见 lib/app/runtime_seed.dart）。
      StartupStep('seedRuntimeProfile', () async => seedRuntimeProfile()),
      StartupStep('pluginsClient.load', pluginsClient.load),
      StartupStep('runtimeBinding.start', () {
        final runtimeBinding = ModelRuntimeBinding(
          models: modelClient,
          chat: chatClient,
          warmup: modelWarmup,
        );
        return runtimeBinding.start().timeout(
          const Duration(seconds: 8),
          onTimeout: () {},
        );
      }),
    ],
  );
  // 不 await：主壳已经可以绘制，内核稍后接通或如实显示失败原因。
  unawaited(startup.startAfterFirstFrame());

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
    this.warmup,
    this._createTransport,
  });

  final ModelClient models;
  final ChatClient chat;
  final ModelWarmupController? warmup;
  final DshTransport Function(Future<void>?)? _createTransport;
  DshTransport? _transport;
  DshTransportRoute? _lastRoute;
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
    // 这一轮连线之前写进装配层的配置，就是这个新内核会读到的配置。
    // 记下快照，连上之后交给 markKernelApplied —— 否则设置页上那句
    // 「有配置待内核重载」永远不会消：写入时标了 restartRequired，而
    // 消解这个标记的唯一入口（markKernelApplied）在 lib/ 里没有调用点，
    // 只有测试在调。用户每改一次设置就积一条，永久挂着。
    final bootConfiguration = settingsClient.captureKernelConfiguration();
    try {
      final previousClosed = _transport?.close();
      final configuration = models.currentRuntimeConfig();
      final previous = _transport;
      final route = models.transportRoute;
      // 换路线是一个显式动作：旧会话属于另一条事件流，不能带过去。
      final routeChanged = _lastRoute != null && _lastRoute != route;
      _lastRoute = route;
      String? resumeSessionId;
      if (!routeChanged && previous is ResumableDshTransport) {
        resumeSessionId = (previous as ResumableDshTransport).sessionId;
      }
      final DshTransport next =
          _createTransport?.call(previousClosed) ??
          (route == DshTransportRoute.remote
              ? RemoteDshTransport(
                  baseUrl: models.remoteBaseUrl,
                  launchToken: models.remoteLaunchToken,
                  provider: configuration.providerId,
                  model: configuration.modelId,
                  workingDirectory: ondraUserHome,
                  // R3 的 session/create 只能复用“空白”会话；普通历史会话
                  // 不能靠 sessionId 原地重开，否则会把旧历史变成新会话。
                  resumeSessionId: null,
                )
              : StdioDshTransport(
                  modelConfig: () => configuration,
                  secretResolver: models.readProviderSecret,
                  previousClosed: previousClosed,
                  resumeSessionId: resumeSessionId,
                ));
      _transport = next;
      // R1↔R3 切换时清空本地缓存，避免两条事件流叠加造成消息重复/消失。
      if (routeChanged) chat.clear();
      // 先同步换到带 barrier 的传输，重连期间新发送也只能等旧进程退出。
      chat.useTransport(next);
      _startWarmup(configuration);
      await chat.connect();
      // 连上了才算内核真的读了那份配置；没连上就保留待重载标记。
      if (chat.connected) settingsClient.markKernelApplied(bootConfiguration);
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

  void _startWarmup(RuntimeModelConfig configuration) {
    final controller = warmup;
    if (controller == null ||
        !configuration.isLoopback ||
        // 本机网关只是把多家模型合成一个路由，预热网关自身的目录
        // 没有意义；真正跑在本机推理服务上的 provider 才需要预热。
        configuration.providerCategory == ProviderCategory.gateway) {
      return;
    }
    final profile = configuration.profile;
    final baseUrl = '${profile['baseURL'] ?? ''}'.trim();
    if ('${profile['api'] ?? ''}' != 'openai-completions' || baseUrl.isEmpty) {
      return;
    }
    // 预热是首帧后的后台工作。这里必须不 await：本地模型冷启动约 30s，
    // 等它会把设置页和后续启动步骤重新拖成“界面在但没反应”。
    unawaited(
      controller.start(
        ModelWarmupRequest(baseUrl: baseUrl, model: configuration.modelId),
      ),
    );
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
