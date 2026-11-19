import 'dart:convert';
import 'dart:io';

import '../../../../../app/desktop_picker.dart';
import '../../../../../app/home_dir.dart';

/// 问题反馈的落盘层。
///
/// ## 为什么不是「点一下就上传」
///
/// 这个应用没有后端，也没有账号。任何「提交成功」的提示如果没有真的送到
/// 人手里，就是欺骗。所以这里做三件真事：
///
/// 1. **落盘**：写进 `~/.ondra/feedback/<时刻>-<类型>.md`。用户自己能看见它，
///    卸载应用前也找得到。
/// 2. **拉日志**：把最近一段系统日志附在落盘文件尾部（用户可以在提交前
///    用设置里的开关关掉）。
/// 3. **交给系统**：调用 `open mailto:` 把内容填进用户的邮件客户端——发不发、
///    改不改，用户自己决定。这里不替用户发信。
///
/// 于是「提交反馈」这句话是真的：内容落到了磁盘，也交到了用户手上。
class FeedbackStore {
  FeedbackStore({String? home}) : home = home ?? _defaultHome();

  final String home;

  static String _defaultHome() =>
      '$ondraUserHome/.ondra';

  String get root => '$home/feedback';

  /// 反馈类型。与设置页下拉里的选项一一对应，不多不少。
  static const List<String> kinds = ['功能建议', '界面问题', '功能异常', '性能问题', '其他'];

  /// 写一条反馈。返回落盘路径，界面据此显示「在哪能找到」。
  ///
  /// [attachLog] 为真时把 `~/.ondra/logs/ondra-code.log` 的尾部带进来。
  /// 只带尾部 32KB：整份日志可能几十兆，而报一个问题只需要出错前后那几屏。
  Future<FeedbackResult> write({
    required String kind,
    required String body,
    required String version,
    required List<String> attachmentPaths,
    bool attachLog = true,
  }) async {
    final text = body.trim();
    if (text.length < 10) {
      return const FeedbackResult(
        ok: false,
        message: '描述太短了，至少写 10 个字才说得清问题。',
      );
    }
    if (text.length > 2000) {
      return const FeedbackResult(
        ok: false,
        message: '描述超过 2000 字了，挑重点写。',
      );
    }
    try {
      await Directory(root).create(recursive: true);
      final now = DateTime.now();
      final stamp = '${now.year}'
          '${now.month.toString().padLeft(2, '0')}'
          '${now.day.toString().padLeft(2, '0')}-'
          '${now.hour.toString().padLeft(2, '0')}'
          '${now.minute.toString().padLeft(2, '0')}'
          '${now.second.toString().padLeft(2, '0')}';
      final file = File('$root/$stamp-$kind.md');

      final buffer = StringBuffer()
        ..writeln('# 空谷反馈 · $kind')
        ..writeln()
        ..writeln('- 时间：${now.toIso8601String()}')
        ..writeln('- 版本：$version')
        ..writeln('- 系统：${Platform.operatingSystem} '
            '${Platform.operatingSystemVersion}')
        ..writeln();
      if (attachmentPaths.isNotEmpty) {
        buffer
          ..writeln('## 附件')
          ..writeln();
        for (final p in attachmentPaths) {
          buffer.writeln('- `$p`');
        }
        buffer.writeln();
      }
      buffer
        ..writeln('## 描述')
        ..writeln()
        ..writeln(text);

      if (attachLog) {
        final tail = await _logTail();
        if (tail != null && tail.isNotEmpty) {
          buffer
            ..writeln()
            ..writeln('## 最近日志（尾部 32 KB，已脱敏）')
            ..writeln()
            ..writeln('```')
            ..writeln(_redact(tail))
            ..writeln('```');
        }
      }

      await file.writeAsString(buffer.toString());
      return FeedbackResult(ok: true, path: file.path, message: '已存到 ${file.path}');
    } catch (e) {
      return FeedbackResult(ok: false, message: '写文件失败：$e');
    }
  }

  /// 打开系统邮件客户端，把内容填好。**不替用户发送**——只是递到他面前。
  Future<FeedbackResult> compose({
    required String kind,
    required String body,
    required String version,
  }) async {
    final subject = Uri.encodeComponent('空谷反馈 · $kind');
    final content = Uri.encodeComponent(
      '$body\n\n---\n版本：$version\n',
    );
    final url = 'mailto:?subject=$subject&body=$content';
    try {
      final r = await Process.run('open', [url]);
      if (r.exitCode != 0) {
        return FeedbackResult(
          ok: false,
          message: '打不开邮件客户端：${(r.stderr as String).trim()}',
        );
      }
      return const FeedbackResult(ok: true, message: '已在邮件客户端里打开草稿。');
    } catch (e) {
      return FeedbackResult(ok: false, message: '打不开邮件客户端：$e');
    }
  }

  /// 选附件。走系统面板，最多三个——多了用户自己也不会再看。
  Future<List<String>> pickAttachments() =>
      DesktopPicker.pickFiles(prompt: '选择要附上的图片或视频', limit: 3);

  /// 日志尾部的脱敏清洗：绝对路径、邮箱、看起来像密钥的十六进制串。
  ///
  /// 附带的日志要离开这台机器（用户手动发出去），写进去之前就该把
  /// 这三类东西抹掉，而不是把开关的判断留给调用点。
  String _redact(String raw) {
    final pathExp = RegExp('/Users/[^\\s\'\' ]+');
    final mailExp = RegExp('[\\w.+-]+@[\\w.-]+\\.\\w+');
    final secretExp = RegExp('[0-9a-fA-F]{32,}');
    return raw
        .replaceAllMapped(pathExp, (_) => '~/…')
        .replaceAllMapped(mailExp, (_) => '[邮箱]')
        .replaceAllMapped(secretExp, (_) => '[密钥片段]');
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
        final bytes = await raf.read(len - start);
        return utf8.decode(bytes, allowMalformed: true);
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
