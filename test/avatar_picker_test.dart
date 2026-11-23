import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/home_dir.dart';
import 'package:ondra/design/avatar_io.dart';

void main() {
  test('头像路径与读取端共用数据根目录', () {
    expect(avatarTargetPath(), '$ondraUserDataRoot/avatar.png');
    expect(
      avatarTargetPath('/tmp/ondra-test'),
      '/tmp/ondra-test/avatar.png',
    );
  });

  test('只接受 System.Drawing 能直接解码的常见格式', () {
    for (final path in [
      r'C:\Users\a\photo.PNG',
      '/tmp/a.jpeg',
      '/tmp/a.bmp',
      '/tmp/a.tif',
    ]) {
      expect(avatarSourceSupported(path), isTrue, reason: path);
    }
    for (final path in ['/tmp/a.heic', '/tmp/a.webp', '/tmp/a.txt', '/tmp/a']) {
      expect(avatarSourceSupported(path), isFalse, reason: path);
    }
  });

  test('PowerShell 脚本转义路径并把裁切尺寸写死为 512', () {
    final script = buildWindowsAvatarScript(
      r"C:\Users\O'Brien\photo.jpg",
      r"C:\Users\O'Brien\.ondra\avatar.png",
    );
    expect(script, contains(r"'C:\Users\O''Brien\photo.jpg'"));
    expect(script, contains('System.Drawing.Bitmap(512, 512)'));
    expect(script, contains('ImageFormat]::Png'));
    expect(script, contains('Move-Item -LiteralPath'));
  });

  test('转换成功、失败与取消形状一致', () async {
    final previous = debugAvatarProcessRunner;
    addTearDown(() => debugAvatarProcessRunner = previous);
    debugAvatarProcessRunner = (cmd, args, {stdoutEncoding, stderrEncoding}) async {
      expect(cmd, 'powershell');
      expect(args, contains('-STA'));
      return ProcessResult(0, 0, 'ok\n', '');
    };
    expect(await convertWindowsAvatar('/tmp/a.png', target: '/tmp/out.png'), isTrue);

    debugAvatarProcessRunner = (cmd, args, {stdoutEncoding, stderrEncoding}) async {
      return ProcessResult(0, 1, '', 'bad image');
    };
    expect(await convertWindowsAvatar('/tmp/a.png', target: '/tmp/out.png'), isFalse);

    // 不合法的扩展名甚至不应该起 PowerShell。
    var started = false;
    debugAvatarProcessRunner = (cmd, args, {stdoutEncoding, stderrEncoding}) async {
      started = true;
      return ProcessResult(0, 0, 'ok', '');
    };
    expect(await convertWindowsAvatar('/tmp/a.heic', target: '/tmp/out.png'), isFalse);
    expect(started, isFalse);
  });
}
