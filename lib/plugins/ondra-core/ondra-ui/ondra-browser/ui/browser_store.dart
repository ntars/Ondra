/// 浏览器白名单的存取。null 是未保存，[] 是明确拒绝所有站点。
library;

export 'browser_store_stub.dart' if (dart.library.io) 'browser_store_io.dart';
