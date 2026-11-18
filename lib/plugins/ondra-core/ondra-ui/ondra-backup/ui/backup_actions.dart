/// 界面取数与动作的唯一入口。
///
/// 页面与时间线都只认这里的变量，不直接调 `backupEngine`：测试里把
/// [backupOverviewLoader] 换成空实现就能渲染整棵树，不必去动真实目录。
/// 这与记忆星图、日志页是同一套做法——**取数在页面外面**，页面只管画。
library;

import 'backup_engine.dart';
import 'backup_model.dart';

typedef BackupOverviewLoader = Future<BackupOverview> Function();

typedef BackupCreate = Future<BackupOpResult> Function({
  BackupTrigger trigger,
});

typedef BackupById = Future<BackupOpResult> Function(String id);

typedef BackupExport = Future<BackupOpResult> Function(String id, String dir);

typedef BackupImport = Future<BackupOpResult> Function(String dir);

typedef BackupReveal = Future<BackupOpResult> Function();

typedef BackupSettingsSaver = Future<void> Function(BackupSettings settings);

typedef BackupDirPicker = Future<String?> Function(String prompt);

BackupOverviewLoader backupOverviewLoader = backupEngine.load;
BackupCreate backupCreate = backupEngine.create;
BackupById backupRestore = backupEngine.restore;
BackupById backupDelete = backupEngine.delete;
BackupExport backupExport = backupEngine.exportTo;
BackupImport backupImport = backupEngine.importFrom;
BackupReveal backupReveal = backupEngine.reveal;
BackupSettingsSaver backupSaveSettings = backupEngine.writeSettings;
BackupDirPicker backupPickDirectory = backupEngine.pickDirectory;
