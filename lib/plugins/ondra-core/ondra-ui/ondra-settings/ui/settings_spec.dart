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
  // general.permissions 已移除：内核没有会话文件权限接口，界面给的三档
  // 选择永远无法兑现——保存必失败、「重试应用」永远无效。等接口落地
  // 再恢复这一项（settings_client 里的同名守卫也一并删）。
  OndraSettingSpec(
    key: 'general.language',
    label: '语言',
    description: '界面语言；未翻译的条目仍显示中文',
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
  // general.focusMute 已移除：它的真实语义是「通知不响」，但应用当前
  // 没有任何系统通知场景（唯一调用方是设置页的测试按钮），也没有应用内
  // 声音播放。挂一个可拨但永不生效的开关比没有更糟。
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
    description: '多久没被引用的记忆会沉底；只忘不删，仍可被翻到',
    kind: OndraSettingKind.choice,
    defaultValue: '180d',
    options: [
      OndraSettingOption('30d', '30 天'),
      OndraSettingOption('180d', '半年'),
      OndraSettingOption('3650d', '十年'),
    ],
  ),
  // 「容量上限」这一项已删除。它原本给的是 1000 / 5000 / 20000 三档，
  // 文案写「到了上限就按最久没被引用淘汰」——两件事都与内核相反：
  //   1. 内核没有「总量上限」这个字段（`memory-core` 的字段表里没有）；
  //   2. 淘汰策略在内核里是明确不做的：归档是「沉底，只忘不删」，
  //      池满时「拒绝新建并告警，不淘汰旧的」（`ondra-memory-pool` 注释原话），
  //      理由是「删一条核心等于替用户决定「你不该是自己」」。
  // 做成三档只会让用户以为自己设了配额，实际一个字节都没被限制。
  // 剩下 `max-select-rows` 那个字段是「单次查询硬上限，内存保护，
  // 不是召回预算」，拿它顶替等于把保护值当成配额，同样是不生效。
  OndraSettingSpec(
    key: 'memory.autoSummarize',
    label: '定期整理记忆',
    // 文案与实际行为对齐（alpha.2 审查第 15 项）：开关控制的是内核的
    // 定期记忆整理任务（检查旧记忆是否该沉底归档），不是对话归纳——
    // 对话归纳由对话管线自己决定，不在这颗开关的管辖内。
    description: '每晚检查旧记忆，该沉底的沉底、该归档的归档',
    defaultValue: true,
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
  // 这里原本有一项「允许联网」，文案是「关掉后只用本地模型，插件也不能访问网络」。
  // 它没有如实落点：内核里**没有**全局网络总闸（`llm-gateway` 只有来源清单与
  // 重试参数，各 provider 各自出站），也没有「禁用所有插件网络」这样的段。
  // 硬映射到 `vision.cloud-without-privacy` 更糟：那个字段的语义是
  // 「没有 ondra-privacy 时是否**仍允许**把图发到云端」，是个绕过确认的开关，
  // 方向与「禁止联网」相反——用户关掉它，图片反而更容易出站。
  //
  // 因此改成两个**各自真能生效**的开关，直接对应内核字段：
  OndraSettingSpec(
    key: 'privacy.voiceCloud',
    label: '语音识别云端兜底',
    description: '本地识别失败时把录音发到云端；关掉即纯本机',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'privacy.imageCloud',
    label: '图片发往云端无需确认',
    description: '没有隐私插件时仍允许把图发出去；默认关闭，出站要先问',
    defaultValue: false,
  ),
  OndraSettingSpec(
    key: 'privacy.redactLogs',
    label: '日志脱敏',
    description: '写日志前去掉路径、邮箱、密钥等敏感片段',
    defaultValue: true,
  ),
  OndraSettingSpec(
    key: 'privacy.screenRead',
    label: '允许读取屏幕',
    description: '插件需要时才能截取当前窗口',
    defaultValue: false,
  ),
  // 「API Key 存放」曾经是二选一（系统钥匙串 / 本地加密文件），但后者
  // 没有实现：密钥写入只有钥匙串一条路。与其留一个选了会静默失效的选项，
  // 不如在界面那一行如实写「系统钥匙串」。见 `console_sheet` 的隐私段。

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
