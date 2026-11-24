import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('安卓插件源码随仓库分发且不依赖 GitHub API 额度', () {
    const expected =
        '6701f6d0228e79ab5e0bfe1ad77c90e35a77292b19f5460f02fd2f8c1c2e59f7';
    final zip = File('tool/vendor/require-builtin-src.zip');
    expect(zip.existsSync(), isTrue);
    expect(sha256.convert(zip.readAsBytesSync()).toString(), expected);

    final script = File('tool/build_android_addons.sh').readAsStringSync();
    expect(script, isNot(contains('https://api.github.com')));
    expect(script, contains('require-builtin-src.zip'));
  });
}
