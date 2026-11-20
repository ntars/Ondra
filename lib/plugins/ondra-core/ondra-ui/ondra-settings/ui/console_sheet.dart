import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../../../../app/data_root.dart';
import '../../../../../app/data_maintenance.dart';
import '../../../../../app/desktop_picker.dart';
import '../../../../../app/i18n.dart';
import '../../../../../app/keychain.dart';
import '../../../../../app/prefs.dart';
import '../../../../../app/update_check.dart';
import '../../../../../app/version.dart';
import '../../../../../design/avatar.dart';
import '../../../../../design/form_factor.dart';
import '../../../../../design/brand.dart';
import '../../../../../design/dialog.dart';
import '../ondra-models/ui/model_client.dart';
import '../ondra-models/ui/probe.dart';
import '../ondra-models/ui/provider_catalog.dart';
import '../ondra-models/ui/model_types.dart';
import '../ondra-persona/ui/persona_client.dart';
import '../../ondra-browser/ui/browser_client.dart';
import '../../ondra-llama/ui/llama_panel.dart';
import '../../ui/shell_state.dart';
import './feedback.dart';
import './maintenance.dart';
import './settings_client.dart';
import './settings_spec.dart';
import './settings_targets.dart';
import '../../../../../design/glyph.dart';
import '../../../../../design/motion.dart';
import '../../../../../design/primitives.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';

/// 设置面板：760 × 500、圆角 26、左栏 168。
///
/// 数值全部来自原实现：左栏 `bg #F3F3F3`、`pt-10 px-3 pb-3`，导航项
/// 32 高 / 圆角 8 / 左右 12，选中 6% 黑底；右栏顶条 40 高放关闭键，
/// 标题 20/500，正文 `px-6 pt-2 pb-6`。分组卡圆角 12、4% 黑底，
/// 行高至少 42、左右 16、行间 5% 发丝线，开关 36×16。
class ConsoleSheet extends StatefulWidget {
  const ConsoleSheet({super.key, required this.onClose, this.initialPane});

  final VoidCallback onClose;

  /// 打开时落在哪一栏。空（默认）进通用设置；侧栏的账户行指定人设——
  /// 那一行是「这个人是谁」的入口，落进通用设置等于点了没反应。
  ///
  /// 用壳层的 [ShellPane] 而不是自己的枚举：壳层不该 import 面板的私有类型。
  final ShellPane? initialPane;

  @override
  State<ConsoleSheet> createState() => _ConsoleSheetState();
}

/// 左栏的条目。**一条到底，不分组、不加分割线**——设置项本来就是一个平铺的清单。
///
/// 五类，对应「谁在管」：应用怎么跑（通用）/ 用哪个脑子（模型）/ 怎么被找到（通道）/
/// 这个人是谁（人设）/ 剩下的都在关于里（版本、隐私、反馈）。
///
/// 合并过的东西与去处，都不是「删功能」，是「别占一格」：
/// - 对话偏好、记忆与数据、语音与音色 → 人设设定：说话的方式、记住什么、什么声音，
///   都是「这个人怎么样」，不是独立的一类；
/// - 隐私与安全、问题反馈 → 关于空谷：边界与报障都属于「这台机器上的这个应用」。
///
/// 「插件设置」不在这里：插件的新增与卸载属于 `ondra-plugins` 页。
enum _Pane {
  general('通用设置'),
  model('模型基座'),
  channels('通道接口'),
  persona('人设设定'),
  about('关于空谷');

  const _Pane(this.label);

  final String label;
}

class _ConsoleSheetState extends State<ConsoleSheet> {
  _Pane _pane = _Pane.general;

  /// 模型基座的三层子态：选分类 → 选预设 → 编辑。
  /// 官方把编辑做成卡片里的展开态，这里用同一层内的「下钻 + 返回」表达。
  String? _editingProvider;
  bool _choosingCategory = false;
  ProviderCategory? _addingCategory;

  /// 「开源许可」是否展开。放在这一层而不是 `_Row` 里，是因为许可文本要
  /// 跨多行铺开，和一行标题不是同一种排版。
  bool _licenseOpen = false;

