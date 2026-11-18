/// Web 端的文件面板：什么都没有。
///
/// 返回 null / 空表而不是抛异常：调用点都是「取消就什么都不做」，
/// 抛异常会让每个用到的地方都写一遍 try。
class DesktopPicker {
  const DesktopPicker._();

  static bool get supported => false;

  static Future<String?> pickFile({required String prompt}) async => null;

  static Future<List<String>> pickFiles({
    required String prompt,
    int limit = 3,
  }) async => const [];

  static Future<String?> pickDirectory(String prompt) async => null;

  static Future<String?> saveFile({
    required String prompt,
    required String defaultName,
  }) async => null;
}
