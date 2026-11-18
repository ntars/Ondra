import '../../../../../app/dsh_settings.dart';

/// 一个设置项在内核里的落点。
///
/// 「界面上的一个开关」和「内核里的一个字段」常常不是一对一：
/// 一个开关可能要写两三个段（比如「允许联网」要同时关掉 vision 与 asr 的云通道），
/// 也可能一个段里有两三个字段合起来才表达一件事。所以这里是一个列表。
class OndraSettingTarget {
  const OndraSettingTarget({
    required this.section,
    required this.key,
    this.scale,
    this.map,
  });

  /// 内核段 id（`CONFIG_SECTION_ID`，kebab）。
  final String section;

  /// 段内字段名（**kebab**，与 `settings.json` 里的写法一致）。
  final String key;

  /// 数值换算：界面上的 0–100 语速要变成 `say` 的「词/分钟」这类。
  /// null 表示原样写入。
  final num Function(num value)? scale;

  /// 值映射：`warm` → 某个具体音色 id 这类。返回 null 表示「这个值没有对应项，跳过」。
  final Object? Function(Object? value)? map;
}

/// 设置页的键 → 内核落点。
///
/// 这份表是本轮新增的**唯一接线处**：它把「33 个开关」变成「内核真的会读的字段」。
/// 没有落点的项不在这张表里，界面会显式标注「本项只影响界面」——
/// 不假装生效。
///
/// 字段名全部按 `settings.json` 的口径写 **kebab**。改成 camel 会让内核
/// 安静地按默认值跑（`ondra-tts` 的 README 里记着这个坑），而且两处都不报错。
///
/// 是 `final` 不是 `const`：`scale` / `map` 是闭包，Dart 的 const 表达式
/// 不允许闭包。这张表在启动时建一次，之后只读，final 的代价可以忽略。
final Map<String, List<OndraSettingTarget>> ondraSettingTargets = {
  // ── 通用 ────────────────────────────────────────────────────────────────
  // 「默认权限模式」直接对应隐私插件的审批档：这两件事本来就是一回事。
  'general.permissions': [
    const OndraSettingTarget(
      section: 'privacy',
      key: 'approval-mode',
      map: _permissionMode,
    ),
  ],
  'general.language': [
    const OndraSettingTarget(section: 'asr', key: 'language', map: _asrLanguage),
  ],
  // 字号只影响界面，没有内核字段——它不在表里，界面据此标注。

  // ── 对话 ────────────────────────────────────────────────────────────────
  'dialog.remember': [
    const OndraSettingTarget(section: 'memory-core', key: 'score-on-write'),
  ],
  'dialog.citeMemory': [
    const OndraSettingTarget(section: 'dialogue', key: 'include-persona'),
  ],
  // 「从记忆里推断偏好」= 要不要从对话里提取出偏好类事实。
  // 内核里这件事就是 `memory-extract` 这个阶段本身：关掉它，
  // 对话照常进行，但不会再从里面长出新的偏好记忆。
  'dialog.inferPreference': [
    const OndraSettingTarget(section: 'memory-extract', key: 'enable'),
  ],
  'dialog.replyLength': [
    const OndraSettingTarget(section: 'dialogue', key: 'max-tokens', map: _replyTokens),
  ],

  // ── 记忆 ────────────────────────────────────────────────────────────────
  'memory.retention': [
    const OndraSettingTarget(
      section: 'memory-core',
      key: 'archive-normal-days',
      map: _retentionDays,
    ),
  ],
  'memory.capacity': [
    const OndraSettingTarget(
      section: 'memory-core',
      key: 'max-select-rows',
      map: _capacityRows,
    ),
  ],
  'memory.autoSummarize': [
    const OndraSettingTarget(section: 'memory-decay', key: 'auto-scan'),
  ],

  // ── 语音 ────────────────────────────────────────────────────────────────
  'voice.tts': [const OndraSettingTarget(section: 'tts', key: 'enable')],
  'voice.timbre': [
    const OndraSettingTarget(section: 'tts', key: 'preset', map: _ttsPreset),
  ],
  'voice.rate': [
    // 界面的 60–160% 是「相对百分比」，内核的 `rate` 是**增量**（-0.5–+0.5，
    // 0.1 表示快一成）。两者是同一件事的两种刻度，不能拿 wpm 顶替：
    // `say-wpm` 是 macOS `say` 的**基准值**（120–300 词/分钟），
    // 写它等于改基准，而不是改这一档的快慢。
    //
    // 换算必须**分段**：界面的区间本身不对称（100 往下一共 40 格，
    // 往上一共 60 格），而内核两头都是 0.5。用一个分母（比如都除以 120），
    // 60% 只能落到 -0.333，用户把滑杆拉到底也到不了内核的下限。
    // 分段之后 100% 仍是原速 0，两端正好贴住 -0.5 / +0.5。
    OndraSettingTarget(
      section: 'tts',
      key: 'rate',
      scale: (v) {
        final delta = v < 100 ? (v - 100) / 80 : (v - 100) / 120;
        // 收到三位小数：settings.json 是给人看的，0.16666666666666666 没有意义。
        return (delta.clamp(-0.5, 0.5) * 1000).round() / 1000;
      },
    ),
  ],
  'voice.asrLanguage': [
    const OndraSettingTarget(section: 'asr', key: 'language', map: _asrLanguage),
  ],

  // ── 隐私与安全 ──────────────────────────────────────────────────────────
  // 「允许联网」是产品层说法，落到内核是两个「允许走云通道」的开关＋隐私总闸。
  'privacy.online': [
    const OndraSettingTarget(section: 'vision', key: 'cloud-without-privacy'),
    const OndraSettingTarget(section: 'asr', key: 'allow-cloud-fallback'),
  ],
  'privacy.screenRead': [
    const OndraSettingTarget(section: 'vision', key: 'enable'),
  ],
  'privacy.redactLogs': [
    const OndraSettingTarget(section: 'privacy', key: 'scan-secrets'),
  ],

  // ── 通道 ────────────────────────────────────────────────────────────────
  // 「允许群聊」在内核侧由主动消息闸门的分钟/分时配额表达：
  // 群里最怕的是刷屏，所以关掉群聊就把配额压到极低而不是写一个不存在的开关。
  'channels.allowGroups': [
    const OndraSettingTarget(section: 'proactive-gate', key: 'per-minute'),
  ],
};

