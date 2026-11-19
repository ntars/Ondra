/// 浏览器白名单的存取。Web 没有文件系统，stub 如实给空表。
library;

export 'browser_store_stub.dart' if (dart.library.io) 'browser_store_io.dart';
