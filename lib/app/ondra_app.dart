import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:material_ui/material_ui.dart';

import '../plugins/ondra-core/ondra-ui/ui/registry.dart';
import '../plugins/ondra-core/ondra-ui/ui/shell_state.dart';
import '../design/avatar.dart';
import '../design/form_factor.dart';
import '../design/theme.dart';
import '../design/motion.dart';
import '../plugins/ondra-core/ondra-ui/ui/boot_screen.dart';
import '../plugins/ondra-core/ondra-ui/ui/chassis.dart';
import 'debug_launch.dart';
import 'i18n.dart';
import 'prefs.dart';
import 'version.dart';
import 'window_appearance.dart';

/// 应用根：持有一份壳层状态，决定主题，先过启动屏再挂主壳。
class OndraApp extends StatefulWidget {
  const OndraApp({super.key});

  @override
  State<OndraApp> createState() => _OndraAppState();
}

/// 调试入口：web 上允许用 `?page=memory` 直接落到某一页。
///
/// 只为逐页核对布局服务，桌面构建里 kIsWeb 为 false，这段不参与。
String _debugInitialId() {
  if (kIsWeb) {
    final page = Uri.base.queryParameters['page'];
    if (page != null && page.isNotEmpty && OndraRegistry.byId(page) != null) {
      return page;
    }
  } else {
    // 桌面：ONDRA_PAGE=browser 直接落到某页，便于核对排版。
    final page = debugLaunchPage();
    if (page.isNotEmpty && OndraRegistry.byId(page) != null) return page;
  }
  return OndraRegistry.initialId;
}

bool _debugSettings() =>
    kIsWeb && Uri.base.queryParameters['settings'] == '1';

/// 调试入口：`?timeline=1` 直接推开时间线。
///
/// 这一屏要用真实快照才看得出排版，而它藏在「备份还原 → 进入时间线」两步
/// 之后；核对版式时不该每次都点两下。
bool _debugTimeline() =>
    kIsWeb && Uri.base.queryParameters['timeline'] == '1';

/// 调试入口：`?boot=hold` 让启动屏停住不切主壳，用来核对这一屏的排版。
///
/// 平时它只活 700ms，截图工具几乎不可能刚好抓到；留一个显式的「停住」开关，
/// 比为了截图去改时长安全得多。
bool _debugBootHold() =>
    kIsWeb && Uri.base.queryParameters['boot'] == 'hold';

/// 主题模式：用户的选择（启动时从偏好文件读回），`ONDRA_THEME` / `?theme=`
/// 可在核对时临时覆盖，避免为了看一眼深色去改设置。
ThemeMode _themeMode(ThemeMode chosen) {
  switch (debugLaunchTheme()) {
    case 'dark':
      return ThemeMode.dark;
    case 'light':
      return ThemeMode.light;
    case 'system':
      return ThemeMode.system;
    default:
      return chosen;
  }
}

/// 偏好文件里存的是 `ThemeMode.name`，认不出来就回到跟随系统。
ThemeMode _readThemeMode() {
  switch (readPref('themeMode')) {
    case 'dark':
      return ThemeMode.dark;
    case 'light':
      return ThemeMode.light;
    default:
      return ThemeMode.system;
  }
}

class _OndraAppState extends State<OndraApp> {
  late final ShellState _state = ShellState(
    initialId: _debugInitialId(),
    themeMode: _readThemeMode(),
    // 桌面一进来是三栏，导航必须在场；手机一进来是聊天，抽屉必须先关着——
    // 否则首帧就是「抽屉盖住聊天」，而用户从没点过任何按钮。
    initialSidebarOpen: !ondraIsMobile,
    // 只在这里认识「偏好文件」：壳层状态只管通知，落盘由应用根负责。
    onThemeModeChanged: (mode) => writePref('themeMode', mode.name),
  )..settingsOpen = _debugSettings();

  @override
  void initState() {
    super.initState();
    // 调试直达：`?timeline=1` 一开机就推开时间线（见 `_debugTimeline`）。
    _state.timelineOpen = _debugTimeline();
    // 头像读一次就好：文件在 `~/.ondra/avatar.png`，几十 KB，同步读完不会拖慢首帧。
    // 放在这里而不是 `OndraAvatar` 的 initState，是因为那个组件有多处实例，
    // 每处都读一遍等于同一份文件解析 N 次。
    avatarStore.reload();
    // 语言包：读偏好里记着的语言，异步装载（走 rootBundle）。
    // 装不上就保持中文，界面不会因此空白——见 `i18n.dart` 的说明。
    // `readPref` 读不到时给空串，`load('')` 会当成「不认识的语言」回落中文。
    OndraI18n.instance.load(readPref('language'));
  }

