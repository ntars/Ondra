import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/feedback_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/feedback_stub.dart'
    as web;

const _body = '反馈描述超过十个字，重现步骤见附件。';

void main() {
  late Directory temp;
  late FeedbackStore store;
  late List<(String, List<String>)> launches;

  setUp(() async {
    temp = await Directory.systemTemp.createTemp('ondra-feedback-test-');
    launches = [];
    store = FeedbackStore(
      home: '${temp.path}/home',
      platform: 'macos',
      launch: (executable, arguments) async {
        launches.add((executable, arguments));
        return true;
      },
    );
  });
  tearDown(() async => temp.delete(recursive: true));

  Future<FeedbackResult> write({
    List<String> paths = const [],
    bool attachLog = false,
    String kind = '其他',
    String body = _body,
  }) => store.write(
    kind: kind,
    body: body,
    version: '3.0.0-alpha',
    attachmentPaths: paths,
    attachLog: attachLog,
  );

  Future<FeedbackResult> compose(String? report, {bool open = false}) =>
      store.compose(
        kind: '其他',
        body: _body,
        version: '3.0.0-alpha',
        reportPath: report,
        openDraft: open,
      );

  Future<File> source(String path, List<int> bytes) async {
    final file = File('${temp.path}/$path');
    await file.parent.create(recursive: true);
    return file.writeAsBytes(bytes);
  }

  test('copies at most three attachments, safely names duplicate basenames, and makes unique reports', () async {
    final first = await source('a/same.png', [0, 1, 2, 255]);
    final second = await source('b/same.png', [9, 8, 7]);
    final unsafe = await source('c/bad"\nname.png', [3, 4]);
    final results = await Future.wait([
      write(paths: [first.path, second.path, unsafe.path]),
      write(paths: [first.path]),
    ]);
    expect(results.every((r) => r.ok), isTrue);
    expect(results[0].path, isNot(results[1].path));
    final report = File(results[0].path!);
    final folder = report.parent;
    expect(await File('${folder.path}/attachments/01-same.png').readAsBytes(), [
      0,
      1,
      2,
      255,
    ]);
    expect(await File('${folder.path}/attachments/02-same.png').readAsBytes(), [
      9,
      8,
      7,
    ]);
    expect(
      await File('${folder.path}/attachments/03-bad__name.png').readAsBytes(),
      [3, 4],
    );
    final text = await report.readAsString();
    expect(text, contains('attachments/01-same.png'));
    expect(text, isNot(contains(first.path)));
    expect(text, contains('不保证完全脱敏'));
    expect(text, contains('描述和附件未自动脱敏'));
    expect(launches, isEmpty);
  });

  test('rejects path-injecting kinds, excess attachments and invalid body before writing', () async {
    for (final kind in [
      '../../escape',
      '/tmp/escape',
      r'..\escape',
      '其他\nInjected',
    ]) {
      expect((await write(kind: kind)).ok, isFalse);
    }
    expect((await write(paths: ['1', '2', '3', '4'])).ok, isFalse);
    expect((await write(body: '短')).ok, isFalse);
    expect((await write(body: '字' * 2001)).ok, isFalse);
    expect(await Directory(store.root).exists(), isFalse);
    expect(launches, isEmpty);
  });

  test('a failed copy cleans only its own session, keeping originals and older reports', () async {
    final original = await source('my-data.png', [42]);
    final previous = await write(paths: [original.path]);
    final marker = File('${store.root}/user-owned.txt');
    await marker.writeAsString('keep me');
    final before = await Directory(store.root)
        .list()
        .map((e) => e.path)
        .toList();
    final failed = await write(paths: [original.path, '${temp.path}/missing']);
    expect(failed.ok, isFalse);
    expect(failed.path, isNull);
    final after = await Directory(store.root)
        .list()
        .map((e) => e.path)
        .toList();
    expect(after.toSet(), before.toSet());
    expect(await original.readAsBytes(), [42]);
    expect(await marker.readAsString(), 'keep me');
    expect(await File(previous.path!).exists(), isTrue);
  });

  test('rejects directories and symlink attachments without changing their targets', () async {
    final original = await source('source.png', [55]);
    final link = await Link('${temp.path}/link.png').create(original.path);
    expect((await write(paths: [temp.path])).ok, isFalse);
    expect((await write(paths: [link.path])).ok, isFalse);
    expect(await original.readAsBytes(), [55]);
  }, skip: Platform.isWindows);

  test('refuses a symlink feedback root without deleting user data', () async {
    final target = await Directory('${temp.path}/user-folder').create();
    await Directory(store.home).create(recursive: true);
    await Link(store.root).create(target.path);
    expect((await write()).ok, isFalse);
    expect(await target.exists(), isTrue);
    expect(await Link(store.root).exists(), isTrue);
  }, skip: Platform.isWindows);

  test(
    'redacts common credentials and identifies its limits honestly',
    () async {
      final secrets = [
        'notHexBearer.AbCd_123',
        'BasicCredentials123=',
        'plainBearer.Ab_Cd-123',
        'sk-proj-nonhexSecret123',
        'querySecretNonhex',
        'camelCaseSecret',
        'accessSecret123',
        'refreshSecret456',
        'clientSecret789',
        'ghp_StandaloneToken1234',
        '0123456789abcdef0123456789abcdef',
        'alice@example.com',
        '/Users/alice/private.txt',
        r'C:\Users\Alice\secret.txt',
      ];
      final log = File('${store.home}/logs/ondra-code.log');
      await log.parent.create(recursive: true);
      await log.writeAsString('''normal diagnostic
Authorization: Bearer ${secrets[0]}
{"Authorization": "Basic ${secrets[1]}"}
request Bearer ${secrets[2]}
x-api-key: ${secrets[3]}
https://example.invalid/?api_key=${secrets[4]}&ok=1
{"apiKey":"${secrets[5]}","access_token":"${secrets[6]}"}
refresh-token=${secrets[7]}
client_secret='${secrets[8]}'
${secrets.skip(9).join('\n')}
''');
      final result = await write(attachLog: true);
      expect(result.ok, isTrue);
      final text = await File(result.path!).readAsString();
      for (final secret in secrets) {
        expect(text, isNot(contains(secret)), reason: secret);
      }
      expect(text, contains('normal diagnostic'));
      expect(text, contains('仅尽力脱敏'));
      expect(text, isNot(contains('已脱敏')));
    },
  );

  test('logs are opt-in and limited to the last 32 KiB', () async {
    final log = File('${store.home}/logs/ondra-code.log');
    await log.parent.create(recursive: true);
    await log.writeAsString('old-marker${'x' * (40 * 1024)}new-marker');
    final excluded = await write();
    expect(
      await File(excluded.path!).readAsString(),
      isNot(contains('new-marker')),
    );
    final included = await write(attachLog: true);
    final text = await File(included.path!).readAsString();
    expect(text, contains('new-marker'));
    expect(text, isNot(contains('old-marker')));
    expect(text.length, lessThan(34 * 1024));
  });

  test('EML contains the saved report, logs and original binary copies, not just filenames', () async {
    final bytes = List.generate(140000, (i) => i % 256);
    final original = await source('photo.png', bytes);
    final log = File('${store.home}/logs/ondra-code.log');
    await log.parent.create(recursive: true);
    await log.writeAsString('log to share; api_key=doNotShareMe');
    final saved = await write(paths: [original.path], attachLog: true);
    await original.delete();
    // A new instance can compose from the persisted report; no in-memory manifest.
    final reconstructed = FeedbackStore(
      home: store.home,
      launch: (_, _) async {
        fail('must not open without explicit request');
      },
    );
    final result = await reconstructed.compose(
      kind: '其他',
      body: 'this is not the saved report',
      version: 'different',
      reportPath: saved.path,
    );
    expect(result.ok, isTrue);
    expect(result.path, endsWith('.eml'));
    final eml = await File(result.path!).readAsString();
    expect(eml, contains('X-Unsent: 1\r\n'));
    expect(eml, contains('MIME-Version: 1.0\r\n'));
    expect(eml, isNot(contains('\nBcc:')));
    final parts = _mimeParts(eml);
    expect(parts, hasLength(3));
    final reportBytes = await File(saved.path!).readAsBytes();
    expect(parts[0].$2, reportBytes);
    expect(parts[1].$1, contains('filename="report.md"'));
    expect(parts[1].$2, reportBytes);
    expect(parts[2].$1, contains('filename="01-photo.png"'));
    expect(parts[2].$2, bytes);
    expect(utf8.decode(parts[0].$2), contains('log to share'));
    expect(utf8.decode(parts[0].$2), isNot(contains('doNotShareMe')));
    expect(result.message, contains('手动附加'));
    expect(result.message, contains('尚未发送'));
    expect(launches, isEmpty);
  });

  test('legacy compose saves a local draft without collecting logs or opening mail', () async {
    final log = File('${store.home}/logs/ondra-code.log');
    await log.parent.create(recursive: true);
    await log.writeAsString('must not collect this log');
    final result = await compose(null);
    expect(result.ok, isTrue);
    final report = utf8.decode(
      _mimeParts(await File(result.path!).readAsString())[0].$2,
    );
    expect(report, contains(_body));
    expect(report, contains('3.0.0-alpha'));
    expect(report, isNot(contains('must not collect')));
    expect(launches, isEmpty);
  });

  test('explicit open uses only a local EML argument and does not promise editable mail', () async {
    final saved = await write();
    final first = await compose(saved.path);
    final result = await compose(saved.path, open: true);
    expect(result.ok, isTrue);
    expect(result.path, isNot(first.path));
    expect(launches, hasLength(1));
    expect(launches.single.$1, 'open');
    expect(launches.single.$2, [result.path!]);
    expect(result.message, contains('已请求系统打开'));
    expect(result.message, contains('可能只预览'));
    expect(result.message, contains('手动附加'));
  });

  test(
    'failed or unsupported launch retains draft and reports failure honestly',
    () async {
      final saved = await write();
      for (final scenario in ['exit-error', 'throw', 'unsupported']) {
        var called = false;
        final failing = FeedbackStore(
          home: store.home,
          platform: scenario == 'unsupported' ? 'android' : 'linux',
          launch: (_, _) async {
            called = true;
            if (scenario == 'throw') {
              throw const ProcessException('mock', [], 'unavailable');
            }
            return false;
          },
        );
        final result = await failing.compose(
          kind: '其他',
          body: _body,
          version: '1',
          reportPath: saved.path,
          openDraft: true,
        );
        expect(result.ok, isFalse);
        expect(await File(result.path!).exists(), isTrue);
        expect(called, scenario != 'unsupported');
        expect(result.message, contains('手动附加'));
        expect(await File(saved.path!).exists(), isTrue);
      }
    },
  );

  test('refuses an outside report or tampered attachment manifest before launching', () async {
    final outside = await source('outside/report.md', utf8.encode('user data'));
    expect((await compose(outside.path, open: true)).ok, isFalse);
    final saved = await write();
    final manifest = File('${File(saved.path!).parent.path}/manifest.json');
    await manifest.writeAsString(
      jsonEncode({
        'kind': '其他',
        'attachments': ['../../outside/report.md'],
      }),
    );
    expect((await compose(saved.path, open: true)).ok, isFalse);
    expect(await outside.readAsString(), 'user data');
    expect(await File(saved.path!).exists(), isTrue);
    expect(launches, isEmpty);
  });

  test('does not package symlinks substituted after write', () async {
    final original = await source('original.txt', [1, 2]);
    final saved = await write(paths: [original.path]);
    final copy = File(
      '${File(saved.path!).parent.path}/attachments/01-original.txt',
    );
    await copy.delete();
    await Link(copy.path).create(original.path);
    expect((await compose(saved.path, open: true)).ok, isFalse);
    expect(await original.readAsBytes(), [1, 2]);
    expect(launches, isEmpty);
  }, skip: Platform.isWindows);

  test('web stub never pretends to save or launch', () async {
    final stub = web.FeedbackStore(
      home: temp.path,
      launch: (_, _) async {
        fail('stub must not launch');
      },
    );
    expect(
      (await stub.write(
        kind: '其他',
        body: _body,
        version: '1',
        attachmentPaths: [],
      )).ok,
      isFalse,
    );
    final result = await stub.compose(
      kind: '其他',
      body: _body,
      version: '1',
      reportPath: '${temp.path}/report.md',
      openDraft: true,
    );
    expect(result.ok, isFalse);
    expect(result.path, isNull);
  });
}

List<(String, List<int>)> _mimeParts(String eml) {
  const boundary = '----Ondra-Feedback-MIME';
  final sections = eml.split('--$boundary\r\n').skip(1);
  final result = <(String, List<int>)>[];
  for (final section in sections) {
    final end = section.indexOf('\r\n\r\n');
    expect(end, greaterThan(0));
    final headers = section.substring(0, end);
    final payload = section
        .substring(end + 4)
        .split('--$boundary--')
        .first
        .trim();
    for (final line in payload.split('\r\n')) {
      expect(line.length, lessThanOrEqualTo(76));
    }
    result.add((headers, base64Decode(payload.replaceAll('\r\n', ''))));
  }
  return result;
}
