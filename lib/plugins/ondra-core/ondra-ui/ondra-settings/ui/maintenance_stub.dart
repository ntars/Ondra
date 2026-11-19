/// Web 端的维护动作：没有文件系统，一律如实拒绝。
///
/// 与 `maintenance_io.dart` 导出同名同形的类，页面只 import 这一行。
class OndraMaintenance {
  OndraMaintenance({String? home, bool Function()? dataIsOffline});

  final String home = '';

  Future<String?> pickDirectory(String prompt) async => null;

  Future<MaintenanceResult> exportAll(String targetDir) async =>
      const MaintenanceResult(ok: false, message: '浏览器预览里没有文件系统，导出请在桌面端操作。');

  Future<MaintenanceResult> wipeAll() async =>
      const MaintenanceResult(ok: false, message: '浏览器预览里没有本地数据，清空请在桌面端操作。');

  DateTime? lastWipe() => null;

  Future<MaintenanceResult> clearCache() async =>
      const MaintenanceResult(ok: false, message: '浏览器预览里没有本地缓存。');

  Future<List<PermissionStatus>> permissions() async => const [
    PermissionStatus(
      name: '浏览器权限',
      granted: null,
      detail: '在浏览器的站点设置里查看；桌面端的权限项在此不可见',
    ),
  ];
}

class MaintenanceResult {
  const MaintenanceResult({required this.ok, required this.message, this.path});

  final bool ok;
  final String message;
  final String? path;
}

class PermissionStatus {
  const PermissionStatus({
    required this.name,
    required this.granted,
    required this.detail,
  });

  final String name;
  final bool? granted;
  final String detail;
}