  @override
  void dispose() {
    _state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return OndraI18nScope(
      child: ShellScope(
        state: _state,
        // 两层监听：壳层状态（切页 / 主题 / 设置开合）与语言。
        // 语言这一路是**兜底**：真正保证「切了立刻变」的是上面那层
        // `OndraI18nScope`（它把变化直接投递给读过译文的 element，
        // 不受中间 `const` 影响）。这里再监听一次是为了让应用根自己
        // 也重建，`MaterialApp` 的 `locale` 之类的参数能跟着更新。
        child: AnimatedBuilder(
          animation: Listenable.merge([_state, OndraI18n.instance]),
          builder: (context, _) {
          return MaterialApp(
            title: ondraAppName,
            debugShowCheckedModeBanner: false,
            // 明暗跟系统走。皮肤的取值不靠「把浅色调暗」，而是
            // `OndraSkin.darkSkin` 里那套独立的角色名（面层更深、字更浅）——
            // 同一份代码在两种模式下读同一批角色，页面里不需要任何 if。
            theme: ondraTheme(Brightness.light),
            darkTheme: ondraTheme(Brightness.dark),
            // 浅色 / 深色 / 跟随系统三选一，选过就记住（`~/.ondra/prefs.json`）。
            themeMode: _themeMode(_state.themeMode),
            // 亮度同步给两处：
            // 1. 原生窗口——磨砂玻璃是 AppKit 画的，只认 NSAppearance，
            //    不传这一下会出现「纸深、玻璃浅」的错层；
            // 2. 排版光学层——深色下白字光渗会发胀，[ondraText] 要按亮度减细
            //    字重。它必须在各页面 build 之前落定，所以同步点放在这里，
            //    而不是每个页面各自判断 brightness。
            builder: (context, child) {
              final dark = Theme.of(context).brightness == Brightness.dark;
              OndraOptics.sync(dark: dark);
              applyWindowBrightness(dark: dark);
              // 系统字号上限收到 1.3x：全站是写死的 fontSize + 大量固定
              // 高度容器（侧栏项 32、日志时间列 58、用量条 26），2x 会有
              // 成片的裁字与溢出。1.3 是「明显放大但仍放得下」的边界；
              // 真正要做到 2x 无裁切需要整套布局改成自适应高度，单列。
              final media = MediaQuery.of(context);
              return MediaQuery(
                data: media.copyWith(
                  textScaler: media.textScaler.clamp(
                    minScaleFactor: 1,
                    maxScaleFactor: 1.3,
                  ),
                ),
                child: child ?? const SizedBox.shrink(),
              );
            },
            // 必须有一层 Material：否则 Text 会继承 WidgetsApp 的「错误文字样式」
            // （红字 + 黄色双下划线），所有未显式声明 decoration 的文本都会被污染。
            //
            // 这一层是全 `const` 的，语言切换照样能穿透——因为译文的变化不走
            // 「父传子」那条会被 `const` 短路的路径，而是由外层 `OndraI18nScope`
            // 直接投递给每个读过译文的 element。见 `i18n.dart` 的说明。
            home: const Material(
              type: MaterialType.transparency,
              child: _BootGate(),
            ),
          );
          },
        ),
      ),
    );
  }
}

/// 启动屏 → 主壳。
///
/// main() 在 `runApp` 之前已经把人设、模型基座与内核连接全部做完
/// （内核连接带 8 秒超时兜底，失败不拦启动），所以这里等的只是
/// 品牌动画的最短时长，不是数据。`?boot=hold` 用于截图核对。
class _BootGate extends StatefulWidget {
  const _BootGate();

  @override
  State<_BootGate> createState() => _BootGateState();
}

class _BootGateState extends State<_BootGate> {
  bool _ready = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    // 700ms 是产品时长（品牌动画的下限）；`?boot=hold` 时改成 10 分钟，
    // 只为截图核对。数据就绪发生在 runApp 之前，见类注释。
    final hold = _debugBootHold();
    _timer = Timer(Duration(milliseconds: hold ? 600000 : 700), () {
      if (mounted) setState(() => _ready = true);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 220),
      child: _ready ? const OndraChassis() : const BootScreen(),
    );
  }
}
