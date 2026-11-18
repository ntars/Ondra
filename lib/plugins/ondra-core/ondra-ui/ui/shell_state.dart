import 'package:material_ui/material_ui.dart';

/// 壳层状态：当前页、两栏开合、沉浸式对话、登录态、设置开关。
///
/// 没有引入状态管理库——骨架阶段这些状态只被外壳与页面读，用
/// [ChangeNotifier] + [InheritedNotifier] 足够，且不留第三方依赖。
///
/// 明暗模式放在这里，是因为它有了**运行期开关**：设置里可选浅色 / 深色 /
/// 跟随系统（默认后者）。选择结果由 [onThemeModeChanged] 交给上层落盘，
/// 这个类不认识文件系统。
class ShellState extends ChangeNotifier {
  ShellState({
    required String initialId,
    this._themeMode = ThemeMode.system,
    this.onThemeModeChanged,
  }) : _activeId = initialId;

  final ValueChanged<ThemeMode>? onThemeModeChanged;

  String _activeId;
  bool _sidebarOpen = true;
  bool _railOpen = true;
  bool _chatFocus = false;
  bool _signedIn = false;
  bool _settingsOpen = false;
  bool _timelineOpen = false;
  ThemeMode _themeMode;

  String get activeId => _activeId;

  ThemeMode get themeMode => _themeMode;

  set themeMode(ThemeMode value) {
    if (value == _themeMode) return;
    _themeMode = value;
    onThemeModeChanged?.call(value);
    notifyListeners();
  }
  bool get sidebarOpen => _sidebarOpen;
  bool get railOpen => _railOpen;

  /// 沉浸式对话：左栏收起、右栏铺满整张纸片。
  ///
  /// 它不是第三个「栏的开合」，而是「这一屏在做什么」：平时三栏并置是为了
  /// 扫视，沉浸是为了长对话——只有一个主题、一条时间线，不该被导航和页面
  /// 各切走三分之一。所以它同时约束两件事，必须由一个状态表达，
  /// 否则会出现「左栏收了但右栏还是 280」这种中间态。
  bool get chatFocus => _chatFocus;

  bool get signedIn => _signedIn;
  bool get settingsOpen => _settingsOpen;

  /// 时间线：把整个窗口接管过去。
  ///
  /// 它和「设置面板」一样是覆盖层，但比设置更彻底——设置是浮在页面上的一个
  /// 面板，时间线是把三栏一起吞掉换成一个空间。所以它不进 `Navigator`：
  /// 退出时应当回到原来那一页、那一栏的开合状态，而不是「返回上一页」。
  bool get timelineOpen => _timelineOpen;

  set activeId(String value) {
    if (value == _activeId) return;
    _activeId = value;
    notifyListeners();
  }

  set sidebarOpen(bool value) {
    if (value == _sidebarOpen) return;
    _sidebarOpen = value;
    notifyListeners();
  }

  set railOpen(bool value) {
    if (value == _railOpen) return;
    _railOpen = value;
    // 右栏都收了，就没有「沉浸」可言了，顺手退掉，免得下次开右栏时
    // 左栏凭空不见。
    if (!value) _chatFocus = false;
    notifyListeners();
  }

  set chatFocus(bool value) {
    if (value == _chatFocus) return;
    _chatFocus = value;
    // 进沉浸必须有右栏：它是这一屏的主体。
    if (value) _railOpen = true;
    notifyListeners();
  }

  set signedIn(bool value) {
    if (value == _signedIn) return;
    _signedIn = value;
    notifyListeners();
  }

  set settingsOpen(bool value) {
    if (value == _settingsOpen) return;
    _settingsOpen = value;
    notifyListeners();
  }

  set timelineOpen(bool value) {
    if (value == _timelineOpen) return;
    _timelineOpen = value;
    // 两个覆盖层不叠着：进来时把设置关掉，退出时不会莫名其妙弹出一个设置面板。
    if (value) _settingsOpen = false;
    notifyListeners();
  }

  void toggleSidebar() => sidebarOpen = !_sidebarOpen;
  void toggleRail() => railOpen = !_railOpen;
  void toggleChatFocus() => chatFocus = !_chatFocus;
}

/// 向下传递 [ShellState] 的作用域。
class ShellScope extends InheritedNotifier<ShellState> {
  const ShellScope({
    super.key,
    required ShellState state,
    required super.child,
  }) : super(notifier: state);

  static ShellState of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<ShellScope>();
    assert(scope != null, 'ShellScope 未挂载：页面必须位于 OndraShell 之内');
    return scope!.notifier!;
  }
}
