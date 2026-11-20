import 'dart:async';

import 'package:material_ui/material_ui.dart';

import 'motion.dart';
import 'pressable.dart';
import 'skin.dart';
import 'tokens.dart';

/// 一个轻量操作结果：成功 / 失败 + 一句人话。
///
/// 设置面板里那些动作（导出、清空、检查更新、提交反馈）产出的结论
/// 要能立刻显示给用户，而不是只写进日志。
class OndraNotice {
  const OndraNotice(this.text, {this.ok = true});

  const OndraNotice.fail(this.text) : ok = false;

  final String text;
  final bool ok;
}

/// 在 Overlay 上弹一条「说清楚发生了什么」的卡片。
///
/// ## 为什么不用 SnackBar
///
/// Material 的 SnackBar 是贴着视口底部滑入的一整条黑带，四角方、字号固定，
/// 在这套界面里像另一个应用的通知。设置面板是 760×500 的居中弹窗，
/// 消息应该出现在面板内部偏下的位置，而不是整个窗口的底边。
///
/// ## 为什么不阻塞
///
/// 这些结论都不需要用户「确认」——导出到哪个目录、缓存清了多少，
/// 都是一句话的事。用一个要点的对话框去挡，等于把提示做成了路障。
class OndraToast {
  const OndraToast._();

  static OverlayEntry? _current;

  static void show(
    BuildContext context,
    String text, {
    bool ok = true,
  }) {
    final overlay = Overlay.maybeOf(context, rootOverlay: true);
    if (overlay == null) return;
    _current?.remove();
    final s = OndraSkin.of(context);
    OverlayEntry? entry;
    entry = OverlayEntry(
      builder: (_) => _ToastLayer(
        text: text,
        ok: ok,
        skin: s,
        onGone: () {
          if (_current == entry) _current = null;
          entry?.remove();
        },
      ),
    );
    _current = entry;
    overlay.insert(entry);
  }
}

class _ToastLayer extends StatefulWidget {
  const _ToastLayer({
    required this.text,
    required this.ok,
    required this.skin,
    required this.onGone,
  });

  final String text;
  final bool ok;
  final OndraSkin skin;
  final VoidCallback onGone;

  @override
  State<_ToastLayer> createState() => _ToastLayerState();
}

