import 'package:material_ui/material_ui.dart';

import '../../../../../design/page_frame.dart';
import '../../../../../design/primitives.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';
import 'transfer_actions.dart';
import 'transfer_model.dart';

/// 导入导出：把「空谷知道的东西」搬进来、搬出去。
///
/// 这一页存在的理由很具体：记忆与人设是用户自己的资产，不能只躺在应用私有的
/// 数据库里。导出一律是**明文**（Markdown / JSON / 一个能看见内容的目录），
/// 换一台机器、换一个工具都读得懂；导入按 id 与文本双重去重，重复导入同一份
/// 文件不会长出两套记忆。
///
/// 三条动作都落到真实文件系统上：导出会真的写出文件（写完回读校验不是空的），
/// 导入会真的写库（写之前先存一份备份）。浏览器预览里则每个动作都如实说做不到——
/// 点完却什么都没发生，比直接说不支持更糟。
class TransferPage extends StatefulWidget {
  const TransferPage({super.key});

  @override
  State<TransferPage> createState() => _TransferPageState();
}

class _TransferPageState extends State<TransferPage> {
  TransferSnapshot? _snapshot;
  bool _busy = false;
  String _message = '';
  bool _messageOk = true;
  String? _lastPath;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final snapshot = await transferLoader();
      if (mounted) setState(() => _snapshot = snapshot);
    } catch (e) {
      if (mounted) {
        setState(() {
          _message = '读取失败：$e';
          _messageOk = false;
        });
      }
    }
  }

  /// 所有动作都走这一个壳：置忙 → 执行 → 重读统计 → 把引擎的原话显示出来。
  Future<void> _run(Future<TransferResult?> Function() action) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = '';
      _lastPath = null;
    });
    try {
      final result = await action();
      if (result == null || !mounted) return;
      setState(() {
        _message = result.message;
        _messageOk = result.ok;
        _lastPath = result.path;
      });
      try {
        final snapshot = await transferLoader();
        if (mounted) setState(() => _snapshot = snapshot);
      } catch (e) {
        // 动作成功但刷新失败时保留产出路径，不能让用户误以为文件没写出。
        if (mounted) {
          setState(() {
            _message += '\n统计刷新失败：$e';
            _messageOk = false;
          });
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _message = '操作失败：$e';
          _messageOk = false;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _exportMemories(TransferFormat format) => _run(() async {
    final dir = await transferPickDirectory('选择要把记忆导出到哪里');
    return dir == null ? null : await transferExportMemory(dir, format);
  });

  Future<void> _exportBundle() => _run(() async {
    final dir = await transferPickDirectory('选择要把人设与偏好导出到哪里');
    return dir == null ? null : await transferExportBundle(dir);
  });

  Future<void> _exportArchive() => _run(() async {
    final dir = await transferPickDirectory('选择要把全部数据导出到哪里');
    return dir == null ? null : await transferExportArchive(dir);
  });

  Future<void> _importFile(List<String> extensions) => _run(() async {
    final path = await transferPickFile('选择要导入的文件', extensions);
    return path == null ? null : await transferImport(path);
  });

  Future<void> _importDir() => _run(() async {
    final path = await transferPickDirectory('选择要导入的人设包目录');
    return path == null ? null : await transferImport(path);
  });

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final snap = _snapshot;

    return OndraPage(
      title: '导入导出',
      subtitle: '明文进出，全部在本机完成',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Inventory(snapshot: snap, busy: _busy),
          if (_message.isNotEmpty) ...[
            const SizedBox(height: 12),
            _ResultStrip(
              text: _message,
              ok: _messageOk,
              path: _lastPath,
              onReveal: _lastPath == null
                  ? null
                  : () {
                      final path = _lastPath!;
                      _run(() => transferReveal(path));
                    },
            ),
          ],
          const SizedBox(height: 18),
          OndraSection(
            title: '导入',
            child: Column(
              children: [
                OndraSettingRow(
                  title: '记忆文件',
                  desc: snap == null ? '读取中…' : '同一条记忆不会长出两份；写库前会自动存一份备份',
                  value: 'JSON / MD',
                  chevron: true,
                  disabled: _busy,
                  onTap: () => _importFile(const ['json', 'md', 'markdown']),
                  showDivider: true,
                ),
                OndraSettingRow(
                  title: '人设包',
                  desc: '导出时生成的那个目录，原样搬回来即可',
                  value: '目录',
                  chevron: true,
                  disabled: _busy,
                  onTap: _importDir,
                  showDivider: true,
                ),
                OndraSettingRow(
                  title: '偏好设置',
                  desc: '主题、语言等偏好；同名项以文件为准',
                  value: 'JSON',
                  chevron: true,
                  disabled: _busy,
                  onTap: () => _importFile(const ['json']),
                  showDivider: false,
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          OndraSection(
            title: '导出',
            child: Column(
              children: [
                OndraSettingRow(
                  title: '记忆明文',
                  desc: snap == null ? '读取中…' : '一条一段，带时间与类别；用任何编辑器都能读',
                  value: snap == null ? '' : '${snap.facts} 条',
                  chevron: true,
                  disabled: _busy,
                  onTap: () => _exportMemories(TransferFormat.markdown),
                  showDivider: true,
                ),
                OndraSettingRow(
                  title: '记忆数据',
                  desc: '保留编号、显著度与证据链，可以再导回空谷',
                  value: 'JSON',
                  chevron: true,
                  disabled: _busy,
                  onTap: () => _exportMemories(TransferFormat.json),
                  showDivider: true,
                ),
                OndraSettingRow(
                  title: '人设与偏好',
                  desc: snap == null
                      ? '读取中…'
                      : snap.personaPacks == 0
                      ? '人设还是内置那份，只有偏好会被带走'
                      : '含 ${snap.personaPacks} 个人设包与全部偏好',
                  value: '目录',
                  chevron: true,
                  disabled: _busy,
                  onTap: _exportBundle,
                  showDivider: true,
                ),
                OndraSettingRow(
                  title: '全部数据',
                  desc: '当前对话、记忆、偏好与人设；不含内核装配层和密钥',
                  value: snap == null ? '' : '${snap.snapshotCount} 份备份',
                  chevron: true,
                  disabled: _busy,
                  onTap: _exportArchive,
                  showDivider: false,
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Text(
            '导出的记忆是明文，存放位置请自己挑；空谷不会上传任何内容。'
            '导入会写进本机记忆库，所以动手前先存一份备份——这台机器上的东西，'
            '应该由你决定它去哪。',
            style: ondraText(10.5, color: s.ink25, height: 15 / 10.5),
          ),
        ],
      ),
    );
  }
}

/// 「本机现在有什么」。
///
/// 先给数字再给动作：读者据此判断「点下去会导出一份空文件还是真的记忆」，
/// 不用点完才发现。数字全是真读的，没有一项是估的。
class _Inventory extends StatelessWidget {
  const _Inventory({required this.snapshot, required this.busy});

  final TransferSnapshot? snapshot;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final snap = snapshot;

    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: s.surface,
        borderRadius: BorderRadius.circular(OndraRadius.lg),
        border: Border.all(color: s.lineCard),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text(
                '本机现在有',
                style: ondraText(
                  11,
                  weight: 600,
                  color: s.ink40,
                  height: 14 / 11,
                ),
              ),
              const Spacer(),
              if (busy)
                Text('处理中…', style: ondraText(11, color: s.ink30))
              else if (snap != null && snap.note.isNotEmpty)
                Text('部分读不到', style: ondraText(11, color: s.ink30)),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Num(value: snap == null ? '—' : '${snap.facts}', label: '条记忆'),
              _Num(value: snap == null ? '—' : '${snap.raws}', label: '条原文'),
              _Num(
                value: snap == null ? '—' : '${snap.sessions}',
                label: '份对话',
              ),
              _Num(
                value: snap == null ? '—' : snap.dataText,
                label: '本机数据',
                last: true,
              ),
            ],
          ),
          if (snap != null && snap.note.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(
              snap.note,
              style: ondraText(10.5, color: s.ink30, height: 15 / 10.5),
            ),
          ],
        ],
      ),
    );
  }
}

class _Num extends StatelessWidget {
  const _Num({required this.value, required this.label, this.last = false});

  final String value;
  final String label;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: ondraText(
              17,
              weight: 500,
              color: s.ink,
              height: 22 / 17,
            ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: ondraText(10.5, color: s.ink30, height: 14 / 10.5),
          ),
        ],
      ),
    );
  }
}

