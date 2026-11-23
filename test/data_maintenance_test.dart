import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/data_maintenance.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';

void main() {
  test('等待完整停机才允许写入，重载和重连期间保持独占', () async {
    final maintenance = DataMaintenance();
    addTearDown(maintenance.dispose);
    final exited = Completer<void>();
    final events = <String>[];
    maintenance.pause = () async {
      events.add('stop');
      await exited.future;
    };
    maintenance.reload = () async {
      expect(maintenance.locked, isTrue);
      expect(maintenance.offline, isTrue);
      events.add('reload');
    };
    maintenance.resume = () async {
      expect(maintenance.locked, isTrue);
      expect(maintenance.offline, isFalse);
      events.add('resume');
    };
    final operation = maintenance.run(() async {
      expect(maintenance.offline, isTrue);
      events.add('write');
      return 42;
    }, refresh: true);
    expect(maintenance.locked, isTrue);
    expect(maintenance.offline, isFalse);
    expect(events, ['stop']);
    await expectLater(maintenance.run(() async => 0), throwsStateError);
    exited.complete();
    expect(await operation, 42);
    expect(events, ['stop', 'write', 'reload', 'resume']);
    expect(maintenance.locked, isFalse);
    expect(maintenance.offline, isFalse);
  });

  test('子进程 close 未完成时不允许动用户数据', () async {
    final maintenance = DataMaintenance();
    addTearDown(maintenance.dispose);
    final exited = Completer<void>();
    final events = <String>[];
    maintenance.pause = () async => events.add('stop');
    maintenance.closeTransport = () async {
      events.add('close');
      await exited.future;
    };
    maintenance.resume = () async => events.add('resume');
    final operation = maintenance.run(() async {
      events.add('write');
    });
    await Future<void>.delayed(Duration.zero);
    expect(events, ['stop', 'close']);
    exited.complete();
    await operation;
    expect(events, ['stop', 'close', 'write', 'resume']);
  });

  test('停机失败不执行写入，也不启动第二个内核', () async {
    final maintenance = DataMaintenance();
    addTearDown(maintenance.dispose);
    var resumed = false;
    var wrote = false;
    maintenance.pause = () async => throw StateError('仍在退出');
    maintenance.resume = () async {
      resumed = true;
    };
    await expectLater(
      maintenance.run(() async {
        wrote = true;
      }),
      throwsStateError,
    );
    expect(wrote, isFalse);
    expect(resumed, isFalse);
    expect(maintenance.locked, isFalse);
    expect(maintenance.offline, isFalse);
  });

  test('写入失败仍重载可能部分恢复的数据并释放锁', () async {
    final maintenance = DataMaintenance();
    addTearDown(maintenance.dispose);
    var reloaded = false;
    var resumed = false;
    maintenance.pause = () async {};
    maintenance.reload = () async {
      reloaded = true;
    };
    maintenance.resume = () async {
      resumed = true;
    };
    await expectLater(
      maintenance.run(() async => throw StateError('写入失败'), refresh: true),
      throwsStateError,
    );
    expect(reloaded, isTrue);
    expect(resumed, isTrue);
    expect(maintenance.locked, isFalse);
  });

  test('未配置协调器时拒绝写入', () async {
    final maintenance = DataMaintenance();
    addTearDown(maintenance.dispose);
    var wrote = false;
    await expectLater(
      maintenance.run(() async {
        wrote = true;
      }),
      throwsStateError,
    );
    expect(wrote, isFalse);
  });

  test('维护期间禁止聊天重连或发送，保留附件', () async {
    final client = ChatClient();
    addTearDown(client.dispose);
    dataMaintenance.pause = () async {};
    dataMaintenance.resume = () async {};
    addTearDown(() {
      dataMaintenance.pause = null;
      dataMaintenance.resume = null;
    });
    client.attach(
      const ChatAttachment(path: '/temporary/image.png', name: 'image.png'),
    );
    await dataMaintenance.run(() async {
      await client.connect();
      await client.send('维护中的消息');
      expect(client.messages, isEmpty);
      expect(client.attachments, hasLength(1));
      expect(client.offlineReason, contains('暂停发送'));
    });
  });
}
