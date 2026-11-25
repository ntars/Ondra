import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/version.dart';

void main() {
  test('应用构建号与 pubspec 发行版本一致', () {
    expect(ondraBuild, '22');
    final pubspec = File('pubspec.yaml').readAsStringSync();
    expect(pubspec, contains('version: 3.0.0-alpha+22'));
  });
}
