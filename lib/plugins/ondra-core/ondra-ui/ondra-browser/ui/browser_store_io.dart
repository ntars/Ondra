import 'dart:convert';

import '../../../../../app/home_dir.dart';
import 'dart:io';


/// 白名单存取：`~/.ondra/browser-sites.json`。
///
/// 独立文件而不是 prefs.json：白名单是数组结构，prefs 只放标量。
/// 文件坏了当作「没有自定义项」，调用方回落到出厂那一条。
List<Map<String, String>> loadBrowserSites() {
  try {
    final f = _storeFile;
    if (!f.existsSync()) return const [];
    final raw = jsonDecode(f.readAsStringSync());
    if (raw is! List) return const [];
    final out = <Map<String, String>>[];
    for (final item in raw) {
      if (item is! Map) continue;
      final url = '${item['url'] ?? ''}';
      if (url.isEmpty) continue;
      out.add({'url': url, 'note': '${item['note'] ?? ''}'});
    }
    return out;
  } catch (_) {
    return const [];
  }
}

void saveBrowserSites(List<Map<String, String>> sites) {
  try {
    _storeFile.writeAsStringSync(
      const JsonEncoder.withIndent('  ').convert(sites),
    );
  } catch (_) {
    // 写盘失败不打断界面：改动还在内存里，下次改动会再试。
  }
}

File get _storeFile {
  final home = ondraUserHome;
  return File('$home/.ondra/browser-sites.json');
}
