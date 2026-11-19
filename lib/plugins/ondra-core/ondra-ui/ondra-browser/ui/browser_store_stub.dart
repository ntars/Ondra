/// 浏览器环境没有文件系统：读回来永远是空表，写出去直接丢弃。
///
/// 白名单因此回落到出厂那一条——这不是丢数据，是 Web 预览本来就没有
/// 可持久化的地方，和 prefs 的内存回退是同一条规矩。
List<Map<String, String>> loadBrowserSites() => const [];

void saveBrowserSites(List<Map<String, String>> sites) {}
