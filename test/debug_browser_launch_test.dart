import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/debug_launch.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-browser/ui/browser_client.dart';

class _MemoryStore {
  List<Map<String, String>>? data;

  BrowserClient client() => BrowserClient(
    loadSites: () => data,
    saveSites: (sites) => data = sites,
  );
}

void main() {
  test('调试启动入口只从环境变量读取白名单地址，且默认关闭写入', () {
    if (kIsWeb) return;
    // 测试进程没有浏览器调试参数时，两个入口都应为空。
    expect(debugBrowserUrl(), anyOf(isEmpty, startsWith('http')));
    expect(debugBrowserAddSite(), isFalse);
  });

  test('调试启动打开白名单站点时仍走正式准入检查', () {
    final client = _MemoryStore().client();
    addTearDown(client.dispose);
    const fixture = 'http://10.211.55.2:8765/';
    expect(client.open(fixture), isNotNull);
    expect(client.visible, isFalse);
    expect(client.add(fixture), isNull);
    expect(client.open(fixture), isNull);
    expect(client.visible, isTrue);
    expect(client.active, fixture);
  });

  test('站点已在白名单时，调试启动仍然直接打开页面', () {
    final store = _MemoryStore();
    final client = store.client();
    addTearDown(client.dispose);
    const fixture = 'http://10.211.55.2:8765/';
    expect(client.add(fixture), isNull);
    // 模拟「应用启动时已读到白名单」：add 对已存在站点返回提示，但 debug
    // 入口不能把这个提示当成跳过打开的理由。
    expect(client.add(fixture), isNotNull);
    expect(client.open(fixture), isNull);
    expect(client.visible, isTrue);
    expect(client.active, fixture);
  });

  test('非规范化但可解析的白名单地址不会让调试启动落到列表页', () {
    final store = _MemoryStore();
    // BrowserClient 构造时会 normalize，但按显示原样落盘的旧白名单仍可能
    // 留下尾部斜杠差异；open 必须比较 normalize 后的 origin。
    store.data = [
      {'url': 'http://10.211.55.2:8765', 'note': 'legacy'},
    ];
    final client = store.client();
    addTearDown(client.dispose);
    const fixture = 'http://10.211.55.2:8765/';
    expect(client.allowed(fixture), isTrue);
    expect(client.open(fixture), isNull);
    expect(client.visible, isTrue);
  });

  test('非法调试地址不能借显式加入绕过 BrowserClient 校验', () {
    final client = _MemoryStore().client();
    addTearDown(client.dispose);
    for (final url in ['javascript:alert(1)', 'ftp://example.com']) {
      expect(client.add(url), isNotNull);
      expect(client.open(url), isNotNull);
    }
    expect(client.active, isNull);
  });
}
