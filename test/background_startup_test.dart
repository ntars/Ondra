import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/background_startup.dart';

void main() {
  testWidgets('首帧之前不执行任何后台启动步骤', (tester) async {
    final events = <String>[];
    final startup = BackgroundStartup(
      onError: (name, error, stack) => events.add('error:$name'),
      steps: [
        StartupStep('persona', () async => events.add('persona')),
        StartupStep('runtime', () async => events.add('runtime')),
      ],
    );

    final done = startup.startAfterFirstFrame();

    // 仅注册了 post-frame 回调，尚未出帧。
    expect(events, isEmpty);
    expect(startup.scheduled, isTrue);

    await tester.pumpWidget(const SizedBox.shrink());
    await done;

    expect(events, ['persona', 'runtime']);
  });

  testWidgets('单步失败不拦截后续步骤', (tester) async {
    final events = <String>[];
    final errors = <String>[];
    final startup = BackgroundStartup(
      onError: (name, error, stack) {
        errors.add('$name:$error');
        events.add('caught:$name');
      },
      steps: [
        StartupStep('broken', () async {
          events.add('broken');
          throw StateError('内核不可用');
        }),
        StartupStep('next', () async => events.add('next')),
      ],
    );

    startup.startAfterFirstFrame();
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();

    expect(events, ['broken', 'caught:broken', 'next']);
    expect(errors.single, contains('内核不可用'));
  });

  testWidgets('重复调用不会重复启动', (tester) async {
    var calls = 0;
    final startup = BackgroundStartup(
      onError: (name, error, stack) {},
      steps: [StartupStep('once', () async => calls += 1)],
    );

    final first = startup.startAfterFirstFrame();
    final second = startup.startAfterFirstFrame();
    await tester.pumpWidget(const SizedBox.shrink());
    await Future.wait([first, second]);

    expect(calls, 1);
  });
}
