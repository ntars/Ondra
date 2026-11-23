import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-browser/ui/browser_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-browser/ui/browser_store_io.dart'
    as disk;
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-browser/ui/web_view.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-browser/ui/web_view_io.dart'
    as io_view;
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-browser/ui/web_view_stub.dart'
    as preview;

/// 所有 client 都注入存储，文件测试仅使用临时目录，不读写真实 ~/.ondra。
class _MemoryStore {
  List<Map<String, String>>? data;
  int writes = 0;

  BrowserClient client() {
    final client = BrowserClient(
      loadSites: () => data,
      saveSites: (sites) {
        data = sites;
        writes++;
      },
    );
    addTearDown(client.dispose);
    return client;
  }
}

void main() {
  test('白名单保存失败会回滚新增与移除，保留原有准入规则', () {
    var fail = true;
    final client = BrowserClient(
      loadSites: () => [
        {'url': 'https://example.com', 'note': ''},
      ],
      saveSites: (_) {
        if (fail) throw const FileSystemException('只读目录');
      },
    );
    addTearDown(client.dispose);
    expect(client.open('https://example.com/page'), isNull);
    expect(client.add('https://other.example'), contains('未保存'));
    expect(client.allowed('https://other.example'), isFalse);
    expect(client.sites, hasLength(1));
    final site = client.sites.single;
    client.remove(site);
    expect(client.error, contains('规则未改变'));
    expect(client.active, 'https://example.com/page');
    expect(client.sites.single, same(site));
    fail = false;
    client.remove(site);
    expect(client.error, isNull);
    expect(client.sites, isEmpty);
    expect(client.active, isNull);
  });

  test('规范化：补 HTTPS、保留显式协议和端口', () {
    for (final entry in {
      'example.com': 'https://example.com',
      '  https://a.b/c  ': 'https://a.b/c',
      'HTTPS://EXAMPLE.COM/path': 'https://example.com/path',
      'example.com:8443/path': 'https://example.com:8443/path',
      'http://localhost:8080': 'http://localhost:8080',
      'https://127.0.0.1': 'https://127.0.0.1',
      'https://[::1]/': 'https://[::1]/',
    }.entries) {
      expect(
        BrowserClient.normalize(entry.key),
        entry.value,
        reason: entry.key,
      );
    }
  });

  test('规范化：拒绝非网页 scheme、凭据和模糊 host', () {
    for (final input in [
      '',
      'javascript:alert(1)',
      'javascript:80',
      'data:text/html,test',
      'mailto:user@example.com',
      'file:///etc/passwd',
      'ftp://example.com',
      'https://',
      'https:///example.com',
      'https://user:secret@example.com',
      'https://@example.com',
      r'https://example.com\@evil.com',
      'https://exa mple.com',
      'https://example.com\n.evil.com',
      'https://%65xample.com',
      'https://*.example.com',
      'https://example.com.',
      'https://-example.com',
      'https://example..com',
      'https://127.1',
      'https://0177.0.0.1',
      'https://256.0.0.1',
      'https://example.com:0',
      'https://example.com:65536',
      'https://example.com:999999999999999999999999999999',
      'https://999999999999999999999999999999.0.0.1',
    ]) {
      expect(BrowserClient.normalize(input), isNull, reason: input);
    }
  });

  test('精确 origin 放行，子域/后缀攻击/协议/端口/凭据不能越界', () {
    final client = _MemoryStore().client();
    expect(client.sites.single.host, 'platform.deepseek.com');
    for (final url in [
      'https://platform.deepseek.com',
      'https://PLATFORM.DEEPSEEK.COM/path?q=1#fragment',
      'https://platform.deepseek.com:443/keys',
    ]) {
      expect(client.allowed(url), isTrue, reason: url);
    }
    for (final url in [
      'https://sub.platform.deepseek.com',
      'https://platform.deepseek.com.evil.com',
      'https://evilplatform.deepseek.com',
      'https://deepseek.com',
      'https://evil.com',
      'http://platform.deepseek.com',
      'https://platform.deepseek.com:444',
      'ftp://platform.deepseek.com',
      'file://platform.deepseek.com/secret',
      'javascript://platform.deepseek.com/alert(1)',
      'https://platform.deepseek.com@evil.com',
      'https://user:password@platform.deepseek.com',
      'https://platform.deepseek.com.',
      '//platform.deepseek.com',
      'platform.deepseek.com',
    ]) {
      expect(client.allowed(url), isFalse, reason: url);
      expect(
        client.openSite(OndraSite(url: url)),
        isNotNull,
        reason: 'openSite 也必须校验：$url',
      );
    }
    expect(client.active, isNull);
    expect(client.open('https://platform.deepseek.com'), isNull);
    expect(client.visible, isTrue);
  });

  test('其他 origin 必须显式配置，路径不限制同 origin 导航', () {
    final client = _MemoryStore().client();
    expect(client.add('https://sub.platform.deepseek.com/start'), isNull);
    expect(client.add('http://localhost:8080/start'), isNull);
    expect(client.allowed('https://sub.platform.deepseek.com/other'), isTrue);
    expect(client.allowed('http://localhost:8080/other'), isTrue);
    expect(client.allowed('http://localhost'), isFalse);
    expect(client.allowed('https://localhost:8080'), isFalse);
    expect(client.allowed('http://sub.localhost:8080'), isFalse);
  });

  test('删除最后一项，空列表保存后重新加载仍为空', () {
    final store = _MemoryStore();
    final client = store.client();
    final site = client.sites.single;
    expect(client.open('https://${site.host}/other'), isNull);
    client.remove(site);
    expect(client.active, isNull, reason: '也关闭该 origin 的其他路径');
    expect(client.allowed(site.url), isFalse);
    expect(store.data, isEmpty);
    expect(store.writes, 1);
    final restored = store.client();
    expect(restored.sites, isEmpty);
    expect(restored.openSite(site), isNotNull, reason: '旧条目不能绕过已撤销权限');
    expect(restored.active, isNull);
  });

  test('显示、打开、关闭均不写盘；仅清单变更写盘', () {
    final store = _MemoryStore();
    final client = store.client();
    client.showList();
    client.openSite(client.sites.single);
    client.backToList();
    client.close();
    expect(store.writes, 0);
    expect(client.add('https://example.com'), isNull);
    expect(store.writes, 1);
    expect(client.add('https://example.com'), isNotNull);
    expect(client.add('file:///tmp/test'), isNotNull);
    expect(store.writes, 1);
  });

  test('临时文件存储：无文件与空数组不同，且首次保存创建父目录', () {
    final dir = Directory.systemTemp.createTempSync('ondra-browser-test-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final file = File('${dir.path}/nested/browser-sites.json');
    expect(disk.loadBrowserSites(file: file), isNull);
    BrowserClient fromFile() {
      final client = BrowserClient(
        loadSites: () => disk.loadBrowserSites(file: file),
        saveSites: (sites) => disk.saveBrowserSites(sites, file: file),
      );
      addTearDown(client.dispose);
      return client;
    }

    final client = fromFile();
    expect(client.sites, isNotEmpty);
    client.remove(client.sites.single);
    expect(jsonDecode(file.readAsStringSync()), isEmpty);
    expect(disk.loadBrowserSites(file: file), isEmpty);
    final restored = fromFile();
    expect(restored.sites, isEmpty);
    restored.add('https://example.com');
    expect(fromFile().sites.single.url, 'https://example.com');

    file.writeAsStringSync('not-json');
    expect(fromFile().sites, isEmpty, reason: '损坏文件不能恢复默认准入权限');
    file.writeAsStringSync('{"url":"https://example.com"}');
    expect(fromFile().sites, isEmpty);
    file.writeAsStringSync('[{"url":"javascript:alert(1)"},null,{"url":42}]');
    expect(fromFile().sites, isEmpty);
  });

  for (final platform in TargetPlatform.values) {
    testWidgets('$platform 平台能力与不可用占位一致', (tester) async {
      debugDefaultTargetPlatformOverride = platform;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final supported =
          platform == TargetPlatform.macOS ||
          platform == TargetPlatform.android ||
          platform == TargetPlatform.windows;
      expect(embeddedBrowserAvailable, supported);
      if (supported) return;
      await tester.pumpWidget(
        const MaterialApp(
          home: OndraWebView(
            url: 'https://example.com',
            allowedSites: ['https://example.com'],
          ),
        ),
      );
      expect(find.byType(AppKitView), findsNothing);
      expect(find.byType(io_view.WindowsView), findsNothing);
      expect(find.text('这个平台没有内嵌浏览器'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Web 预览明确不可用，不构建 AppKitView', (tester) async {
    expect(preview.embeddedBrowserAvailable, isFalse);
    await tester.pumpWidget(
      const MaterialApp(
        home: preview.OndraWebView(
          url: 'https://example.com',
          allowedSites: ['https://example.com'],
        ),
      ),
    );
    expect(find.byType(AppKitView), findsNothing);
    expect(find.byType(io_view.WindowsView), findsNothing);
    expect(find.text('这个平台没有内嵌浏览器'), findsOneWidget);
  });

  testWidgets('macOS 传递白名单、呈现原生拒绝原因，规则变化重建并停止旧视图', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final messenger = tester.binding.defaultBinaryMessenger;
    final creations = <Map<dynamic, dynamic>>[];
    final calls = <String>[];
    final channels = <MethodChannel>[];
    messenger.setMockMethodCallHandler(SystemChannels.platform_views, (
      call,
    ) async {
      if (call.method == 'create') {
        final args = call.arguments as Map;
        creations.add(args);
        final id = args['id'] as int;
        final channel = MethodChannel('ondra/webview/$id');
        channels.add(channel);
        messenger.setMockMethodCallHandler(channel, (call) async {
          calls.add('$id:${call.method}');
          return null;
        });
      }
      return null;
    });
    addTearDown(() {
      messenger.setMockMethodCallHandler(SystemChannels.platform_views, null);
      for (final channel in channels) {
        messenger.setMockMethodCallHandler(channel, null);
      }
    });

    Widget view(List<String> sites) => MaterialApp(
      home: OndraWebView(url: 'https://example.com', allowedSites: sites),
    );
    await tester.pumpWidget(view(['https://example.com']));
    await tester.pumpAndSettle();
    expect(creations, hasLength(1));
    final first = creations.single;
    final params = const StandardMessageCodec().decodeMessage(
      ByteData.sublistView(first['params'] as Uint8List),
    ) as Map;
    expect(params['url'], 'https://example.com');
    expect(params['allowedSites'], ['https://example.com']);
    expect(calls, contains('${first['id']}:start'));

    const reason = '已阻止导航：目标的协议、主机或端口不在白名单里。';
    final reply = Completer<ByteData?>();
    tester.binding.channelBuffers.push(
      channels.single.name,
      const StandardMethodCodec().encodeMethodCall(
        const MethodCall('navigationRejected', {'reason': reason}),
      ),
      reply.complete,
    );
    await reply.future;
    await tester.pump();
    expect(find.text(reason), findsOneWidget);

    await tester.pumpWidget(view([]));
    await tester.pumpAndSettle();
    expect(creations, hasLength(2));
    expect(calls, contains('${first['id']}:stop'));
    expect(find.text(reason), findsNothing);
    final changed = const StandardMessageCodec().decodeMessage(
      ByteData.sublistView(creations.last['params'] as Uint8List),
    ) as Map;
    expect(changed['allowedSites'], isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    expect(calls, contains('${creations.last['id']}:stop'));
    expect(tester.takeException(), isNull);
  }, skip: !Platform.isMacOS);

  // 这里只验证 Dart 的平台分支与协议；不模拟 WebView2 运行时，也不宣称
  // Windows 原生构建/渲染已验证。宿主 create 在测试里返回假纹理 ID。
  testWidgets('Windows 分支复用白名单协议并可被 macOS 单元测试覆盖', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    expect(embeddedBrowserAvailable, isTrue);

    final messenger = tester.binding.defaultBinaryMessenger;
    const host = MethodChannel(io_view.ondraWebViewHostChannel);
    final creations = <Map<dynamic, dynamic>>[];
    final calls = <String>[];
    final channels = <MethodChannel>[];
    messenger.setMockMethodCallHandler(host, (call) async {
      if (call.method == 'create') {
        final args = call.arguments as Map;
        creations.add(args);
        final viewId = args['id'] as int;
        final channel = MethodChannel('ondra/webview/$viewId');
        channels.add(channel);
        messenger.setMockMethodCallHandler(channel, (call) async {
          calls.add('$viewId:${call.method}');
          return null;
        });
        return args['id'] as int;
      }
      return null;
    });
    addTearDown(() {
      messenger.setMockMethodCallHandler(host, null);
      for (final channel in channels) {
        messenger.setMockMethodCallHandler(channel, null);
      }
    });

    Widget view(List<String> sites) => MaterialApp(
      home: OndraWebView(url: 'https://example.com', allowedSites: sites),
    );
    await tester.pumpWidget(view(['https://example.com']));
    await tester.pumpAndSettle();
    expect(find.byType(io_view.WindowsView), findsOneWidget);
    expect(find.byType(AppKitView), findsNothing);
    expect(creations, hasLength(1));
    expect(creations.single['viewType'], 'ondra/webview');
    final params = const StandardMessageCodec().decodeMessage(
      ByteData.sublistView(creations.single['params'] as Uint8List),
    ) as Map;
    expect(params['url'], 'https://example.com');
    expect(params['allowedSites'], ['https://example.com']);
    expect(calls, contains('${creations.single['id']}:start'));

    const reason = '已阻止导航：目标的协议、主机或端口不在白名单里。';
    final reply = Completer<ByteData?>();
    tester.binding.channelBuffers.push(
      channels.single.name,
      const StandardMethodCodec().encodeMethodCall(
        const MethodCall('navigationRejected', {'reason': reason}),
      ),
      reply.complete,
    );
    await reply.future;
    await tester.pump();
    expect(find.text(reason), findsOneWidget);

    await tester.pumpWidget(view([]));
    await tester.pumpAndSettle();
    expect(creations, hasLength(2));
    expect(calls, contains('${creations.first['id']}:stop'));
    expect(find.text(reason), findsNothing);
    final changed = const StandardMessageCodec().decodeMessage(
      ByteData.sublistView(creations.last['params'] as Uint8List),
    ) as Map;
    expect(changed['allowedSites'], isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    expect(calls, contains('${creations.last['id']}:stop'));
    expect(tester.takeException(), isNull);
  });
}
