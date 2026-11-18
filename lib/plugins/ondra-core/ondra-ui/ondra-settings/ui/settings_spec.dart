/// 设置项的本地镜像：键、标签、取值、默认值。
///
/// **唯一真源在这里**，界面不各自写死文案。正式实现是 `ondra-settings` 这个
/// Cordis 插件（值存在 `ctx.settings`，字段由各插件的 Config schema 声明）；
/// 运行时接通前，客户端用这份声明渲染同样的界面。
///
/// 取值口径全部按官方 DeepSeek Harness 对齐，见同目录 README 的来源表。
class OndraSettingOption {
  const OndraSettingOption(this.value, this.label);

  final String value;
  final String label;
}

class OndraSettingSpec {
  const OndraSettingSpec({
    required this.key,
    required this.label,
    this.description,
    this.options = const [],
    this.kind = OndraSettingKind.toggle,
    this.defaultValue,
    this.min,
    this.max,
    this.unit,
  });

  final String key;
  final String label;
  final String? description;
  final OndraSettingKind kind;

  /// 单选：可选项；其余类型为空。
  final List<OndraSettingOption> options;

  final Object? defaultValue;

  /// 数值型（字号）的边界与单位。
  final int? min;
  final int? max;
  final String? unit;

  String labelOf(String value) {
    for (final o in options) {
      if (o.value == value) return o.label;
    }
    return value;
  }
}

enum OndraSettingKind {
  /// 开关。
  toggle,

  /// 单选（分段控件）。
  choice,

  /// 数值加减（字号）。
  stepper,
}

