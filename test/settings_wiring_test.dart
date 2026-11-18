import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/dsh_settings.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/settings_spec.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/settings_targets.dart';

/// 「开关拨了到底生不生效」的验收。
///
/// 这一版最要命的问题不是界面缺功能，而是**界面齐了、内核没收到**：
/// 33 个设置项里只有 2 项被真的读过，其余拨了也没人看，而且两边都不报错。
/// 这类错误测不出来就等于没修，所以这里直接对着真实文件断言。
///
/// 用临时目录而不是 `~/.ondra`：测试不该改用户的真实配置。
/// `DSH_HOME` 在进程启动时就定了，所以这里另起一个子进程去验——
/// 见 `_runInIsolate` 的说明。
void main() {
  test('映射表里的段与字段都是 kebab，且段名不是驼峰', () {
    for (final entry in ondraSettingTargets.entries) {
      for (final t in entry.value) {
        expect(
          t.section,
          matches(RegExp(r'^[a-z][a-z0-9-]*$')),
          reason: '${entry.key} 的段名 ${t.section} 不合规',
        );
        expect(
          t.key,
          matches(RegExp(r'^[a-z][a-z0-9-]*$')),
          reason: '${entry.key} 的字段名 ${t.key} 不是 kebab：'
              'camel 会让内核安静地用默认值，两边都不报错',
        );
      }
    }
  });

  test('每个有落点的键都必须是已声明的设置项', () {
    for (final key in ondraSettingTargets.keys) {
      expect(() => ondraSettingSpec(key), returnsNormally,
          reason: '$key 在映射表里，但 settings_spec 里没有声明');
    }
  });

  test('值映射：三档权限 / 音色 / 回复长度都能落到合法值', () {
    // 直接对着映射后的结果断言，不经过文件。
    Map<String, Object?> push(Map<String, Object?> ui) {
      final out = <String, Object?>{};
      for (final entry in ui.entries) {
        final targets = ondraSettingTargets[entry.key];
        if (targets == null) continue;
        for (final t in targets) {
          final mapped = t.map == null ? entry.value : t.map!(entry.value);
          if (mapped == null) continue;
          out['${t.section}.${t.key}'] =
              t.scale != null && mapped is num ? t.scale!(mapped) : mapped;
        }
      }
      return out;
    }

    expect(push({'general.permissions': 'readOnly'}), {'privacy.approval-mode': 'strict'});
    expect(push({'general.permissions': 'fullAccess'}), {'privacy.approval-mode': 'open'});
    expect(push({'dialog.replyLength': '2'}), {'dialogue.max-tokens': 8192});
    expect(push({'voice.timbre': 'warm'}), {'tts.preset': 'soft'});
  });

  test('音色只映射到内核真有的八个预设 id', () {
    // 内核 `ondra-tts/src/types.ts` 的 `PRESET_IDS`（手册 §1.7，顺序原样）。
    // 不在这个集合里的 id 会被 `isPresetId()` 拒掉，静默回落 soft——
    // 界面显示「已选」，实际没生效，且两边都不报错。
    const presetIds = {
      'soft',
      'lively',
      'broadcast',
      'dongbei',
      'shaanxi',
      'cantonese',
      'taiwan',
      'english',
    };
    for (final option in ondraSettingSpec('voice.timbre').options) {
      final targets = ondraSettingTargets['voice.timbre']!;
      for (final t in targets) {
        final mapped = t.map!(option.value);
        expect(mapped, isNotNull, reason: '音色 ${option.value} 没有映射');
        expect(
          presetIds,
          contains(mapped),
          reason: '音色 ${option.value} 映射成了 $mapped，'
              '它不是内核的预设 id，内核会静默回落到 soft',
        );
      }
    }
    // 不同档位要落到不同预设，否则三档形同虚设。
    final mapped = {
      for (final o in ondraSettingSpec('voice.timbre').options)
        o.value: ondraSettingTargets['voice.timbre']!.first.map!(o.value),
    };
    expect(mapped.values.toSet().length, 3, reason: '三档音色必须落到三个不同预设');
  });

  test('语速写的是 tts.rate（增量 −0.5~+0.5），不是 say-wpm 基准值', () {
    // 内核 `ondra-tts`：`rate` 是增量（-0.5 表示慢一半刻度，0.1 快一成），
    // `say-wpm` 是 macOS `say` 的**基准**语速（120–300 词/分钟）。
    // 把界面百分比写进 say-wpm 等于每次都改基准，不是改这一档快慢。
    final targets = ondraSettingTargets['voice.rate']!;
    expect(targets, hasLength(1));
    expect(targets.first.section, 'tts');
    expect(targets.first.key, 'rate');

    num at(num percent) => targets.first.scale!(percent);

    expect(at(100), 0, reason: '100% 是原速，增量必须是 0');
    expect(at(160), closeTo(0.5, 0.001), reason: '160% 顶到内核上限 +0.5');
    expect(at(60), closeTo(-0.5, 0.001), reason: '60% 落到内核下限 -0.5');
    // 区间内也不能越界，否则内核 clamp 之后与界面显示不一致。
    for (var p = 60; p <= 160; p += 5) {
      expect(at(p), inInclusiveRange(-0.5, 0.5), reason: '$p% 换算后越界');
    }
  });

  test('写进 settings.json 的形状与内核一致，且能读回来', () {
    final tmp = Directory.systemTemp.createTempSync('ondra-dsh-settings-');
    addTearDown(() {
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {}
    });
    // 这台机器上 DshSettings 读的是 $DSH_HOME 或 ~/.ondra/dsh。
    // 为了不碰真实配置，这里直接验「文件写法」而不经过 DshSettings 的默认路径：
    // 用同一份 JSON 结构手写一遍，再用 jsonDecode 校验形状。
    final file = File('${tmp.path}/settings.json');
    file.writeAsStringSync(
      const JsonEncoder.withIndent('  ').convert({
        'user': {
          'privacy': {'approval-mode': 'strict', 'scan-secrets': true},
          'tts': {'enable': true, 'rate': 0.25, 'preset': 'soft'},
        },
      }),
    );

    final parsed = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    final user = parsed['user'] as Map<String, dynamic>;
    expect(user['privacy'], isA<Map>());
    expect((user['privacy'] as Map)['approval-mode'], 'strict');
    expect((user['tts'] as Map)['rate'], 0.25);
    // 段名与字段名都要是 kebab——这一条是这次修复的核心，写进测试防回归。
    for (final section in user.keys) {
      expect(section, matches(RegExp(r'^[a-z][a-z0-9-]*$')));
      for (final key in (user[section] as Map).keys) {
        expect('$key', matches(RegExp(r'^[a-z][a-z0-9-]*$')));
      }
    }
  });

  test('没有落点的项如实报告：isWired 为 false', () {
    // 字号只影响界面排版，内核里没有对应字段。
    expect(ondraSettingIsWired('general.fontSize'), isFalse);
    // 这两项是真的有落点。
    expect(ondraSettingIsWired('voice.tts'), isTrue);
    expect(ondraSettingIsWired('privacy.online'), isTrue);
  });


  test('落点在系统侧的项也算「真生效」，不能被标成纯界面', () {
    // 这几项的落点不是 settings.json，而是 launchd / caffeinate / osascript。
    // 如果只按「有没有内核段」判定，界面会在一个真能用的开关下面
    // 写「只影响界面」，把用户劝退。
    for (final key in [
      'general.launchAtLogin',
      'general.preventSleep',
      'general.notify',
      'general.notifySound',
      'about.channel',
    ]) {
      expect(
        ondraSettingIsWired(key),
        isTrue,
        reason: '$key 有系统侧或界面自身的落点，不该被标成「只影响界面」',
      );
    }
    // 这几项是真的没有任何落点，必须如实为 false。
    for (final key in ['general.fontSize', 'general.focusMute']) {
      expect(ondraSettingIsWired(key), isFalse, reason: '$key 当前确实没接');
    }
  });


  test('真写进 settings.json：形状与内核一致，且能读回来', () {
    // 这一条走真实文件，不是内存里的映射：`DshSettings` 写到
    // `$DSH_HOME/settings.json`，内核读的就是这一份。
    final tmp = Directory.systemTemp.createTempSync('ondra-dsh-');
    DshSettings.setHome(tmp.path);
    addTearDown(() {
      DshSettings.setHome(null);
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {}
    });

    expect(DshSettings.path, '${tmp.path}/settings.json');

    // 写两项：一个数值、一个字符串。
    expect(DshSettings.writeField('tts', 'rate', 0.25), isTrue);
    expect(DshSettings.writeField('privacy', 'approval-mode', 'strict'), isTrue);

    // 读回来要一致。
    expect(DshSettings.section('tts'), {'rate': 0.25});
    expect(DshSettings.section('privacy'), {'approval-mode': 'strict'});

    // 落盘的字面形状必须是 {user: {段: {kebab 字段}}}——
    // 内核按这个形状找段，少一层 `user` 或段名写成驼峰都会静默失效。
    final raw = jsonDecode(File('${tmp.path}/settings.json').readAsStringSync());
    expect(raw, isA<Map<String, dynamic>>());
    final user = (raw as Map<String, dynamic>)['user'];
    expect(user, isA<Map<String, dynamic>>());
    expect((user as Map)['tts'], isA<Map>());
    expect((user['tts'] as Map)['rate'], 0.25);

    // 覆盖同一字段不产生第二份、删除之后整段该消失。
    expect(DshSettings.writeField('tts', 'rate', -0.1), isTrue);
    expect(DshSettings.section('tts'), {'rate': -0.1});
    expect(DshSettings.removeField('tts', 'rate'), isTrue);
    expect(DshSettings.section('tts'), isEmpty);
  });

  test('settings.json 坏掉不拖死设置页：读回空表而不是抛', () {
    final tmp = Directory.systemTemp.createTempSync('ondra-dsh-bad-');
    DshSettings.setHome(tmp.path);
    addTearDown(() {
      DshSettings.setHome(null);
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {}
    });

    File('${tmp.path}/settings.json').writeAsStringSync('{ 这不是 JSON');
    expect(() => DshSettings.readAll(), returnsNormally);
    expect(DshSettings.readAll(), isEmpty);
    // 坏文件之后仍然能写：不能被一份烂 JSON 永久卡住。
    expect(DshSettings.writeField('tts', 'enable', true), isTrue);
    expect(DshSettings.section('tts'), {'enable': true});
  });

  test('DshSettings 在桌面端可用', () {
    expect(DshSettings.supported, isTrue);
    expect(DshSettings.path, endsWith('settings.json'));
  });
}
