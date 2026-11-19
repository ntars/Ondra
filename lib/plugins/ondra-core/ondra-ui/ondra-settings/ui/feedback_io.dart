import 'dart:convert';
import 'dart:io';

import '../../../../../app/desktop_picker.dart';
import '../../../../../app/home_dir.dart';

/// 仅保存本地报告和邮件草稿，不上传、不发送，也不读取邮件账号或凭据。
class FeedbackStore {
  FeedbackStore({
    String? home,
    Future<bool> Function(String, List<String>)? launch,
    String? platform,
  }) : home = home ?? '$ondraUserHome/.ondra',
       _launch = launch ?? _systemLaunch,
       _platform = platform ?? Platform.operatingSystem;

  final String home;
  final Future<bool> Function(String, List<String>) _launch;
  final String _platform;

  String get root => '$home/feedback';

  static const List<String> kinds = ['功能建议', '界面问题', '功能异常', '性能问题', '其他'];
  static const _privacyNotice = '日志仅尽力遮盖常见敏感信息，不保证完全脱敏；描述和附件未自动脱敏，请在分享前检查。';
  static const _draftNotice =
      '邮件草稿包含报告、日志（如有）和附件副本，尚未发送。'
      '系统或邮件客户端可能只预览 .eml，或不保留附件；'
      '请核对，必要时新建邮件并从报告目录手动附加 report.md 和 attachments 中的文件。';

