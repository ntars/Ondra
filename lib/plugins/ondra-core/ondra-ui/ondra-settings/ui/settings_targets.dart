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
  // 「语言」是**界面语言**，落点是 `OndraI18n` 载入哪份语言包，不写 `settings.json`。
  //
  // 上一版把它映射到 `asr.language`——那是语音识别语言。改界面语言会顺带
  // 把语音识别切到别的语种：选 English 之后，说中文录进来识别不出来，
  // 而用户完全不会把这件事和「界面语言」联系起来。
  //
  // 语音识别语言现在单独一项（`voice.asrLanguage`），两者互不影响。
  // 字号只影响界面，没有内核字段——它不在表里，界面据此标注。

  // ── 对话 ────────────────────────────────────────────────────────────────
  // 「允许空谷记住」= 要不要把对话里的东西提炼成记忆点。内核里这件事是
  // `memory-extract` 这个阶段：关掉它，对话照常，但不再从里面长出记忆。
  //
  // 上一版写的是 `memory-core.score-on-write`，那个字段的 doc 原话是
  // 「关掉后统一 50 分，**仅供对拍调试**」——它不是「记不记得」的开关，
  // 而是「写入时按不按打分表算显著度」。拨这一下会让所有记忆等权，
  // 而用户以为自己在说「别记我」。
  'dialog.remember': [
    const OndraSettingTarget(section: 'memory-extract', key: 'enable'),
  ],
  // 「引用记忆」= 回答前先翻一遍记忆点。内核里这件事是**召回**这一步：
  // 关掉召回，回答照常生成，只是不再引用记忆。上一版写的是
  // `dialogue.include-persona`——那是「要不要拼人设段进提示词」，
  // 和记忆毫无关系，拨这个开关只会让人设消失。
  'dialog.citeMemory': [
    const OndraSettingTarget(section: 'memory-recall', key: 'enable'),
  ],
  // 「从记忆里推断偏好」比「记住」更窄：只关掉偏好的沉淀，事实照记。
  // 内核没有单独的偏好段，最接近的是梦境归纳（`memory-dream`）——
  // 它负责在夜巡时把零散对话收成卡片。关掉它，事实仍由 extract 落地，
  // 只是不再有「归纳」这一层。
  'dialog.inferPreference': [
    const OndraSettingTarget(section: 'memory-dream', key: 'enable'),
  ],
  'dialog.replyLength': [
    const OndraSettingTarget(section: 'dialogue', key: 'max-tokens', map: _replyTokens),
  ],

  // ── 记忆 ────────────────────────────────────────────────────────────────
  // 「记忆保留期」= 普通记忆多久没被引用就沉底。内核字段是
  // `memory-core.archive-normal-days`（1–3650），语义完全对得上。
  //
  // 界面不再给「永久」这一档：内核没有「永不沉底」的取值，`3650` 已经
  // 是它能接受的上界（十年）。上一版把 `forever` 映射成 36500——超出
  // `max: 3650`，会被 `completeConfig` 的 `clampInt` 夹回 3650，用户
  // 看到的「永久」实际是十年，且没有任何提示。
  'memory.retention': [
    const OndraSettingTarget(
      section: 'memory-core',
      key: 'archive-normal-days',
      map: _retentionDays,
    ),
  ],
  // 「自动归纳」= 夜巡时把零散对话收成记忆点。内核里这是 `memory-decay`
  // 的定时扫描（`auto-scan`），默认 **false**——不是漏配，是刻意：
  // 「`archive()` 是写操作，时机该由回合边界或夜巡显式给」。
  //
  // 界面这一项默认 true，与内核相反。两边不一致时会以最后一次写入为准：
  // 用户动过一次开关，值就落进 `settings.json`，此后一致。这里记下差异，
  // 不改默认值——界面的默认只影响「从没碰过这一项的人」。
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
  // 「允许联网」这个大开关已拆成两个如实落点——内核没有全局网络总闸，
  // 详见 `settings_spec` 里这两项上方的说明。
  'privacy.voiceCloud': [
    const OndraSettingTarget(section: 'asr', key: 'allow-cloud-fallback'),
  ],
  'privacy.imageCloud': [
    const OndraSettingTarget(section: 'vision', key: 'cloud-without-privacy'),
  ],
  'privacy.screenRead': [
    const OndraSettingTarget(section: 'vision', key: 'enable'),
  ],
  'privacy.redactLogs': [
    const OndraSettingTarget(section: 'privacy', key: 'scan-secrets'),
  ],

  // ── 通道 ────────────────────────────────────────────────────────────────
  // 这一段目前**没有任何一项有真实落点**，全部如实标注为「需要通道插件」。
  //
  // 上一版给「允许群聊」配了 `proactive-gate.per-minute`，这是个打字错误级别的
  // 灾难：那个字段是 number（1–20 的每分钟配额），写进去的是布尔值。
  // 内核的 `clampInt` 对非数字一律回退默认值，所以拨开关等于什么都没发生；
  // 更糟的是即使写对了类型也没意义——群聊主动消息在内核里是**合规章节级
  // 红线**：「群里不主动说话（§5.7 红线，**无开关**）」（`gate.ts:285` 原话）。
  // 没有的东西就不该给一个开关。
  //
  // 通道接入的真实形态是安装 `ondra-channel` 适配器（QQ / 飞书），
  // 装上之后由适配器自己的配置段接管，不在这个总表里。
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
  // 界面自身：语言决定 `OndraI18n` 载入哪份语言包，字号改的是会话正文的
  // 排版系数（`_Bubble._scale`）。两者都不进 `settings.json`，但拨了就
  // 立刻看得见变化——不在这里算上，界面会在它们下面写「只影响界面」。
  'general.language',
  'general.fontSize',
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
///
/// 内核只有三档（`ondra-privacy/src/types.ts` 的 `APPROVAL_MODES`）：
/// - `supervised` 每个高风险都问；
/// - `auto` 低风险直过、高风险问；
/// - `full` 免审批，但要求开沙箱写边界。
///
/// **取值必须落在这三个里**：`approvalModeOf()` 认不出来就 `report()` 一次
/// 然后回退 `DEFAULT_CONFIG.approvalMode`（`auto`）。上一版写的是
/// `strict` / `open`——两个都不可识别，于是「仅可查看」和「完全权限」
/// 都静默变成 `auto`。这不是文案问题：用户以为自己收紧了审批，实际没有。
///
/// 三档对位：
/// - 仅可查看 = 每一步都要问（`supervised`）；
/// - 工作区内修改 = 内核的默认档（`auto`）；
/// - 完全权限 = 免审批（`full`）。
Object? _permissionMode(Object? v) => switch (v) {
  'readOnly' => 'supervised',
  'workspace' => 'auto',
  'fullAccess' => 'full',
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

/// 记忆保留期 → 归档天数。取值必须落在内核的 1–3650 之间：
/// 超出上界会被 `clampInt` 夹回 3650，用户以为设了更久，实际没有。
Object? _retentionDays(Object? v) => switch (v) {
  '30d' => 30,
  '180d' => 180,
  '3650d' => 3650,
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