/// 这一项有没有落点。没有的项界面要如实标注。
///
/// **不只算 `settings.json`**：有些项的落点是操作系统，不是内核配置。
/// 开机自启动写的是 launchd 登录项、阻止睡眠起的是 `caffeinate` 进程、
/// 通知开关决定要不要 `osascript display notification`。
/// 它们都不进 `settings.json`，但确实"拨了就生效"——如果不在这里算上，
/// 界面会在一个真的能用的开关下面写「只影响界面」，把用户劝退。
bool ondraSettingIsWired(String key) =>
    ondraSettingTargets.containsKey(key) || _platformWiredKeys.contains(key);

/// 落点在系统侧或界面自身的项。由 `SettingsClient._applyPlatformAction`
/// 与各自的调用点执行，**不写 `settings.json`**。
///
/// 分成两份而不是混进上面那张表：那张表的语义是「写进内核的哪个段哪个字段」，
/// 这里一项都写不进去。混在一起会让「同步内核配置」这件事变得不纯粹——
/// `ondraPushAllSettings` 遍历它的时候会拿到一堆没有 section 的条目。
const Set<String> _platformWiredKeys = {
  // 系统侧：launchd 登录项 / caffeinate 进程 / osascript 通知。
  'general.launchAtLogin',
  'general.preventSleep',
  'general.notify',
  'general.notifySound',
  // 界面自身：更新通道会被「检查更新」直接读走（`UpdateChecker.check`
  // 的 channel 参数），选了就查哪条线，不需要经过内核。
  'about.channel',
};

/// 这一项的内核落点（可能为空，表示落点在系统侧或纯界面）。
List<OndraSettingTarget> ondraSettingTargetsOf(String key) =>
    ondraSettingTargets[key] ?? const [];

