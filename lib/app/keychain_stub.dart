/// 浏览器预览里的「钥匙串」：没有系统钥匙串，一切如实失败。
///
/// 不做内存假存：刷新就丢的值不是「已保存」，下次打开界面显示「已填写」
/// 而实际没有，比留空更糟。
library;

import 'keychain_secret.dart';

export 'keychain_secret.dart';

class Keychain {
  const Keychain._();

  /// 系统钥匙串是否可用。
  static bool get supported => false;

  /// 测试用的探针注入点，与 `keychain_io.dart` 同名同形。
  ///
  /// stub 里本来不需要它（`exists` 直接返回 false），但两个实现必须
  /// **接口完全一致**：`flutter analyze` 会把条件导出的两边都分析一遍，
  /// 一边多一个成员，调用点就会在另一边报「没有这个 setter」。
  /// 这不是测试专用的后门，而是「同一份契约的两个实现」必须同形。
  static Future<bool> Function(String key) existsProbe = (_) async => false;

  static Future<KeychainSecret> write(String key, String value) async =>
      const KeychainSecret(
        ok: false,
        message: '浏览器预览里没有系统钥匙串，请在桌面端填写。',
      );

  static Future<String?> read(String key) async => null;

  static Future<bool> erase(String key) async => false;

  /// 只回答「有没有」，不取值：界面需要显示「已填写 / 未填写」，
  /// 而把密钥读回内存再丢掉没有任何用处。
  static Future<bool> exists(String key) => existsProbe(key);
}
