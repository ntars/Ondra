import 'backup_model.dart';

/// 浏览器预览里的引擎：不碰文件系统，一律如实说「读不到」。
///
/// 不用假数据把界面撑起来——空态里写着「浏览器预览读不到本机文件」，
/// 用户就知道这不是「没有备份」，而是「这个环境看不到」。两者的区别
/// 决定了他是该去建一份备份，还是该打开桌面版。
class BackupEngine {
  const BackupEngine();

  String get home => '';
  String get root => '';

  Future<BackupOverview> load() async =>
      BackupOverview.empty.copyWithNote('浏览器预览读不到本机文件系统；桌面版会显示真实快照。');

  Future<BackupSettings> readSettings() async => const BackupSettings();

  Future<void> writeSettings(BackupSettings settings) async {}

  Future<BackupOpResult> create({
    BackupTrigger trigger = BackupTrigger.manual,
  }) async =>
      const BackupOpResult(ok: false, message: '浏览器预览不能读写本机备份目录，请在桌面版里备份。');

  Future<BackupOpResult> restore(String id) async =>
      const BackupOpResult(ok: false, message: '浏览器预览不能还原到本机。');

  Future<BackupOpResult> delete(String id) async =>
      const BackupOpResult(ok: false, message: '浏览器预览不能删除本机快照。');

  Future<BackupOpResult> exportTo(String id, String targetDir) async =>
      const BackupOpResult(ok: false, message: '浏览器预览不能导出到本机。');

  Future<BackupOpResult> importFrom(String sourceDir) async =>
      const BackupOpResult(ok: false, message: '浏览器预览不能从本机导入。');

  Future<BackupOpResult> reveal() async =>
      const BackupOpResult(ok: false, message: '浏览器预览里没有访达。');

  Future<String?> pickDirectory(String prompt) async => null;
}

/// Web 上不排班：没有进程常驻，也没有可写的目录。
class BackupScheduler {
  const BackupScheduler(this.engine);

  final BackupEngine engine;

  bool get running => false;

  void start() {}

  void stop() {}

  Future<void> tick() async {}
}

const BackupEngine backupEngine = BackupEngine();
const BackupScheduler backupScheduler = BackupScheduler(backupEngine);
