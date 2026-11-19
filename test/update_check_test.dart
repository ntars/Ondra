import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/update_check_io.dart';
import 'package:ondra/app/update_check_stub.dart' as web;

const _release = 'https://github.com/ntars/Ondra/releases/tag/';

Map<String, Object> _entry(
  String tag, {
  bool draft = false,
  String? url,
  bool prerelease = false,
}) => {
  'tag_name': tag,
  'html_url': url ?? '$_release$tag',
  'draft': draft,
  'prerelease': prerelease,
};

UpdateFetch _fetch(Object? payload, {int status = 200}) =>
    (_) async =>
        UpdateFetchResponse(statusCode: status, body: jsonEncode(payload));

void main() {
  test(
    'stable returns the selected API html_url rather than releases/latest',
    () async {
      Uri? requested;
      final result = await UpdateChecker.check(
        currentVersion: '3.0.0-alpha',
        fetch: (uri) async {
          requested = uri;
          return UpdateFetchResponse(
            statusCode: 200,
            body: jsonEncode(_entry('v3.0.0')),
          );
        },
      );
      expect(
        requested.toString(),
        'https://api.github.com/repos/ntars/Ondra/releases/latest',
      );
      expect(result.status, UpdateStatus.available);
      expect(result.latest, '3.0.0');
      expect(result.url, '${_release}v3.0.0');
    },
  );

  test(
    'nightly selects the greatest version, ignores drafts and creation order',
    () async {
      final result = await UpdateChecker.check(
        currentVersion: '3.0.0-alpha1',
        channel: 'nightly',
        fetch: _fetch([
          {..._entry('v2.9.9'), 'created_at': '2026-11-20'},
          _entry('v9.0.0', draft: true),
          _entry('v3.0.0-alpha10', prerelease: true),
          _entry('v3.0.0-alpha2', prerelease: true),
          {
            ..._entry('v3.0.0-rc2', prerelease: true),
            'created_at': '2026-01-01',
          },
          null,
          {'tag_name': ''},
          _entry('not-a-version'),
        ]),
      );
      expect(result.status, UpdateStatus.available);
      expect(result.latest, '3.0.0-rc2');
      expect(result.url, '${_release}v3.0.0-rc2');
    },
  );

  test('nightly considers releases on later pages instead of only recently created releases', () async {
    final pages = <String?>[];
    final result = await UpdateChecker.check(
      currentVersion: '3.0.0',
      channel: 'nightly',
      fetch: (uri) async {
        pages.add(uri.queryParameters['page']);
        expect(uri.queryParameters['per_page'], '100');
        return UpdateFetchResponse(
          statusCode: 200,
          body: jsonEncode(
            pages.length == 1
                ? List.generate(100, (_) => _entry('v2.0.0'))
                : [_entry('v4.0.0')],
          ),
        );
      },
    );
    expect(pages, ['1', '2']);
    expect(result.latest, '4.0.0');
    expect(result.url, '${_release}v4.0.0');
  });

  test('stable excludes drafts and prereleases; nightly favors a final over its prerelease', () async {
    for (final entry in [
      _entry('v4.0.0', draft: true),
      _entry('v4.0.0-beta', prerelease: true),
    ]) {
      expect(
        (await UpdateChecker.check(
          currentVersion: '3.0.0',
          fetch: _fetch(entry),
        )).status,
        UpdateStatus.current,
      );
    }
    final nightly = await UpdateChecker.check(
      currentVersion: '3.0.0-beta',
      channel: 'nightly',
      fetch: _fetch([_entry('v3.0.0-rc10'), _entry('v3.0.0')]),
    );
    expect(nightly.latest, '3.0.0');
    expect(nightly.status, UpdateStatus.available);
  });

  test(
    'does not downgrade and preserves existing version comparison semantics',
    () async {
      for (final tag in ['v2.9.0', 'v3.0.0-alpha+999']) {
        final result = await UpdateChecker.check(
          currentVersion: '3.0.0-alpha+1',
          fetch: _fetch(_entry(tag)),
        );
        expect(result.status, UpdateStatus.current);
        expect(result.url, isNull);
      }
      expect(
        UpdateChecker.compareVersions('3.0.0-alpha10', '3.0.0-alpha2'),
        greaterThan(0),
      );
      expect(
        UpdateChecker.compareVersions('3.0.0', '3.0.0-rc99'),
        greaterThan(0),
      );
      expect(UpdateChecker.compareVersions('3.0+1', '3.0.0+2'), 0);
    },
  );

  test('empty, missing, rate-limited, malformed and failing responses are explicit', () async {
    expect(
      (await UpdateChecker.check(
        currentVersion: '1',
        channel: 'nightly',
        fetch: _fetch([]),
      )).status,
      UpdateStatus.current,
    );
    expect(
      (await UpdateChecker.check(
        currentVersion: '1',
        fetch: _fetch(null, status: 404),
      )).status,
      UpdateStatus.current,
    );
    for (final status in [403, 429, 500, 302]) {
      expect(
        (await UpdateChecker.check(
          currentVersion: '1',
          fetch: _fetch(null, status: status),
        )).status,
        UpdateStatus.failed,
      );
    }
    for (final payload in [null, [], 'not a release']) {
      expect(
        (await UpdateChecker.check(
          currentVersion: '1',
          fetch: _fetch(payload),
        )).status,
        UpdateStatus.failed,
      );
    }
    expect(
      (await UpdateChecker.check(
        currentVersion: '1',
        fetch: (_) async =>
            const UpdateFetchResponse(statusCode: 200, body: '{bad json'),
      )).status,
      UpdateStatus.failed,
    );
    expect(
      (await UpdateChecker.check(
        currentVersion: '1',
        fetch: (_) async => throw const SocketException('offline'),
      )).status,
      UpdateStatus.failed,
    );
    expect(
      (await UpdateChecker.check(
        currentVersion: '1',
        channel: 'unknown',
        fetch: (_) async {
          fail('invalid channel must not fetch');
        },
      )).status,
      UpdateStatus.failed,
    );
  });

  test('invalid or missing selected html_url fails, never falls back to latest or an older release', () async {
    for (final url in [
      'https://evil.example/release',
      'http://github.com/ntars/Ondra/releases/tag/v4',
      '',
    ]) {
      final result = await UpdateChecker.check(
        currentVersion: '1',
        channel: 'nightly',
        fetch: _fetch([_entry('v4.0.0', url: url), _entry('v3.0.0')]),
      );
      expect(result.status, UpdateStatus.failed);
      expect(result.url, isNull);
    }
    final result = await UpdateChecker.check(
      currentVersion: '1',
      fetch: _fetch({'tag_name': 'v4.0.0'}),
    );
    expect(result.status, UpdateStatus.failed);
  });

  test('URL validation rejects foreign origins, traversal, shell-like inputs and non-release pages', () async {
    final invalid = [
      'https://github.com.evil.example/ntars/Ondra/releases/tag/v4',
      'https://github.com@evil.example/ntars/Ondra/releases/tag/v4',
      'https://user@github.com/ntars/Ondra/releases/tag/v4',
      'https://github.com:443/ntars/Ondra/releases/tag/v4',
      'http://github.com/ntars/Ondra/releases/tag/v4',
      'file:///tmp/release',
      'javascript:alert(1)',
      '--help',
      'https://github.com/other/Ondra/releases/tag/v4',
      'https://github.com/ntars/Ondra/releases/download/v4/app.zip',
      'https://github.com/ntars/Ondra/releases/tag/v4?redirect=https://evil.example',
      'https://github.com/ntars/Ondra/releases/tag/v4#fragment',
      'https://github.com/ntars/Ondra/releases/tag/../latest',
      'https://github.com/ntars/Ondra/releases/tag/%2e%2e/latest',
      'https://github.com/ntars/Ondra/releases/tag/%252e%252e',
      'https://github.com/ntars/Ondra/releases/tag/a%2fb',
      'https://github.com/ntars/Ondra/releases/tag/v4%0A',
      'https://github.com/ntars/Ondra/releases/tag/v4\n',
      'https://github.com/ntars/Ondra/releases/tag/v4; touch /tmp/pwned',
      r'https://github.com/ntars/Ondra/releases/tag/v4\evil',
      'https://github.com/ntars/Ondra/releases/tag/',
    ];
    for (final url in invalid) {
      expect(isTrustedReleaseUrl(url), isFalse, reason: url);
      final result = await UpdateChecker.openRelease(
        url,
        launch: (_, _) async {
          fail('must not launch $url');
        },
      );
      expect(result.ok, isFalse);
    }
    for (final url in [
      '${_release}v3.0.0-alpha+1',
      UpdateChecker.releasesUrl,
    ]) {
      expect(isTrustedReleaseUrl(url), isTrue, reason: url);
    }
  });

  test(
    'safe platform launch receives one URL argument and reports exit errors',
    () async {
      const url = '${_release}v3.0.0-alpha';
      for (final platform in {
        'macos': 'open',
        'linux': 'xdg-open',
        'windows': 'explorer.exe',
      }.entries) {
        var calls = 0;
        final result = await UpdateChecker.openRelease(
          url,
          platform: platform.key,
          launch: (exe, args) async {
            calls++;
            expect(exe, platform.value);
            expect(args, [url]);
            return true;
          },
        );
        expect(result.ok, isTrue);
        expect(result.message, contains('已请求'));
        expect(calls, 1);
      }
      expect(
        (await UpdateChecker.openRelease(
          url,
          launch: (_, _) async => false,
        )).ok,
        isFalse,
      );
      expect(
        (await UpdateChecker.openRelease(
          url,
          launch: (_, _) async => throw const ProcessException('mock', []),
        )).ok,
        isFalse,
      );
      expect(
        (await UpdateChecker.openRelease(
          url,
          platform: 'android',
          launch: (_, _) async {
            fail('unsupported platform must not launch');
          },
        )).ok,
        isFalse,
      );
    },
  );

  test(
    'injected fetch is bounded and cannot start another page after timeout',
    () async {
      final pending = Completer<UpdateFetchResponse>();
      var calls = 0;
      final result = await UpdateChecker.check(
        currentVersion: '1',
        channel: 'nightly',
        timeout: const Duration(milliseconds: 20),
        fetch: (_) {
          calls++;
          return pending.future;
        },
      );
      expect(result.status, UpdateStatus.failed);
      expect(result.message, contains('超时'));
      pending.complete(
        UpdateFetchResponse(
          statusCode: 200,
          body: jsonEncode(List.generate(100, (_) => _entry('v2'))),
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(calls, 1);
    },
  );

  test('real HTTP pipeline has a deadline for connection, headers and stalled body, and closes its client', () async {
    for (final phase in ['connect', 'headers', 'body']) {
      final body = StreamController<List<int>>();
      final request = _Request(
        () => phase == 'headers'
            ? Completer<HttpClientResponse>().future
            : Future.value(_Response(200, body.stream)),
      );
      final client = _Client(
        () => phase == 'connect'
            ? Completer<HttpClientRequest>().future
            : Future.value(request),
      );
      final result = await UpdateChecker.check(
        currentVersion: '1',
        timeout: const Duration(milliseconds: 25),
        clientFactory: () => client,
      );
      expect(result.status, UpdateStatus.failed, reason: phase);
      expect(result.message, contains('超时'), reason: phase);
      expect(client.closed, isTrue, reason: phase);
      expect(client.force, isTrue, reason: phase);
      if (phase != 'connect') {
        expect(request.followRedirects, isFalse);
        expect(request.headers.values['User-Agent'], 'Ondra-Desktop');
        expect(request.headers.values.containsKey('Authorization'), isFalse);
      }
      // Only the body case has a listener; closing is enough to release it.
      unawaited(body.close());
    }
  });

  test('HTTP deadline is overall, not renewed between connection and response body', () async {
    final request = _Request(() async {
      await Future<void>.delayed(const Duration(milliseconds: 50));
      return _Response(
        200,
        Stream.value(utf8.encode(jsonEncode(_entry('v3')))),
      );
    });
    final client = _Client(() async {
      await Future<void>.delayed(const Duration(milliseconds: 50));
      return request;
    });
    final result = await UpdateChecker.check(
      currentVersion: '1',
      timeout: const Duration(milliseconds: 80),
      clientFactory: () => client,
    );
    expect(result.status, UpdateStatus.failed);
    expect(result.message, contains('超时'));
    expect(client.closed, isTrue);
  });

  test('HTTP client also closes after a successful response', () async {
    final request = _Request(
      () async =>
          _Response(200, Stream.value(utf8.encode(jsonEncode(_entry('v3'))))),
    );
    final client = _Client(() async => request);
    final result = await UpdateChecker.check(
      currentVersion: '1',
      clientFactory: () => client,
    );
    expect(result.status, UpdateStatus.available);
    expect(result.url, '${_release}v3');
    expect(client.closed, isTrue);
    expect(client.force, isTrue);
  });

  test('web stub truthfully refuses fetch and browser launch', () async {
    final result = await web.UpdateChecker.check(
      currentVersion: '1',
      fetch: (_) async {
        fail('web stub must not fetch');
      },
    );
    expect(result.status, UpdateStatus.failed);
    expect(
      (await web.UpdateChecker.openRelease(
        '${_release}v3',
        launch: (_, _) async {
          fail('web stub must not launch');
        },
      )).ok,
      isFalse,
    );
  });
}

class _Client extends Fake implements HttpClient {
  _Client(this.connect);
  final Future<HttpClientRequest> Function() connect;
  bool closed = false;
  bool? force;
  @override
  Duration? connectionTimeout;
  @override
  Future<HttpClientRequest> getUrl(Uri url) => connect();
  @override
  void close({bool force = false}) {
    closed = true;
    this.force = force;
  }
}

class _Request extends Fake implements HttpClientRequest {
  _Request(this.respond);
  final Future<HttpClientResponse> Function() respond;
  @override
  bool followRedirects = true;
  @override
  final _Headers headers = _Headers();
  @override
  Future<HttpClientResponse> close() => respond();
}

class _Headers extends Fake implements HttpHeaders {
  final values = <String, Object>{};
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {
    values[name] = value;
  }
}

class _Response extends Fake implements HttpClientResponse {
  _Response(this.statusCode, this.chunks);
  @override
  final int statusCode;
  final Stream<List<int>> chunks;
  @override
  Stream<S> transform<S>(StreamTransformer<List<int>, S> streamTransformer) =>
      chunks.transform(streamTransformer);
}
