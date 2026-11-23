import 'package:material_ui/material_ui.dart';

import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';
import 'llama_client.dart';

/// 「本地部署」在模型基座里的那段：二进制、模型目录、运行状态、下载。
///
/// 自带一套行样式而不是复用设置面板的私有 `_Row`：插件不该 import 另一个插件的
/// 私有组件，否则哪天设置面板改行高，本地模型会跟着歪。
class LlamaPanel extends StatefulWidget {
  const LlamaPanel({super.key, required this.port, this.onEndpointReady});

  /// 从 provider 的地址里解析出的端口，用来起服务。
  final int port;

  /// 服务就绪后回调实际地址，界面据此把 provider.baseUrl 改对。
  final void Function(String baseUrl)? onEndpointReady;

  @override
  State<LlamaPanel> createState() => _LlamaPanelState();
}

class _LlamaPanelState extends State<LlamaPanel> {
  final _url = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // 打开这段时才扫目录：没装过本地模型的用户不该为一次没发生的扫描付费。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) llamaClient.refresh();
    });
  }

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _download() async {
    final url = _url.text.trim();
    if (url.isEmpty) {
      setState(() => _error = '先填一个 .gguf 的地址');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await llamaClient.download(url);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = err;
    });
    if (err == null) _url.clear();
  }

  Future<void> _start(LlamaModel model) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await llamaClient.start(model, port: widget.port);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = err;
    });
    if (err == null) {
      widget.onEndpointReady?.call('http://127.0.0.1:${widget.port}/v1');
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return AnimatedBuilder(
      animation: llamaClient,
      builder: (context, _) {
        final c = llamaClient;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Group(
              title: 'llama.cpp',
              children: [
                _Line(
                  title: 'llama-server',
                  desc: c.binary ?? '没找到：brew install llama.cpp',
                  value: c.binary == null ? '未安装' : '已找到',
                  action: _Link(label: '重新查找', onTap: c.refresh),
                ),
                _Line(
                  title: '模型目录',
                  desc: c.modelsDir,
                  value: '${c.models.length} 个模型',
                  action: _Link(label: '刷新', onTap: c.refresh),
                  showDivider: false,
                ),
              ],
            ),
            const SizedBox(height: 20),
            _Group(
              title: '运行状态',
              children: [
                _Line(
                  title: c.running ? (c.starting ? '启动中…' : '运行中') : '未运行',
                  desc: c.running
                      ? '${c.runningModel ?? '模型'} · 127.0.0.1:${c.port}'
                      : '选一个本地模型启动，地址会自动填回上面',
                  value: c.running ? 'PID ${c.pidLabel}' : null,
                  action: c.running ? _Link(label: '停止', onTap: c.stop) : null,
                  showDivider: c.lastLine != null,
                ),
                if (c.lastLine != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 10),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        c.lastLine!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: ondraText(11, color: s.ink45, height: 16 / 11),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 20),
            _Group(
              title: '已下载的模型',
              children: [
                if (c.models.isEmpty)
                  const _Line(
                    title: '还没有模型',
                    desc: '在下面填一个 GGUF 地址下载；模型放在 ~/.ondra/models',
                    showDivider: false,
                  ),
                for (var i = 0; i < c.models.length; i++)
                  _Line(
                    title: c.models[i].name,
                    desc: c.models[i].sizeLabel,
                    action: c.running
                        ? null
                        : _Link(
                            label: '启动',
                            onTap: _busy ? null : () => _start(c.models[i]),
                          ),
                    showDivider: i != c.models.length - 1,
                  ),
              ],
            ),
            const SizedBox(height: 20),
            _Group(
              title: '下载模型',
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 6, 16, 10),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _url,
                          enabled: !_busy,
                          cursorColor: OndraColor.accent,
                          style: ondraText(12, color: s.ink, height: 18 / 12),
                          decoration: InputDecoration(
                            isDense: true,
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            contentPadding: const EdgeInsets.symmetric(
                              vertical: 6,
                            ),
                            hintText: 'https://…/model.gguf',
                            hintStyle: ondraText(
                              11,
                              color: s.ink25,
                              height: 18 / 11,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      _Link(
                        label: _busy ? '下载中…' : '下载',
                        onTap: _busy ? null : _download,
                      ),
                    ],
                  ),
                ),
                if (c.progress != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(3),
                          child: LinearProgressIndicator(
                            value: c.progress == 0 ? null : c.progress,
                            minHeight: 4,
                            backgroundColor: s.fill,
                            valueColor: const AlwaysStoppedAnimation(
                              OndraColor.accent,
                            ),
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          c.progress == 0
                              ? '正在建立连接…'
                              : '${(c.progress! * 100).toStringAsFixed(0)}%',
                          style: ondraText(11, color: s.ink40, height: 14 / 11),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Padding(
                padding: const EdgeInsets.only(left: 4),
                child: Text(
                  _error!,
                  style: ondraText(
                    11,
                    color: OndraColor.danger,
                    height: 16 / 11,
                  ),
                ),
              ),
            ],
            const SizedBox(height: 6),
            Text(
              'llama.cpp 用 MIT 许可；模型文件由你自己下载与保管，空谷不会上传。',
              style: ondraText(11, color: s.ink30, height: 16 / 11),
            ),
          ],
        );
      },
    );
  }
}

class _Group extends StatelessWidget {
  const _Group({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
          child: Text(
            title,
            style: ondraText(
              11,
              weight: 600,
              color: s.ink40,
              height: 14 / 11,
              spacing: 0.3,
            ),
          ),
        ),
        Container(
          decoration: BoxDecoration(
            color: s.fill,
            borderRadius: BorderRadius.circular(OndraRadius.lg),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: children,
          ),
        ),
      ],
    );
  }
}

class _Line extends StatelessWidget {
  const _Line({
    required this.title,
    this.desc,
    this.value,
    this.action,
    this.showDivider = true,
  });

  final String title;
  final String? desc;
  final String? value;
  final Widget? action;
  final bool showDivider;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      constraints: const BoxConstraints(minHeight: 42),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        border: showDivider
            ? Border(bottom: BorderSide(color: s.lineSoft, width: 1))
            : null,
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ondraText(13, color: s.ink80, height: 18 / 13),
                ),
                if (desc != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    desc!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: ondraText(11, color: s.ink45, height: 14 / 11),
                  ),
                ],
              ],
            ),
          ),
          if (value != null) ...[
            const SizedBox(width: 12),
            Text(
              value!,
              style: ondraText(12, color: s.ink45, height: 18 / 12),
            ),
          ],
          if (action != null) ...[const SizedBox(width: 12), action!],
        ],
      ),
    );
  }
}

class _Link extends StatelessWidget {
  const _Link({required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return MouseRegion(
      cursor: onTap == null
          ? SystemMouseCursors.basic
          : SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Text(
          label,
          style: ondraText(
            12,
            weight: 500,
            color: onTap == null ? s.ink25 : OndraColor.accent,
            height: 18 / 12,
          ),
        ),
      ),
    );
  }
}
