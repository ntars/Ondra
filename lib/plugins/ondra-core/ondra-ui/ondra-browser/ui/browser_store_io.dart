import 'dart:convert';
import 'dart:io';

import '../../../../../app/home_dir.dart';

/// null 表示文件不存在；空数组表示用户清空了白名单。
/// 损坏或不可读的文件按空表处理，不能意外恢复默认权限。
/// file 是文件存储测试接缝，测试不得使用真实用户目录。
List<Map<String, String>>? loadBrowserSites({File? file}) {
  try {
    final f = file ?? _storeFile;
    if (!f.existsSync()) return null;
    final raw = jsonDecode(f.readAsStringSync());
    if (raw is! List) return const [];
    return [
      for (final item in raw)
        if (item is Map && item['url'] is String)
          {'url': item['url'] as String, 'note': '${item['note'] ?? ''}'},
    ];
  } catch (_) {
    return const [];
  }
}

void saveBrowserSites(List<Map<String, String>> sites, {File? file}) {
  final f = file ?? _storeFile;
  f.parent.createSync(recursive: true);
  final temporary = f.parent.createTempSync('.browser-sites-');
  try {
    final pending = File('${temporary.path}/sites.json');
    pending.writeAsStringSync(
      const JsonEncoder.withIndent('  ').convert(sites),
      flush: true,
    );
    pending.renameSync(f.path);
  } finally {
    try {
      temporary.deleteSync(recursive: true);
    } on FileSystemException {
      // 临时目录清理失败不能把已提交的规则误报成保存失败。
    }
  }
}

File get _storeFile => File('$ondraUserHome/.ondra/browser-sites.json');
