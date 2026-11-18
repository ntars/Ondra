import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-browser/ui/browser_client.dart';

/// 白名单是「能不能读一个网页」的唯一一道门，所以它的判定值得单独测：
/// 规范化会不会放进 `javascript:`、子域算不算、移除后还能不能打开。
void main() {
  test('规范化：补协议、拒绝非 http(s)', () {
    expect(BrowserClient.normalize('example.com'), 'https://example.com');
    expect(BrowserClient.normalize('  https://a.b/c  '), 'https://a.b/c');
    expect(BrowserClient.normalize('javascript:alert(1)'), isNull);
    expect(BrowserClient.normalize('file:///etc/passwd'), isNull);
    expect(BrowserClient.normalize(''), isNull);
  });

  test('白名单：本域与子域放行，别的域拒绝', () {
    final client = BrowserClient();
    expect(client.sites, isNotEmpty, reason: '出厂带一条 deepseek 平台');
    final host = client.sites.first.host;

    expect(client.allowed('https://$host'), isTrue);
    expect(client.allowed('https://sub.$host/x'), isTrue);
    expect(client.allowed('https://evil.com'), isFalse);

    expect(client.open('https://evil.com'), isNotNull);
    expect(client.open('https://$host'), isNull);
  });

  test('移除后同一地址不再放行', () {
    final client = BrowserClient();
    final site = client.sites.first;
    client.openSite(site);
    expect(client.active, site.url);

    client.remove(site);
    expect(client.active, isNull);
    expect(client.allowed(site.url), isFalse);
  });
}
