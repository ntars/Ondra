import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/i18n.dart';

/// 语言包与 i18n 层的验收。
///
/// 这一层的核心承诺是「缺条目回落原文，不是空白」，所以测试分两类：
/// 1. 行为：词条命中、缺词条回落、插值、未知语言回落中文；
/// 2. 内容：语言包里的键必须是代码里**真实出现**的中文字符串。
///    第 2 条是最容易腐烂的——译文写好了但没人调用，或者键被改了中文
///    却忘了改语言包，两种情况都不会报错，只会让翻译悄悄失效。
void main() {
  // `load()` 走 `rootBundle`，读资源前必须有 binding。
  // 没有这一行时 `load` 会静默回落中文（它自己 catch 住了），
  // 于是所有断言都变成「在测中文」——看起来全过，实际一条没测到。
  TestWidgetsFlutterBinding.ensureInitialized();

  group('OndraI18n 行为', () {
    setUp(() => OndraI18n.instance.load('zh'));

    test('原文语言下 tr 原样返回，不查表', () async {
      await OndraI18n.instance.load('zh');
      expect(OndraI18n.instance.isSource, isTrue);
      expect(t('设置'), '设置');
      expect(OndraI18n.instance.entryCount, 0);
    });

    test('缺词条时回落原文，不是空串', () async {
      await OndraI18n.instance.load('en');
      // `en.json` 里没有这一条。
      expect(t('这句话语言包里没有'), '这句话语言包里没有');
    });

    test('插值：{name} 被替换，未给变量时保留占位符原样', () async {
      await OndraI18n.instance.load('en');
      // 词条里带了 {n} 的那一条。
      const zh = '应用内打开的网页只能来自这份清单；当前 {n} 个站点';
      expect(t(zh, {'n': 3}), contains('3'));
      expect(t(zh, {'n': 3}), isNot(contains('{n}')));
      // 不给变量时不该把 {n} 吃掉——那样反而看不出哪里没填。
      expect(t(zh), contains('{n}'));
    });

    test('不认识的语言代码回落中文', () async {
      await OndraI18n.instance.load('tlh');
      expect(OndraI18n.instance.code, 'zh');
      expect(OndraI18n.instance.isSource, isTrue);
    });

    test('切语言会通知监听者，界面才能跟着重建', () async {
      await OndraI18n.instance.load('zh');
      var notified = 0;
      void listener() => notified += 1;
      OndraI18n.instance.addListener(listener);
      addTearDown(() => OndraI18n.instance.removeListener(listener));

      await OndraI18n.instance.load('en');
      expect(notified, greaterThan(0));
    });
  });

  group('语言包内容', () {
    Map<String, String> readEn() {
      final raw = File('assets/locales/en.json').readAsStringSync();
      final parsed = jsonDecode(raw) as Map<String, dynamic>;
      return {
        for (final e in parsed.entries)
          if (e.value is String) e.key: e.value as String,
      };
    }

    test('en.json 是合法 JSON，且没有空译文', () {
      final table = readEn();
      expect(table, isNotEmpty);
      // 语言名用该语言自身书写，这是通行做法（BCP 47 / CLDR 的
      // 「语言自称」）：中文选项在英文界面里也写「简体中文」，
      // 法语写「Français」。用英文拼出来（"Simplified Chinese"）
      // 反而让看不懂英文的人认不出自己该选哪个。
      const selfNamed = {'简体中文'};
      for (final e in table.entries) {
        // 下划线开头的是说明字段，允许为空。
        if (e.key.startsWith('_')) continue;
        expect(e.value.trim(), isNotEmpty, reason: '键「${e.key}」的译文是空的');
        if (selfNamed.contains(e.value)) continue;
        // 译文里不该还留着大段中文——那就是没翻。
        final hasCjk = RegExp(r'[\u4e00-\u9fa5]').hasMatch(e.value);
        expect(hasCjk, isFalse, reason: '键「${e.key}」的译文里还有中文：${e.value}');
      }
    });

    test('插值占位符两边一致：中文键里有 {x}，译文里也要有', () {
      final table = readEn();
      final placeholder = RegExp(r'\{(\w+)\}');
      for (final e in table.entries) {
        if (e.key.startsWith('_')) continue;
        final inKey = placeholder
            .allMatches(e.key)
            .map((m) => m.group(1))
            .toSet();
        final inVal = placeholder
            .allMatches(e.value)
            .map((m) => m.group(1))
            .toSet();
        expect(
          inVal,
          inKey,
          reason:
              '键「${e.key}」的占位符与译文不一致：'
              '键里 $inKey，译文里 $inVal——少一个就会把 {n} 原样显示给用户',
        );
      }
    });

    test('语言包里每一条都能被 assets 找到（pubspec 声明了目录）', () {
      final pubspec = File('pubspec.yaml').readAsStringSync();
      expect(
        pubspec.contains('- assets/locales/'),
        isTrue,
        reason:
            'pubspec.yaml 的 assets 段没有声明 assets/locales/，'
            '装出来的包读不到语言包，会静默回落中文',
      );
      expect(File('assets/locales/en.json').existsSync(), isTrue);
    });

    test('语言包的每个键都是代码里真实出现的中文字面量', () {
      // 这一条防的是「写了译文但永远不会被用到」。
      // 键是原文而不是 `nav.status` 这样的符号，好处是翻译即增量；
      // 代价是键写错时**不会报错**，只会永远命不中——症状是
      // 「这个界面切了英文没变化」，而没有任何一处提示为什么。
      //
      // 所以这里反过来扫一遍源码：语言包的键必须能在 `lib/` 的
      // 中文单引号字面量里找到。找不到就说明这条译文的原文写错了，
      // 或者那个文案已经被改掉、译文成了孤儿。
      final table = readEn();
      final sources = <String>{};
      final lit = RegExp(r"'([^'\\\n]*[\u4e00-\u9fa5][^'\\\n]*)'");
      final dir = Directory('lib');
      for (final f in dir.listSync(recursive: true)) {
        if (f is! File || !f.path.endsWith('.dart')) continue;
        var src = f.readAsStringSync();
        // 注释里的中文不是界面文案，去掉再扫——否则一条注释就能
        // 让一个写错的键「看起来有出处」。
        src = src.replaceAll(RegExp(r'/\*.*?\*/', dotAll: true), '');
        src = src.replaceAll(RegExp(r'^\s*//.*$', multiLine: true), '');
        for (final m in lit.allMatches(src)) {
          sources.add(m.group(1)!);
        }
      }
      expect(sources, isNotEmpty, reason: '没扫到任何中文文案，扫描逻辑坏了');

      final orphans = [
        for (final k in table.keys)
          if (!k.startsWith('_') && !sources.contains(k)) k,
      ];
      expect(
        orphans,
        isEmpty,
        reason:
            '这些键在 lib/ 里找不到对应的中文字面量，'
            '永远不会被 t() 命中：$orphans',
      );
    });
  });
}
