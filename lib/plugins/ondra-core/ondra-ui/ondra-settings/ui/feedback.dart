/// 问题反馈的入口：桌面端落盘并交给系统邮件客户端，浏览器预览里如实拒绝。
///
/// 拆成两个实现而不是一个 if：`dart:io` 在 Web 上根本不存在，
/// 只要 import 到就会编译失败，条件导出是唯一能把两边同时编过的写法。
library;

export 'feedback_stub.dart' if (dart.library.io) 'feedback_io.dart';
