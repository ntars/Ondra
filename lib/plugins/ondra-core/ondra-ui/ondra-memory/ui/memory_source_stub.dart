import 'memory_types.dart';

/// 浏览器里没有文件系统，也没有子进程。
///
/// 预览环境（`flutter run -d chrome/web-server`）只能看版式与交互，
/// 拿不到 `~/.ondra/user/ondra.db`。这里如实返回一条说明，
/// 让空态写「这个环境读不到本地库」，而不是含糊地写「还没有记忆点」——
/// 后者会让人以为插件没写数据。
Future<MemorySnapshot> loadMemorySnapshot() async {
  return const MemorySnapshot(
    facts: [],
    links: [],
    note: '浏览器预览没有本地文件系统，读不到记忆库；请在桌面应用里看这一页',
  );
}