  // 开关状态不在页面里：一切取值走 settingsClient（ondra-settings 的投影），
  // 页面自己不再保存任何设置值。
  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): widget.onClose,
      },
      child: Focus(
        autofocus: true,
        child: Stack(
          fit: StackFit.expand,
          children: [
            GestureDetector(
              onTap: widget.onClose,
              child: ColoredBox(color: Colors.black.withValues(alpha: 0.4)),
            ),
            Center(
              child: LayoutBuilder(
                builder: (context, c) {
                  // 手机会吃掉一部分屏幕：状态栏/刘海在顶，手势条在底，
                  // 软键盘直接盖住下半屏。桌面只有那 48 的呼吸边距。
                  final pad = MediaQuery.paddingOf(context);
                  final insets = MediaQuery.viewInsetsOf(context);
                  final spare = 48.0 + pad.top + pad.bottom + insets.bottom;
                  final w = (c.maxWidth - 48).clamp(0.0, 760.0);
                  final h = (c.maxHeight - spare).clamp(280.0, 500.0);
                  return GestureDetector(
                    onTap: () {},
                    child: Container(
                      width: w,
                      height: h,
                      decoration: BoxDecoration(
                        color: s.surface,
                        borderRadius: BorderRadius.circular(OndraRadius.modal),
                        boxShadow: const [
                          BoxShadow(color: Color(0x2E000000), spreadRadius: 1),
                          BoxShadow(
                            color: Color(0x59000000),
                            blurRadius: 48,
                            offset: Offset(0, 16),
                          ),
                        ],
                      ),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(OndraRadius.modal),
                        child: Row(
                          // stretch 是必须的：默认 center 会让左栏按内容高度收缩，
                          // 上下各留一条白边（`#F3F3F3` 只铺到内容为止），
                          // 看起来像弹窗高度没对齐。宽度改由外层 SizedBox 给。
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            // 手机（<560dp）没有左导航的生存空间：140dp 的导航
                            // 只给右列留 92dp，连一行字都放不下。窄屏改成
                            // 顶部横向分类条，内容区独占整行宽。
                            if (w >= 560)
                              SizedBox(
                                width: w < 620 ? 140 : 168,
                                child: _NavPane(
                                  pane: _pane,
                                  onPane: (p) => setState(() => _pane = p),
                                ),
                              ),
                            Expanded(
                              child: Column(
                                children: [
                                  SizedBox(
                                    height: 40,
                                    child: Row(
                                      mainAxisAlignment: MainAxisAlignment.end,
                                      children: [
                                        Padding(
                                          padding: const EdgeInsets.fromLTRB(
                                            0,
                                            16,
                                            16,
                                            0,
                                          ),
                                          child: _CloseButton(
                                            onTap: widget.onClose,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  _Header(pane: _pane),
                                  if (w < 560)
                                    _MobilePaneBar(
                                      pane: _pane,
                                      onPane: (p) => setState(() => _pane = p),
                                    ),
                                  Expanded(
                                    child: OndraScroll(
                                      padding: const EdgeInsets.fromLTRB(
                                        24,
                                        8,
                                        24,
                                        24,
                                      ),
                                      child: _body(s),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(OndraSkin s) {
    // 设置值统一由 ondra-settings 的投影提供：任一开关 / 选项变化都要重建，
    // 所以整页包一层 AnimatedBuilder，而不是让每个控件自己管状态。
    return AnimatedBuilder(
      animation: Listenable.merge([settingsClient, modelClient, personaClient]),
      builder: (context, _) {
        final pane = switch (_pane) {
          _Pane.general => _general(s),
          _Pane.model => _model(s),
          _Pane.channels => _channels(s),
          _Pane.persona => _persona(s),
          _Pane.about => _about(s),
        };
        return _stack([
          if (settingsClient.applicationErrors.isNotEmpty)
            _Section(
              children: [
                _Row(
                  title: '${settingsClient.applicationErrors.length} 项设置尚未应用',
                  desc: '查看逐项原因；保存失败不会显示为已经生效',
                  action: _LinkText(label: '详情', onTap: _showSettingErrors),
                  showDivider: false,
                ),
              ],
            ),
          if (settingsClient.restartRequired ||
              modelClient.runtimePending ||
              personaClient.pendingRestart)
            _Section(
              children: [
                _Row(
                  title: modelClient.runtimeApplying ? '正在连接内核…' : '有配置待内核重载',
                  desc:
                      modelClient.runtimeApplyError ?? '重连会保留已存数据；正在生成时等待本轮结束',
                  descMaxLines: 2,
                  action: _LinkText(label: '应用', onTap: _applyRuntime),
                  showDivider: false,
                ),
              ],
            ),
          pane,
        ]);
      },
    );
  }

  Future<void> _showSettingErrors() async {
    final retry = await OndraDialog.show<bool>(
      context,
      OndraDialog(
        title: '未应用的设置',
        content: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 250),
          child: SingleChildScrollView(
            child: SelectableText(
              [
                for (final entry in settingsClient.applicationErrors.entries)
                  '${ondraSettingSpec(entry.key).label}：${entry.value}',
              ].join('\n\n'),
            ),
          ),
        ),
        actions: const [
          OndraDialogButton(label: '关闭', value: false),
          OndraDialogButton(label: '重试应用', value: true, filled: true),
        ],
      ),
    );
    if (retry == true) {
      final ok = await settingsClient.applyPending();
      if (mounted) {
        OndraToast.show(
          context,
          ok ? '已重新保存；内核配置需重连后生效。' : '仍有设置未应用，请查看详情。',
          ok: ok,
        );
      }
    }
  }

  Future<void> _applyRuntime() async {
    if (modelClient.runtimeReconnect == null) {
      OndraToast.show(context, '当前环境没有可重连的本机内核。', ok: false);
      return;
    }
    await modelClient.applyPendingRuntime();
    if (!mounted) return;
    final error = modelClient.runtimeApplyError;
    OndraToast.show(
      context,
      error ?? (modelClient.runtimePending ? '已等待当前对话完成后应用。' : '内核已重新连接。'),
      ok: error == null,
    );
  }

  /// 由声明生成一行设置：文案、默认值、选项都取自 `settings_spec.dart`，
  /// 页面里不再逐条手写开关。
  ///
  /// 每行都带一句「这一项在内核里有没有落点」的说明（见 [settings_targets.dart]）。
  /// 没有落点的项不假装生效——那一句小字就是它的诚实标签。
  Widget _specRow(String key, {bool showDivider = true}) {
    final spec = ondraSettingSpec(key);
    final desc = _wiringNote(key, spec.description);
    // 这里**传中文原文**，翻译统一在 `_Row` / `_Section` 那两处做。
    // 在这里翻一次、`_Row` 里再翻一次会翻两遍——如果某个译文恰好等于
    // 另一条的中文键，第二次就会把它换掉，症状是「偶尔有一条英文变成了
    // 完全不相干的话」，极难查。一处翻译、一处渲染，边界才清楚。
    switch (spec.kind) {
      case OndraSettingKind.toggle:
        return _Row(
          title: spec.label,
          desc: desc,
          action: OndraSwitch(
            value: settingsClient.boolean(key),
            onChanged: (v) => settingsClient.set(key, v),
          ),
          showDivider: showDivider,
        );
      case OndraSettingKind.choice:
        final current = settingsClient.choice(key);
        final index = spec.options.indexWhere((o) => o.value == current);
        // 存储值不在选项里（旧数据、手改过的 prefs）：回写默认值。
        // 高亮第 0 项会让用户看到「选中的」其实没生效，那是假的当前值。
        if (index < 0) {
          settingsClient.set(key, spec.defaultValue);
        }
        final resolved = index < 0
            ? spec.options.indexWhere((o) => o.value == spec.defaultValue)
            : index;
        return _Row(
          title: spec.label,
          desc: desc,
          action: _PillSegmented(
            value: resolved < 0 ? 0 : resolved,
            items: [
              for (final o in spec.options)
                OndraI18nScope.translate(context, o.label),
            ],
            onChanged: (i) => settingsClient.set(key, spec.options[i].value),
          ),
          showDivider: showDivider,
        );
      case OndraSettingKind.stepper:
        return _Row(
          title: spec.label,
          desc: desc,
          action: _Stepper(
            value: settingsClient.number(key),
            unit: spec.unit ?? '',
            onMinus: () => settingsClient.stepNumber(key, -1),
            onPlus: () => settingsClient.stepNumber(key, 1),
          ),
          showDivider: showDivider,
        );
    }
  }

  /// 说明文字后面缀一句接线状态。
  ///
  /// 为什么值得占这一行：这一版最重要的修复就是「开关拨了到底生不生效」。
  /// 用户没法自己验证——他看不见 `settings.json`。所以界面必须自己说清楚。
  ///
  /// 两种情况要分开说，因为用户的下一步动作不一样：
  /// - **内核没有这个配置段**：装了也没用，等内核更新；
  /// - **缺的是插件**（QQ 通道这类）：装上对应插件就能生效。
  /// 一律写成「只影响界面」会让人以为永远没救。
  ///
  /// 返回值是**中文原文**（未翻译）：调用点拿着它和主描述一起过 [t]。
  /// 在这里翻译会做出「中文描述 + 英文提示」这种半截结果——两段是拼在一起的，
  /// 必须一起翻。
  static String? _wiringNote(String key, String? desc) {
    if (ondraSettingIsWired(key)) return desc;
    final note = _noteOf(key);
    return desc == null || desc.isEmpty ? note : '$desc · $note';
  }

  static String _noteOf(String key) => key.startsWith('channels.')
      ? '本项需要通道插件：未安装时只记录界面选择'
      : '本项只影响界面：内核还没有对应的配置段';

  // ── 通用设置（权限 / 语言 / 字号，通知已并入） ───────────────────────────────

  Widget _general(OndraSkin s) => _stack([
    _Section(
      title: '外观',
      children: [
        // 三种都真的能选：浅色 / 深色是应用自己的决定，跟随系统交给 macOS。
        // 选择写进 `~/.ondra/prefs.json`，下次启动直接是这个外观，
        // 不会先闪一帧浅色再切过去。
        _Row(
          title: '主题',
          desc: ShellScope.of(context).themeMode == ThemeMode.system
              ? '跟随 macOS 外观自动切换'
              : '不随系统，固定使用此模式',
          action: const _ThemePicker(),
        ),
        _specRow('general.language'),
        _specRow('general.fontSize', showDivider: false),
      ],
    ),
    _Section(
      title: '权限',
      children: [_specRow('general.permissions', showDivider: false)],
    ),
    _Section(
      title: '启动',
      children: [
        _specRow('general.launchAtLogin'),
        _specRow('general.preventSleep', showDivider: false),
      ],
    ),
    _Section(
      title: '通知',
      children: [
        _specRow('general.notify'),
        _specRow('general.notifySound'),
        _specRow('general.focusMute', showDivider: false),
      ],
    ),
    // 白名单是「被动网页」的唯一入口：浏览不挂在左栏，管理它的地方在这里。
    AnimatedBuilder(
      animation: browserClient,
      builder: (context, _) => _Section(
        title: '浏览',
        children: [
          _Row(
            title: '网页白名单',
            desc: '应用内打开的网页只能来自这份清单；当前 {n} 个站点',
            descVars: {'n': browserClient.sites.length},
            chevron: true,
            onTap: () {
              // 先关设置再露面：面板顶替中栏那一页，设置盖在上面会打架。
              final shell = ShellScope.of(context);
              if (ondraIsMobile) shell.mobilePageOpen = true;
              widget.onClose();
              browserClient.showList();
            },
            showDivider: false,
          ),
        ],
      ),
    ),
  ]);

  // ── 模型基座：分类 → 预设 → 配置 ────────────────────────────────────────────

  Widget _model(OndraSkin s) {
    if (_choosingCategory) return _categoryPicker(s);

    final category = _addingCategory;
    if (category != null) {
      if (category == ProviderCategory.custom) {
        return _CustomProviderForm(
          category: category,
          onDone: () => setState(() => _addingCategory = null),
        );
      }
      return _PresetPicker(
        category: category,
        onBack: () => setState(() {
          _addingCategory = null;
          _choosingCategory = true;
        }),
        onPick: (preset) {
          final err = modelClient.addPreset(preset);
          if (err != null) return err;
          // 加完直接进编辑器：地址（合作方 / 免费服务）与密钥都得用户补，
          // 退回列表只会让人以为「加完了，怎么还是不能用」。
          setState(() {
            _addingCategory = null;
            _editingProvider = preset.id;
          });
          return null;
        },
        onManual: () =>
            setState(() => _addingCategory = ProviderCategory.custom),
      );
    }

    final editing = _editingProvider == null
        ? null
        : modelClient.byId(_editingProvider!);
    if (editing != null) {
      return _ProviderEditor(
        // 换提供商要重建编辑页：输入框里的文字属于某一条提供商，
        // 复用同一个 State 会把上一家的地址留在框里。
        key: ValueKey(editing.id),
        provider: editing,
        onBack: () => setState(() => _editingProvider = null),
      );
    }
    return _providerList(s);
  }

  Widget _providerList(OndraSkin s) {
    final used = [
      for (final c in ProviderCategory.values)
        if (modelClient.byCategory(c).isNotEmpty) c,
    ];
    final entries = modelClient.allModelEntries;

    return _stack([
      _Section(
        title: '提供商',
        children: [
          if (used.isEmpty)
            const _Row(
              title: '还没有提供商',
              desc: '从下面加一个：官方 / 合作 / 免费 / 自定义 / 本地部署 / 本地网关',
              showDivider: false,
            ),
          for (final c in used) ...[
            _GroupLabel(
              label: c.label,
              meta: '${modelClient.byCategory(c).length} 个',
            ),
            for (var i = 0; i < modelClient.byCategory(c).length; i++)
              _Row(
                title: modelClient.byCategory(c)[i].name,
                desc: _providerLine(modelClient.byCategory(c)[i]),
                value: _providerState(modelClient.byCategory(c)[i]),
                action: _LinkText(
                  label: '编辑',
                  onTap: () => setState(
                    () => _editingProvider = modelClient.byCategory(c)[i].id,
                  ),
                ),
                showDivider: i != modelClient.byCategory(c).length - 1,
              ),
          ],
          _Row(
            title: '添加模型提供商',
            desc: '官方 API / 合作 API / 免费 API / 自定义 / 本地部署 / 本地网关',
            chevron: true,
            onTap: () => setState(() => _choosingCategory = true),
            showDivider: false,
          ),
        ],
      ),
      _Section(
        title: '默认模型',
        children: [
          if (entries.isEmpty)
            const _Row(title: '还没有可用模型', desc: '先添加一个提供商', showDivider: false),
          for (var i = 0; i < entries.length; i++)
            _Row(
              title: entries[i].$2.id,
              desc: entries[i].$2.contextWindow.isEmpty
                  ? entries[i].$1.name
                  : '${entries[i].$1.name} · 上下文 ${entries[i].$2.contextWindow}',
              action: _SmallPill(
                label: modelClient.isDefault(entries[i].$1, entries[i].$2)
                    ? '当前'
                    : '设为默认',
                onTap: () {
                  final err = modelClient.setDefaultModel(
                    entries[i].$1,
                    entries[i].$2,
                  );
                  if (err != null && context.mounted) {
                    OndraToast.show(context, err, ok: false);
                  }
                },
              ),
              showDivider: i != entries.length - 1,
            ),
        ],
      ),
      Text(
        '提供商与模型目录保存在 ~/.ondra/models.json，重启后还在；'
        '密钥只写不读，存本机钥匙串。本地部署与网关可以直接「检测连接」，从端点读回模型目录。',
        style: ondraText(11, color: s.ink30, height: 16 / 11),
      ),
    ]);
  }

  String _providerLine(OndraProvider p) {
    if (p.baseUrl.isEmpty) return '${p.category.label} · 地址未填写';
    return '${p.category.label} · ${p.baseUrl}';
  }

  String _providerState(OndraProvider p) {
    if (p.baseUrl.isEmpty) return '待填地址';
    if (p.category == ProviderCategory.local) return '本地';
    return p.keyConfigured ? '密钥已配置' : '密钥缺失';
  }

  /// 第一步：选「模型从哪来」。
  Widget _categoryPicker(OndraSkin s) => _stack([
    _BackRow(
      label: '添加模型提供商',
      onTap: () => setState(() => _choosingCategory = false),
    ),
    _Section(
      title: '模型从哪来',
      children: [
        for (var i = 0; i < ProviderCategory.values.length; i++)
          _Row(
            title: ProviderCategory.values[i].label,
            desc: ProviderCategory.values[i].note,
            value: ProviderCategory.values[i] == ProviderCategory.custom
                ? '空白表单'
                : '${presetsOf(ProviderCategory.values[i]).length} 个预设',
            chevron: true,
            onTap: () => setState(() {
              _choosingCategory = false;
              _addingCategory = ProviderCategory.values[i];
            }),
            showDivider: i != ProviderCategory.values.length - 1,
          ),
      ],
    ),
    Text(
      '分类只决定「模型在哪」，不决定能不能用：本地部署与网关同样是 OpenAI 兼容协议，'
      '换过去不用改提示词。',
      style: ondraText(11, color: s.ink30, height: 16 / 11),
    ),
  ]);

  // ── 人设设定（对话 / 记忆 / 语音已并入） ────────────────────────────────────

  Widget _persona(OndraSkin s) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 顶距比别的页小：这一页的第一屏是「头像 + 名字」，多留白会把
        // 下面的设置挤出第一屏。
        const SizedBox(height: 16),
        const Center(child: _AvatarEditor()),
        const SizedBox(height: 8),
        // 名字与包信息全部来自 ondra-persona 插件：这一页不认识任何具体的
        // 人设，换包、热切换、重载之后，这里跟着变。
        AnimatedBuilder(
          animation: personaClient,
          builder: (context, _) {
            final p = personaClient.active;
            return Column(
              children: [
                Center(
                  child: SizedBox(
                    width: 120,
                    child: Text(
                      p.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: ondraText(
                        14,
                        weight: 500,
                        color: s.ink,
                        height: 18 / 14,
                      ),
                    ),
                  ),
                ),
                if (personaClient.error != null) ...[
                  const SizedBox(height: 4),
                  Text(
                    '包加载失败：${personaClient.error}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: ondraText(11, color: s.ink40, height: 15 / 11),
                  ),
                ],
              ],
            );
          },
        ),
        const SizedBox(height: 20),
        _Section(
          title: '人设包',
          children: [
            AnimatedBuilder(
              animation: personaClient,
              builder: (context, _) {
                final p = personaClient.active;
                return _Row(
                  title: '当前人设',
                  desc: p.tagline.isEmpty ? '（包里没有写一句话内核）' : p.tagline,
                  descMaxLines: 1,
                  // 「重载」挂在这一行上：它重载的就是这个人设包。
                  action: _LinkText(
                    label: '重载',
                    onTap: () => personaClient.reload(),
                  ),
                  value: 'v${p.version}',
                );
              },
            ),
            for (final pack in personaClient.packs)
              _Row(
                title: pack.name,
                desc: pack.builtIn ? '随包人设' : '已安装人设',
                value: pack.id == personaClient.active.id ? '当前' : null,
                action: pack.id == personaClient.active.id
                    ? null
                    : _LinkText(
                        label: '使用',
                        onTap: () async {
                          final result = await personaClient.switchTo(pack.id);
                          if (!mounted) return;
                          OndraToast.show(
                            context,
                            result.message,
                            ok: result.ok,
                          );
                        },
                      ),
              ),
            if (!personaClient.active.builtIn) ...[
              _Row(title: '导出当前人设', chevron: true, onTap: _exportPersona),
              _Row(title: '删除当前人设', chevron: true, onTap: _removePersona),
            ],
            if (personaClient.error != null)
              _Row(title: '人设操作未完成', desc: personaClient.error),
            _Row(
              title: '导入人设包',
              desc: '支持 .skill / .zip 文件，校验与落盘由 ondra-persona 完成',
              chevron: true,
              onTap: _importPersona,
            ),
            _Row(
              title: '重置为默认人设',
              desc: '只切回默认包，记忆不删',
              onTap: () => personaClient.resetToDefault(),
              showDivider: false,
            ),
          ],
        ),
        const SizedBox(height: 20),
        _Section(
          title: '称呼',
          children: [
            _Row(
              title: '让你怎么叫我',
              desc: '本项只影响界面：内核提示词段的称呼要等人设切换接上后一并生效',
              value: _nickname.isEmpty ? '不指定' : _nickname,
              chevron: true,
              onTap: _editNickname,
              showDivider: false,
            ),
          ],
        ),
        const SizedBox(height: 20),
        // 对话行为：怎么发、发多长。之前是独立一类，现在归到「这个人怎么说话」。
        _Section(
          title: '对话',
          children: [
            _specRow('dialog.busySend'),
            _specRow('dialog.enterSend'),
            _specRow('dialog.replyLength', showDivider: false),
          ],
        ),
        const SizedBox(height: 20),
        // 记忆：记不记、怎么记、留多久。开关与保留策略放在一起才对得上——
        // 「允许记住」和「留 30 天」本来就是同一件事的两端。
        _Section(
          title: '记忆',
          children: [
            _specRow('dialog.remember'),
            _specRow('dialog.citeMemory'),
            _specRow('dialog.inferPreference'),
            _specRow('memory.retention'),
            _specRow('memory.autoSummarize', showDivider: false),
          ],
        ),
        const SizedBox(height: 20),
        _Section(
          title: '数据',
          children: [
            // 不给选择器：数据根目录由内核写死，改这里不会搬家。
            // 显示真实路径，用户至少知道东西在哪、能自己去备份。
            _Row(title: '数据位置', desc: '记忆、会话与配置都写在这里', value: ondraDataRoot),
            _Row(
              title: '导出全部数据',
              desc: '记忆、会话、人设与配置打包；明文，自己挑存放位置',
              chevron: true,
              onTap: _exportAll,
            ),
            _Row(
              title: '清空全部数据',
              desc: '删掉记忆与会话，不可恢复',
              chevron: true,
              onTap: _wipeAll,
              showDivider: false,
            ),
          ],
        ),
        const SizedBox(height: 20),
        // 语音：念不念、什么音色、听哪种话。音色属于「这个人」，不属于应用。
        _Section(
          title: '语音',
          children: [
            _specRow('voice.tts'),
            _specRow('voice.timbre'),
            _specRow('voice.rate'),
            _specRow('voice.asrLanguage', showDivider: false),
          ],
        ),
        const SizedBox(height: 6),
        Text(
          '音色与语速只影响朗读，不改文字语气；语气属于人设包。',
          style: ondraText(11, color: s.ink30, height: 16 / 11),
        ),
      ],
    );
  }

  // ── 通道接口（QQ 机器人这类外部通道） ──────────────────────────────────────

  Widget _channels(OndraSkin s) => _stack([
    _Section(
      title: 'QQ',
      children: [
        _specRow('channels.qqBot'),
        _specRow('channels.qqSandbox'),
        _specRow('channels.allowGroups', showDivider: false),
      ],
    ),
    _Section(
      title: '机器人凭据',
      children: [
        _Row(
          title: 'AppID',
          desc: '在 QQ 开放平台创建机器人后取得 · 本项需要通道插件：接上前只记录填写内容',
          value: _qqAppId.isEmpty ? '未填写' : _qqAppId,
          action: _LinkText(
            label: '填写',
            onTap: () => _editQqCredential(qqAppIdKey),
          ),
        ),
        _Row(
          title: '密钥',
          desc: '只存在本机钥匙串，不上传 · 接上通道插件后才会被读取',
          value: _qqSecretSet ? '已保存' : '未填写',
          action: _LinkText(
            label: '填写',
            onTap: () => _editQqCredential(qqSecretKey),
          ),
          showDivider: false,
        ),
      ],
    ),
    _Section(
      title: '投递',
      children: [_specRow('channels.busyPolicy', showDivider: false)],
    ),
    const SizedBox(height: 4),
    Text(
      '通道是「把空谷接到别的聊天工具」：消息从 QQ 进来，回复送回去，'
      '会话与记忆仍在本机。',
      style: ondraText(11, color: s.ink30, height: 16 / 11),
    ),
  ]);

  // ── 关于空谷（隐私 / 反馈已并入） ──────────────────────────────────────────

  Widget _about(OndraSkin s) => _stack([
    _Section(
      children: [
        _Row(
          title: '空谷 Ondra',
          desc: '$ondraVersion · $ondraStage',
          action: _SmallPill(
            label: _checkingUpdate ? '检查中…' : '检查更新',
            onTap: _checkUpdates,
          ),
        ),
        _specRow('about.channel'),
        AnimatedBuilder(
          animation: personaClient,
          builder: (context, _) => _Row(
            title: '人设包',
            desc: '当前：${personaClient.active.displayName}',
            value: personaClient.active.id,
            showDivider: false,
          ),
        ),
      ],
    ),
    _Section(
      children: [
        _Row(
          title: '清除缓存',
          desc: '清掉不会丢对话与记忆',
          chevron: true,
          onTap: _clearCache,
        ),
        _Row(title: '系统权限', chevron: true, onTap: _showPermissions),
        // 许可必须点得开：MiSans 许可协议第 2 条第 1 款要求「在软件中特别
        // 注明使用了 MiSans 字体」，一个点不动的行满足不了这条。
        _Row(
          title: '开源许可',
          desc: _licenseOpen ? null : 'Apache-2.0 与 MIT 分层授权；字体 MiSans',
          chevron: true,
          onTap: () => setState(() => _licenseOpen = !_licenseOpen),
          showDivider: _licenseOpen,
        ),
        if (_licenseOpen) _licensePanel(s),
      ],
    ),
    // 隐私与安全：本地优先产品的边界，不能只藏在版本号下面一行。
    _Section(
      title: '隐私与安全',
      children: [
        _specRow('privacy.voiceCloud'),
        _specRow('privacy.imageCloud'),
        _specRow('privacy.screenRead'),
        _specRow('privacy.redactLogs'),
        // 「API Key 存放」不给选择器：当前只有钥匙串一种实现，
        // 「本地加密文件」这个选项背后没有代码。留一个选了会静默失效的
        // 单选，用户会以为密钥存到了别处。
        _Row(
          title: 'API Key 存放',
          desc: '密钥只进系统钥匙串，不写进任何配置文件',
          value: Keychain.supported ? '系统钥匙串' : '当前环境不可用',
          showDivider: false,
        ),
      ],
    ),
    // 问题反馈：与版本信息同屏，报问题时版本号就在上面。
    _Section(
      title: '问题反馈',
      children: [
        _Row(
          title: '问题类型',
          value: _feedbackKind ?? '请选择问题类型',
          chevron: true,
          onTap: _pickFeedbackKind,
        ),
        _Row(
          title: '建议详情',
          desc: _feedbackBody.isEmpty
              ? '请具体描述您的建议（不少于 10 个字，最多 200 字）'
              : '${_feedbackBody.length} / 200 字',
          value: _feedbackBody.isEmpty ? null : _ellipsis(_feedbackBody, 18),
          multiline: _feedbackBody.isEmpty,
          action: _LinkText(
            label: _feedbackBody.isEmpty ? '填写' : '修改',
            onTap: _editFeedbackBody,
          ),
        ),
        _Row(
          title: '添加图片或视频',
          desc: _attachments.isEmpty
              ? '最多添加 3 个附件'
              : '已选 ${_attachments.length} 个：${_attachmentNames()}',
          descMaxLines: 2,
          chevron: true,
          onTap: _pickAttachments,
          showDivider: false,
        ),
      ],
    ),
    Align(
      alignment: Alignment.centerRight,
      child: _PrimaryPill(
        label: _savingFeedback ? '保存中…' : '保存反馈',
        onTap: _submitFeedback,
      ),
    ),
    const SizedBox(height: 4),
    Text(
      '只保存到本机，不会自动上传或发送。日志仅尽力脱敏；描述和附件未自动脱敏，分享前请检查。',
      style: ondraText(11, color: s.ink30, height: 16 / 11),
    ),
  ]);

  // ── 人设：装包与称呼 ────────────────────────────────────────────────────

  /// 称呼存在偏好里，键与开发侧同名前缀。
  ///
  /// 它不是设置项（不进 `settings_spec.dart`），因为「你叫什么」属于**关系**，
  /// 不属于应用配置；放同一张表里会让 33 个开关的清单多出一条完全不同性质的条目。
  static const String _nicknameKey = 'persona.nickname';

  String get _nickname => readPref(_nicknameKey);

  /// 导入人设包：系统面板选文件 → 交给 personaClient 校验落盘 → 报告结论。
  ///
  /// 这里**不读文件内容**：判后缀、判 PK 头、解压、找 meta.json、查 slug 合法性
  /// 全在 `PersonaStore.install` 里做。界面层如果自己也判一遍，两处的规则
  /// 迟早会分叉——一处放行、另一处拒绝，用户看到的是「选完没反应」。
  Future<void> _importPersona() async {
    if (!DesktopPicker.supported && mounted) {
      OndraToast.show(context, '这台系统还没有接入文件选择面板', ok: false);
      return;
    }
    final path = await DesktopPicker.pickFile(
      prompt: '选择人设包（.skill / .zip / .ondra）',
    );
    if (path == null) return; // 取消就是什么都不做。
    final r = await personaClient.importPack(archivePath: path);
    if (!mounted) return;
    OndraToast.show(context, r.message, ok: r.ok);
  }

  Future<void> _exportPersona() async {
    if (!DesktopPicker.supported) {
      OndraToast.show(context, '这台系统还没有接入文件选择面板', ok: false);
      return;
    }
    final path = await DesktopPicker.saveFile(
      prompt: '导出当前人设',
      defaultName: '${personaClient.active.id}.skill.zip',
    );
    if (path == null) return;
    final result = await personaClient.exportActive(targetZip: path);
    if (mounted) OndraToast.show(context, result.message, ok: result.ok);
  }

  Future<void> _removePersona() async {
    final pack = personaClient.active;
    final confirmed = await OndraDialog.show<bool>(
      context,
      OndraDialog(
        title: '删除人设包？',
        body: '将删除「${pack.name}」并切回默认人设，记忆与对话会保留。',
        actions: const [
          OndraDialogButton(label: '取消', value: false),
          OndraDialogButton(
            label: '删除',
            value: true,
            danger: true,
            filled: true,
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final result = await personaClient.remove(pack.id);
    if (mounted) OndraToast.show(context, result.message, ok: result.ok);
  }

  /// 改称呼：一个输入框、一句话说明。
  Future<void> _editNickname() async {
    final controller = TextEditingController(text: _nickname);
    final value = await OndraDialog.show<String>(
      context,
      _TextPromptDialog(
        title: '让你怎么叫我',
        hint: '留空表示不指定，就按「你」称呼',
        controller: controller,
        maxLength: 16,
      ),
    );
    controller.dispose();
    if (value == null) return; // 取消。
    writePref(_nicknameKey, value.trim());
    if (mounted) setState(() {});
  }

  // ── 数据：导出与清空 ────────────────────────────────────────────────────

  final OndraMaintenance _maintenance = OndraMaintenance(
    dataIsOffline: () => dataMaintenance.offline,
  );

  Future<MaintenanceResult> _runMaintenance(
    Future<MaintenanceResult> Function() action, {
    bool refresh = false,
  }) async {
    try {
      return await dataMaintenance.run(action, refresh: refresh);
    } catch (error) {
      return MaintenanceResult(ok: false, message: '数据维护未完成：$error');
    }
  }

  /// 导出全部数据：挑目录 → 复制成 `ondra-export/` → 报文件数与体积。
  Future<void> _exportAll() async {
    if (!DesktopPicker.supported) {
      OndraToast.show(context, '这台系统还没有接入文件选择面板', ok: false);
      return;
    }
    final dir = await _maintenance.pickDirectory('选择导出位置');
    if (dir == null) return;
    final r = await _runMaintenance(() => _maintenance.exportAll(dir));
    if (!mounted) return;
    OndraToast.show(context, r.message, ok: r.ok);
  }

  /// 清空全部数据。**两步确认**：这是一条不可逆的动作，
  /// 单击就执行等于把「手滑」也当成意愿。
  Future<void> _wipeAll() async {
    final confirmed = await OndraDialog.show<bool>(
      context,
      const OndraDialog(
        title: '清空全部数据？',
        body:
            '会删掉记忆、会话与设备缓存，以及设置里的全部偏好。'
            '插件装配表与你导入的人设包会保留——删掉它们应用就起不来了。\n\n'
            '这一步不可恢复，也没有回收站。想留一份就先「导出全部数据」。',
        actions: [
          OndraDialogButton(label: '取消', value: false),
          OndraDialogButton(
            label: '确认清空',
            filled: true,
            danger: true,
            value: true,
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final r = await _runMaintenance(() async {
      final result = await _maintenance.wipeAll();
      if (result.ok) await settingsClient.resetAll();
      return result;
    }, refresh: true);
    if (!mounted) return;
    if (r.ok) {
      setState(() {
        _attachments.clear();
        _feedbackBody = '';
        _feedbackKind = null;
      });
    }
    OndraToast.show(context, r.message, ok: r.ok);
  }

  // ── 关于：更新、缓存、权限 ──────────────────────────────────────────────

  bool _checkingUpdate = false;

  Future<void> _checkUpdates() async {
    if (_checkingUpdate) return;
    setState(() => _checkingUpdate = true);
    final r = await UpdateChecker.check(
      currentVersion: ondraVersion,
      channel: settingsClient.choice('about.channel'),
    );
    if (!mounted) return;
    setState(() => _checkingUpdate = false);
    final url = r.url;
    if (r.status != UpdateStatus.available || url == null) {
      OndraToast.show(context, r.message, ok: r.status != UpdateStatus.failed);
      return;
    }
    final action = await OndraDialog.show<String>(
      context,
      OndraDialog(
        title: '发现新版本',
        body: '${r.message}\n\n$url\n\n仅打开官方发行页，不会自动下载或安装。',
        actions: const [
          OndraDialogButton(label: '稍后', value: 'later'),
          OndraDialogButton(label: '复制链接', value: 'copy'),
          OndraDialogButton(label: '打开发行页', filled: true, value: 'open'),
        ],
      ),
    );
    if (action == 'copy') {
      await Clipboard.setData(ClipboardData(text: url));
      if (mounted) OndraToast.show(context, '发行页链接已复制。', ok: true);
    } else if (action == 'open') {
      final opened = await UpdateChecker.openRelease(url);
      if (mounted) OndraToast.show(context, opened.message, ok: opened.ok);
    }
  }

  Future<void> _clearCache() async {
    final r = await _runMaintenance(_maintenance.clearCache);
    if (!mounted) return;
    OndraToast.show(context, r.message, ok: r.ok);
  }

  Future<void> _showPermissions() async {
    final list = await _maintenance.permissions();
    if (!mounted) return;
    await OndraDialog.show<void>(
      context,
      OndraDialog(
        title: '系统权限',
        body:
            '「未知」是如实的：系统不提供这两项的查询接口，'
            '只能等它第一次弹窗时由你决定。',
        width: 440,
        content: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < list.length; i++)
              _permissionRow(list[i], last: i == list.length - 1),
          ],
        ),
        actions: const [OndraDialogButton(label: '知道了', filled: true)],
      ),
    );
  }

  Widget _permissionRow(PermissionStatus p, {required bool last}) {
    final s = OndraSkin.of(context);
    final (String label, Color color) = switch (p.granted) {
      true => ('已授权', const Color(0xFF16A34A)),
      false => ('未授权', OndraColor.danger),
      null => ('未知', s.ink45),
    };
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 9),
      decoration: BoxDecoration(
        border: last
            ? null
            : Border(bottom: BorderSide(color: s.lineFaint, width: 1)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  p.name,
                  style: ondraText(12.5, color: s.ink80, height: 18 / 12.5),
                ),
                const SizedBox(height: 1),
                Text(
                  p.detail,
                  style: ondraText(11, color: s.ink40, height: 15 / 11),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Text(
            label,
            style: ondraText(
              11.5,
              weight: 500,
              color: color,
              height: 18 / 11.5,
            ),
          ),
        ],
      ),
    );
  }

  // ── 反馈 ────────────────────────────────────────────────────────────────

  final FeedbackStore _feedback = FeedbackStore();

  String? _feedbackKind;
  bool _savingFeedback = false;
  String _feedbackBody = '';
  final List<String> _attachments = [];

  Future<void> _pickFeedbackKind() async {
    final chosen = await OndraDialog.show<String>(
      context,
      OndraDialog(
        title: '问题类型',
        content: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final k in FeedbackStore.kinds)
              _kindOption(k, selected: k == _feedbackKind),
          ],
        ),
        actions: const [OndraDialogButton(label: '取消')],
      ),
    );
    if (chosen == null) return;
    setState(() => _feedbackKind = chosen);
  }

  Widget _kindOption(String kind, {required bool selected}) {
    final s = OndraSkin.of(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => OndraDialog.close(context, kind),
      child: Container(
        margin: const EdgeInsets.only(bottom: 2),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? s.fill : Colors.transparent,
          borderRadius: BorderRadius.circular(OndraRadius.md),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                kind,
                style: ondraText(13, color: s.ink80, height: 18 / 13),
              ),
            ),
            if (selected)
              const Glyph(Glyphs.check, size: 14, color: OndraColor.accent),
          ],
        ),
      ),
    );
  }

  Future<void> _editFeedbackBody() async {
    final controller = TextEditingController(text: _feedbackBody);
    final value = await OndraDialog.show<String>(
      context,
      _TextPromptDialog(
        title: '建议详情',
        hint: '具体说说你遇到的情况：做了什么、看到什么、期望什么',
        controller: controller,
        maxLength: 200,
        minLines: 4,
        maxLines: 8,
      ),
    );
    controller.dispose();
    if (value == null) return;
    setState(() => _feedbackBody = value.trim());
  }

  Future<void> _pickAttachments() async {
    if (!DesktopPicker.supported) {
      OndraToast.show(context, '当前环境不支持选择附件。', ok: false);
      return;
    }
    final picked = await _feedback.pickAttachments();
    if (!mounted || picked.isEmpty) return;
    setState(() {
      _attachments
        ..clear()
        ..addAll(picked.take(3));
    });
  }

  Future<void> _submitFeedback() async {
    if (_savingFeedback) return;
    final kind = _feedbackKind;
    if (kind == null) {
      OndraToast.show(context, '先选一个问题类型。', ok: false);
      return;
    }
    if (_feedbackBody.trim().length < 10) {
      OndraToast.show(context, '描述至少写 10 个字，否则看不出是什么问题。', ok: false);
      return;
    }
    setState(() => _savingFeedback = true);
    final body = _feedbackBody;
    try {
      final r = await _feedback.write(
        kind: kind,
        body: body,
        version: '$ondraVersion+$ondraBuild',
        attachmentPaths: List.of(_attachments),
        attachLog: true,
      );
      if (!mounted) return;
      if (!r.ok) {
        OndraToast.show(context, r.message, ok: false);
        return;
      }
      final open = await OndraDialog.show<bool>(
        context,
        OndraDialog(
          title: '已存到本机',
          body:
              '${r.message}\n\n可生成包含报告、日志和附件副本的邮件草稿。'
              '客户端可能只预览 .eml 或不保留附件；请核对，必要时从报告目录手动附加。'
              '收件人与是否发送由你决定，应用不会发送。',
          actions: const [
            OndraDialogButton(label: '只保存报告', value: false),
            OndraDialogButton(label: '生成并打开草稿', filled: true, value: true),
          ],
        ),
      );
      if (open == true) {
        final draft = await _feedback.compose(
          kind: kind,
          body: body,
          version: '$ondraVersion+$ondraBuild',
          reportPath: r.path,
          openDraft: true,
        );
        if (mounted) OndraToast.show(context, draft.message, ok: draft.ok);
      }
    } finally {
      if (mounted) setState(() => _savingFeedback = false);
    }
  }

  String _attachmentNames() {
    // 只显示文件名：完整路径太长，一行放不下，而用户认得的是文件名。
    final names = [for (final p in _attachments) p.split('/').last];
    return names.join('、');
  }

  static String _ellipsis(String text, int max) {
    final flat = text.replaceAll('\n', ' ');
    return flat.length <= max ? flat : '${flat.substring(0, max)}…';
  }

  // ── 通道凭据 ────────────────────────────────────────────────────────────

  /// AppID 存在偏好里、密钥进系统钥匙串。
  ///
  /// 分开存不是随意的：AppID 在 QQ 开放平台的控制台里是可见的公开标识，
  /// 而密钥是密码。两样都塞钥匙串会让「AppID 填错了」这种排查变得麻烦
  /// （得开钥匙串访问才能看），两样都放明文则是把密码摊在磁盘上。
  static const String qqAppIdKey = 'channels.qqAppId';
  static const String qqSecretKey = 'channels.qqSecret';

  String get _qqAppId => readPref(qqAppIdKey);

  bool _qqSecretSet = false;

  @override
  void initState() {
    super.initState();
    // 打开时落在指定的那一栏：侧栏账户行 → 人设。枚举在壳层，这里翻译。
    if (widget.initialPane != null) {
      _pane = switch (widget.initialPane!) {
        ShellPane.general => _Pane.general,
        ShellPane.model => _Pane.model,
        ShellPane.channels => _Pane.channels,
        ShellPane.persona => _Pane.persona,
        ShellPane.about => _Pane.about,
      };
    }
    // 「已填写 / 未填写」要让用户一眼看清，而密钥本身永远不读回界面。
    //
    // 放到首帧之后：查钥匙串要起一个 `security` 子进程，在 initState 里同步
    // 发起会让帧预算里挂一个未完成的定时器——测试里 `pumpWidget` 会因此报
    // 「pending timers」，真机上则是打开设置的第一帧多一次进程创建的抖动。
    WidgetsBinding.instance.addPostFrameCallback((_) => _refreshSecretState());
  }

  Future<void> _refreshSecretState() async {
    final has = await Keychain.exists(qqSecretKey);
    if (mounted && has != _qqSecretSet) setState(() => _qqSecretSet = has);
  }

  /// 填写凭据。AppID 走偏好，密钥走钥匙串，两者校验规则不同：
  /// AppID 是纯数字，密钥是 32 位十六进制以上的串——但这里**不强制**，
  /// 只挡掉明显错的（空、带空格）。格式校验归通道插件，界面不该抢着判。
  Future<void> _editQqCredential(String key) async {
    final isSecret = key == qqSecretKey;
    final controller = TextEditingController(text: isSecret ? '' : _qqAppId);
    final value = await OndraDialog.show<String>(
      context,
      _TextPromptDialog(
        title: isSecret ? 'QQ 机器人密钥' : 'QQ 机器人 AppID',
        hint: isSecret
            ? (_qqSecretSet ? '已保存；重新输入可覆盖，留空则不修改' : '在 QQ 开放平台 → 开发设置里取得')
            : '机器人资料页上的 AppID',
        controller: controller,
        obscure: isSecret,
        maxLength: 4096,
      ),
    );
    final text = value?.trim();
    controller.dispose();
    if (text == null) return;
    if (text.isEmpty) {
      // 密钥留空 = 「不修改」。要清掉得显式点删除，避免手滑清空一个正确的密钥。
      if (isSecret) return;
      writePref(key, '');
      setState(() {});
      return;
    }
    if (!isSecret) {
      writePref(key, text);
      if (mounted) setState(() {});
      return;
    }
    final r = await Keychain.write(key, text);
    if (!mounted) return;
    OndraToast.show(context, r.message, ok: r.ok);
    if (r.ok) await _refreshSecretState();
  }

  /// 开源许可的展开内容。
  ///
  /// 三段：代码许可、字体许可、第三方组件。前两段是**义务披露**——
  /// Apache-2.0 要求保留 NOTICE，MiSans 许可第 2 条第 1 款要求注明使用了
  /// 该字体，所以这几行不是装饰，删了就是违约。
  Widget _licensePanel(OndraSkin s) => Container(
    width: double.infinity,
    padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
    color: s.lineSoft,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _licenseItem(
          s,
          '代码',
          'Apache-2.0（内核）+ MIT（外壳）。可商用、可闭源、可修改，无传染性。'
              '再分发须保留仓库根 NOTICE 中的归属声明。',
        ),
        const SizedBox(height: 10),
        _licenseItem(
          s,
          '字体 · MiSans',
          '界面字体为 MiSans，版权归小米科技有限责任公司，'
              '依《MiSans 字体知识产权许可协议》免费商用。'
              '字体文件不随源码分发；未附带字体时应用自动使用系统中文字体，'
              '功能不受影响。',
        ),
        const SizedBox(height: 10),
        _licenseItem(
          s,
          '第三方组件',
          'cordis（MIT）、Lucide 图标（ISC）、Flutter SDK（BSD-3-Clause）。'
              '逐项披露见仓库根 NOTICE。本项目不含 GPL / LGPL / AGPL / MPL 组件。',
        ),
      ],
    ),
  );

  Widget _licenseItem(OndraSkin s, String title, String body) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(title, style: ondraText(11.5, weight: 600, color: s.ink60)),
      const SizedBox(height: 3),
      Text(
        body,
        style: ondraText(11, color: s.ink40, height: 17 / 11),
      ),
    ],
  );

  Widget _stack(List<Widget> children) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (var i = 0; i < children.length; i++) ...[
        if (i > 0) const SizedBox(height: 20),
        children[i],
      ],
    ],
  );
}

class _Header extends StatelessWidget {
  const _Header({required this.pane});

  final _Pane pane;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
      child: Align(
        alignment: Alignment.centerLeft,
        child: SizedBox(
          height: 32,
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(
              pane.label,
              style: ondraText(20, weight: 500, color: s.ink, height: 1.4),
            ),
          ),
        ),
      ),
    );
  }
}

