/// 内核配置桥在浏览器里的形态：没有文件系统，读回空、写入如实失败。
///
/// 成员必须与 `dsh_settings_io.dart` **完全同形**：`flutter analyze` 会把
/// 条件导出的两边都分析一遍，缺一个成员，调用点就会在另一边报错。
class DshSettings {
  const DshSettings._();

  static bool get supported => false;

  /// 内核配置目录。浏览器里没有这个概念，给空串而不是编一个路径。
  static String get home => '';

  static String get path => '';

  /// 读一份完整的用户层。浏览器里没有文件，所以是空的。
  static Map<String, Object?> readAll() => const {};

  /// 读某个段。读不到返回空 map。
  static Map<String, Object?> section(String id) => const {};

  /// 写一个字段。浏览器里如实返回 false。
  static bool writeField(String section, String key, Object? value) => false;

  /// 删一个字段。
  static bool removeField(String section, String key) => false;

  /// 与 io 版同名的重定向入口（接口同形的需要）。
  ///
  /// 浏览器里没有文件可写，这个函数什么都不做；它存在只是为了
  /// `flutter analyze` 分析条件导出两边时，调用点不会在另一边报错。
  static void setHome(String? home) {}
}
