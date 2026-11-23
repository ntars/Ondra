import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:ondra/app/notifier_io.dart';
import 'package:ondra/app/platform_actions_io.dart';
import 'package:ondra/app/prefs.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/profile_config_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/settings_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/settings_targets.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory tmp;
  late File patch;
  late SettingsClient client;

  void seed() {
    final sections = {
      for (final targets in ondraSettingTargets.values)
        for (final target in targets) target.section,
    };
    patch.writeAsStringSync(
      '- insert:\n${sections.map((s) => '    - id: ondra-$s\n      name: plugin-$s\n').join()}',
    );
  }

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('ondra-settings-client-');
    patch = File('${tmp.path}/cordis.patch.yml');
    debugProfileConfigFileOverride = patch.path;
    setPrefHome(tmp.path);
    PlatformActions.probe = const PlatformActionsProbe();
    Notifier.probe = NotifierProbe();
    client = SettingsClient();
  });
  tearDown(() async {
    client.dispose();
    // 完成被注入的异步动作后再解除替身，绝不落到真实系统动作。
    await Future<void>.delayed(Duration.zero);
    PlatformActions.probe = null;
    PlatformActions.debugOperatingSystemOverride = null;
    PlatformActions.debugLaunchAgentPathOverride = null;
    PlatformActions.debugProcessRunner = null;
    Notifier.probe = null;
    Notifier.debugOperatingSystemOverride = null;
    Notifier.debugProcessRunner = null;
    debugProfileConfigFileOverride = null;
    setPrefHome(null);
    tmp.deleteSync(recursive: true);
  });

  test('恢复替换偏好文件后重读，不将内存旧值写回', () async {
    seed();
    client.load();
    await client.applyPending();
    await client.set('voice.tts', true);
    writePref('settings.voice.tts', 'false');
    await client.reloadFromDisk();
    expect(client.boolean('voice.tts'), isFalse);
    expect(readProfileConfigField('tts', 'enable'), 'false');
    File('${tmp.path}/.ondra/prefs.json').deleteSync();
    await client.reloadFromDisk();
    expect(client.boolean('voice.tts'), isFalse);
  });

  test('首启无偏好时把旧 profile 的朗读默认关对齐为界面默认', () async {
    patch.writeAsStringSync(
      '- insert:\n'
      '    - id: ondra-tts\n'
      '      name: tts\n'
      '      config:\n'
      '        enable: true\n',
    );

    client.load();

    expect(client.boolean('voice.tts'), isFalse);
    expect(readProfileConfigField('tts', 'enable'), 'false');
    expect(client.stateOf('voice.tts'), SettingApplyState.restartRequired);
    expect(readPref('settings.voice.tts'), isEmpty);
  });

  test('用户保存过朗读偏好时不覆盖其值', () async {
    seed();
    writePref('settings.voice.tts', 'true');
    writeProfileConfigField('tts', 'enable', true);

    client.load();

    expect(client.boolean('voice.tts'), isTrue);
    expect(readProfileConfigField('tts', 'enable'), 'true');
  });

  test('新 profile 出厂值是关时，无偏好也不二次改写', () async {
    patch.writeAsStringSync(
      '- insert:\n'
      '    - id: ondra-tts\n'
      '      name: tts\n'
      '      config:\n'
      '        enable: false\n',
    );
    final original = patch.readAsStringSync();

    client.load();

    expect(client.boolean('voice.tts'), isFalse);
    expect(readProfileConfigField('tts', 'enable'), 'false');
    expect(client.stateOf('voice.tts'), SettingApplyState.unverified);
    expect(patch.readAsStringSync(), original);
  });

  test('prefs 写失败保留旧值/不执行平台动作，并能重试真实意图', () async {
    final blocker = File('${tmp.path}/.ondra')
      ..writeAsStringSync('not a directory');
    final calls = <bool>[];
    PlatformActions.probe = PlatformActionsProbe(
      setAutoLaunch: (enabled) async {
        calls.add(enabled);
        return true;
      },
    );
    expect(await client.set('general.launchAtLogin', false), isFalse);
    expect(client.boolean('general.launchAtLogin'), isTrue);
    expect(client.errorFor('general.launchAtLogin'), contains('保存失败'));
    expect(client.pendingValues['general.launchAtLogin'], isFalse);
    expect(calls, isEmpty);
    blocker.deleteSync();
    expect(await client.applyPending(), isTrue);
    expect(calls, [false]);
    expect(client.boolean('general.launchAtLogin'), isFalse);
  });

  test('load 在 seed 前失败可见，seed 后 applyPending 真写配置', () async {
    writePref('settings.voice.tts', 'true');
    client.load();
    expect(client.errorFor('voice.tts'), contains('profile'));
    seed();
    await client.applyPending();
    expect(client.errorFor('voice.tts'), isNull);
    expect(readProfileConfigField('tts', 'enable'), 'true');
    expect(client.stateOf('voice.tts'), SettingApplyState.restartRequired);
    expect(client.appliedValues.containsKey('voice.tts'), isFalse);
  });

  test('落盘不冒充生效；启动期间改动不被旧快照清掉', () async {
    seed();
    expect(await client.set('voice.tts', true), isTrue);
    final boot = client.captureKernelConfiguration();
    expect(await client.set('voice.tts', false), isTrue);
    client.markKernelApplied(boot);
    expect(client.restartRequiredKeys, contains('voice.tts'));
    expect(client.appliedValues['voice.tts'], isTrue);
    client.markKernelApplied(client.captureKernelConfiguration());
    expect(client.stateOf('voice.tts'), SettingApplyState.applied);
    expect(client.restartRequired, isFalse);
  });

  test('resetAll 推送默认值；失败项不虚报恢复成功', () async {
    seed();
    await client.set('voice.tts', true);
    await client.set('voice.rate', 160);
    await client.set('dialog.replyLength', '2');
    // channels.*（QQ 适配器）已从 spec 移除：现在全部项都有落点，全成功。
    expect(await client.resetAll(), isTrue);
    expect(readProfileConfigField('tts', 'enable'), 'false');
    expect(readProfileConfigField('tts', 'rate'), '0.0');
    expect(readProfileConfigField('dialogue', 'max-tokens'), '2048');
    expect(readPref('settings.voice.tts'), 'false');
  });

  test('平台 false/异常可见，失败不会标成 applied', () async {
    PlatformActions.probe = PlatformActionsProbe(
      setAutoLaunch: (_) async => false,
      beginPreventSleep: () async => throw StateError('denied'),
      endPreventSleep: () async => throw StateError('still running'),
    );
    expect(await client.set('general.launchAtLogin', false), isFalse);
    expect(client.stateOf('general.launchAtLogin'), SettingApplyState.error);
    expect(await client.set('general.preventSleep', true), isFalse);
    expect(client.errorFor('general.preventSleep'), contains('denied'));
    expect(await client.set('general.preventSleep', false), isFalse);
    expect(client.errorFor('general.preventSleep'), contains('still running'));
  });

  test('快速开关串行执行，旧 Future 不覆盖新状态', () async {
    final started = Completer<void>();
    final release = Completer<bool>();
    final calls = <String>[];
    PlatformActions.probe = PlatformActionsProbe(
      beginPreventSleep: () {
        calls.add('begin');
        started.complete();
        return release.future;
      },
      endPreventSleep: () async {
        calls.add('end');
      },
    );
    final first = client.set('general.preventSleep', true);
    await started.future;
    final second = client.set('general.preventSleep', false);
    expect(client.stateOf('general.preventSleep'), SettingApplyState.applying);
    release.complete(false);
    expect(await first, isFalse);
    expect(await second, isTrue);
    expect(calls, ['begin', 'end']);
    expect(client.errorFor('general.preventSleep'), isNull);
    expect(client.appliedValues['general.preventSleep'], isFalse);
  });

  test('启动登录项查询晚返回，不能覆盖用户选择', () async {
    final queried = Completer<bool?>();
    PlatformActions.probe = PlatformActionsProbe(
      autoLaunchEnabled: () => queried.future,
    );
    seed();
    client.load();
    expect(await client.set('general.launchAtLogin', true), isTrue);
    queried.complete(false);
    await Future<void>.delayed(Duration.zero);
    expect(client.boolean('general.launchAtLogin'), isTrue);
    expect(readPref('settings.general.launchAtLogin'), 'true');
  });

  test('dispose 后异步结果不能通知/写入偏好', () async {
    final query = Completer<bool?>();
    PlatformActions.probe = PlatformActionsProbe(
      autoLaunchEnabled: () => query.future,
    );
    client.load();
    var notifications = 0;
    client.addListener(() => notifications++);
    client.dispose();
    final old = notifications;
    query.complete(false);
    await Future<void>.delayed(Duration.zero);
    expect(notifications, old);
    expect(readPref('settings.general.launchAtLogin'), isEmpty);
    // tearDown 只 dispose 新客户端一次。
    client = SettingsClient();
  });

  // permissions 测试已随 spec 项移除（内核没有会话文件权限接口）。

  test('坏类型/非法选项/越界数值不会落盘或应用', () async {
    expect(await client.set('voice.tts', 'true'), isFalse);
    expect(await client.set('voice.rate', 999), isFalse);
    expect(await client.set('voice.timbre', 'invented'), isFalse);
    expect(client.number('voice.rate'), 100);
    expect(readPref('settings.voice.rate'), isEmpty);
    expect(ondraPushSetting('voice.timbre', 'invented'), isFalse);
  });

  test('缺/禁用条目给具体应用错误，允许同值重试', () async {
    expect(await client.set('voice.tts', true), isFalse);
    patch.writeAsStringSync(
      '- insert:\n    - id: ondra-tts\n      name: tts\n      disabled: true\n',
    );
    expect(await client.set('voice.tts', true), isFalse);
    expect(client.errorFor('voice.tts'), contains('禁用'));
    seed();
    expect(await client.set('voice.tts', true), isTrue);
    expect(client.errorFor('voice.tts'), isNull);
  });

  test('Linux 如实不支持，不启动 macOS 命令或创建登录项', () async {
    PlatformActions.probe = null;
    Notifier.probe = null;
    PlatformActions.debugOperatingSystemOverride = 'linux';
    Notifier.debugOperatingSystemOverride = 'linux';
    expect(PlatformActions.canAutoLaunch, isFalse);
    expect(PlatformActions.canPreventSleep, isFalse);
    expect(await PlatformActions.autoLaunchEnabled(), isNull);
    expect(await PlatformActions.setAutoLaunch(true), isFalse);
    expect(await PlatformActions.beginPreventSleep(), isFalse);
    expect(Notifier.supported, isFalse);
    expect(await Notifier.tryShow(title: 'test', body: 'not sent'), isFalse);
    expect(Notifier.lastError, contains('不支持'));
    expect(await client.set('general.notify', true), isFalse);
  });

  test('launchctl 非零退出如实失败并恢复临时登录项文件', () async {
    PlatformActions.probe = null;
    PlatformActions.debugOperatingSystemOverride = 'macos';
    final plist = File('${tmp.path}/test-agent.plist');
    PlatformActions.debugLaunchAgentPathOverride = plist.path;
    final calls = <String>[];
    PlatformActions.debugProcessRunner = (exe, args) async {
      calls.add('$exe ${args.first}');
      return ProcessResult(1, args.first == 'list' ? 0 : 5, '', 'denied');
    };
    expect(await PlatformActions.setAutoLaunch(true), isFalse);
    expect(plist.existsSync(), isFalse);
    plist.writeAsStringSync('original');
    expect(await PlatformActions.setAutoLaunch(false), isFalse);
    expect(plist.readAsStringSync(), 'original');
    expect(calls, contains('/bin/launchctl unload'));
    PlatformActions.debugProcessRunner = (_, _) async =>
        ProcessResult(1, 0, '', '');
    expect(await PlatformActions.setAutoLaunch(false), isTrue);
    expect(plist.existsSync(), isFalse);
  });

  test('通知命令失败不能报成功；参数转义不执行用户文本', () async {
    Notifier.probe = null;
    Notifier.debugOperatingSystemOverride = 'macos';
    var script = '';
    Notifier.debugProcessRunner = (exe, args) async {
      expect(exe, '/usr/bin/osascript');
      expect(args.first, '-e');
      script = args.last;
      return ProcessResult(1, 1, '', 'permission denied');
    };
    expect(
      await Notifier.tryShow(title: 'a"b', body: 'line\nnext', sound: false),
      isFalse,
    );
    expect(Notifier.lastError, contains('permission denied'));
    expect(script, contains(r'a\"b'));
    expect(script, contains(r'line\nnext'));
    expect(script, isNot(contains('sound name')));
  });

  test('通知替身真实记录请求，保持旧 show 接口', () async {
    expect(
      await Notifier.tryShow(title: 'title', body: 'body', sound: false),
      isTrue,
    );
    await Notifier.show(title: 'second', body: 'body');
    expect(Notifier.probe!.sent, hasLength(2));
    expect(Notifier.probe!.sent.first.sound, isFalse);
  });

  test('Windows 通知走原生通道并以系统接受为成功', () async {
    Notifier.probe = null;
    Notifier.debugOperatingSystemOverride = 'windows';
    final messages = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('ondra/notify'), (
          call,
        ) async {
          messages.add(call);
          return call.arguments is Map && call.arguments['title'] == 'ok';
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(const MethodChannel('ondra/notify'), null),
    );

    expect(
      await Notifier.tryShow(title: 'ok', body: 'done', sound: false),
      isTrue,
    );
    expect((messages.single.arguments as Map)['sound'], isFalse);
    expect(await Notifier.tryShow(title: 'no', body: 'not sent'), isFalse);
    expect(Notifier.lastError, contains('没有送达'));
  });

  test('Windows 阻止睡眠走原生通道并对拒绝如实失败', () async {
    PlatformActions.probe = null;
    PlatformActions.debugOperatingSystemOverride = 'windows';
    final calls = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('ondra/platform'), (
          call,
        ) async {
          calls.add(call.method);
          if (call.method == 'beginPreventSleep') {
            throw PlatformException(code: 'denied', message: 'denied');
          }
          return null;
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            const MethodChannel('ondra/platform'),
            null,
          ),
    );

    expect(PlatformActions.canPreventSleep, isTrue);
    expect(await PlatformActions.beginPreventSleep(), isFalse);
    await PlatformActions.endPreventSleep();
    expect(calls, ['beginPreventSleep', 'endPreventSleep']);
  });
}
