/// 界面取数与动作的唯一入口。
///
/// 页面只认这里的变量，不直接调 `transferEngine`：测试里把这些换成空实现或
/// 临时目录，就能把整棵树渲染出来，不必去动真实的记忆库。这与备份、记忆星图、
/// 日志页是同一套做法——**取数在页面外面**，页面只管画。
library;

import 'transfer_engine.dart';
import 'transfer_model.dart';

typedef TransferLoader = Future<TransferSnapshot> Function();

typedef TransferExportMemory =
    Future<TransferResult> Function(String dir, TransferFormat format);

typedef TransferExportBundle = Future<TransferResult> Function(String dir);

typedef TransferExportArchive = Future<TransferResult> Function(String dir);

typedef TransferImport = Future<TransferResult> Function(String path);

typedef TransferPickDirectory = Future<String?> Function(String prompt);

typedef TransferPickFile =
    Future<String?> Function(String prompt, List<String> extensions);

typedef TransferReveal = Future<TransferResult> Function(String path);

TransferLoader transferLoader = transferEngine.load;
TransferExportMemory transferExportMemory = transferEngine.exportMemory;
TransferExportBundle transferExportBundle = transferEngine.exportBundle;
TransferExportArchive transferExportArchive = transferEngine.exportArchive;
TransferImport transferImport = transferEngine.importPath;
TransferPickDirectory transferPickDirectory = transferEngine.pickDirectory;
TransferPickFile transferPickFile = transferEngine.pickFile;
TransferReveal transferReveal = transferEngine.reveal;
