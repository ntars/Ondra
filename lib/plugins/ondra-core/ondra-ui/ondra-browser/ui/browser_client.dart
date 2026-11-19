import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import 'browser_store.dart';

/// 白名单里的一个站点。
class OndraSite {
  const OndraSite({required this.url, this.note = ''});

  /// 规范化后的地址（带协议）。
  final String url;
  final String note;

  String get host {
    final uri = Uri.tryParse(url);
    return uri?.host ?? url;
  }
}

/// 白名单与当前打开的页面。
///
/// 规则只有一条：**没进白名单的地址不打开**。后续「读网页」类能力也走这里，
/// 所以判定只写一份。
class BrowserClient extends ChangeNotifier {
  /// 出厂白名单只有一条：模型基座要填 API Key，那个页面是第一个真用得上的。
  /// 别的站点由用户自己加——预置一堆「常用网站」等于替用户做隐私决定。
  /// 面板是否出现。**它不挂在左栏**：只有别的东西请求打开网页、
  /// 或用户从设置里进白名单时才会出现，关掉就回到原来那一页。
  bool _visible = false;

  List<OndraSite> _sites = [
    const OndraSite(url: 'https://platform.deepseek.com', note: 'API 密钥与用量'),
  ];
  String? _active;

  BrowserClient() {
    // 白名单落盘读回（浏览器环境没有文件系统，store 的 stub 会给空表）。
    // 这是用户攒出来的准入清单，重启丢了等于把「我用哪些服务」又替他忘了一次。
    final saved = loadBrowserSites();
    // 文件里的清单整体替换出厂值：出厂那一条要是用户删了，不该每次
    // 启动又冒回来。
    if (saved.isNotEmpty) {
      _sites = [
        for (final item in saved)
          OndraSite(url: item['url'] ?? '', note: item['note'] ?? ''),
      ].where((s) => s.url.isNotEmpty).toList(growable: true);
    }
    addListener(_persist);
  }

  List<OndraSite> get sites => List.unmodifiable(_sites);

  /// 白名单落盘。监听器要求 VoidCallback，所以包一层。
  void _persist() {
    saveBrowserSites([
      for (final s in _sites) {'url': s.url, 'note': s.note},
    ]);
  }
  String? get active => _active;
  bool get visible => _visible;

  /// 被动出现的入口：显示面板（白名单列表）。
  void showList() {
    _visible = true;
    notifyListeners();
  }

  /// 规范化：没写协议的补 https://；不是 http(s) 的一律拒绝。
  static String? normalize(String input) {
    var text = input.trim();
    if (text.isEmpty) return null;
    if (!text.contains('://')) text = 'https://$text';
    final uri = Uri.tryParse(text);
    if (uri == null || uri.host.isEmpty) return null;
    if (uri.scheme != 'http' && uri.scheme != 'https') return null;
    return uri.toString();
  }

  String? add(String input) {
    final url = normalize(input);
    if (url == null) return '地址不合法，需要 http(s)://';
    if (_sites.any((s) => s.url == url)) return '已在白名单里';
    _sites.add(OndraSite(url: url));
    notifyListeners();
    return null;
  }

  void remove(OndraSite site) {
    _sites.remove(site);
    if (_active == site.url) _active = null;
    notifyListeners();
  }

  /// 打开：只允许白名单内的地址（含子域）。
  String? open(String input) {
    final url = normalize(input);
    if (url == null) return '地址不合法，需要 http(s)://';
    if (!allowed(url)) return '这个地址不在白名单里';
    _active = url;
    notifyListeners();
    return null;
  }

  void openSite(OndraSite site) {
    _active = site.url;
    _visible = true;
    notifyListeners();
  }

  /// 关掉面板：回到出现之前那一页。
  void close() {
    _active = null;
    _visible = false;
    notifyListeners();
  }

  /// 从网页退回白名单（面板不关）。
  void backToList() {
    _active = null;
    notifyListeners();
  }

  bool allowed(String url) {
    final host = Uri.tryParse(url)?.host;
    if (host == null || host.isEmpty) return false;
    return _sites.any((s) => host == s.host || host.endsWith('.${s.host}'));
  }
}

final BrowserClient browserClient = BrowserClient();
