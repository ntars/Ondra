import 'transfer_model.dart';

/// 浏览器预览里的引擎：不碰文件系统，也不碰数据库。
///
/// 这一页在浏览器里**整个功能都不成立**（没有选目录面板、没有本机记忆库），
/// 所以每个动作都如实说「这里做不到」，而不是假装成功——点完导出却什么都没写，
/// 比直接说不支持更糟。
class TransferEngine {
  const TransferEngine();

  String get home => '';
  String get dataRoot => '';
  String get dbPath => '';

  Future<TransferSnapshot> load() async => TransferSnapshot.empty;

  Future<TransferResult> exportMemory(String dir, TransferFormat format) async =>
      const TransferResult.fail('浏览器预览不能写本机文件，请在桌面版导出。');

  Future<TransferResult> exportBundle(String dir) async =>
      const TransferResult.fail('浏览器预览不能写本机文件，请在桌面版导出。');

  Future<TransferResult> exportArchive(String dir) async =>
      const TransferResult.fail('浏览器预览不能写本机文件，请在桌面版导出。');

  Future<TransferResult> importPath(String path) async =>
      const TransferResult.fail('浏览器预览读不到本机文件，请在桌面版导入。');

  Future<String?> pickDirectory(String prompt) async => null;

  Future<String?> pickFile(String prompt, List<String> extensions) async => null;

  Future<TransferResult> reveal(String path) async =>
      const TransferResult.fail('浏览器预览里没有访达。');
}

const TransferEngine transferEngine = TransferEngine();
