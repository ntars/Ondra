/// 首次使用引导：第一次打开应用时的一屏说明。
///
/// ## 为什么是「一屏」而不是多步向导
///
/// 要说的话只有三句：对话在右栏、记得住、随时可查。三句话拆成三步点击，
/// 每一步的信息量撑不起一整屏，用户只会想快点点完——那引导就变成了障碍。
///
/// ## 为什么判据是 prefs 而不是「有没有数据」
///
/// 「跟空谷说过话」不是判断依据：用户可能先逛了一圈界面再回来聊。引导的
/// 使命是第一次打开时把界面结构讲清楚，讲过一次就不该再出现。
///
/// ## 什么时候消失
///
/// 点「开始使用」，写 `onboardingDone` 并原地移除——不用重启，也不用导航。
library;

import 'package:material_ui/material_ui.dart';

import '../../../../../../app/prefs.dart';
import '../../../../../../app/version.dart';
import '../../../../../design/pressable.dart';
import '../../../../../design/primitives.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';

/// 首次启动标记在 prefs 里的键。
const String _doneKey = 'onboardingDone';

class OnboardingGate extends StatefulWidget {
  const OnboardingGate({super.key, required this.child});

  final Widget child;

  @override
  State<OnboardingGate> createState() => _OnboardingGateState();
}

class _OnboardingGateState extends State<OnboardingGate> {
  late bool _shown = readPref(_doneKey) != '1';

  void _finish() {
    writePref(_doneKey, '1');
    setState(() => _shown = false);
  }

  @override
  Widget build(BuildContext context) {
    if (!_shown) return widget.child;
    return Stack(
      fit: StackFit.expand,
      children: [
        widget.child,
        _OnboardingLayer(onFinish: _finish),
      ],
    );
  }
}

class _OnboardingLayer extends StatelessWidget {
  const _OnboardingLayer({required this.onFinish});

  final VoidCallback onFinish;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return ColoredBox(
      color: Colors.black.withValues(alpha: 0.45),
      child: Center(
        child: Container(
          width: 440,
          padding: const EdgeInsets.fromLTRB(28, 26, 28, 22),
          decoration: BoxDecoration(
            color: s.surface,
            borderRadius: BorderRadius.circular(OndraRadius.modal),
            boxShadow: const [
              BoxShadow(color: Color(0x33000000), spreadRadius: 1),
              BoxShadow(
                color: Color(0x66000000),
                blurRadius: 48,
                offset: Offset(0, 16),
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '欢迎使用 $ondraProductName',
                style: ondraText(
                  17,
                  weight: 600,
                  color: s.ink,
                  height: 24 / 17,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                ondraSlogan,
                style: ondraText(12.5, color: s.ink60, height: 19 / 12.5),
              ),
              const SizedBox(height: 18),
              const _Point(
                title: '对话在右栏',
                body: '应用自带对话内核；开始聊天前，需要在“模型基座”配置可用的模型或网关。',
              ),
              const _Point(title: '记得住', body: '聊过的内容会沉淀成记忆星图，在左栏随时回看。'),
              const _Point(title: '随时可查', body: '历史对话、备份还原、导入导出都收在左侧一列里。'),
              const SizedBox(height: 20),
              OndraPressable(
                onTap: onFinish,
                radius: OndraRadius.md,
                child: Container(
                  height: 36,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: s.accentSoft,
                    borderRadius: BorderRadius.circular(OndraRadius.md),
                  ),
                  child: Text(
                    '开始使用',
                    style: ondraText(13, weight: 500, color: s.ink),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 一条要点：左侧一个主色小圆点，右侧两行字。
class _Point extends StatelessWidget {
  const _Point({required this.title, required this.body});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: s.accentWashStrong,
                shape: BoxShape.circle,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: ondraText(
                    12.5,
                    weight: 500,
                    color: s.ink,
                    height: 18 / 12.5,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  body,
                  style: ondraText(11.5, color: s.ink60, height: 17 / 11.5),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
