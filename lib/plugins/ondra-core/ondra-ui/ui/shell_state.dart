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
    bool initialSidebarOpen = true,
  })  : _activeId = initialId,
        _sidebarOpen = initialSidebarOpen;

  final ValueChanged<ThemeMode>? onThemeModeChanged;

  String _activeId;
  bool _sidebarOpen;
  bool _railOpen = true;
  bool _chatFocus = false;
  bool _settingsOpen = false;
  bool _timelineOpen = false;
  ThemeMode _themeMode;

  /// 手机上是否正停留在某个功能页。
  ///
  /// **只在手机布局里有意义**（见 `design/form_factor.dart` 的 `ondraIsMobile`）。
  /// 桌面是三栏并置，页面与对话同时在场，不存在「离开聊天」这件事；
  /// 手机只有一列，聊天是主界面，点侧栏里的一项就等于离开聊天去看那一页。
  ///
  /// 用一个布尔而不是复用 `activeId`：`activeId` 是「选中了哪一项」，
  /// 桌面切页时它变但人还在三栏里；手机需要额外知道「现在到底盖没盖住聊天」。
  /// 两者混用会出现「抽屉关掉后聊天没回来」或者「切了页但还显示聊天」。
  bool _mobilePageOpen = false;

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

  bool get settingsOpen => _settingsOpen;

  /// 打开设置面板时落在哪一栏。由入口（如侧栏账户行 → 人设）指定，
  /// 面板取走后清空：下一次从菜单进，还是落回通用。
  /// 打开设置面板时落在哪一栏。由入口（如侧栏账户行 → 人设）指定，
  /// 面板取走后清空：下一次从菜单进，还是落回通用。
  ShellPane? settingsPane;

  /// 手机上是否正盖着功能页（false = 正在看聊天）。
  ///
  /// 见 [_mobilePageOpen] 的说明。桌面布局不读它，恒为 false。
  bool get mobilePageOpen => _mobilePageOpen;

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

  set mobilePageOpen(bool value) {
    if (value == _mobilePageOpen) return;
    _mobilePageOpen = value;
    notifyListeners();
  }

  /// 手机上从抽屉里选了某一项：切页、盖住聊天、收起抽屉，三个动作一次做完。
  ///
  /// 为什么合成一个方法：分三次赋值会触发三次通知，中间那两帧里
  /// 「页面已经切了但聊天还盖在上面」会被画出来，肉眼看到抽屉消失的瞬间
  /// 底下闪一下聊天。
  void openMobilePage(String id) {
    _activeId = id;
    _mobilePageOpen = true;
    _sidebarOpen = false;
    notifyListeners();
  }

  /// 手机上从功能页回到聊天。
  void closeMobilePage() {
    if (!_mobilePageOpen) return;
    _mobilePageOpen = false;
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

/// 设置面板的初始落点。与设置面板自己的枚举同形：壳层只说「想去哪一类」，
/// 面板把它翻译成自己的 pane，两边不互相 import 私有类型。
enum ShellPane { general, model, channels, persona, about }
