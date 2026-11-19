import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/home_dir.dart';

/// 主目录解析。
///
/// 这组断言看起来平淡，但它们挡的是一类**在 Windows 上才会显形**的静默失败：
/// 原来 20 处各自写 `Platform.environment['HOME'] ?? '.'`，而 Windows 不设
/// `HOME`，于是数据目录变成相对路径 `./.ondra`。从开始菜单启动时当前目录是
/// 安装目录（通常在 `C:\Program Files\…`），普通用户写不进去；而调用方多数
/// 把写入异常当「文件不存在」，界面于是显示成「没有数据」而不是报错。
///
/// 测试跑在 macOS 上，验不到「Windows 没有 HOME」这个前提，但能验住这个
/// 约定：结果是绝对路径、不含反斜杠、$HOME 存在时与之一致。
void main() {
  test('主目录是绝对路径且不为空', () {
    final home = ondraUserHome;
    expect(home.isNotEmpty, isTrue, reason: '退回当前目录也比空串好，但不能是空串');
    expect(home.startsWith('/') || home.contains(':'), isTrue,
        reason: '相对路径会让数据目录跟着「当前在哪」漂移');
  });

  test(r'与 $HOME 一致（POSIX 上 HOME 总是存在）', () {
    final envHome = Platform.environment['HOME'];
    if (envHome == null || envHome.isEmpty) {
      // Windows 走 USERPROFILE 分支，这里没有可断言的基准。
      return;
    }
    expect(ondraUserHome, envHome);
  });

  test('数据根目录统一用正斜杠', () {
    final root = ondraUserDataRoot;
    expect(root.endsWith('/.ondra'), isTrue);
    // Windows 的 USERPROFILE 带反斜杠。若原样拼进路径，界面上显示成
    // `C:\Users\x\.ondra` 与 `/` 混排，复制到终端里有些工具会不认。
    expect(root.contains(r'\'), isFalse);
  });

  test('数据根目录拼在用户主目录下', () {
    expect(ondraUserDataRoot, '${ondraUserHome.replaceAll(r'\', '/')}/.ondra');
  });
}