/// 把所有设置写进内核。
///
/// 在启动时调用一次：把界面上记着的值同步到 `settings.json`。
/// 之后每次 `set()` 只写变化的那一项——全量重写在设置页里拨一下开关
/// 就要重写几十个字段，写坏的窗口也更大。
///
/// [read] 由调用方提供（通常是 `settingsClient` 的取值函数）：
/// 这一层不认识 SettingsClient，否则 settings_client → settings_targets →
/// settings_client 会绕成一个环。
///
/// 返回成功写入的字段数与失败数，启动日志用它说明「接线通没通」。
({int written, int failed}) ondraPushAllSettings(Object? Function(String key) read) {
  var written = 0;
  var failed = 0;
  for (final entry in ondraSettingTargets.entries) {
    final value = read(entry.key);
    if (value == null) continue;
    for (final t in entry.value) {
      final mapped = t.map == null ? value : t.map!(value);
      if (mapped == null) continue;
      final resolved = t.scale != null && mapped is num ? t.scale!(mapped) : mapped;
      if (DshSettings.writeField(t.section, t.key, resolved)) {
        written += 1;
      } else {
        failed += 1;
      }
    }
  }
  return (written: written, failed: failed);
}

/// 写一项。
bool ondraPushSetting(String uiKey, Object? value) {
  final targets = ondraSettingTargets[uiKey];
  if (targets == null) return true; // 没有落点不算失败：它只影响界面。
  var ok = true;
  for (final t in targets) {
    final mapped = t.map == null ? value : t.map!(value);
    if (mapped == null) continue;
    final final_ = t.scale != null && mapped is num ? t.scale!(mapped) : mapped;
    if (!DshSettings.writeField(t.section, t.key, final_)) ok = false;
  }
  return ok;
}

// ── 值映射 ────────────────────────────────────────────────────────────────

/// 界面三档 → 隐私插件的审批模式。
Object? _permissionMode(Object? v) => switch (v) {
  'readOnly' => 'strict',
  'workspace' => 'supervised',
  'fullAccess' => 'open',
  _ => null,
};

/// 语音识别语言：内核用 BCP-47 风格的短码，界面用 zh / yue / en。
Object? _asrLanguage(Object? v) => switch (v) {
  'zh' => 'zh',
  'yue' => 'yue',
  'en' => 'en',
  _ => null,
};

/// 回复长度 → max-tokens。三档对应 512 / 2048 / 8192。
Object? _replyTokens(Object? v) => switch (v) {
  '0' => 512,
  '1' => 2048,
  '2' => 8192,
  _ => null,
};

/// 记忆保留期 → 归档天数。`forever` 用一个很大的值而不是 null：
/// null 在内核里表示「未设置」，会回退默认值，那是 180 天，不是永久。
Object? _retentionDays(Object? v) => switch (v) {
  '30d' => 30,
  '180d' => 180,
  'forever' => 36500,
  _ => null,
};

/// 容量上限 → 单次检索最多取多少行。
Object? _capacityRows(Object? v) => switch (v) {
  '1k' => 200,
  '5k' => 1000,
  '20k' => 4000,
  _ => null,
};

/// 音色三档 → tts 的预设 id。
///
/// 内核的八个预设是 `PRESET_IDS`：soft(温柔) / lively(活泼) / broadcast(播音) /
/// dongbei(东北) / shaanxi(陕西) / cantonese(粤语) / taiwan(台湾) / english。
/// **取值必须是这八个之一**——内核用 `isPresetId()` 校验，不是合法 id 时
/// 静默回落默认值（`soft`），界面上看起来「选了」，实际没生效。
/// 上一版把「沉」映射到 `gentle`，这个 id 根本不在表里，正是踩了这个坑。
///
/// 三档只映射**同语种的通用音色**，不碰方言与外语档：那五档是「说什么话」，
/// 不是「什么音色」。界面上写着「沉」，落成东北腔，是比不生效更坏的结果。
/// 因此「沉」落到 `broadcast`（云健，男声、偏低沉），与「清」共用同一档——
/// 内核这一维只有粗糙的几个预置，硬造第四档只会造出一个假选项。
Object? _ttsPreset(Object? v) => switch (v) {
  'warm' => 'soft', // 温柔 · 晓晓
  'clear' => 'lively', // 活泼 · 晓伊
  'low' => 'broadcast', // 播音 · 云健（男声，低）
  _ => null,
};