/// 左栏：168 宽、比面板再深一档的底、右侧 6% 发丝线。
/// 手机（<560dp）的分类条：横排 pills，可滚动，替代 140dp 的左导航。
class _MobilePaneBar extends StatelessWidget {
  const _MobilePaneBar({required this.pane, required this.onPane});

  final _Pane pane;
  final ValueChanged<_Pane> onPane;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 44,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(
          children: [
            for (final p in _Pane.values)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: _NavItem(
                  label: p.label,
                  selected: pane == p,
                  onTap: () => onPane(p),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _NavPane extends StatelessWidget {
  const _NavPane({required this.pane, required this.onPane});

  final _Pane pane;
  final ValueChanged<_Pane> onPane;

  /// 一条清单，顺序即 `_Pane` 的声明顺序。
  static const _items = _Pane.values;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      decoration: BoxDecoration(
        // 浅色下是 `#F3F3F3`（比白色面板深一档）；深色下不能照抄这个值——
        // 一块浅灰会在一片深色里变成一个发光的方框，导航文字也会全糊掉。
        // 深色下取 `s.content`：比面板深，层级关系与浅色时一致。
        color: s.dark ? s.content : const Color(0xFFF3F3F3),
        border: Border(right: BorderSide(color: s.lineFaint)),
      ),
      padding: const EdgeInsets.only(top: 40),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [_group(_items, s)],
        ),
      ),
    );
  }

