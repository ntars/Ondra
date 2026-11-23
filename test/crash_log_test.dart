import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/crash_log_io.dart';
import 'package:ondra/app/prefs.dart';

void main() {
  late Directory temp;

  setUp(() {
    temp = Directory.systemTemp.createTempSync('ondra-crash-log-');
    setPrefHome(temp.path);
    CrashLog.debugHomeOverride = temp.path;
  });

  tearDown(() {
    CrashLog.debugHomeOverride = null;
    setPrefHome(null);
    temp.deleteSync(recursive: true);
  });

  String writeAndRead(String error) {
    CrashLog.write('test', error, StackTrace.fromString(error));
    final log = File('${temp.path}/.ondra/logs/crash.log');
    return log.readAsStringSync();
  }

  test('missing preference defaults to redaction', () {
    const email = 'alice@example.com';
    const key = 'sk-proj-abcdefghijklmnop';
    const hex = '0123456789abcdef0123456789abcdef';
    final text = writeAndRead(
      'path=$temp/private.txt email=$email key=$key hex=$hex',
    );

    expect(text, contains('<email>'));
    expect(text, contains('<key>'));
    expect(text, contains('<hex>'));
    expect(text, isNot(contains(email)));
    expect(text, isNot(contains(key)));
    expect(text, isNot(contains(hex)));
    expect(text, isNot(contains(temp.path)));
  });

  test(
    'explicit false disables extended redaction but keeps path baseline',
    () {
      writePref('settings.privacy.redactLogs', 'false');
      const email = 'alice@example.com';
      const key = 'sk-proj-abcdefghijklmnop';
      final text = writeAndRead(
        'path=${temp.path}/private.txt email=$email key=$key',
      );

      expect(text, contains(email));
      expect(text, contains(key));
      expect(text, isNot(contains(temp.path)));
      expect(text, contains('~/private.txt'));
    },
  );

  test('malformed preferences fail closed to redaction', () {
    final prefs = File('${temp.path}/.ondra/prefs.json');
    prefs.parent.createSync(recursive: true);
    prefs.writeAsStringSync('{not-json');

    final text = writeAndRead(
      'email=alice@example.com key=sk-proj-abcdefghijklmnop',
    );

    expect(text, contains('<email>'));
    expect(text, contains('<key>'));
    expect(text, isNot(contains('alice@example.com')));
  });

  test('unrecognized preference value fails closed to redaction', () {
    writePref('settings.privacy.redactLogs', 'not-a-bool');

    final text = writeAndRead('email=alice@example.com');

    expect(text, contains('<email>'));
    expect(text, isNot(contains('alice@example.com')));
  });
}
