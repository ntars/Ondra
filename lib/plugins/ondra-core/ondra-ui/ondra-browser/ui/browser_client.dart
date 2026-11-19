import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import 'browser_store.dart';

/// 白名单中的一个站点。准入范围是精确的协议、host、端口，不隐含子域。
class OndraSite {
  const OndraSite({required this.url, this.note = ''});

  final String url;
  final String note;

  String get host => Uri.tryParse(url)?.host ?? url;
}

typedef BrowserSitesLoader = List<Map<String, String>>? Function();
typedef BrowserSitesSaver = void Function(List<Map<String, String>> sites);

/// 白名单与当前页面。原生 WebView 会对同一份规则再次校验所有导航。
class BrowserClient extends ChangeNotifier {
  BrowserClient({BrowserSitesLoader? loadSites, BrowserSitesSaver? saveSites})
    : _saveSites = saveSites ?? saveBrowserSites,
      _loadSites = loadSites ?? loadBrowserSites {
    // null 才表示没有文件；用户保存的 [] 必须继续拒绝所有站点。
    final saved = _loadSites();
    if (saved != null) {
      _sites = [
        for (final item in saved)
          if (normalize(item['url'] ?? '') case final String url)
            OndraSite(url: url, note: item['note'] ?? ''),
      ];
    }
  }

  final BrowserSitesSaver _saveSites;
  final BrowserSitesLoader _loadSites;
  bool _visible = false;
  List<OndraSite> _sites = [
    const OndraSite(url: 'https://platform.deepseek.com', note: 'API 密钥与用量'),
  ];
  String? _active;
  String? _error;
  String? get error => _error;

  List<OndraSite> get sites => List.unmodifiable(_sites);
  String? get active => _active;
  bool get visible => _visible;

  // 只有修改清单才写盘；显示、导航和关闭都不应改用户的存储。
  void _persist() {
    _saveSites([
      for (final s in _sites) {'url': s.url, 'note': s.note},
    ]);
  }

  void reload() {
    final saved = _loadSites();
    _sites = [
      for (final item in saved ?? const <Map<String, String>>[])
        if (normalize(item['url'] ?? '') case final String url)
          OndraSite(url: url, note: item['note'] ?? ''),
    ];
    _error = null;
    if (_active != null && !allowed(_active!)) _active = null;
    notifyListeners();
  }

  void showList() {
    _visible = true;
    notifyListeners();
  }

  /// 仅输入入口可补 https；准入判定本身要求完整 http(s) URL。
  static String? normalize(String input) {
    var text = input.trim();
    if (text.isEmpty) return null;
    if (!text.contains('://')) {
      // 不把 javascript:、data: 等 scheme 误当成省略协议的地址。
      final hasScheme = RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*:').hasMatch(text);
      final hostAndPort = RegExp(
        r'^(?:localhost|[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+):[0-9]+(?:[/?#]|$)',
      ).hasMatch(text);
      if (hasScheme && !hostAndPort) return null;
      text = 'https://$text';
    }
    return _webUri(text)?.toString();
  }

  /// 与原生规则保持一致：无 URL 凭据、不接受编码 host 或模糊的数字 IP。
  static Uri? _webUri(String text) {
    if (RegExp(r'[\s\x00-\x1f\x7f\\]').hasMatch(text)) return null;
    // Uri 会消去空 userInfo、解码 host，必须先检查原始 authority。
    final authority = RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]*)')
        .firstMatch(text)
        ?.group(1);
    if (authority == null ||
        authority.contains('@') ||
        authority.contains('%')) {
      return null;
    }
    final uri = Uri.tryParse(text);
    if (uri == null || !uri.hasAuthority || uri.host.isEmpty) return null;
    if (uri.scheme != 'http' && uri.scheme != 'https') return null;
    final int port;
    try {
      port = uri.port;
    } on FormatException {
      return null;
    }
    if (port < 1 || port > 65535) return null;
    final host = uri.host;
    if (host.contains(':')) {
      if (!RegExp(r'^[0-9a-f:]+$').hasMatch(host)) return null;
      try {
        Uri.parseIPv6Address(host);
      } on FormatException {
        return null;
      }
    } else {
      if (host.length > 253 ||
          !host
              .split('.')
              .every(
                (label) =>
                    RegExp(r'^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
                        .hasMatch(label),
              )) {
        return null;
      }
      if (RegExp(r'^[0-9.]+$').hasMatch(host)) {
        final parts = host.split('.');
        if (parts.length != 4 ||
            parts.any(
              (p) =>
                  (p.length > 1 && p.startsWith('0')) ||
                  (int.tryParse(p) ?? 256) > 255,
            )) {
          return null;
        }
      }
    }
    return uri;
  }

  String? add(String input) {
    final url = normalize(input);
    if (url == null) return '地址不合法，需要不含凭据的 http(s) 地址';
    if (_sites.any((s) => s.url == url)) return '已在白名单里';
    final site = OndraSite(url: url);
    _sites.add(site);
    try {
      _persist();
      _error = null;
    } catch (error) {
      _sites.remove(site);
      _error = '白名单未保存：$error';
    }
    notifyListeners();
    return _error;
  }

  void remove(OndraSite site) {
    final index = _sites.indexOf(site);
    if (index < 0) return;
    _sites.removeAt(index);
    try {
      _persist();
      _error = null;
      if (_active != null && !allowed(_active!)) _active = null;
    } catch (error) {
      _sites.insert(index, site);
      _error = '白名单移除失败，规则未改变：$error';
    }
    notifyListeners();
  }

  String? open(String input) {
    final url = normalize(input);
    if (url == null) return '地址不合法，需要不含凭据的 http(s) 地址';
    if (!allowed(url)) return '这个地址的协议、主机或端口不在白名单里';
    _active = url;
    _visible = true;
    notifyListeners();
    return null;
  }

  /// 即使调用方传来旧条目或临时构造的条目，也不能绕过准入检查。
  String? openSite(OndraSite site) {
    if (!allowed(site.url)) return '这个地址的协议、主机或端口不在白名单里';
    return open(site.url);
  }

  void close() {
    _active = null;
    _visible = false;
    notifyListeners();
  }

  void backToList() {
    _active = null;
    notifyListeners();
  }

  bool allowed(String url) {
    final uri = _webUri(url);
    if (uri == null) return false;
    return _sites.any((site) {
      final rule = _webUri(site.url);
      return rule != null &&
          uri.scheme == rule.scheme &&
          uri.host == rule.host &&
          uri.port == rule.port;
    });
  }
}

final BrowserClient browserClient = BrowserClient();