  Widget _group(List<_Pane> items, OndraSkin s) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final p in items)
        Padding(
          padding: const EdgeInsets.only(bottom: 1),
          child: _NavItem(
            label: p.label,
            selected: pane == p,
            onTap: () => onPane(p),
          ),
        ),
    ],
  );
}

class _NavItem extends StatefulWidget {
  const _NavItem({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_NavItem> createState() => _NavItemState();
}

class _NavItemState extends State<_NavItem> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: Container(
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          alignment: Alignment.centerLeft,
          decoration: BoxDecoration(
            color: widget.selected
                ? s.fill
                : (_hover ? s.fillHover : Colors.transparent),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(
            widget.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: ondraText(
              14,
              color: widget.selected ? s.ink : s.ink60,
              height: 16 / 14,
            ),
          ),
        ),
      ),
    );
  }
}

class _CloseButton extends StatefulWidget {
  const _CloseButton({required this.onTap});

  final VoidCallback onTap;

  @override
  State<_CloseButton> createState() => _CloseButtonState();
}

class _CloseButtonState extends State<_CloseButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        // 视觉圆圈仍是 24；命中区垫到 44×44（触控最低标准）。
        child: SizedBox(
          width: 44,
          height: 44,
          child: Center(
            child: Container(
              width: 24,
              height: 24,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _hover ? s.fillHover : Colors.transparent,
                shape: BoxShape.circle,
              ),
              child: Glyph(Glyphs.close, size: 16, color: s.ink45),
            ),
          ),
        ),
      ),
    );
  }
}

