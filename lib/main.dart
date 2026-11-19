import 'dart:async';
import 'dart:ui' show PlatformDispatcher;

import 'package:material_ui/material_ui.dart';

import 'app/crash_log.dart';
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

  // 右栏接内核：桌面端起 `dsh --profile ondra` 子进程；Web 端如实报错。
  // connect 失败不算启动失败——应用照常起，右栏会显示具体原因。
  // 桌面端这个构造不是 const（要持有进程与订阅），Web 端的空实现才是；
  // 条件导出让两边同名，所以这里不能用 const。
  chatClient.useTransport(_transportForCurrentModel());
  // 首帧不等内核：连接慢或失败都不该让窗口空着。
  await chatClient.connect().timeout(
    const Duration(seconds: 8),
    onTimeout: () {},
  );

  _followModelChoice();

  runApp(const OndraApp());

  // 自动备份在首帧之后才开始：开机第一秒不该和首帧抢磁盘。
  // 它只在应用活着的时候工作——空谷不常驻后台，见 `BackupScheduler` 的注释。
  backupScheduler.start();
}

/// 按「设置 → 模型基座」里选中的那一档建传输层。
///
/// `provider` 与 `model` 是在 initialize 时交给内核的**选路参数**：
/// 前者是路由名（`magpie`、`deepseek-official`……），后者是那家目录里的模型名。
/// 默认走本机网关 magpie，不填密钥、不联外网就能说话。
StdioDshTransport _transportForCurrentModel() => StdioDshTransport(
      provider: modelClient.defaultProviderId,
      modelId: modelClient.defaultModelId,
    );

/// 换模型要重起内核：`provider` / `model` 只在 initialize 那一刻生效，
/// 中途改一个正在跑的进程没有接口。所以这里监听默认模型，
/// 一变就停掉旧进程、按新路由重连——界面会经历一次「离线 → 在线」，
/// 那是对的，不是抖动。
void _followModelChoice() {
  var route = _currentRoute();
  modelClient.addListener(() {
    final next = _currentRoute();
    if (next == route) return;
    route = next;
    chatClient.stop();
    chatClient.useTransport(_transportForCurrentModel());
    unawaited(
      chatClient.connect().timeout(const Duration(seconds: 8), onTimeout: () {}),
    );
  });
}

String _currentRoute() => '${modelClient.defaultProviderId}/${modelClient.defaultModelId}';

/// 记一次崩溃。
///
/// 上报开关（`privacy.crashReport`）只决定**要不要往外发**；
/// 本地这一份永远写——用户来问「为什么闪退」时，没有堆栈就只能猜。
/// 往外发的那一半等有接收端再接，否则就是一个永远发不出去的假开关。
void _logCrash(String scope, Object error, StackTrace? stack) {
  CrashLog.write(scope, error, stack);
}
