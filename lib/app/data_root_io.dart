import 'home_dir.dart';

/// 数据根目录的绝对路径。
///
/// `~` 不展开成 `$HOME`：界面上显示一串完整路径，用户才能直接复制到
/// 访达的「前往文件夹」里；显示 `~/.ondra` 的话，某些地方复制过去是不认的。
String get ondraDataRoot => ondraUserDataRoot;