class _ToastLayerState extends State<_ToastLayer> {
  @override
  void initState() {
    super.initState();
    // 长文本多留一会儿：一句话 3.2 秒够读，三行不够。
    final hold = widget.text.length > 60 ? 5600 : 3200;
    Future<void>.delayed(Duration(milliseconds: hold), () {
      if (mounted) widget.onGone();
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.skin;
    return Positioned(
      left: 0,
      right: 0,
      bottom: 40,
      child: IgnorePointer(
        child: Center(
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: 1),
            duration: OndraMotion.panel,
            curve: OndraMotion.decel,
            builder: (context, t, child) => Opacity(
              opacity: t,
              child: Transform.translate(
                offset: Offset(0, 8 * (1 - t)),
                child: child,
              ),
            ),
            child: Container(
              constraints: const BoxConstraints(maxWidth: 520),
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
              decoration: BoxDecoration(
                color: s.dark ? const Color(0xFF2A2E36) : const Color(0xFF1C1F28),
                borderRadius: BorderRadius.circular(OndraRadius.pill),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x33000000),
                    blurRadius: 24,
                    offset: Offset(0, 8),
                  ),
                ],
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: widget.ok
                          ? const Color(0xFF4ADE80)
                          : OndraColor.danger,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Flexible(
                    child: Text(
                      widget.text,
                      style: ondraText(
                        12.5,
                        color: const Color(0xFFF2F4F8),
                        height: 18 / 12.5,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 一个居中的小对话框：一句标题、一段说明、两三个按钮。
///
/// 只用于**需要用户做决定**的场合（清空数据是不可逆的，必须停一下）。
/// 结果提示走 [OndraToast]，不要拿这个当「知道了」用。
class OndraDialog extends StatelessWidget {
  const OndraDialog({
    super.key,
    required this.title,
    this.body,
    this.content,
    required this.actions,
    this.width = 380,
  });

  final String title;
  final String? body;

  /// 正文里的自定义内容（输入框、选项列表）。
  ///
  /// 不叫 `child`：它在视觉上是「说明下面的那一块」，在构造参数里排在
  /// `actions` 之前也读得通；叫 `child` 会撞上 `sort_child_properties_last`。
  final Widget? content;
  final List<Widget> actions;
  final double width;

  /// 弹出一个对话框，返回对话框关闭时带出的值。
  static Future<T?> show<T>(BuildContext context, Widget dialog) {
    final overlay = Overlay.maybeOf(context, rootOverlay: true);
    if (overlay == null) return Future<T?>.value();
    final completer = Completer<T?>();
    // 先声明再赋值：builder 闭包里要用到 entry 本身才能把它自己移除，
    // `late final` 在这里不算「已声明」，编译器会拒绝闭包里的前向引用。
    OverlayEntry? entry;
    entry = OverlayEntry(
      builder: (ctx) => _DialogLayer(
        onDone: (value) {
          entry?.remove();
          if (!completer.isCompleted) completer.complete(value as T?);
        },
        child: dialog,
      ),
    );
    overlay.insert(entry);
    return completer.future;
  }

  /// 关掉当前对话框并带出一个值。
  ///
  /// 对话框不是一条路由（它挂在 Overlay 上，`Navigator.maybePop` 拿它没办法），
  /// 所以按钮必须显式走这条路。找不到作用域时什么都不做——那说明这个按钮
  /// 不在对话框里，本来也不该关。
  static void close(BuildContext context, [Object? value]) {
    _DialogScope.maybeOf(context)?.close(value);
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      width: width,
      padding: const EdgeInsets.fromLTRB(24, 22, 24, 18),
      decoration: BoxDecoration(
        color: s.surface,
        borderRadius: BorderRadius.circular(OndraRadius.panel),
        boxShadow: const [
          BoxShadow(color: Color(0x2E000000), spreadRadius: 1),
          BoxShadow(
            color: Color(0x59000000),
            blurRadius: 48,
            offset: Offset(0, 16),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 正文可滚：手机上长文案（「清空全部数据」那段有六行）叠加系统
          // 字号放大后，超出屏高的部分会被直接裁掉。
          Flexible(
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    title,
                    style: ondraText(
                      15,
                      weight: 500,
                      color: s.ink,
                      height: 21 / 15,
                    ),
                  ),
                  if (body != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      body!,
                      style: ondraText(12.5, color: s.ink60, height: 19 / 12.5),
                    ),
                  ],
                  if (content != null) ...[const SizedBox(height: 14), content!],
                ],
              ),
            ),
          ),
          const SizedBox(height: 18),
          // Wrap 而不是 Row：三个按钮（稍后 / 复制链接 / 打开发行页）
          // 在 360dp 屏上一行放不下，Row 会直接溢出。
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 8,
            runSpacing: 8,
            children: actions,
          ),
        ],
      ),
    );
  }
}

/// 对话框的作用域：让任意深度的按钮都能把值带回去。
///
/// 为什么需要它：按钮在**调用点的闭包里**创建，捕获的 `context` 是设置面板那一层，
/// 不是对话框内部那一层。用那个 `context` 去找 Navigator，找到的是外壳的导航栈，
/// `maybePop` 会把整个页面弹掉或者什么都不做——两种都不是用户想要的。
class _DialogScope extends InheritedWidget {
  const _DialogScope({required this.close, required super.child});

  final void Function(Object? value) close;

  static _DialogScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<_DialogScope>();

  @override
  bool updateShouldNotify(_DialogScope oldWidget) => false;
}

class _DialogLayer extends StatelessWidget {
  const _DialogLayer({required this.onDone, required this.child});

  final void Function(Object? value) onDone;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return _DialogScope(
      close: onDone,
      child: _buildStack(context),
    );
  }

  Widget _buildStack(BuildContext context) {
    return Material(
      type: MaterialType.transparency,
      child: Stack(
        children: [
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => onDone(null),
              child: ColoredBox(color: Colors.black.withValues(alpha: 0.32)),
            ),
          ),
          SafeArea(
            child: Center(
              // ConstrainedBox 把桌面的 380/460 固定宽度在窄屏上钳到
              // 「屏宽 - 32」：Container 的 width 只是期望值，受父约束钳制，
              // 所以 dialog 组件本身不用感知屏幕尺寸。
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth: MediaQuery.sizeOf(context).width - 32,
                  maxHeight: MediaQuery.sizeOf(context).height - 96,
                ),
                child: GestureDetector(
                  // 拦住面板上的点击，不让它穿透到遮罩把对话框关掉。
                  onTap: () {},
                  child: child,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 对话框里的小按钮：描边那颗是「取消」，实底那颗是「确认」。
///
/// ## 为什么是 `value` 而不是让调用方自己 `Navigator.pop`
///
/// 按钮在**调用点的闭包**里创建，那个闭包里的 `context` 是设置面板那一层的，
/// 不在对话框的树枝里。拿它去 `Navigator.maybePop`，弹掉的是外壳那一页
/// （或者干脆什么都不做），对话框反而留在屏幕上——用户看到的是「点了没反应」。
///
/// 所以按钮只声明「按下去要带出什么值」，由 [_DialogScope] 负责关面板并
/// 把值填回 `Future`。调用点因此可以写 `await OndraDialog.show<bool>(...)`
/// 然后直接拿结果，不需要知道 Overlay 的存在。
class OndraDialogButton extends StatelessWidget {
  const OndraDialogButton({
    super.key,
    required this.label,
    this.onTap,
    this.filled = false,
    this.danger = false,
    this.value,
    this.closeAfter = true,
  });

  final String label;

  /// 按钮按下时**额外**要做的事。只关面板的按钮（取消、知道了）不需要它。
  final VoidCallback? onTap;
  final bool filled;
  final bool danger;

  /// 按下后带出的值。为 null 也照样关面板（`closeAfter` 管这件事）。
  final Object? value;

  /// 按下后是否关闭对话框。少数按钮（如「重试」）要留在原地。
  final bool closeAfter;

  @override
  Widget build(BuildContext context) {
    return _OndraDialogButtonBody(
      label: label,
      filled: filled,
      danger: danger,
      onTap: () {
        onTap?.call();
        if (closeAfter) OndraDialog.close(context, value);
      },
    );
  }
}

class _OndraDialogButtonBody extends StatefulWidget {
  const _OndraDialogButtonBody({
    required this.label,
    required this.onTap,
    required this.filled,
    required this.danger,
  });

  final String label;
  final VoidCallback onTap;
  final bool filled;
  final bool danger;

  @override
  State<_OndraDialogButtonBody> createState() => _OndraDialogButtonBodyState();
}

class _OndraDialogButtonBodyState extends State<_OndraDialogButtonBody> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final bg = widget.filled
        ? (widget.danger ? OndraColor.danger : OndraColor.accent)
        : (_hover ? s.fillHover : Colors.transparent);
    final fg = widget.filled
        ? Colors.white
        : (widget.danger ? OndraColor.danger : s.ink80);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: OndraPressable(
        radius: OndraRadius.pill,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: OndraMotion.snap,
          curve: OndraMotion.expo,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(OndraRadius.pill),
            border: widget.filled ? null : Border.all(color: s.line),
          ),
          child: Text(
            widget.label,
            style: ondraText(12.5, weight: 500, color: fg, height: 18 / 12.5),
          ),
        ),
      ),
    );
  }
}
