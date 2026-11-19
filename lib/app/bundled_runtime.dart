/// 随包运行时：应用自带的 Node、dsh 内核入口与 profile 种子。
///
/// 与 `prefs.dart` / `data_root.dart` 同一模式：一个条件导出，两个同形实现。
///
/// 为什么需要它：**用户不该为了说话去装 Node**。安装包在
/// `runtime/<平台>-<架构>/` 里带了一份裁剪过的运行时（node 108MB + dsh 依赖
/// 闭包 60MB 上下 + profile 种子 4.4MB，合计约 180MB；Windows 另加
/// sqlite3.exe 4MB），由 `tool/assemble_runtime.mjs` 生成。
/// 这个文件只负责**找到**它，不负责安装，也不负责启动。
///
/// 找不到是正常状态：开发机上没跑过装配脚本、或者有人在 Linux 上用系统装的
/// dsh。这时返回 null，由调用方退回系统安装——所以返回类型是可空的，
/// 而不是抛异常。
///
/// **但发行包不能没有它。** Windows 上系统既没有 dsh 也没有 node，退回的那条
/// 路是断的；所以 `windows/CMakeLists.txt` 在缺运行时的时候直接让构建失败，
/// 而不是打出一个双击后连不上内核的安装包。
library;

export 'bundled_runtime_stub.dart' if (dart.library.io) 'bundled_runtime_io.dart';
