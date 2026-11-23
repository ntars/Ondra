import 'dart:convert' show Encoding, utf8;
import 'dart:io' show File, Platform, Process, ProcessResult;
import 'dart:typed_data';

import 'package:flutter/services.dart' show MethodChannel;
import '../app/desktop_picker_io.dart';
import '../app/home_dir.dart';

/// 头像文件：`~/.ondra/avatar.png`。
///
///  macOS / Android 的写入由原生侧完成（居中裁方 + 缩到 512 + 编码 PNG）；
///  Windows 走系统文件面板选图，再用 PowerShell + System.Drawing 原地做同一件事。
///  这里负责读与删。读用同步：文件最多几十 KB，且启动首帧就要显示头像，异步会闪一下默认图。
const MethodChannel _channel = MethodChannel('ondra/avatar');
const String _pickerPrompt = '选择一张图片作为头像';
const int _avatarSide = 512;
const Set<String> _sourceExtensions = {
  '.png',
  '.jpg',
  '.jpeg',
  '.bmp',
  '.gif',
  '.tif',
  '.tiff',
};

File get _file {
  return File(avatarTargetPath());
}

/// 头像落盘位置。公开出来是为了让 Windows 转换脚本与读取端共用同一个路径，
/// 免得选图写了 A 文件、启动读 B 文件。
String avatarTargetPath([String? dataRoot]) =>
    '${dataRoot ?? ondraUserDataRoot}/avatar.png';

/// System.Drawing 能直接解的常见位图格式。HEIC/WebP 需要先装扩展，不在这里
/// 假装支持：选中后静默失败比在面板里看不到更让人困惑。
bool avatarSourceSupported(String path) {
  final dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return _sourceExtensions.contains(path.substring(dot).toLowerCase());
}

/// PowerShell 单引号字面量。路径里的单引号要翻倍，否则脚本会被截断——
/// 中文 Windows 的用户目录里出现撇号并不罕见。
String _psLiteral(String value) => "'${value.replaceAll("'", "''")}'";

/// 生成 Windows 的「居中裁方 → 缩到 512 → 写 PNG」脚本。
///
/// 不引 Dart 图像库：之前试过 `image`，它与项目已有的 `archive` 版本冲突；
/// Windows 自带 .NET 的 System.Drawing 已经够用，也不会把依赖树搅乱。
/// 写临时文件再原子替换，避免转换中途退出留下半张头像。
String buildWindowsAvatarScript(String source, String target) {
  final temp = '$target.tmp.png';
  final src = _psLiteral(source);
  final dst = _psLiteral(target);
  final tmp = _psLiteral(temp);
  return '''
\$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
\$src = $src
\$dest = $dst
\$tmp = $tmp
try {
  \$image = [System.Drawing.Image]::FromFile(\$src)
  try {
    \$width = \$image.Width
    \$height = \$image.Height
    if (\$width -le 0 -or \$height -le 0) { throw 'empty image' }
    \$side = [Math]::Min(\$width, \$height)
    \$x = [int][Math]::Floor((\$width - \$side) / 2)
    \$y = [int][Math]::Floor((\$height - \$side) / 2)
    \$out = New-Object System.Drawing.Bitmap($_avatarSide, $_avatarSide)
    try {
      \$graphics = [System.Drawing.Graphics]::FromImage(\$out)
      try {
        \$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        \$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        \$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        \$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        \$rect = New-Object System.Drawing.Rectangle(0, 0, $_avatarSide, $_avatarSide)
        \$graphics.DrawImage(\$image, \$rect, \$x, \$y, \$side, \$side, [System.Drawing.GraphicsUnit]::Pixel)
      } finally { \$graphics.Dispose() }
      \$dir = Split-Path -Parent \$dest
      if (-not (Test-Path -LiteralPath \$dir)) {
        New-Item -ItemType Directory -Force -Path \$dir | Out-Null
      }
      \$out.Save(\$tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { \$out.Dispose() }
    Move-Item -LiteralPath \$tmp -Destination \$dest -Force
    [Console]::Out.Write('ok')
  } finally { \$image.Dispose() }
} catch {
  if (\$tmp -and (Test-Path -LiteralPath \$tmp)) {
    Remove-Item -LiteralPath \$tmp -Force -ErrorAction SilentlyContinue
  }
  [Console]::Error.Write(\$_.Exception.Message)
  exit 1
}
''';
}

/// 测试注入点。真机走 `Process.run`；测试用它断言脚本内容与失败回传，
/// 不必在 CI 上弹一个真的 Windows 文件面板。
typedef AvatarProcessRunner = Future<ProcessResult> Function(
  String executable,
  List<String> arguments, {
  Encoding? stdoutEncoding,
  Encoding? stderrEncoding,
});

AvatarProcessRunner? debugAvatarProcessRunner;

/// Windows：把用户选中的图片裁成 512 方图并写到头像路径。
/// 取消、格式不支持、转换失败都返回 false，与另外两个平台的接口一致。
Future<bool> convertWindowsAvatar(String source, {String? target}) async {
  if (!avatarSourceSupported(source)) return false;
  final dest = target ?? avatarTargetPath();
  final runner = debugAvatarProcessRunner ?? Process.run;
  try {
    final result = await runner(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA', // WinForms / System.Drawing 的 COM 互操作要求单线程单元。
        '-Command',
        buildWindowsAvatarScript(source, dest),
      ],
      stdoutEncoding: utf8,
      stderrEncoding: utf8,
    );
    return result.exitCode == 0 && (result.stdout as String).trim() == 'ok';
  } catch (_) {
    return false;
  }
}

Uint8List? readAvatarBytes() {
  try {
    final f = _file;
    if (!f.existsSync()) return null;
    final bytes = f.readAsBytesSync();
    // 0 字节说明上次写到一半被杀掉了：当没有，回默认图。
    return bytes.isEmpty ? null : bytes;
  } catch (_) {
    return null;
  }
}

/// 原生头像通道是否可用：macOS（NSOpenPanel）与安卓（系统选图 + 原生
/// 裁切落盘）实现了 `ondra/avatar`；Windows 用系统面板 + PowerShell 转换。
bool get avatarPickerSupported =>
    Platform.isMacOS || Platform.isAndroid || Platform.isWindows;

/// 弹系统选图面板。原生侧负责裁切、缩放、落盘，返回是否真的换了图。
/// [avatarPickerSupported] 为 false 时不会真正调用。
Future<bool> pickAvatar() async {
  if (!avatarPickerSupported) return false;
  if (Platform.isWindows) {
    final source = await DesktopPicker.pickFile(prompt: _pickerPrompt);
    if (source == null || source.isEmpty) return false;
    return convertWindowsAvatar(source);
  }
  try {
    final changed = await _channel.invokeMethod<bool>('pick');
    return changed ?? false;
  } catch (_) {
    // 通道建好但仍失败（面板被系统策略拒绝等）：同上，false 即取消/失败。
    return false;
  }
}

void clearAvatar() {
  try {
    final f = _file;
    if (f.existsSync()) f.deleteSync();
  } catch (_) {
    // 删不掉（权限、占用）时下次启动还会读回来：用户会看到「恢复默认」没生效。
    // 不做重试，也不静默改写到别处——文件系统异常不该由界面来圆。
  }
}
