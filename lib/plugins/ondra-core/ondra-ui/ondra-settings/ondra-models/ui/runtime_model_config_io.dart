import 'dart:convert';
import 'dart:io';

import '../../../../../../app/bundled_runtime.dart';
import 'runtime_model_config.dart';

const runtimeModelBegin = '# BEGIN ONDRA APP-MANAGED MODEL v1';
const runtimeModelEnd = '# END ONDRA APP-MANAGED MODEL v1';

/// 只替换明确标记的段。半个、重复、未知版本或被缩进的 marker 一律拒绝。
({String before, String after}) splitRuntimeModelPatch(String original) {
  final markers = RegExp(
    r'^.*# (?:BEGIN|END) ONDRA APP-MANAGED MODEL[^\r\n]*(?:\r?\n|$)',
    multiLine: true,
  ).allMatches(original).toList();
  if (markers.isEmpty) return (before: original, after: '');
  if (markers.length != 2 ||
      markers[0].group(0)!.trimRight() != runtimeModelBegin ||
      markers[1].group(0)!.trimRight() != runtimeModelEnd) {
    throw const FormatException('模型配置受管标记损坏，请先修复 cordis.patch.yml');
  }
  return (
    before: original.substring(0, markers.first.start),
    after: original.substring(markers.last.end),
  );
}

/// 使用随包 loader 的真实 applyEntryPatches 和 YAML 解析器获得原 gateway config。
/// loader 对 config 是整体替换，不是深合并，因此保留其它配置再覆盖 sources。
/// 原文件的非受管字节、禁用项、顺序、注释始终原样保留。
Future<void> writeRuntimeModelPatch({
  required String dshHome,
  required RuntimeModelConfig model,
  required Map<String, String> environment,
}) async {
  final runtime = ondraBundledRuntime;
  if (runtime == null) throw StateError('应用模型配置需要随包 DSH 运行时');
  final file = File('$dshHome/profiles/ondra/cordis.patch.yml');
  final bytes = await file.readAsBytes();
  final bom = bytes.length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf;
  final original = '${bom ? '\ufeff' : ''}${utf8.decode(bytes)}';
  final parts = splitRuntimeModelPatch(original);
  final process = await Process.start(
    runtime.nodePath,
    ['-e', _compose, runtime.dshEntry],
    environment: environment,
    includeParentEnvironment: false,
  );
  // 不用 drain 收正文：drain 不传 result 时只能用 void 泛型（否则 null cast），
  // 而正文是字符串，走 UTF-8 解码器 join。
  final out = utf8.decoder.bind(process.stdout).join();
  // 不把 YAML 解析器可能包含用户配置的报错转入应用日志。
  final errors = process.stderr.drain<void>();
  process.stdin.write(
    jsonEncode({
      'patch': parts.before + parts.after,
      'file': file.path,
      'original': original,
      'before': parts.before,
      'after': parts.after,
      'begin': runtimeModelBegin,
      'end': runtimeModelEnd,
      'route': model.route,
      'profile': model.profile,
      'model': model.modelId,
      'local': model.isLoopback,
      'credentialRef': model.apiKeyEnv,
    }),
  );
  await process.stdin.close();
  final code = await process.exitCode.timeout(
    const Duration(seconds: 15),
    onTimeout: () {
      process.kill(ProcessSignal.sigkill);
      throw StateError('模型配置解析超时');
    },
  );
  await errors;
  final body = await out;
  if (body.trim().isEmpty) {
    throw StateError('受管段生成失败：合并子进程没有输出（exit $code）');
  }
  if (code != 0) throw StateError('无法安全合并模型配置，请检查 profile YAML、网关条目与路由 ID');
  final newline = original.contains('\r\n') ? '\r\n' : '\n';
  final separator = parts.before.isEmpty || parts.before.endsWith('\n')
      ? ''
      : newline;
  final next =
      '${parts.before}$separator$runtimeModelBegin$newline'
      '${body.trimRight().replaceAll('\n', newline)}$newline$runtimeModelEnd$newline${parts.after}';
  if (next == original) return;
  // 异步解析期间若其它设置改了文件，不覆盖它；下一次重连可重试。
  if (await file.readAsString() != original) {
    throw StateError('配置已被其它设置修改，请重新连接');
  }
  final temp = File(
    '${file.path}.model-\$pid-\${DateTime.now().microsecondsSinceEpoch}.tmp',
  );
  try {
    await temp.writeAsString(next, flush: true);
    // 同 isolate 的其它设置不能插在最后校验与 rename 之间。
    if (file.readAsStringSync() != original) {
      throw StateError('配置已被其它设置修改，请重新连接');
    }
    temp.renameSync(file.path);
  } finally {
    if (await temp.exists()) await temp.delete();
  }
}

const _compose = r'''
(async () => {
  const { createRequire } = require('node:module');
  const req = createRequire(process.argv[1]);
  const yaml = req('js-yaml');
  const { applyEntryPatches } = await import(req.resolve('@deepseek-ai/cordis-plugin-include'));
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const data = JSON.parse(input);
  const patches = yaml.load(data.patch) ?? [];
  if (!Array.isArray(patches)) throw new Error('patch must be a list');
  const entries = applyEntryPatches([], patches, () => {});
  const flatten = entries => entries.flatMap(entry => [entry, ...(entry.group && Array.isArray(entry.config) ? flatten(entry.config) : [])]);
  const tree = flatten(entries);
  if (tree.some(entry => entry.id === 'ondra-ui-model')) throw new Error('managed id collision');
  const gateway = tree.filter(entry => entry.id === 'ondra-llm-gateway');
  if (gateway.length > 1) throw new Error('duplicate gateway');
  // pi-ai 每个实例注册完整 configurable-provider 目录，重复实例会冲突。
  // 所以在同一个适配器的 providers 字典里添加独立 route，而非起第二个实例。
  const adapters = tree.filter(entry => entry.name === '@deepseek-ai/dsh-llm-pi-ai');
  if (adapters.length > 1) throw new Error('multiple pi-ai instances');
  const adapter = adapters[0];
  if (adapter?.config?.providers?.[data.route]) throw new Error('route collision');
  const config = {...adapter?.config, providers: {...adapter?.config?.providers, [data.route]: data.profile}};
  const result = adapter
    ? [{id: adapter.id, name: adapter.name, config}]
    : [{insert: [{id: 'ondra-ui-model', name: '@deepseek-ai/dsh-llm-pi-ai', config}]}];
  if (gateway.length) {
    const entry = gateway[0];
    if (entry.name !== '@ondra/cordis-plugin-ondra-llm-gateway' ||
        (entry.config != null && (typeof entry.config !== 'object' || Array.isArray(entry.config)))) throw new Error('invalid gateway');
    result.push({id: entry.id, name: entry.name, config: {...entry.config, sources: [{
      id: 'ondra-ui-current', kind: data.local ? 'local' : 'remote',
      provider: data.route, model: data.model, credentialRef: data.credentialRef,
      priority: 10, timeoutMs: 120000
    }]}});
  }
  // JSON 是 YAML 的 flow 语法子集；名称中的引号、换行、# 不能变成 YAML 指令。
  process.stdout.write(result.map(patch => '- ' + JSON.stringify(patch)).join('\n'));
})().catch(() => { process.exitCode = 1; });
''';