/// 分组：标题在卡外（13/18、60% 黑），卡 12 圆角、4% 黑底。
class _Section extends StatelessWidget {
  const _Section({this.title, required this.children});

  final String? title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null)
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 8),
            child: Text(
              // 章节标题在这里翻：`_Section` 是设置页唯一的标题渲染点，
              // 逐处翻会漏，而漏一条的表现是「一屏里一句英文夹在中文中间」。
              // 用 `translate(context, …)`：它会登记依赖，语言变了这一处
              // 才会被重建（这棵树上有 `const`，靠父级重建传不下来）。
              OndraI18nScope.translate(context, title!),
              style: ondraText(13, color: s.ink60, height: 18 / 13),
            ),
          ),
        _Card(children: children),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: s.fillFaint,
        borderRadius: BorderRadius.circular(OndraRadius.xl),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(OndraRadius.xl),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      ),
    );
  }
}

/// 行：至少 42 高、左右 16、行间 5% 发丝线。
/// 主题三选一：浅色 / 深色 / 跟随系统。
///
/// 用分段控件而不是下拉：只有三个互斥选项，全摊开比「点开再选」少一步，
/// 也能一眼看出当前是哪一个。样式按系统分段控件的做法——灰槽 + 选中项浮起。
class _ThemePicker extends StatelessWidget {
  const _ThemePicker();

  /// 三格的**原文**。渲染前按当前语言翻译，量宽也用量出来的结果——
  /// 拿中文原文量宽、画英文，滑片就会与文字错位（这是之前那版的做法）。
  static const List<String> _labels = ['浅色', '深色', '跟随系统'];
  static const List<ThemeMode> _modes = [
    ThemeMode.light,
    ThemeMode.dark,
    ThemeMode.system,
  ];

  static const double _trackHeight = 26;
  static const double _cellHeight = 22;
  static const double _padH = 9;
  static const double _trackPad = 2;

  /// 量一格要多宽。
  ///
  /// 三格是**不等宽**的（「跟随系统」四个字），滑片必须知道每一格的真实边界，
  /// 所以宽度不能靠 `Expanded` 均分，得按文字现量。量的时候统一用 500 字重，
  /// 和选中态一致——否则选中一格之后它自己会变宽，滑片就跟文字错位了。
  double _cellWidth(BuildContext context, String label) {
    final painter = TextPainter(
      text: TextSpan(
        text: label,
        style: ondraText(11, weight: OndraWeight.control, height: 1),
      ),
      textDirection: TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final w = painter.width.ceilToDouble() + _padH * 2;
    painter.dispose();
    return w.clamp(38, 96);
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final st = ShellScope.of(context);
    final index = _modes.indexOf(st.themeMode).clamp(0, _modes.length - 1);

    // 先翻译再量宽：`_cellWidth` 量的是「画出来的那串字」，
    // 不是源语言的字。两者用同一份 labels，滑片才对得上格。
    final labels = [
      for (final l in _labels) OndraI18nScope.translate(context, l),
    ];
    final widths = [for (final l in labels) _cellWidth(context, l)];
    final offsets = <double>[];
    var x = 0.0;
    for (final w in widths) {
      offsets.add(x);
      x += w;
    }
    final total = x + _trackPad * 2;

    return Container(
      height: _trackHeight,
      width: total,
      padding: const EdgeInsets.all(_trackPad),
      decoration: BoxDecoration(
        color: s.fill,
        borderRadius: BorderRadius.circular(7),
      ),
      child: Stack(
        children: [
          // 一块滑片，不是三块各自变色的底。
          //
          // 逐格改色会在切换的一瞬间出现「旧的还在淡出、新的已经半亮」，
          // 两个方块同时存在，读起来像闪了一下。参考实现用的是共享元素滑片
          // （`layoutId`），这里用 120ms 的位移复刻：一个白块从 A 滑到 B。
          AnimatedPositioned(
            duration: OndraMotion.snap,
            curve: OndraMotion.expo,
            left: offsets[index],
            top: 0,
            width: widths[index],
            height: _cellHeight,
            child: Container(
              decoration: BoxDecoration(
                // 深色下选中项要比槽更亮，浅色下要比槽更白：同一句「浮起来」，
                // 两种主题里方向相反，所以不能共用一个颜色。
                color: s.dark ? s.fillSelected : s.surface,
                borderRadius: BorderRadius.circular(5),
                border: Border.all(
                  color: s.dark ? const Color(0x1FFFFFFF) : s.lineSoft,
                  width: 0.5,
                ),
                boxShadow: s.dark
                    ? null
                    : const [
                        BoxShadow(
                          color: Color(0x0A000000),
                          blurRadius: 2,
                          offset: Offset(0, 1),
                        ),
                        BoxShadow(
                          color: Color(0x0D000000),
                          blurRadius: 6,
                          spreadRadius: -1,
                          offset: Offset(0, 2),
                        ),
                      ],
              ),
            ),
          ),
          // Wrap 而不是 Row：三档（浅色/深色/跟随系统）在窄屏的设置行里
          // 排不下，Row 会直接从右侧溢出 36px。Wrap 在窄屏折成两行。
          Wrap(
            children: [
              for (var i = 0; i < _labels.length; i++)
                OndraPressable(
                  onTap: () => st.themeMode = _modes[i],
                  radius: 5,
                  scale: false,
                  tint: false,
                  child: SizedBox(
                    width: widths[i],
                    height: _cellHeight,
                    child: Center(
                      child: Text(
                        labels[i],
                        style: ondraText(
                          11,
                          weight: i == index
                              ? OndraWeight.control
                              : OndraWeight.body,
                          color: i == index ? s.ink85 : s.ink45,
                          height: 1,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.title,
    this.desc,
    this.descVars,
    this.value,
    this.action,
    this.chevron = false,
    this.onTap,
    this.showDivider = true,
    this.multiline = false,
    this.descMaxLines = 2,
  });

  final String title;
  final String? desc;

  /// `desc` 里的 `{name}` 占位符取值。
  ///
  /// 为什么要在这里收，而不是在调用点拼好再传：`_Row` 会**翻译** `desc`，
  /// 而拼接之后的中文（`…当前 3 个站点`）与语言包里的键（`…当前 {n} 个站点`）
  /// 对不上，翻译永远命不中。让 `_Row` 先按词条翻译、再填占位符，
  /// 两种语言的语序才都能正确。
  final Map<String, Object?>? descVars;
  final String? value;
  final Widget? action;
  final bool chevron;
  final VoidCallback? onTap;
  final bool showDivider;

  /// 无右侧控件时，标题按正文排版（说明性长句）。
  final bool multiline;

  /// 说明最多几行。人设的一句话内核可能很长，这里压成 1 行，
  /// 否则它会顶到右侧的版本号上。
  final int descMaxLines;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final content = Container(
      constraints: const BoxConstraints(minHeight: 42),
      // 左右 16 与设置面板的分组卡一致；行内不再接受自定义内距，
      // 免得同一屏里出现 12 / 16 两套缩进。
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        border: showDivider
            ? Border(bottom: BorderSide(color: s.lineSoft, width: 1))
            : null,
      ),
      child: Row(
        children: [
          // 窄屏（手机单列）标题 flex 1、控件 flex 2：像字号加减这种
          // ~140dp 的复合控件，1:1 平分只有 ~124dp 会溢出；2:1 才放得下。
          // 宽屏不受影响（两种都是 Expanded/Flexible 的默认 1:1）。
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  OndraI18nScope.translate(context, title),
                  maxLines: multiline ? 3 : 1,
                  overflow: TextOverflow.ellipsis,
                  style: ondraText(
                    13,
                    color: s.ink80,
                    height: multiline ? 20 / 13 : 18 / 13,
                  ),
                ),
                if (desc != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    OndraI18nScope.translate(context, desc!, descVars),
                    maxLines: descMaxLines,
                    overflow: TextOverflow.ellipsis,
                    style: ondraText(11, color: s.ink45, height: 14 / 11),
                  ),
                ],
              ],
            ),
          ),
          if (value != null) ...[
            // 说明与右侧的值之间留 12：不留的时候，长说明的省略号会正好顶在
            // 值的第一个字上，看起来像两个字叠在一起。
            const SizedBox(width: 12),
            // Flexible 兜住窄屏：宽屏上 230 上限生效（行为不变），
            // 手机上剩余宽度可能只有几十 dp，没有弹性这行必溢出。
            Flexible(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 230),
                child: Text(
                  OndraI18nScope.translate(context, value!),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ondraText(12, color: s.ink45, height: 18 / 12),
                ),
              ),
            ),
          ],
          if (action != null) ...[
            const SizedBox(width: 12),
            // 右侧控件用 `Flexible` 包住，并给一个明确的上限。
            //
            // 不给上限时，`Row` 传给 `action` 的是**无界**宽度约束；里面
            // `_PillSegmented` 的 `Flexible` 因为拿不到「可用宽度」而退化，
            // 整行按内容宽度撑开，越过卡片的右边界 → RenderFlex overflow。
            // 中文三字（仅可查看 / 工作区内修改 / 完全权限）时刚好压线，
            // 换成英文（View only / Edit in workspace / Full access）就崩。
            //
            // 240 是「标题栏留得下两个中文字 + 省略号」的经验值：
            // 再宽会挤压标题，再窄会让「工作区内修改」这类词截得太碎。
            Flexible(
              flex: MediaQuery.sizeOf(context).width < 420 ? 2 : 1,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 240),
                child: Align(alignment: Alignment.centerRight, child: action!),
              ),
            ),
          ],
          if (chevron) ...[
            const SizedBox(width: 8),
            Glyph(Glyphs.chevronRight, size: 16, color: s.ink25),
          ],
        ],
      ),
    );

