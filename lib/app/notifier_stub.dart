/// 浏览器里的通知：没有通知中心，如实不弹。
///
/// 不用 Web Notifications API：那要用户授权、要点在页面里、而且离开标签页
/// 就没了——与「任务在后台跑完提醒我」是两件事。与其做一半，不如说清楚。
///
/// 接口与 `notifier_io.dart` **完全同形**：条件导出两边都会被分析。
library;

class Notifier {
  const Notifier._();

  static bool get supported => false;

  /// 与 io 版同名的测试桩注入点（接口同形的要求，见文件头）。
  static NotifierProbe? probe;

  static Future<void> show({
    required String title,
    required String body,
    bool sound = true,
  }) async {
    if (probe != null) {
      await probe!.show(title: title, body: body, sound: sound);
    }
  }
}

/// 测试用的替身，签名与 io 版一致。
class NotifierProbe {
  NotifierProbe();

  final List<({String title, String body, bool sound})> sent = [];

  Future<void> show({
    required String title,
    required String body,
    bool sound = true,
  }) async {
    sent.add((title: title, body: body, sound: sound));
  }
}
