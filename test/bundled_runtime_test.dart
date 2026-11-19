import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/bundled_runtime.dart';
import 'package:ondra/app/runtime_seed.dart';

/// 随包运行时的**解析**与**种子铺开**。
///
/// 这两个东西是「用户打开就能说话」的前提：找不到运行时，内核就起不来；
/// profile 没铺开，内核会抛 `profile "ondra" does not exist`。
///
/// 测试只跑真实产物：`runtime/<平台>-<架构>/` 由 `tool/assemble_runtime.sh`
/// 生成，没跑过装配脚本的机器上整组跳过——不该因为「没打包」就红。
void main() {
  final runtime = ondraBundledRuntime;

  group('解析随包运行时', () {
    test('装配产物存在时，三个入口路径都指向真实文件', () {
      if (runtime == null) {
        markTestSkipped('没有 runtime/ 产物（先跑 tool/assemble_runtime.sh）');
      }
      final r = runtime!;

      expect(File(r.nodePath).existsSync(), isTrue,
          reason: 'node 应存在于 ${r.nodePath}');
      expect(File(r.dshEntry).existsSync(), isTrue,
          reason: 'dsh 入口应存在于 ${r.dshEntry}');
      expect(r.dshEntry, endsWith('${Platform.pathSeparator}bin.js'));

      // 三者必须同源：混用「包里的 node + 系统装的 dsh」是没法排障的状态。
      expect(r.nodePath, startsWith(r.rootDir));
      expect(r.dshEntry, startsWith(r.rootDir));
    });

    test('目录名带平台前缀，且不含 .. 这类未归一化片段', () {
      if (runtime == null) {
        markTestSkipped('没有 runtime/ 产物');
      }
      final r = runtime!;

      expect(r.rootDir, contains('${Platform.operatingSystem}-'),
          reason: '目录名要与 uname 对齐（macos-arm64 / linux-x64 …）');
      expect(r.rootDir, isNot(contains('..')),
          reason: '路径里的 ../ 会让错误提示看起来像拼接出错');
      expect(r.rootDir, isNot(contains('//')));
    });

    test('profile 种子目录里有装配层清单', () {
      if (runtime == null) {
        markTestSkipped('没有 runtime/ 产物');
      }
      final r = runtime!;

      expect(r.hasProfile, isTrue, reason: '包里应带 profile 种子');
      // 内核读的就是 cordis.yml（+ patch）；只有目录不算。
      expect(File('${r.profileDir}/cordis.yml').existsSync(), isTrue);
      expect(Directory('${r.profileDir}/node_modules').existsSync(), isTrue);
    });
  });

  group('铺开 profile 种子', () {
    late Directory tempHome;

    setUp(() {
      tempHome = Directory.systemTemp.createTempSync('ondra-seed-test');
    });

    tearDown(() {
      if (tempHome.existsSync()) tempHome.deleteSync(recursive: true);
    });

    test('空目录里铺一次，得到完整的 profile', () {
      if (runtime == null) markTestSkipped('没有 runtime/ 产物');

      final result = seedRuntimeProfile(dshHome: tempHome.path);

      expect(result.outcome, RuntimeSeedOutcome.seeded);
      final target = Directory(
        '${tempHome.path}${Platform.pathSeparator}profiles'
        '${Platform.pathSeparator}$ondraRuntimeProfileName',
      );
      expect(target.existsSync(), isTrue);
      expect(File('${target.path}/cordis.yml').existsSync(), isTrue);
      expect(
        Directory('${target.path}/node_modules/@ondra').existsSync(),
        isTrue,
        reason: '插件包必须一起过去，否则内核装配时找不到模块',
      );
    });

    test('再调一次不再复制（幂等）', () {
      if (runtime == null) markTestSkipped('没有 runtime/ 产物');

      expect(seedRuntimeProfile(dshHome: tempHome.path).outcome,
          RuntimeSeedOutcome.seeded);
      expect(seedRuntimeProfile(dshHome: tempHome.path).outcome,
          RuntimeSeedOutcome.alreadyPresent);
    });

    test('用户已有安装时不覆盖——插件更新不能被包里的旧快照吞掉', () {
      if (runtime == null) markTestSkipped('没有 runtime/ 产物');

      // 先铺一份
      expect(seedRuntimeProfile(dshHome: tempHome.path).outcome,
          RuntimeSeedOutcome.seeded);

      // 模拟「用户自己更新过插件」：改掉一个文件
      final marker = File(
        '${tempHome.path}/profiles/$ondraRuntimeProfileName/cordis.yml',
      );
      marker.writeAsStringSync('# 用户自己的版本\n');

      final again = seedRuntimeProfile(dshHome: tempHome.path);

      expect(again.outcome, RuntimeSeedOutcome.alreadyPresent);
      expect(marker.readAsStringSync(), '# 用户自己的版本\n',
          reason: '目标是「用户装的那份优先」，不是「包里那份优先」');
    });
  });
}