    if (onTap == null) return content;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(onTap: onTap, child: content),
    );
  }
}

/// 字号加减控件：− [14 px] ＋。官方外观页就是这个形状，
/// 不做滑块——字号要的是「一格一格」，滑块的连续值反而选不准。
/// 下钻页面的返回条：左箭头 + 标题，回到上一层。
class _BackRow extends StatelessWidget {
  const _BackRow({required this.label, required this.onTap, this.meta});

  final String label;

  /// 右侧的小字：分类、包名之类的补充信息。
  final String? meta;

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: Row(
            children: [
              Glyph(Glyphs.chevronLeft, size: 14, color: s.ink45),
              const SizedBox(width: 4),
              Text(
                label,
                style: ondraText(
                  12,
                  weight: 500,
                  color: s.ink60,
                  height: 18 / 12,
                ),
              ),
              if (meta != null) ...[
                const SizedBox(width: 8),
                Text(
                  meta!,
                  style: ondraText(10, color: s.ink25, height: 18 / 10),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// 字号加减控件：− [14 px] ＋。官方外观页就是这个形状，
/// 不做滑块——字号要的是「一格一格」，滑块的连续值反而选不准。
class _Stepper extends StatelessWidget {
  const _Stepper({
    required this.value,
    required this.unit,
    required this.onMinus,
    required this.onPlus,
  });

  final int value;
  final String unit;
  final VoidCallback onMinus;
  final VoidCallback onPlus;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _StepKey(glyph: Glyphs.chevronLeft, onTap: onMinus, label: '减小字号'),
        SizedBox(
          width: 52,
          child: Text(
            '$value$unit',
            textAlign: TextAlign.center,
            style: ondraText(12, color: s.ink80, height: 18 / 12),
          ),
        ),
        _StepKey(glyph: Glyphs.chevronRight, onTap: onPlus, label: '增大字号'),
      ],
    );
  }
}

class _StepKey extends StatefulWidget {
  const _StepKey({
    required this.glyph,
    required this.onTap,
    required this.label,
  });

  final String glyph;
  final VoidCallback onTap;
  final String label;

  @override
  State<_StepKey> createState() => _StepKeyState();
}

class _StepKeyState extends State<_StepKey> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Tooltip(
      message: widget.label,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          onTap: widget.onTap,
          // 命中区 44：视觉块 26 不变，外面垫透明命中层。
          child: Container(
            width: 44,
            height: 44,
            alignment: Alignment.center,
            child: Container(
              width: 26,
              height: 26,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _hover ? s.fill : s.fillFaint,
                borderRadius: BorderRadius.circular(OndraRadius.sm),
              ),
              child: Glyph(widget.glyph, size: 12, color: s.ink60),
            ),
          ),
        ),
      ),
    );
  }
}

class _LinkText extends StatelessWidget {
  const _LinkText({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Text(
          label,
          style: ondraText(
            13,
            weight: 500,
            color: OndraColor.accent,
            height: 18 / 13,
          ),
        ),
      ),
    );
  }
}

/// 胶囊按钮：底色 6% 黑、文字正文色、28 高。
class _SmallPill extends StatelessWidget {
  const _SmallPill({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      // 不用 alignment：带 alignment 的 Container 在松约束（Align / Center 之下）
      // 会把自己撑到父级宽度，一个胶囊按钮就会变成一条通栏黑条。
      // 高度改由行高 + 上下内距自然得出，宽度随文字自适应。
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        decoration: BoxDecoration(
          color: const Color(0x0F000000),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Text(
          label,
          style: ondraText(
            13,
            weight: 500,
            color: OndraColor.ink,
            height: 16 / 13,
          ),
        ),
      ),
    );
  }
}

class _PrimaryPill extends StatelessWidget {
  const _PrimaryPill({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
        decoration: BoxDecoration(
          color: OndraColor.accent,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(
          label,
          style: ondraText(
            13,
            weight: 500,
            color: Colors.white,
            height: 16 / 13,
          ),
        ),
      ),
    );
  }
}

/// 胶囊分段：轨道 28 高，选中项 6% 黑底、500 字重。
class _PillSegmented extends StatelessWidget {
  const _PillSegmented({
    required this.value,
    required this.items,
    required this.onChanged,
  });

  final int value;
  final List<String> items;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    // 每格用 `Flexible` 而不是固定宽度。
    //
    // 中文两三个字（浅色 / 深色 / 跟随系统）时三格排开正好；换成英文
    // （Light / Dark / System 还好，但 Warm / Clear / Deep、Short / Balanced /
    // Detailed 这几组会长得多）就越过右边界，直接 RenderFlex overflow。
    // 固定在中文长度上量宽，等于默认「只有中文」——多语言一上来就崩版。
    //
    // `Flexible` + `ellipsis` 的取舍：宁可把某格文字截断，也不能溢出——
    // 溢出的黄黑条会盖住整行，而截断至少还能靠 hover title 读到全文。
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < items.length; i++)
          Flexible(
            child: Padding(
              padding: EdgeInsets.only(left: i == 0 ? 0 : 4),
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: () => onChanged(i),
                  child: Container(
                    height: 28,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: i == value ? s.fill : Colors.transparent,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      items[i],
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      softWrap: false,
                      style: ondraText(
                        13,
                        weight: 500,
                        color: i == value ? s.ink80 : s.ink40,
                        height: 16 / 13,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// 卡片内的分组小标题：分类名 + 数量。
///
/// 用在「提供商」这张卡里——同一个卡片里再套卡片会变成两层圆角，
/// 所以分组只用一条 24 高的标题行，靠 10/600 的灰字把层级拉开。
class _GroupLabel extends StatelessWidget {
  const _GroupLabel({required this.label, required this.meta});

  final String label;
  final String meta;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      height: 26,
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
      alignment: Alignment.centerLeft,
      child: Row(
        children: [
          Text(
            label,
            style: ondraText(
              10,
              weight: 600,
              color: s.ink40,
              height: 14 / 10,
              spacing: 0.3,
            ),
          ),
          const Spacer(),
          Text(
            meta,
            style: ondraText(10, color: s.ink25, height: 14 / 10),
          ),
        ],
      ),
    );
  }
}

/// 第二步：某一类下的预设列表。
///
/// 带 `_error` 是因为「添加」可能被拒（id 重复、地址冲突）——错误要留在原地，
/// 不能弹一下就消失。
class _PresetPicker extends StatefulWidget {
  const _PresetPicker({
    required this.category,
    required this.onPick,
    required this.onManual,
    required this.onBack,
  });

  final ProviderCategory category;
  final String? Function(OndraProviderPreset preset) onPick;
  final VoidCallback onManual;
  final VoidCallback onBack;

  @override
  State<_PresetPicker> createState() => _PresetPickerState();
}

class _PresetPickerState extends State<_PresetPicker> {
  String? _error;

  String _descOf(OndraProviderPreset p) {
    if (p.baseUrl.isEmpty) return p.note.isEmpty ? '需要填写地址' : p.note;
    final models = p.models.isEmpty ? '模型目录待检测' : '${p.models.length} 个模型';
    return '${p.baseUrl} · $models';
  }

  String get _manualDesc => switch (widget.category) {
    ProviderCategory.official => '目录里没有的官方接口，自己填地址与协议',
    ProviderCategory.partner => '合作方直接给的地址，不进预设',
    ProviderCategory.free => '自建或别的免费服务',
    ProviderCategory.custom => '任何兼容 OpenAI / Anthropic 协议的服务',
    ProviderCategory.local => '别的本地服务，如 vLLM、LocalAI',
    ProviderCategory.gateway => '别的网关，如 Higress、Kong AI',
  };

  String get _note => switch (widget.category) {
    ProviderCategory.official => '官方接口按 token 计费；密钥只存本机钥匙串。',
    ProviderCategory.partner =>
      '这一类由 ondra-beichen-api 插件提供；换合作方改插件的目录，界面与基座都不动。',
    ProviderCategory.free => 'our-free-model 基于官方目录精简：模型 id 与官方一致，额度与限速以它为准。',
    ProviderCategory.local => '本地服务不需要密钥；添加后点「检测连接」，模型目录从端点读回来。',
    ProviderCategory.gateway => '网关自己管多家模型与密钥；空谷只认一个地址。',
    ProviderCategory.custom => '',
  };

  void _add(OndraProviderPreset preset) {
    final err = widget.onPick(preset);
    if (err != null) setState(() => _error = err);
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final presets = presetsOf(widget.category);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _BackRow(label: widget.category.label, onTap: widget.onBack),
        if (presets.isNotEmpty) ...[
          const SizedBox(height: 20),
          _Section(
            title: '预设',
            children: [
              for (var i = 0; i < presets.length; i++)
                _Row(
                  title: presets[i].name,
                  desc: _descOf(presets[i]),
                  descMaxLines: 2,
                  value: modelClient.hasPreset(presets[i].id) ? '已添加' : null,
                  action: modelClient.hasPreset(presets[i].id)
                      ? null
                      : _LinkText(label: '添加', onTap: () => _add(presets[i])),
                  showDivider: i != presets.length - 1,
                ),
            ],
          ),
        ],
        const SizedBox(height: 20),
        _Section(
          children: [
            _Row(
              title: '手动填写',
              desc: _manualDesc,
              chevron: true,
              onTap: widget.onManual,
              showDivider: false,
            ),
          ],
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 2, left: 4),
            child: Text(
              _error!,
              style: ondraText(11, color: OndraColor.danger, height: 16 / 11),
            ),
          ),
        if (_note.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(
            _note,
            style: ondraText(11, color: s.ink30, height: 16 / 11),
          ),
        ],
      ],
    );
  }
}

