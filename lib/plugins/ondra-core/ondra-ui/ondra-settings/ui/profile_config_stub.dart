/// 浏览器环境没有文件系统：读不到装配层，如实拒绝。
library;

/// 读一个条目配置字段。读不到返回 null。
String? readProfileConfigField(String section, String key) => null;

/// 写一个条目配置字段。浏览器写不进装配层，返回 false。
bool writeProfileConfigField(String section, String key, Object? value) => false;
