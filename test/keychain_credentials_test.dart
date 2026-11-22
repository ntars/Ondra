import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/keychain.dart';

/// `.credentials.yaml` 是和内核共用的文件。
///
/// 内核侧（`dsh-client-connection` / `dsh-authorization`）会往里写
/// `records:` 段，桌面壳只负责 `refs:` 段。这组测试锁住三件事：
///
/// 1. 壳写 refs 不能动 records；
/// 2. 写进去的键名必须是内核能解析的 POSIX 标识符（不含点号）；
/// 3. 读回来的值要和写进去的逐字节相等（引号/转义不能变形）。
void main() {
  late Directory home;
  late File credentials;

  setUp(() {
    home = Directory.systemTemp.createTempSync('ondra-credentials-');
    credentials = File('${home.path}/dsh/.credentials.yaml');
    // 走目录重定向，而不是改 HOME：`Platform.environment` 在测试进程里
    // 只读，拿不到假 HOME。
    Keychain.debugDshHomeOverride = '${home.path}/dsh';
  });

  tearDown(() {
    Keychain.debugDshHomeOverride = null;
    home.deleteSync(recursive: true);
  });

  void write(String text) {
    credentials.parent.createSync(recursive: true);
    credentials.writeAsStringSync(text);
  }

  String read() => credentials.readAsStringSync();

  test('写 refs 不抹掉内核的 records 段', () async {
    write('''version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: goxSQtqaGbbk739G5dKWGaPMPaeuJ9U30pBPEO6mVUc
''');
    final r = await Keychain.write('DEEPSEEK_API_KEY', 'sk-test-value');
    expect(r.ok, isTrue);

    final after = read();
    expect(after, contains('records:'));
    expect(after, contains('client-connection/browser-session'));
    expect(after, contains('goxSQtqaGbbk739G5dKWGaPMPaeuJ9U30pBPEO6mVUc'));
    expect(after, contains('DEEPSEEK_API_KEY: sk-test-value'));
  });

  test('没有 refs 段时插在 version 之后，records 仍在', () async {
    write('''version: 1
records:
  authorization/device:
    kind: grant
    payload:
      version: 1
      token: abc
''');
    await Keychain.write('MAGPIE_API_KEY', 'k1');
    final after = read();
    final lines = after.split('\n');
    expect(lines[0], 'version: 1');
    expect(lines[1], 'refs:');
    expect(after, contains('authorization/device'));
    expect(after, contains('token: abc'));
  });

  test('删掉最后一个 ref 后 records 与 version 都还在', () async {
    write('''version: 1
refs:
  DEEPSEEK_API_KEY: sk-a
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: s
''');
    await Keychain.write('DEEPSEEK_API_KEY', '');
    final after = read();
    expect(after, contains('records:'));
    expect(after, contains('client-connection/browser-session'));
    expect(after, isNot(contains('DEEPSEEK_API_KEY')));
    expect(after, contains('version: 1'));
  });

  test('写入 → 读回逐字节相等（含需加引号的值）', () async {
    await Keychain.write('A_KEY', "sk-with space:and'quote");
    expect(await Keychain.read('A_KEY'), "sk-with space:and'quote");

    await Keychain.write('B_KEY', 'sk-plain-123');
    expect(await Keychain.read('B_KEY'), 'sk-plain-123');
  });

  test('键名用 POSIX 标识符：官方解析器拒收点号', () async {
    // 老版本用 provider.<id>.key 当键名，官方 REF_PATTERN 会整份拒绝。
    // 这里守住「新写进去的键名符合该语法」。
    await Keychain.write('DEEPSEEK_API_KEY', 'x');
    final key = read()
        .split('\n')
        .firstWhere((l) => l.startsWith('  ') && l.contains(':'))
        .trim()
        .split(':')
        .first;
    expect(RegExp(r'^[A-Za-z_][A-Za-z0-9_]*$').hasMatch(key), isTrue,
        reason: '写进凭据文件的键名必须能被内核解析，实际为 $key');
  });

  test('refs 段在 records 之后时，写密钥不会把 records 误当成 refs', () async {
    // 官方 provider 写出的顺序不保证 refs 永远在 records 之前。解析器原来
    // 遇到 `records:` 才退出 refs 段；若顺序反过来，后续授权字段会被当成
    // 一堆密钥读回，再写出去就把结构完全破坏。
    write('''version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: keepme
refs:
  MAGPIE_API_KEY: k1
''');
    expect(await Keychain.read('MAGPIE_API_KEY'), 'k1');
    await Keychain.write('DEEPSEEK_API_KEY', 'sk-x');
    final after = read();
    expect(after, contains('secret: keepme'));
    expect(after, contains('MAGPIE_API_KEY: k1'));
    expect(after, contains('DEEPSEEK_API_KEY: sk-x'));
  });

  test('erase 只删目标键，records 不受影响', () async {
    write('''version: 1
refs:
  DEEPSEEK_API_KEY: sk-a
  MAGPIE_API_KEY: k1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: s
''');
    expect(await Keychain.erase('DEEPSEEK_API_KEY'), isTrue);
    final after = read();
    expect(after, isNot(contains('DEEPSEEK_API_KEY')));
    expect(after, contains('MAGPIE_API_KEY: k1'));
    expect(after, contains('client-connection/browser-session'));
  });
}