/// 动作结果条。
///
/// 成功后把产出路径也列出来，并给一个「在访达中显示」：用户点完导出，
/// 下一个问题一定是「东西在哪」，不该让他自己去找。
class _ResultStrip extends StatelessWidget {
  const _ResultStrip({
    required this.text,
    required this.ok,
    this.path,
    this.onReveal,
  });

  final String text;
  final bool ok;
  final String? path;
  final VoidCallback? onReveal;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: ok ? s.fillFaint : s.fillHover,
        borderRadius: BorderRadius.circular(OndraRadius.md),
        border: Border.all(color: ok ? s.lineFaint : s.lineCard),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              OndraStatusDot(color: ok ? OndraColor.accent : s.ink45, size: 6),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  text,
                  style: ondraText(11.5, color: s.ink60, height: 17 / 11.5),
                ),
              ),
            ],
          ),
          if (path != null) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                Expanded(
                  child: Text(
                    _shortPath(path!),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ondraText(10.5, color: s.ink30, height: 15 / 10.5),
                  ),
                ),
                if (onReveal != null)
                  PredicateTap(
                    onTap: onReveal!,
                    child: Text(
                      '在访达中显示',
                      style: ondraText(10.5, color: s.ink45, height: 15 / 10.5),
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  /// 长路径从左边截：真正有信息的是最后两级（文件名、它所在的目录）。
  String _shortPath(String path) {
    final parts = path.split('/').where((e) => e.isNotEmpty).toList();
    if (parts.length <= 3) return path;
    return '…/${parts.sublist(parts.length - 3).join('/')}';
  }
}

/// 一个只有命中区的可点文字。抽出来是因为本页要用它两三次，
/// 而 `GestureDetector` 包文字时最容易漏掉 `behavior: opaque`（点空隙不响应）。
class PredicateTap extends StatelessWidget {
  const PredicateTap({super.key, required this.onTap, required this.child});

  final VoidCallback onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: child,
      ),
    );
  }
}