/// 全表。顺序即界面顺序（分组由页面决定）。
const List<OndraSettingSpec> ondraSettingSpecs = [
  // ── 通用 ────────────────────────────────────────────────────────────────
  OndraSettingSpec(
    key: 'general.permissions',
    label: '权限',
    description: '选择新会话的默认权限模式',
    kind: OndraSettingKind.choice,
    defaultValue: 'workspace',
    options: [
      OndraSettingOption('readOnly', '仅可查看'),
      OndraSettingOption('workspace', '工作区内修改'),
      OndraSettingOption('fullAccess', '完全权限'),
    ],
  ),
  OndraSettingSpec(
    key: 'general.language',
    label: '语言',
    kind: OndraSettingKind.choice,
    defaultValue: 'zh',
    options: [
      OndraSettingOption('zh', '简体中文'),
      OndraSettingOption('en', 'English'),
    ],
  ),
  OndraSettingSpec(
    key: 'general.fontSize',
    label: '字号大小',
    description: '仅影响会话内容的字号',
    kind: OndraSettingKind.stepper,
    defaultValue: 14,
    min: 12,
    max: 20,
    unit: 'px',
  ),
  OndraSettingSpec(
    key: 'general.launchAtLogin',
    label: '开机自启动',
    description: '登录系统后自动打开空谷',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'general.preventSleep',
    label: '阻止系统空闲睡眠',
    description: '有任务在跑时保持系统唤醒',
    defaultValue: false,
  ),
  OndraSettingSpec(
    key: 'general.notify',
    label: '启用系统通知',
    description: '任务完成、插件报错时提醒',
    defaultValue: true,
  ),
  OndraSettingSpec(key: 'general.notifySound', label: '通知提示音', defaultValue: true),
  OndraSettingSpec(
    key: 'general.focusMute',
    label: '专注时静音',
    description: '全屏应用运行时只留角标',
    defaultValue: false,
  ),

  // ── 对话 ────────────────────────────────────────────────────────────────
  OndraSettingSpec(
    key: 'dialog.busySend',
    label: '繁忙时的发送行为',
    description: '智能体运行时 Enter 键和发送按钮的行为；⌘ Enter 使用另一行为',
    kind: OndraSettingKind.choice,
    defaultValue: 'queue',
    options: [
      OndraSettingOption('queue', '排队发送'),
      OndraSettingOption('steer', '插话发送'),
    ],
  ),
  OndraSettingSpec(
    key: 'dialog.enterSend',
    label: '回车发送',
    description: '关掉后用 ⌘ Enter 发送，回车换行',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'dialog.remember',
    label: '允许空谷记住',
    description: '关掉后新对话不再写入记忆点',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'dialog.citeMemory',
    label: '引用记忆',
    description: '回答前先翻一遍相关的记忆点',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'dialog.inferPreference',
    label: '从记忆里推断偏好',
    description: '把反复出现的做法沉成偏好，不必每次重说',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'dialog.replyLength',
    label: '回复长度',
    kind: OndraSettingKind.choice,
    defaultValue: '1',
    options: [
      OndraSettingOption('0', '简短'),
      OndraSettingOption('1', '适中'),
      OndraSettingOption('2', '详细'),
    ],
  ),

  // ── 日志 ────────────────────────────────────────────────────────────────
  OndraSettingSpec(
    key: 'logs.usageDetail',
    label: '性能与用量',
    description: '选择性能与用量信息展示的详细程度',
    kind: OndraSettingKind.choice,
    // 默认「详细」：日志页本来就是给排障用的，默认藏起来等于白记。
    defaultValue: 'detailed',
    options: [
      OndraSettingOption('compact', '简洁'),
      OndraSettingOption('detailed', '详细'),
    ],
  ),


  // ── 通道接口 ────────────────────────────────────────────────────────────
  OndraSettingSpec(
    key: 'channels.qqBot',
    label: 'QQ 机器人',
    description: '把空谷接到 QQ 群或私聊；需要机器人 AppID 与密钥',
    defaultValue: false,
  ),
  OndraSettingSpec(
    key: 'channels.qqSandbox',
    label: 'QQ 沙箱环境',
    description: '先在测试频道里跑通，再切到正式环境',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'channels.allowGroups',
    label: '允许群聊',
    description: '关掉后只回应私聊',
    defaultValue: false,
  ),
  OndraSettingSpec(
    key: 'channels.busyPolicy',
    label: '通道繁忙时',
    description: '多个通道同时来消息时的排队方式',
    kind: OndraSettingKind.choice,
    defaultValue: 'queue',
    options: [
      OndraSettingOption('queue', '排队'),
      OndraSettingOption('steer', '插话'),
      OndraSettingOption('drop', '丢弃'),
    ],
  ),

  // ── 记忆与数据（已并入人设设定） ──────────────────────────────────────
  OndraSettingSpec(
    key: 'memory.retention',
    label: '记忆保留期',
    description: '超过期限的记忆点会被淡出，不再引用',
    kind: OndraSettingKind.choice,
    defaultValue: 'forever',
    options: [
      OndraSettingOption('30d', '30 天'),
      OndraSettingOption('180d', '半年'),
      OndraSettingOption('forever', '永久'),
    ],
  ),
  OndraSettingSpec(
    key: 'memory.capacity',
    label: '容量上限',
    description: '到了上限就按「最久没被引用」淘汰',
    kind: OndraSettingKind.choice,
    defaultValue: '5k',
    options: [
      OndraSettingOption('1k', '1000 条'),
      OndraSettingOption('5k', '5000 条'),
      OndraSettingOption('20k', '20000 条'),
    ],
  ),
  OndraSettingSpec(
    key: 'memory.autoSummarize',
    label: '自动归纳',
    description: '每晚把零散的对话收成记忆点',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'data.location',
    label: '数据位置',
    description: '记忆、会话与配置都写在这里',
    kind: OndraSettingKind.choice,
    defaultValue: 'app',
    options: [
      OndraSettingOption('app', '应用目录'),
      OndraSettingOption('custom', '自定义目录'),
    ],
  ),

  // ── 语音与音色（已并入人设设定） ──────────────────────────────────────
  OndraSettingSpec(
    key: 'voice.tts',
    label: '朗读回复',
    description: '把回答念出来，长回答只念前两段',
    defaultValue: false,
  ),
  OndraSettingSpec(
    key: 'voice.timbre',
    label: '音色',
    kind: OndraSettingKind.choice,
    defaultValue: 'warm',
    options: [
      OndraSettingOption('warm', '暖'),
      OndraSettingOption('clear', '清'),
      OndraSettingOption('low', '沉'),
    ],
  ),
  OndraSettingSpec(
    key: 'voice.rate',
    label: '语速',
    kind: OndraSettingKind.stepper,
    defaultValue: 100,
    min: 60,
    max: 160,
    unit: '%',
  ),
  OndraSettingSpec(
    key: 'voice.asrLanguage',
    label: '语音识别语言',
    kind: OndraSettingKind.choice,
    defaultValue: 'zh',
    options: [
      OndraSettingOption('zh', '普通话'),
      OndraSettingOption('yue', '粤语'),
      OndraSettingOption('en', 'English'),
    ],
  ),

  // ── 隐私与安全（已并入关于空谷） ──────────────────────────────────────
  OndraSettingSpec(
    key: 'privacy.online',
    label: '允许联网',
    description: '关掉后只用本地模型，插件也不能访问网络',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'privacy.redactLogs',
    label: '日志脱敏',
    description: '写日志前去掉路径、邮箱、密钥等敏感片段',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'privacy.crashReport',
    label: '崩溃上报',
    description: '只发堆栈与版本号，不发对话内容',
    defaultValue: false,
  ),
  OndraSettingSpec(
    key: 'privacy.screenRead',
    label: '允许读取屏幕',
    description: '插件需要时才能截取当前窗口',
    defaultValue: false,
  ),
  OndraSettingSpec(
    key: 'privacy.keychain',
    label: 'API Key 存放',
    kind: OndraSettingKind.choice,
    defaultValue: 'keychain',
    options: [
      OndraSettingOption('keychain', '系统钥匙串'),
      OndraSettingOption('file', '本地加密文件'),
    ],
  ),

  // ── 关于空谷 ────────────────────────────────────────────────────────────
  OndraSettingSpec(
    key: 'about.channel',
    label: '更新通道',
    description: 'nightly 更新更快，stable 更稳',
    kind: OndraSettingKind.choice,
    defaultValue: 'stable',
    options: [
      OndraSettingOption('stable', 'stable'),
      OndraSettingOption('nightly', 'nightly'),
    ],
  ),
];

/// 按键取声明。找不到就抛错——拼错键应该立刻炸，而不是静默不显示。
OndraSettingSpec ondraSettingSpec(String key) {
  for (final s in ondraSettingSpecs) {
    if (s.key == key) return s;
  }
  throw StateError('未声明的设置项：$key');
}