  /// 返回独立报告目录内的 report.md；附件为副本，原文件不被修改。
  Future<FeedbackResult> write({
    required String kind,
    required String body,
    required String version,
    required List<String> attachmentPaths,
    bool attachLog = true,
  }) async {
    if (!kinds.contains(kind)) {
      return const FeedbackResult(ok: false, message: '未知的反馈类型。');
    }
    if (attachmentPaths.length > 3) {
      return const FeedbackResult(ok: false, message: '最多只能添加 3 个附件。');
    }
    final text = body.trim();
    if (text.length < 10 || text.length > 2000) {
      return const FeedbackResult(ok: false, message: '描述须为 10–2000 字。');
    }
    // 不跨异步边界继续使用调用者可变的列表。
    final sources = List<String>.of(attachmentPaths);
    Directory? session;
    try {
      if (await FileSystemEntity.type(root, followLinks: false) ==
          FileSystemEntityType.link) {
        throw const FileSystemException('反馈目录不能是符号链接');
      }
      final parent = await Directory(root).absolute.create(recursive: true);
      session = await parent.createTemp('report-');
      final copies = <String>[];
      if (sources.isNotEmpty) {
        await Directory('${session.path}/attachments').create();
      }
      for (var i = 0; i < sources.length; i++) {
        if (await FileSystemEntity.type(sources[i], followLinks: false) !=
            FileSystemEntityType.file) {
          throw const FileSystemException('附件必须是普通文件，不能是目录或符号链接');
        }
        final basename = sources[i].replaceAll(r'\', '/').split('/').last;
        var safeName = basename.replaceAll(RegExp(r'[^a-zA-Z0-9._-]'), '_');
        if (safeName.isEmpty) safeName = 'attachment';
        if (safeName.length > 120) safeName = safeName.substring(0, 120);
        // 序号既避免同名覆盖，也避免前导点、路径分隔符和 MIME 头注入。
        final relative = 'attachments/0${i + 1}-$safeName';
        await File(sources[i]).copy('${session.path}/$relative');
        copies.add(relative);
      }

      final buffer = StringBuffer()
        ..writeln('# 空谷反馈 · $kind')
        ..writeln()
        ..writeln('- 时间：${DateTime.now().toIso8601String()}')
        ..writeln('- 版本：$version')
        ..writeln(
          '- 系统：${Platform.operatingSystem} '
          '${Platform.operatingSystemVersion}',
        )
        ..writeln()
        ..writeln(_privacyNotice)
        ..writeln()
        ..writeln('## 描述')
        ..writeln()
        ..writeln(text);
      if (copies.isNotEmpty) {
        buffer
          ..writeln()
          ..writeln('## 附件（报告目录内的副本）');
        for (final copy in copies) {
          buffer.writeln('- `$copy`');
        }
      }
      if (attachLog) {
        final tail = await _logTail();
        buffer
          ..writeln()
          ..writeln('## 最近日志（尾部最多 32 KB，仅尽力脱敏，请人工检查）')
          ..writeln()
          ..writeln(tail == null || tail.isEmpty ? '没有可读取的日志。' : _redact(tail));
      }
      final report = File('${session.path}/report.md');
      await report.writeAsString(buffer.toString());
      await File('${session.path}/manifest.json')
          .writeAsString(jsonEncode({'kind': kind, 'attachments': copies}));
      return FeedbackResult(
        ok: true,
        path: report.path,
        message: '已保存本地报告：${report.path}。$_privacyNotice',
      );
    } catch (e) {
      // 只清理本次 createTemp 成功创建的目录，不删除 root、原附件或旧报告。
      if (session != null) await _cleanup(session);
      return FeedbackResult(ok: false, message: '保存反馈失败：$e');
    }
  }

  /// [reportPath] 接收 write 返回的 path，以保存的报告及附件为准。
  /// 不传时兼容旧调用，只保存 kind/body/version，不额外收集日志或附件。
  /// 默认仅生成自包含 .eml；UI 应先显示客户端兼容性提示，再在用户明确点击后
  /// 传 openDraft: true。即使系统接受打开请求，也不代表草稿已可编辑或已发送。
  Future<FeedbackResult> compose({
    required String kind,
    required String body,
    required String version,
    String? reportPath,
    bool openDraft = false,
  }) async {
    if (!kinds.contains(kind)) {
      return const FeedbackResult(ok: false, message: '未知的反馈类型。');
    }
    if (reportPath == null) {
      final saved = await write(
        kind: kind,
        body: body,
        version: version,
        attachmentPaths: const [],
        attachLog: false,
      );
      if (!saved.ok) return saved;
      reportPath = saved.path!;
    }
    Directory? draftDirectory;
    File draft;
    try {
      final report = File(reportPath).absolute;
      final session = report.parent;
      final canonicalRoot = await Directory(root).resolveSymbolicLinks();
      if (report.uri.pathSegments.last != 'report.md' ||
          !session.uri.pathSegments
              .where((p) => p.isNotEmpty)
              .last
              .startsWith('report-') ||
          await FileSystemEntity.type(session.path, followLinks: false) !=
              FileSystemEntityType.directory ||
          await session.parent.resolveSymbolicLinks() != canonicalRoot) {
        throw const FileSystemException('请选择 write 返回的本地报告路径');
      }
      await _requireFile(report);
      final manifestFile = File('${session.path}/manifest.json');
      await _requireFile(manifestFile);
      final manifest = jsonDecode(await manifestFile.readAsString());
      if (manifest is! Map ||
          !kinds.contains(manifest['kind']) ||
          manifest['attachments'] is! List) {
        throw const FormatException('报告清单无效');
      }
      final names = manifest['attachments'] as List;
      if (names.length > 3 || names.toSet().length != names.length) {
        throw const FormatException('报告附件数量或名称无效');
      }
      final attachments = <File>[];
      if (names.isNotEmpty &&
          await FileSystemEntity.type(
                '${session.path}/attachments',
                followLinks: false,
              ) !=
              FileSystemEntityType.directory) {
        throw const FileSystemException('附件目录无效');
      }
      for (final name in names) {
        if (name is! String ||
            !RegExp(r'^attachments/0[1-3]-[a-zA-Z0-9._-]{1,120}$')
                .hasMatch(name)) {
          throw const FormatException('报告附件路径无效');
        }
        final file = File('${session.path}/$name');
        await _requireFile(file);
        attachments.add(file);
      }
      draftDirectory = await session.createTemp('draft-');
      draft = File('${draftDirectory.path}/feedback.eml');
      final sink = draft.openWrite();
      // Base64 内容不含连字符，故不会与边界相撞。
      const boundary = '----Ondra-Feedback-MIME';
      try {
        sink.write(
          'Subject: =?UTF-8?B?${base64Encode(utf8.encode('空谷反馈 · ${manifest['kind']}'))}?=\r\n'
          'MIME-Version: 1.0\r\n'
          'X-Unsent: 1\r\n'
          'Content-Type: multipart/mixed; boundary="$boundary"\r\n\r\n'
          '--$boundary\r\n'
          'Content-Type: text/plain; charset=UTF-8\r\n'
          'Content-Transfer-Encoding: base64\r\n\r\n',
        );
        await _writeBase64(sink, report.openRead());
        // 报告也作为真实附件，方便不支持编辑 .eml 的客户端手动转交。
        for (final file in [report, ...attachments]) {
          final name = file.uri.pathSegments.last;
          sink.write(
            '--$boundary\r\n'
            'Content-Type: application/octet-stream\r\n'
            'Content-Disposition: attachment; filename="$name"\r\n'
            'Content-Transfer-Encoding: base64\r\n\r\n',
          );
          await _writeBase64(sink, file.openRead());
        }
        sink.write('--$boundary--\r\n');
        await sink.flush();
      } finally {
        await sink.close();
      }
    } catch (e) {
      if (draftDirectory != null) await _cleanup(draftDirectory);
      return FeedbackResult(ok: false, message: '生成邮件草稿失败：$e');
    }

    if (!openDraft) {
      return FeedbackResult(
        ok: true,
        path: draft.path,
        message: '草稿已保存：${draft.path}。$_draftNotice',
      );
    }
    final executable = switch (_platform) {
      'macos' => 'open',
      'linux' => 'xdg-open',
      'windows' => 'explorer.exe',
      _ => null,
    };
    try {
      if (executable != null &&
          await _launch(executable, [
            draft.absolute.path,
          ]).timeout(const Duration(seconds: 10))) {
        return FeedbackResult(
          ok: true,
          path: draft.path,
          message: '已请求系统打开 ${draft.path}。$_draftNotice',
        );
      }
      return FeedbackResult(
        ok: false,
        path: draft.path,
        message: '系统未能打开草稿，请手动打开 ${draft.path}。$_draftNotice',
      );
    } catch (e) {
      return FeedbackResult(
        ok: false,
        path: draft.path,
        message: '打开草稿失败：$e。草稿保留在 ${draft.path}。$_draftNotice',
      );
    }
  }

  Future<List<String>> pickAttachments() =>
      DesktopPicker.pickFiles(prompt: '选择要附上的图片或视频', limit: 3);

  static Future<void> _requireFile(File file) async {
    if (await FileSystemEntity.type(file.path, followLinks: false) !=
        FileSystemEntityType.file) {
      throw const FileSystemException('报告及附件必须是普通文件，不能是符号链接');
    }
  }

  static Future<void> _cleanup(Directory directory) async {
    try {
      await directory.delete(recursive: true);
    } catch (_) {
      // 清理失败不扩大删除范围；保留原始错误。
    }
  }

  static Future<bool> _systemLaunch(
    String executable,
    List<String> arguments,
  ) async =>
      (await Process.run(executable, arguments, runInShell: false)).exitCode ==
      0;

  /// 流式编码，跨输入块保留 base64 状态，输出 RFC 2045 的 76 列 CRLF。
  static Future<void> _writeBase64(IOSink sink, Stream<List<int>> bytes) async {
    var pending = '';
    await for (final chunk in bytes.transform(base64.encoder)) {
      pending += chunk;
      var offset = 0;
      while (pending.length - offset >= 76) {
        sink.write('${pending.substring(offset, offset + 76)}\r\n');
        offset += 76;
      }
      pending = pending.substring(offset);
      await sink.flush();
    }
    if (pending.isNotEmpty) sink.write('$pending\r\n');
  }

  String _redact(String raw) {
    final authorization = RegExp(
      r'''\b(?:proxy-)?authorization\b["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)''',
      caseSensitive: false,
    );
    final keys = RegExp(
      r'''\b(?:x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret[-_]?key|token|password)\b["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)''',
      caseSensitive: false,
    );
    return raw
        .replaceAll(authorization, '[Authorization 已隐藏]')
        .replaceAll(keys, '[凭据已隐藏]')
        .replaceAll(
          RegExp(r'\bBearer\s+[a-zA-Z0-9._~+/=-]+', caseSensitive: false),
          '[Bearer 已隐藏]',
        )
        .replaceAll(
          RegExp(r'\b(?:sk-|gh[pousr]_|github_pat_)[a-zA-Z0-9_-]{8,}'),
          '[密钥已隐藏]',
        )
        .replaceAll(
          RegExp(r'''(?:/Users/|/home/|[A-Za-z]:\\Users\\)[^\s"'<>]+'''),
          '~/…',
        )
        .replaceAll(
          RegExp(r'\b[\w.+-]{1,64}@[\w.-]{1,253}\.\w{2,63}\b'),
          '[邮箱]',
        )
        .replaceAll(RegExp(r'[0-9a-fA-F]{32,}'), '[密钥片段]');
  }

  Future<String?> _logTail() async {
    try {
      final f = File('$home/logs/ondra-code.log');
      if (!await f.exists()) return null;
      final len = await f.length();
      const window = 32 * 1024;
      final start = len > window ? len - window : 0;
      final raf = await f.open();
      try {
        await raf.setPosition(start);
        return utf8.decode(await raf.read(len - start), allowMalformed: true);
      } finally {
        await raf.close();
      }
    } catch (_) {
      return null;
    }
  }
}

class FeedbackResult {
  const FeedbackResult({required this.ok, required this.message, this.path});

  final bool ok;
  final String message;
  final String? path;
}