/// 自定义提供商表单：官方要求「地址 + 至少一个模型」。
///
/// 也负责「本地 / 网关 / 合作」这几类里的「手动填写」——它们的字段完全一样，
/// 只是 `category` 不同，列表里归到不同组。
class _CustomProviderForm extends StatefulWidget {
  const _CustomProviderForm({
    required this.onDone,
    this.category = ProviderCategory.custom,
  });

  final VoidCallback onDone;
  final ProviderCategory category;

  @override
  State<_CustomProviderForm> createState() => _CustomProviderFormState();
}

class _CustomProviderFormState extends State<_CustomProviderForm> {
  final _id = TextEditingController();
  final _name = TextEditingController();
  final _baseUrl = TextEditingController();
  final _key = TextEditingController();
  final _modelId = TextEditingController();
  String? _error;

  @override
  void dispose() {
    for (final c in [_id, _name, _baseUrl, _key, _modelId]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final modelText = _modelId.text.trim();
    if (modelText.isEmpty) {
      setState(() => _error = '至少需要一个模型');
      return;
    }
    final key = _key.text.trim();
    final provider = OndraProvider(
      id: _id.text.trim(),
      name: _name.text.trim().isEmpty ? _id.text.trim() : _name.text.trim(),
      category: widget.category,
      baseUrl: _baseUrl.text.trim(),
      models: [OndraModelEntry(id: modelText)],
    );
    final err = modelClient.validateProvider(provider);
    if (err != null) {
      setState(() => _error = err);
      return;
    }
    // 密钥真的写进钥匙串。之前这里只取 isNotEmpty 存成布尔——用户输入的
    // 密钥被直接丢掉，页面却显示「密钥已配置」。
    if (key.isNotEmpty) {
      final keyErr = await modelClient.writeProviderKey(provider.id, key);
      if (keyErr != null && mounted) {
        setState(() => _error = keyErr);
        return;
      }
    }
    provider.keyConfigured = key.isNotEmpty;
    final saveError = modelClient.addProvider(provider);
    if (!mounted) return;
    if (saveError != null) {
      setState(() => _error = saveError);
      return;
    }
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _BackRow(label: widget.category.label, onTap: widget.onDone),
        const SizedBox(height: 20),
        _Section(
          title: '基本信息',
          children: [
            _InputRow(controller: _id, title: '标识', hint: '小写字母开头，可含数字与短横线'),
            _InputRow(controller: _name, title: '显示名称', hint: '留空用标识'),
          ],
        ),
        const SizedBox(height: 20),
        _Section(
          title: '接入',
          children: [
            _InputRow(
              controller: _baseUrl,
              title: 'API 地址',
              hint: 'https://… 或 http://127.0.0.1:8080/v1',
            ),
            _InputRow(
              controller: _key,
              title: 'API 密钥',
              hint: '本地部署可留空',
              obscure: true,
            ),
          ],
        ),
        const SizedBox(height: 20),
        _Section(
          title: '模型目录',
          children: [
            _InputRow(
              controller: _modelId,
              title: '模型 ID',
              hint: '如 gpt-4o、qwen2.5:7b',
            ),
          ],
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 6, left: 4),
            child: Text(
              _error!,
              style: ondraText(11, color: OndraColor.danger, height: 16 / 11),
            ),
          ),
        Align(
          alignment: Alignment.centerRight,
          child: _PrimaryPill(label: '保存', onTap: _save),
        ),
        const SizedBox(height: 2),
        Text(
          '其余字段（协议、最大输出、推理档位）保存后在「编辑」里补；模型目录也能用「检测连接」自动读。',
          style: ondraText(11, color: s.ink30, height: 16 / 11),
        ),
      ],
    );
  }
}

/// 已有提供商的编辑态：接入、连接检测、模型目录（含进阶字段）、删除。
class _ProviderEditor extends StatefulWidget {
  const _ProviderEditor({
    super.key,
    required this.provider,
    required this.onBack,
  });

  final OndraProvider provider;
  final VoidCallback onBack;

  @override
  State<_ProviderEditor> createState() => _ProviderEditorState();
}

class _ProviderEditorState extends State<_ProviderEditor> {
  /// 从 provider 的地址里取端口；取不到就用 8080（llama-server 的默认值）。
  static int _portOf(String baseUrl) {
    final uri = Uri.tryParse(baseUrl.trim());
    if (uri == null || uri.port == 0) return 8080;
    return uri.port;
  }

  final Set<OndraModelEntry> _expanded = {};
  String? _error;
  bool _probing = false;
  String? _probeMessage;
  bool _probeOk = false;

  Future<void> _addModel() async {
    final controller = TextEditingController();
    final id = await OndraDialog.show<String>(
      context,
      _TextPromptDialog(title: '添加模型', hint: '模型 ID', controller: controller),
    );
    controller.dispose();
    if (id == null || !mounted) return;
    setState(() => _error = modelClient.addModel(widget.provider.id, id: id));
  }

  /// 填写 / 更换 API 密钥：收进钥匙串，状态由写入结果驱动。
  ///
  /// 之前这里只把 `keyConfigured` 置成 true——不弹输入框、不存任何东西，
  /// 重启后布尔也丢。密钥属于「只写不读」的凭据，唯一去处是钥匙串。
  /// 密钥的存储说明按平台如实：mac 是钥匙串；安卓没有钥匙串，
  /// 落到应用私有目录（沙箱内其他应用读不到，root 设备除外）。
  /// 不说清楚 = 用户以为都进了加密存储。
  String _keyStorageNote(String apiKeyEnv) {
    final envNote = apiKeyEnv.isEmpty ? '' : '环境变量回退：$apiKeyEnv · ';
    final storage = switch (defaultTargetPlatform) {
      TargetPlatform.macOS => 'mac：写进系统钥匙串',
      TargetPlatform.android => '安卓：应用私有目录（root 设备可读）',
      _ => '当前平台不支持保存密钥',
    };
    return '$envNote$storage，只写不读';
  }

  Future<void> _editKey() async {
    final controller = TextEditingController();
    final value = await OndraDialog.show<String>(
      context,
      _TextPromptDialog(
        title: 'API 密钥',
        hint: '只写进系统钥匙串，不在任何文件里出现',
        controller: controller,
        obscure: true,
        maxLength: 4096,
      ),
    );
    controller.dispose();
    if (value == null) return; // 取消。
    final trimmed = value.trim();
    if (trimmed.isEmpty) return;
    final err = await modelClient.writeProviderKey(widget.provider.id, trimmed);
    if (!mounted) return;
    setState(() {
      // 写入失败时状态保持「未配置」，错误借「检测连接」那一行显示——
      // 它本来就是这个编辑器的错误出口，不另开一条。
      if (err != null) {
        _probeOk = false;
        _probeMessage = err;
      }
    });
  }

