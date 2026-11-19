import 'persona_model.dart';

/// Web 端的假实现：没有文件系统，装包与导出都如实失败。
///
/// 导出名与 `persona_store_io.dart` 保持一致（`PersonaStore`、`PersonaInstall`），
/// 页面只 import 这一行，两边的调用代码完全相同。
class PersonaStore {
  PersonaStore({
    String? home,
    this.userSubdir = 'personas',
    Future<void> Function(String step)? transactionHook,
  });

  static const maxArchiveBytes = 32 * 1024 * 1024;
  static const maxEntryBytes = 4 * 1024 * 1024;
  static const maxEntries = 2048;

  final String userSubdir;
  String get root => '';
  String get kernelRoot => '';

  Future<PersonaInstall> ensureKernelPack(String slug) async =>
      const PersonaInstall(ok: false, message: '浏览器预览无法同步内核人设包。');

  final String home = '';

  List<String> installedSlugs() => const [];

  OndraPersona? readInstalled(String slug) => null;

  Future<PersonaInstall> install({
    required String archivePath,
    required Set<String> builtInSlugs,
  }) async =>
      const PersonaInstall(ok: false, message: '浏览器预览里读不到本地文件，装包请在桌面端操作。');

  Future<PersonaInstall> export(
    String slug, {
    required String targetZip,
  }) async =>
      const PersonaInstall(ok: false, message: '浏览器预览里没有文件系统，导出请在桌面端操作。');

  Future<PersonaInstall> remove(String slug, {required bool builtIn}) async =>
      const PersonaInstall(ok: false, message: '浏览器预览里没有文件系统，删除请在桌面端操作。');
}

class PersonaInstall {
  const PersonaInstall({
    required this.ok,
    required this.message,
    this.slug,
    this.id,
  });

  final bool ok;
  final String message;
  final String? slug;
  final String? id;
}
