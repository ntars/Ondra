import 'status_types.dart';

/// 浏览器预览里的读数：一律返回空。
///
/// 「浏览器里看不到本机文件」是**环境事实**，不是「空谷现在很空」。
/// 两者的区别决定用户是去聊两句，还是去打开桌面版，所以这句必须说出来。
Future<StatusSnapshot> loadStatus({
  DateTime Function()? now,
  String? home,
}) async {
  return const StatusSnapshot(
    facts: 0,
    raws: 0,
    links: 0,
    archived: 0,
    rawsLastDay: 0,
    sessions: 0,
    plugins: 0,
    dbBytes: 0,
    backupCount: 0,
    backupBytes: 0,
    sources: [
      StatusSource(label: '对话流', detail: '你说过的话与她的回答', count: 0),
      StatusSource(label: '插件事件', detail: '插件调用与返回', count: 0),
      StatusSource(label: '系统事件', detail: '宿主与运行状态', count: 0),
    ],
    metrics: [],
    note: '浏览器预览读不到本机数据库与日志；桌面版会显示真实读数。',
  );
}