  /// 探测端点并合并模型目录。
  ///
  /// 只对本地部署与网关有意义（它们在 127.0.0.1 上），但对官方接口同样可用——
  /// 能连上就是能连上，没必要按分类限制。
  Future<void> _probe() async {
    setState(() {
      _probing = true;
      _probeMessage = null;
    });
    final key = await modelClient.readProviderKey(widget.provider.id);
    final result = await probeOpenAiEndpoint(
      widget.provider.baseUrl,
      apiKey: key,
      protocol: widget.provider.protocol,
    );
    if (!mounted) return;
    if (result.ok) {
      final added = modelClient.mergeDiscoveredModels(
        widget.provider.id,
        result.models,
      );
      setState(() {
        _probing = false;
        _probeOk = true;
        _probeMessage = result.models.isEmpty
            ? '已连接，但端点没有列出模型'
            : '已连接 · ${result.models.length} 个模型${added > 0 ? '（新增 $added 个）' : ''}';
      });
    } else {
      setState(() {
        _probing = false;
        _probeOk = false;
        _probeMessage = result.error ?? '连接失败';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final p = widget.provider;
    final isLocal = p.category == ProviderCategory.local;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _BackRow(label: p.name, meta: p.category.label, onTap: widget.onBack),
        const SizedBox(height: 20),
        _Section(
          title: '接入',
          children: [
            _InputRow(
              title: 'API 地址',
              hint: '留空使用默认地址',
              value: p.baseUrl,
              onChanged: (v) => setState(
                () => _error = modelClient.updateProviderAddress(p.id, v),
              ),
            ),
            if (!isLocal)
              _Row(
                title: 'API 密钥',
                desc: _keyStorageNote(p.apiKeyEnv),
                value: p.keyConfigured ? '已配置' : '未配置',
                action: _LinkText(
                  label: p.keyConfigured ? '更换' : '填写',
                  onTap: _editKey,
                ),
                showDivider: false,
              )
            else
              const _Row(
                title: 'API 密钥',
                desc: '本地服务不校验密钥，留空即可',
                value: '不需要',
                showDivider: false,
              ),
          ],
        ),
        // 连接检测：本地部署与网关的「配置对不对」只有连一次才知道。
        const SizedBox(height: 20),
        _Section(
          title: '连接',
          children: [
            _Row(
              title: _probing ? '正在检测…' : '检测连接',
              desc: '请求 {地址}/models，把端点里的模型读回来',
              descVars: {'地址': p.baseUrl},
              action: _probing ? null : _SmallPill(label: '检测', onTap: _probe),
              showDivider: _probeMessage != null,
            ),
            if (_probeMessage != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    _probeMessage!,
                    style: ondraText(
                      11,
                      color: _probeOk ? s.ink60 : OndraColor.danger,
                      height: 16 / 11,
                    ),
                  ),
                ),
              ),
          ],
        ),
        // llama.cpp 有真正的启动面板（ondra-llama），这里只给其余本地/网关提示命令。
        if (p.launchHint.isNotEmpty && p.id != 'llama-cpp') ...[
          const SizedBox(height: 20),
          _Section(
            title: '启动方式',
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 10),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    p.launchHint,
                    style: ondraText(11, color: s.ink60, height: 16 / 11),
                  ),
                ),
              ),
            ],
          ),
        ],
        if (p.id == 'llama-cpp') ...[
          const SizedBox(height: 20),
          LlamaPanel(
            port: _portOf(p.baseUrl),
            onEndpointReady: (url) => setState(
              () => _error = modelClient.updateProviderAddress(p.id, url),
            ),
          ),
        ],
        const SizedBox(height: 20),
        _Section(
          title: '模型目录',
          children: [
            if (p.models.isEmpty)
              const _Row(
                title: '还没有模型',
                desc: '点上面的「检测」从端点读，或手动添加',
                showDivider: false,
              ),
            for (final m in p.models) ...[
              _Row(
                title: m.id,
                desc:
                    '${m.name.isEmpty ? '未设显示名' : m.name} · ${m.inputs.join(' / ')}',
                value: m.contextWindow.isEmpty ? '默认容量' : m.contextWindow,
                action: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _LinkText(
                      label: _expanded.contains(m) ? '收起' : '进阶',
                      onTap: () => setState(() {
                        _expanded.contains(m)
                            ? _expanded.remove(m)
                            : _expanded.add(m);
                      }),
                    ),
                    const SizedBox(width: 10),
                    _LinkText(
                      label: '删除',
                      onTap: () => modelClient.removeModel(p.id, m),
                    ),
                  ],
                ),
              ),
              if (_expanded.contains(m))
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _InputRow(
                        title: '模型 ID',
                        hint: '端点模型标识',
                        value: m.id,
                        onChanged: (v) => setState(
                          () =>
                              _error = modelClient.updateModel(p.id, m, id: v),
                        ),
                      ),
                      _InputRow(
                        title: '显示名',
                        hint: '留空用模型 ID',
                        value: m.name,
                        onChanged: (v) => setState(
                          () => _error = modelClient.updateModel(
                            p.id,
                            m,
                            name: v,
                          ),
                        ),
                      ),
                      _InputRow(
                        title: '上下文窗口',
                        hint: '128K / 1M',
                        value: m.contextWindow,
                        onChanged: (v) => setState(
                          () => _error = modelClient.updateModel(
                            p.id,
                            m,
                            contextWindow: v,
                          ),
                        ),
                      ),
                      _InputRow(
                        title: '最大输出',
                        hint: '8K / 64K',
                        value: m.maxTokens,
                        onChanged: (v) => setState(
                          () => _error = modelClient.updateModel(
                            p.id,
                            m,
                            maxTokens: v,
                          ),
                        ),
                      ),
                      _Row(
                        title: '输入类型',
                        action: _PillSegmented(
                          value: m.acceptsImage ? 1 : 0,
                          items: const ['文本', '文本 + 图片'],
                          onChanged: (i) => setState(() {
                            _error = modelClient.updateModel(
                              p.id,
                              m,
                              inputs: i == 1 ? ['text', 'image'] : ['text'],
                            );
                          }),
                        ),
                      ),
                      _Row(
                        title: '推理档位',
                        desc: '每档写入请求的推理强度字段',
                        action: _PillSegmented(
                          value: m.reasoning.length > 1
                              ? 2
                              : (m.reasoning.isEmpty ? 0 : 1),
                          items: const ['关闭', '中', '中+高'],
                          onChanged: (i) => setState(() {
                            _error = modelClient.updateModel(
                              p.id,
                              m,
                              reasoning: switch (i) {
                                0 => [],
                                1 => [OndraReasoningLevel.medium],
                                _ => [
                                  OndraReasoningLevel.medium,
                                  OndraReasoningLevel.high,
                                ],
                              },
                            );
                          }),
                        ),
                        showDivider: false,
                      ),
                    ],
                  ),
                ),
            ],
            _Row(
              title: '添加模型',
              desc: '模型 ID 不能为空、不能重复',
              action: _LinkText(label: '添加', onTap: _addModel),
              showDivider: false,
            ),
          ],
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 6, left: 4),
            child: Text(
              _error!,
              style: ondraText(11, color: OndraColor.danger, height: 16 / 11),
            ),
          ),
        if (!p.builtIn) ...[
          const SizedBox(height: 20),
          _Section(
            children: [
              _Row(
                title: '删除提供商',
                desc: '会移除其配置和存储的 API 密钥',
                onTap: () async {
                  final error = await modelClient.removeProvider(p.id);
                  if (!mounted) return;
                  if (error != null) {
                    setState(() => _error = error);
                  } else {
                    widget.onBack();
                  }
                },
                showDivider: false,
              ),
            ],
          ),
        ],
        const SizedBox(height: 20),
        _Section(
          children: [
            _Row(
              title: '恢复默认模型目录',
              desc: '回到适配器自带的模型列表',
              onTap: () => setState(() {
                // 按这一类来源找同名端点的预设：OpenAI 恢复成 OpenAI 的目录，
                // 本地部署恢复成本地那份。自定义 API 的「目录」本来就来自
                // 端点检测，默认值是空——恢复后清空是实情，不是丢数据。
                final preset = presetsOf(p.category)
                    .where((e) => e.baseUrl == p.baseUrl)
                    .firstOrNull;
                final List<OndraModelEntry> catalog =
                    (preset?.models ?? const [])
                        .map((m) => m.toEntry())
                        .toList();
                modelClient.restoreCatalog(p.id, catalog);
              }),
              showDivider: false,
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          modelClient.persistenceError ?? '有效改动即时保存；密钥写进系统钥匙串，文件里不出现。',
          style: ondraText(11, color: s.ink30, height: 16 / 11),
        ),
      ],
    );
  }
}

/// 一行「标签 + 输入框」，用于表单里就地填。
class _InputRow extends StatefulWidget {
  const _InputRow({
    required this.title,
    required this.hint,
    this.value = '',
    this.onChanged,
    this.controller,
    this.obscure = false,
  });

  final String title;
  final String hint;

  /// 初始值。只在第一次建行时读一次——外部再改由调用方自己换 key。
  final String value;

  final ValueChanged<String>? onChanged;
  final TextEditingController? controller;
  final bool obscure;

  @override
  State<_InputRow> createState() => _InputRowState();
}

class _InputRowState extends State<_InputRow> {
  TextEditingController? _own;

  TextEditingController get _controller =>
      widget.controller ?? (_own ??= TextEditingController(text: widget.value));

  @override
  void dispose() {
    _own?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final field = TextField(
      controller: _controller,
      obscureText: widget.obscure,
      onChanged: widget.onChanged,
      textAlign: TextAlign.right,
      cursorColor: OndraColor.accent,
      style: ondraText(12, color: s.ink, height: 18 / 12),
      decoration: InputDecoration(
        isDense: true,
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        contentPadding: const EdgeInsets.symmetric(vertical: 6),
        hintText: widget.hint,
        hintStyle: ondraText(11, color: s.ink25, height: 18 / 11),
      ),
    );
    // 窄屏（<420dp，全部手机）标签上置：84dp 的行内标签会把输入框挤到
    // 只剩个位数像素——改 API 地址/模型 ID 的表单在手机上没法用。
    // 宽屏保持桌面原样。
    final narrow = MediaQuery.sizeOf(context).width < 420;
    if (narrow) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.title,
              style: ondraText(12, color: s.ink80, height: 16 / 12),
            ),
            const SizedBox(height: 2),
            field,
          ],
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 84,
            child: Text(
              widget.title,
              style: ondraText(13, color: s.ink80, height: 30 / 13),
            ),
          ),
          Expanded(child: field),
        ],
      ),
    );
  }
}

/// 一个「输入一段文字」的对话框。
///
/// 称呼与反馈详情共用它：两者都只是「写一段话然后确定」，
/// 差别只在行数。各写一个对话框会让两处的确定键位置、字数提示、
/// 回车行为都不一样。
class _TextPromptDialog extends StatefulWidget {
  const _TextPromptDialog({
    required this.title,
    required this.hint,
    required this.controller,
    this.maxLength = 200,
    this.minLines = 1,
    this.maxLines = 1,
    this.obscure = false,
  });

  final String title;
  final String hint;
  final TextEditingController controller;
  final int maxLength;
  final int minLines;
  final int maxLines;
  final bool obscure;

  @override
  State<_TextPromptDialog> createState() => _TextPromptDialogState();
}

class _TextPromptDialogState extends State<_TextPromptDialog> {
  @override
  void initState() {
    super.initState();
    // 字数提示要跟着输入走。
    widget.controller.addListener(_onChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final over = widget.controller.text.length > widget.maxLength;
    return OndraDialog(
      title: widget.title,
      width: widget.maxLines > 1 ? 460 : 380,
      content: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: s.field,
          borderRadius: BorderRadius.circular(OndraRadius.lg),
          border: Border.all(color: s.line),
        ),
        child: TextField(
          controller: widget.controller,
          autofocus: true,
          minLines: widget.minLines,
          maxLines: widget.maxLines,
          obscureText: widget.obscure,
          cursorColor: OndraColor.accent,
          style: ondraText(13, color: s.ink, height: 20 / 13),
          decoration: InputDecoration(
            isDense: true,
            border: InputBorder.none,
            enabledBorder: InputBorder.none,
            focusedBorder: InputBorder.none,
            contentPadding: EdgeInsets.zero,
            hintText: widget.hint,
            hintStyle: ondraText(12, color: s.ink25, height: 19 / 12),
            counterText: '', // 自绘：Material 的计数器位置与这套内距对不上
          ),
        ),
      ),
      actions: [
        const OndraDialogButton(label: '取消'),
        OndraDialogButton(
          label: '保存',
          filled: true,
          // 空内容也允许保存：称呼留空是合法选择（「不指定」）。
          // 超长时按钮不关闭，把面板留在原地让用户删几个字。
          closeAfter: !over,
          value: widget.controller.text,
        ),
      ],
    );
  }
}

/// 头像编辑：大圆 + 一行小字操作。
///
/// 交互只有两件事：点圆换图、点「恢复默认」退回占位图。
/// 不给「上传」单独做一页——头像是一个文件，不是一项配置；把它做成设置项
/// 列表里的一行，用户每次换头像都要多跳一层。
class _AvatarEditor extends StatefulWidget {
  const _AvatarEditor();

  @override
  State<_AvatarEditor> createState() => _AvatarEditorState();
}

class _AvatarEditorState extends State<_AvatarEditor> {
  bool _hover = false;

  Future<void> _pick() async {
    // 通道不支持（安卓没有 ondra/avatar）：如实提示。不拦的话用户看到
    // 的是「点了没反应」，会以为是卡死。用户取消则一声不吭。
    if (!avatarStore.pickerSupported) {
      if (mounted) {
        OndraToast.show(
          context,
          '这台系统还没有接入头像选择，换头像需要桌面版。',
          ok: false,
        );
      }
      return;
    }
    final ok = await avatarStore.pick();
    if (!ok) return;
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return AnimatedBuilder(
      animation: avatarStore,
      builder: (context, _) {
        return Column(
          children: [
            MouseRegion(
              cursor: SystemMouseCursors.click,
              onEnter: (_) => setState(() => _hover = true),
              onExit: (_) => setState(() => _hover = false),
              child: OndraPressable(
                onTap: _pick,
                radius: 28,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    const OndraAvatar(size: 56),
                    // 悬停蒙层：只在鼠标压上去时出现，提示「这里能点」。
                    // 常驻一个相机角标会让默认头像看起来「坏了一块」。
                    AnimatedOpacity(
                      opacity: _hover ? 1 : 0,
                      duration: OndraMotion.hover,
                      child: Container(
                        width: 54,
                        height: 54,
                        decoration: const BoxDecoration(
                          shape: BoxShape.circle,
                          color: Color(0x8C0B0D12),
                        ),
                        child: const Center(
                          child: Glyph(
                            Glyphs.edit,
                            size: 16,
                            color: Color(0xFFFFFFFF),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 6),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                _AvatarLink(label: '更换头像', onTap: _pick),
                if (avatarStore.isCustom) ...[
                  Text(
                    '  ·  ',
                    style: ondraText(11, color: s.ink25, height: 1),
                  ),
                  _AvatarLink(label: '恢复默认', onTap: () => avatarStore.reset()),
                ],
              ],
            ),
          ],
        );
      },
    );
  }
}

/// 头像下面那行小字：默认 45% 墨，hover 到 85%——没有下划线、没有按钮底，
/// 它是一条说明里的动词，不是一颗按钮。
class _AvatarLink extends StatefulWidget {
  const _AvatarLink({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  State<_AvatarLink> createState() => _AvatarLinkState();
}

class _AvatarLinkState extends State<_AvatarLink> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: Text(
          widget.label,
          style: ondraText(
            11,
            weight: _hover ? OndraWeight.control : OndraWeight.body,
            color: _hover ? s.ink85 : s.ink45,
            height: 1,
          ),
        ),
      ),
    );
  }
}
