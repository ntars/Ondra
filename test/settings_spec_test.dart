import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_types.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/provider_catalog.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/settings_spec.dart';

/// 设置与模型基座的回归测试。
///
/// 起因很具体：一次批量编辑把 `settings_spec.dart` 从「模型基座」那一行截到了
/// 列表结尾，memory / voice / privacy / channels / about 的键全被删掉，
/// 打开页面直接红屏（`未声明的设置项`）。这类错误编译期发现不了，
/// 只能靠一条「界面用到的键必须都有声明」的断言守住。
void main() {
  test('设置键唯一，且界面用到的键都有声明', () {
    final keys = ondraSettingSpecs.map((s) => s.key).toList();
    expect(keys.toSet().length, keys.length, reason: '有重复的键');

    // 与各页实际调用的 _specRow 一一对应。改页面时这里要跟着改——
    // 但正是这条对应关系能在键被误删时立刻炸。
    const used = [
      // 通用设置
      'general.language', 'general.fontSize', 'general.permissions',
      'general.launchAtLogin', 'general.preventSleep',
      'general.notify', 'general.notifySound', 'general.focusMute',
      // 人设设定（对话 / 记忆 / 数据 / 语音）
      'dialog.busySend', 'dialog.enterSend', 'dialog.replyLength',
      'dialog.remember', 'dialog.citeMemory', 'dialog.inferPreference',
      'memory.retention', 'memory.autoSummarize',
      'voice.tts', 'voice.timbre', 'voice.rate', 'voice.asrLanguage',
      // 通道接口
      'channels.qqBot', 'channels.qqSandbox', 'channels.allowGroups',
      'channels.busyPolicy',
      // 关于空谷（隐私已并入）
      'privacy.voiceCloud', 'privacy.imageCloud',
      'privacy.screenRead', 'privacy.redactLogs',
      'about.channel',
      // 日志页底部
      'logs.usageDetail',
    ];
    for (final key in used) {
      expect(() => ondraSettingSpec(key), returnsNormally, reason: '$key 没有声明');
    }

    // 反向：声明里不该留下已经没有界面的孤儿项。
    // 「容量上限」与「允许联网」被删掉，正是因为它们没法如实落地
    // （内核不淘汰记忆；没有全局网络总闸）。留着它们没人渲染，
    // 但会让 `_pushAll` 往 `settings.json` 写一个用户看不见的值。
    final declared = keys.toSet();
    for (final gone in [
      'memory.capacity',
      'privacy.online',
      'data.location',
      'privacy.keychain',
    ]) {
      expect(declared.contains(gone), isFalse, reason: '$gone 已删除，不该再声明');
    }
  });

  test('六个分类的预设 id 全局唯一，且合作 API 来自插件', () {
    final ids = <String>[];
    for (final category in ProviderCategory.values) {
      for (final preset in presetsOf(category)) {
        expect(preset.category, category, reason: '${preset.id} 归错了类');
        ids.add(preset.id);
      }
    }
    expect(ids.toSet().length, ids.length, reason: '预设 id 重复');
    expect(presetsOf(ProviderCategory.partner), isNotEmpty);
    expect(presetsOf(ProviderCategory.custom), isEmpty);
  });

  test('本地部署不需要密钥，地址都有默认端口', () {
    for (final preset in presetsOf(ProviderCategory.local)) {
      expect(preset.needsKey, isFalse, reason: '${preset.name} 不该要密钥');
      expect(preset.baseUrl, contains('127.0.0.1'));
      expect(preset.launchHint, isNotEmpty, reason: '${preset.name} 缺启动提示');
    }
  });

  test('自定义 API 必须有地址；预设可以后补地址', () {
    final client = ModelClient();
    final custom = OndraProvider(
      id: 'my-api',
      name: '自建',
      category: ProviderCategory.custom,
    );
    expect(client.addProvider(custom), isNotNull);

    final partner = presetsOf(ProviderCategory.partner).first;
    expect(client.addPreset(partner), isNull, reason: '合作方地址可以后填');
    expect(client.byId(partner.id)!.baseUrl, isEmpty);
  });

  test('无内核路由的提供商不能设为默认；有路由的能设且只标一个', () {
    final client = ModelClient();
    // 免费目录还没有内核路由：设为默认会让内核 initialize 直接报
    // no adapter registered，所以在这一步就拦下。
    final free = presetsOf(ProviderCategory.free).first;
    expect(client.addPreset(free), isNull);
    final freeProvider = client.byId(free.id)!;
    final freeChat = freeProvider.models.first;
    expect(client.setDefaultModel(freeProvider, freeChat), isNotNull);
    expect(client.isDefault(freeProvider, freeChat), isFalse);

    // 官方接口有路由（deepseek-official），能设为默认。
    final official = client.byId('deepseek')!;
    final officialChat = official.models.first;
    expect(client.setDefaultModel(official, officialChat), isNull);
    expect(client.isDefault(official, officialChat), isTrue);
    expect(client.isDefault(freeProvider, freeChat), isFalse);
  });
}
