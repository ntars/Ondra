import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/prefs.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-persona/ui/persona_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-persona/ui/persona_model.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-persona/ui/persona_store.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/profile_config_io.dart';

class _Bundle extends CachingAssetBundle {
  _Bundle({this.skill = '# Built in\nContent'});
  String? skill;
  final String slug = 'built-in';
  @override
  Future<ByteData> load(String key) async {
    final values = <String, String>{
      'assets/personas/index.json': jsonEncode({
        'packs': [slug],
        'builtIn': [slug],
        'default': slug,
      }),
      'assets/personas/$slug/meta.json': jsonEncode({
        'slug': slug,
        'name': 'Built in',
      }),
      'assets/personas/$slug/SKILL.md': ?skill,
    };
    final value = values[key];
    if (value == null) throw StateError('missing asset: $key');
    return ByteData.sublistView(Uint8List.fromList(utf8.encode(value)));
  }
}

const _makeZip = r'''
import json, stat, struct, sys, zipfile
path, spec = sys.argv[1], json.loads(sys.argv[2])
with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for entry in spec['entries']:
        info = zipfile.ZipInfo(entry['name'].replace('\x00', '!'))
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777 if entry.get('link') else stat.S_IFREG | 0o600) << 16
        info.compress_type = zipfile.ZIP_DEFLATED if entry.get('repeat') else zipfile.ZIP_STORED
        content = entry.get('text', 'data').encode('utf-8')
        if entry.get('repeat'):
            content = b'x' * entry['repeat']
        z.writestr(info, content)
if any('\x00' in entry['name'] for entry in spec['entries']):
    data = open(path, 'rb').read().replace(b'nul!name', b'nul\x00name')
    open(path, 'wb').write(data)
if spec.get('corrupt'):
    with zipfile.ZipFile(path) as z:
        info = z.infolist()[-1]
        offset = info.header_offset
    with open(path, 'r+b') as f:
        f.seek(offset + 26)
        name_len, extra_len = struct.unpack('<HH', f.read(4))
        f.seek(offset + 30 + name_len + extra_len)
        b = f.read(1)
        f.seek(-1, 1)
        f.write(bytes([b[0] ^ 1]))
if spec.get('oversize'):
    data = bytearray(open(path, 'rb').read())
    cd = data.find(b'PK\x01\x02')
    struct.pack_into('<I', data, cd + 24, 4194305)
    open(path, 'wb').write(data)
''';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory temp;
  late PersonaStore store;
  var sequence = 0;

  setUp(() {
    temp = Directory.systemTemp.createTempSync('ondra-persona-test-');
    store = PersonaStore(home: '${temp.path}/data');
    // 兜底隔离；客户端本身的 home/store 注入也会关闭真实 prefs/profile 访问。
    setPrefHome(temp.path);
    debugProfileConfigFileOverride = '${temp.path}/cordis.patch.yml';
  });
  tearDown(() {
    setPrefHome(null);
    debugProfileConfigFileOverride = null;
    temp.deleteSync(recursive: true);
  });

  Future<String> archive({
    String slug = 'hero',
    Object? meta,
    String? skill = '# Hero\n> 一句话内核：test persona',
    String wrapper = '',
    List<Map<String, Object?>> extra = const [],
    bool corrupt = false,
    bool oversize = false,
    String? filename,
  }) async {
    final path = '${temp.path}/${filename ?? 'pack-${sequence++}.skill.zip'}';
    final prefix = wrapper.isEmpty ? '' : '$wrapper/';
    final result = await Process.run('python3', [
      '-I',
      '-c',
      _makeZip,
      path,
      jsonEncode({
        'entries': [
          {
            'name': '${prefix}meta.json',
            'text': jsonEncode(meta ?? {'slug': slug, 'name': 'Hero'}),
          },
          if (skill != null) {'name': '${prefix}SKILL.md', 'text': skill},
          {
            'name': '${prefix}references/context.txt',
            'text': 'unchanged reference',
          },
          ...extra,
        ],
        'corrupt': corrupt,
        'oversize': oversize,
      }),
    ]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    return path;
  }

  Future<PersonaInstall> install(
    String path, {
    Set<String> builtIn = const {},
  }) => store.install(archivePath: path, builtInSlugs: builtIn);

  test('平铺与一层目录包往返，旧目录保留且内核 ZIP 可直接加载', () async {
    final result = await install(
      await archive(wrapper: 'Hero.skill', slug: 'Hero'),
    );
    expect(result.ok, isTrue, reason: result.message);
    expect(result.slug, 'Hero');
    expect(result.id, 'hero');
    expect(store.installedSlugs(), ['Hero']);
    expect(store.readInstalled('Hero')!.id, 'hero');
    final kernelZip = File('${store.kernelRoot}/Hero.skill.zip');
    expect(kernelZip.existsSync(), isTrue);
    // 使用真实 loader 只读模块核实格式/ID；没有启动内核或读取用户 home。
    final scan = File(
      'plugin-profile/node_modules/@ondra/cordis-plugin-ondra-persona-loader/lib/scan.js',
    ).absolute.uri;
    final settings = File(
      'plugin-profile/node_modules/@ondra/cordis-plugin-ondra-persona-loader/lib/settings.js',
    ).absolute.uri;
    final loaded = await Process.run('node', [
      '--input-type=module',
      '-e',
      '''
import { loadOne } from ${jsonEncode(scan.toString())};
import { DEFAULT_CONFIG } from ${jsonEncode(settings.toString())};
const result = loadOne(process.argv[1], 'user', DEFAULT_CONFIG);
if (!result.detail || result.detail.id !== 'hero' || result.detail.skillChars === 0) {
  throw new Error(JSON.stringify(result));
}
''',
      kernelZip.path,
    ]);
    expect(loaded.exitCode, 0, reason: '${loaded.stderr}');
    final exported = '${temp.path}/export.skill.zip';
    expect((await store.export('Hero', targetZip: exported)).ok, isTrue);
    final second = PersonaStore(home: '${temp.path}/second');
    final imported = await second.install(
      archivePath: exported,
      builtInSlugs: {},
    );
    expect(imported.ok, isTrue, reason: imported.message);
    expect(
      File('${second.root}/Hero/references/context.txt').readAsStringSync(),
      'unchanged reference',
    );
    expect((await second.remove('Hero', builtIn: false)).ok, isTrue);
    expect(Directory('${second.root}/Hero').existsSync(), isFalse);
    expect(File('${second.kernelRoot}/Hero.skill.zip').existsSync(), isFalse);
  });

  for (final malicious in [
    '../escaped',
    '/absolute',
    r'C:\escape',
    r'folder\escape',
    'safe/../../escape',
    './alias',
    'safe//alias',
    'meta.json',
    'META.JSON',
    'SKILL.md/child',
    'trailing. /file',
    'nul\u0000name',
  ]) {
    test('解压前拒绝恶意或重复路径 ${jsonEncode(malicious)}', () async {
      final outside = File('${temp.path}/sentinel')..writeAsStringSync('keep');
      final result = await install(
        await archive(
          extra: [
            {'name': malicious, 'text': 'malicious'},
          ],
        ),
      );
      expect(result.ok, isFalse, reason: malicious);
      expect(store.installedSlugs(), isEmpty);
      expect(outside.readAsStringSync(), 'keep');
      expect(Directory(store.root).listSync(), isEmpty);
      expect(Directory(store.kernelRoot).listSync(), isEmpty);
    });
  }

  test('拒绝软链及其后续文件，绝不写出 staging', () async {
    final outside = Directory('${temp.path}/outside')..createSync();
    final result = await install(
      await archive(
        extra: [
          {'name': 'link', 'text': outside.path, 'link': true},
          {'name': 'link/injected', 'text': 'bad'},
        ],
      ),
    );
    expect(result.ok, isFalse);
    expect(outside.listSync(), isEmpty);
  });

  test('所有未使用条目也校验 CRC，拒绝损坏与伪造超大声明', () async {
    expect((await install(await archive(corrupt: true))).ok, isFalse);
    expect((await install(await archive(oversize: true))).ok, isFalse);
    final truncated = File(await archive());
    truncated.writeAsBytesSync(truncated.readAsBytesSync().sublist(0, 80));
    expect((await install(truncated.path)).ok, isFalse);
    expect(store.installedSlugs(), isEmpty);
  });

  test('拒绝单文件、总解压大小及条目数超限', () async {
    expect(
      (await install(
        await archive(
          extra: [
            {'name': 'huge', 'repeat': PersonaStore.maxEntryBytes + 1},
          ],
        ),
      )).ok,
      isFalse,
    );
    expect(
      (await install(
        await archive(
          extra: [
            for (var i = 0; i < 9; i++)
              {'name': 'large-$i', 'repeat': PersonaStore.maxEntryBytes},
          ],
        ),
      )).ok,
      isFalse,
    );
    expect(
      (await install(
        await archive(
          extra: [
            for (var i = 0; i < PersonaStore.maxEntries; i++)
              {'name': 'entry-$i'},
          ],
        ),
      )).ok,
      isFalse,
    );
  });

  test('合法非空 metadata 与 SKILL 是统一入口要求', () async {
    for (final meta in [
      <String, Object?>{},
      [],
      {'slug': '../escape'},
      {'slug': 12},
      {'slug': 'hero', 'name': 42},
    ]) {
      expect(
        (await install(await archive(meta: meta))).ok,
        isFalse,
        reason: '$meta',
      );
    }
    expect((await install(await archive(skill: null))).ok, isFalse);
    expect((await install(await archive(skill: ' \n\t'))).ok, isFalse);
    expect(
      (await install(
        await archive(slug: 'oh-jingjing'),
        builtIn: {'oh-jingjing'},
      )).ok,
      isFalse,
    );
    expect(
      (await install(
        await archive(slug: 'OH-JINGJING'),
        builtIn: {'oh-jingjing'},
      )).ok,
      isFalse,
    );
  });

  test('不允许目录名不同但内核 ID 相同的包互相遮蔽', () async {
    expect((await install(await archive(slug: 'Hero'))).ok, isTrue);
    expect((await install(await archive(slug: 'hero'))).ok, isFalse);
    expect(store.installedSlugs(), ['Hero']);
  });

  test('缺 slug 时使用稳定包文件名而不是随机临时目录', () async {
    final result = await install(
      await archive(meta: {'name': '中文名'}, filename: 'My.Role.skill.zip'),
    );
    expect(result.ok, isTrue, reason: result.message);
    expect(result.slug, 'My.Role');
    expect(result.id, 'my-role');
    expect(store.readInstalled('My.Role')!.id, result.id);
  });

  test('所有 slug API 拒绝穿越和隐藏目录', () async {
    for (final slug in [
      '',
      '.',
      '..',
      '../outside',
      '/tmp',
      r'a\b',
      '.hero',
      'a..b',
    ]) {
      expect(store.readInstalled(slug), isNull);
      expect((await store.remove(slug, builtIn: false)).ok, isFalse);
      expect(
        (await store.export(slug, targetZip: '${temp.path}/out.zip')).ok,
        isFalse,
      );
      expect((await store.ensureKernelPack(slug)).ok, isFalse);
    }
  });

  test('已安装包及数据根链接不可读写/导出，不跟随读取外部内容', () async {
    expect((await install(await archive())).ok, isTrue);
    final outside = File('${temp.path}/outside')
      ..writeAsStringSync('private fixture');
    Link('${store.root}/hero/link').createSync(outside.path);
    expect(store.readInstalled('hero'), isNull);
    expect(
      (await store.export('hero', targetZip: '${temp.path}/out.zip')).ok,
      isFalse,
    );
    expect((await store.ensureKernelPack('hero')).ok, isFalse);
    final linked = PersonaStore(home: '${temp.path}/linked');
    Directory(linked.home).createSync();
    Link(linked.root).createSync(store.root);
    expect(
      (await linked.install(archivePath: await archive(), builtInSlugs: {})).ok,
      isFalse,
    );
    expect((await linked.remove('hero', builtIn: false)).ok, isFalse);
    expect(outside.readAsStringSync(), 'private fixture');
  });

  test('导出不覆盖已存在的文件/链接且无半成品', () async {
    await install(await archive());
    final target = File('${temp.path}/existing.zip')..writeAsStringSync('keep');
    expect((await store.export('hero', targetZip: target.path)).ok, isFalse);
    expect(target.readAsStringSync(), 'keep');
    final link = Link('${temp.path}/linked.zip')..createSync(target.path);
    expect((await store.export('hero', targetZip: link.path)).ok, isFalse);
    expect(target.readAsStringSync(), 'keep');
    expect(
      temp.listSync().where((e) => e.path.contains('.persona-export-')),
      isEmpty,
    );
  });

  test('替换在各发布阶段故障均恢复旧目录及旧 ZIP，不删同名残留', () async {
    expect((await install(await archive(skill: 'old skill'))).ok, isTrue);
    final oldZip = File('${store.kernelRoot}/hero.skill.zip').readAsBytesSync();
    final residue = Directory('${store.root}/.hero.replaced')..createSync();
    File('${residue.path}/user-data').writeAsStringSync('keep');
    final replacement = await archive(skill: 'new skill');
    for (final step in [
      'backed-up-0',
      'published-0',
      'backed-up-1',
      'published-1',
    ]) {
      final failing = PersonaStore(
        home: store.home,
        transactionHook: (point) async {
          if (point == step) throw StateError('injected $step');
        },
      );
      final result = await failing.install(
        archivePath: replacement,
        builtInSlugs: {},
      );
      expect(result.ok, isFalse, reason: step);
      expect(
        File('${store.root}/hero/SKILL.md').readAsStringSync(),
        'old skill',
      );
      expect(
        File('${store.kernelRoot}/hero.skill.zip').readAsBytesSync(),
        oldZip,
      );
      expect(File('${residue.path}/user-data').readAsStringSync(), 'keep');
      expect(
        Directory(store.root)
            .listSync()
            .where((e) => e.path.contains('.persona-')),
        isEmpty,
      );
      expect(Directory(store.kernelRoot).listSync(), hasLength(1));
    }
    expect((await install(replacement)).ok, isTrue);
    expect(File('${store.root}/hero/SKILL.md').readAsStringSync(), 'new skill');
    expect(File('${residue.path}/user-data').readAsStringSync(), 'keep');
  });

  test('删除第二份包失败也恢复全部旧数据', () async {
    await install(await archive());
    final failing = PersonaStore(
      home: store.home,
      transactionHook: (point) async {
        if (point == 'backed-up-1') throw StateError('remove interrupted');
      },
    );
    expect((await failing.remove('hero', builtIn: false)).ok, isFalse);
    expect(store.readInstalled('hero'), isNotNull);
    expect(File('${store.kernelRoot}/hero.skill.zip').existsSync(), isTrue);
  });

  test('旧版本目录选用前同步，不迁移或删除旧数据', () async {
    final dir = Directory('${store.root}/Hero')..createSync(recursive: true);
    File('${dir.path}/meta.json')
        .writeAsStringSync('{"slug":"Hero","name":"Hero"}');
    File('${dir.path}/SKILL.md').writeAsStringSync('legacy content');
    final client = PersonaClient(
      store: store,
      bundle: _Bundle(),
      configWriter: (_, _, _) => true,
    );
    addTearDown(client.dispose);
    await client.load();
    final selected = await client.switchTo('hero');
    expect(selected.ok, isTrue, reason: selected.message);
    expect(selected.pendingRestart, isTrue);
    expect(client.pendingRestart, isTrue);
    expect(dir.existsSync(), isTrue);
    expect(File('${store.kernelRoot}/Hero.skill.zip').existsSync(), isTrue);
  });

  test('选择调用真实 config writer，只改目标字段；重载/重启状态诚实', () async {
    await install(await archive(slug: 'Hero'));
    final patch = File(debugProfileConfigFileOverride!)
      ..writeAsStringSync('''
- insert:
    - id: ondra-persona-loader
      name: '@ondra/cordis-plugin-ondra-persona-loader'
      config:
        enable: true
        active-persona: built-in
    - id: ondra-privacy
      name: '@ondra/cordis-plugin-ondra-privacy'
      config:
        approval-mode: supervised
''');
    final client = PersonaClient(
      store: store,
      bundle: _Bundle(),
      configWriter: writeProfileConfigField,
      configReader: readProfileConfigField,
    );
    addTearDown(client.dispose);
    await client.load();
    expect(client.active.id, 'built-in');
    final selected = await client.switchTo('hero');
    expect(selected.ok, isTrue, reason: selected.message);
    expect(selected.pendingRestart, isTrue);
    expect(readProfileConfigField('persona-loader', 'active-persona'), 'hero');
    expect(patch.readAsStringSync(), contains('approval-mode: supervised'));
    expect(patch.readAsStringSync(), contains('enable: true'));
    expect(File('${temp.path}/.ondra/prefs.json').existsSync(), isFalse);
    await client.reload();
    expect(client.pendingRestart, isTrue);
    final restarted = PersonaClient(
      store: store,
      bundle: _Bundle(),
      configReader: readProfileConfigField,
    );
    addTearDown(restarted.dispose);
    await restarted.load();
    expect(restarted.active.id, 'hero');
    expect(restarted.pendingRestart, isFalse);
  });

  test('保存 false/异常保持当前选择，返回错误而非成功或重启标志', () async {
    await install(await archive());
    for (final throws in [false, true]) {
      final client = PersonaClient(
        home: store.home,
        bundle: _Bundle(),
        configWriter: (_, _, _) {
          if (throws) throw StateError('disk full');
          return false;
        },
      );
      await client.load();
      final result = await client.switchTo('hero');
      expect(result.ok, isFalse);
      expect(result.error, contains('未保存'));
      expect(result.pendingRestart, isFalse);
      expect(client.selectionError, isNotNull);
      expect(client.pendingRestart, isFalse);
      expect(client.active.id, 'built-in');
      client.dispose();
    }
  });

  test('注入 home 时不默认访问真实配置；默认同角色仍需真实保存', () async {
    final client = PersonaClient(home: store.home, bundle: _Bundle());
    addTearDown(client.dispose);
    await client.load();
    final result = await client.switchTo('built-in');
    expect(result.ok, isFalse);
    expect(File(debugProfileConfigFileOverride!).existsSync(), isFalse);
    expect(File('${temp.path}/.ondra/prefs.json').existsSync(), isFalse);
  });

  test('内置资产缺失/空 SKILL 不再静默接受', () async {
    for (final skill in [null, ' \n']) {
      final client = PersonaClient(
        home: store.home,
        bundle: _Bundle(skill: skill),
      );
      await client.load();
      expect(client.error, isNotNull);
      expect(client.packs, isEmpty);
      client.dispose();
    }
  });

  test('client 导入按内核 ID 选择，导出/删除按原 slug 执行', () async {
    final written = <Object?>[];
    final client = PersonaClient(
      home: store.home,
      bundle: _Bundle(),
      configWriter: (section, key, value) {
        expect(section, 'persona-loader');
        expect(key, 'active-persona');
        written.add(value);
        return true;
      },
    );
    addTearDown(client.dispose);
    final imported = await client.importPack(
      archivePath: await archive(
        slug: 'My.Role',
        meta: {'slug': 'My.Role', 'name': 'Hero-ID'},
      ),
    );
    expect(imported.ok, isTrue, reason: imported.message);
    expect(client.active.id, 'hero-id');
    expect(client.active.slug, 'My.Role');
    expect(written.last, 'hero-id');
    expect(
      (await client.exportPack(
        'hero-id',
        targetZip: '${temp.path}/out.zip',
      )).ok,
      isTrue,
    );
    expect((await client.remove('hero-id')).ok, isTrue);
    expect(written.last, 'built-in');
    expect(client.active.id, 'built-in');
    expect(Directory('${store.root}/My.Role').existsSync(), isFalse);
    expect(File('${store.kernelRoot}/My.Role.skill.zip').existsSync(), isFalse);
  });

  test('导入选择保存失败如实报告，但已验证的包保留；删除当前包先保存默认', () async {
    final client = PersonaClient(
      home: store.home,
      bundle: _Bundle(),
      configWriter: (_, _, _) => false,
    );
    addTearDown(client.dispose);
    final imported = await client.importPack(archivePath: await archive());
    expect(imported.ok, isFalse);
    expect(imported.message, contains('未保存'));
    expect(store.readInstalled('hero'), isNotNull);
    final selected = PersonaClient(
      home: store.home,
      bundle: _Bundle(),
      configReader: (_, key) => key == 'active-persona' ? 'hero' : null,
      configWriter: (_, _, _) => false,
    );
    addTearDown(selected.dispose);
    await selected.load();
    expect((await selected.remove('hero')).ok, isFalse);
    expect(store.readInstalled('hero'), isNotNull);
    expect(selected.active.id, 'hero');
  });

  test('仅靠文件名推导的 ID 导出改名后也保持，旧 metadata 不被改写', () async {
    final installed = await install(
      await archive(meta: {'name': '中文名'}, filename: 'My.Role.skill.zip'),
    );
    expect(installed.ok, isTrue, reason: installed.message);
    final before = File('${store.root}/My.Role/meta.json').readAsStringSync();
    final renamed = '${temp.path}/different-name.zip';
    expect((await store.export('My.Role', targetZip: renamed)).ok, isTrue);
    final second = PersonaStore(home: '${temp.path}/second');
    final result = await second.install(archivePath: renamed, builtInSlugs: {});
    expect(result.ok, isTrue, reason: result.message);
    expect(result.id, 'my-role');
    expect(File('${store.root}/My.Role/meta.json').readAsStringSync(), before);
  });

  test('client 遵循自定义 userSubdir，兼容 camelCase 配置且不修改路径设置', () async {
    final client = PersonaClient(
      home: store.home,
      bundle: _Bundle(),
      configReader: (_, key) => key == 'userSubdir' ? 'custom-personas' : null,
      configWriter: (_, key, value) {
        expect(key, 'active-persona');
        return true;
      },
    );
    addTearDown(client.dispose);
    final result = await client.importPack(archivePath: await archive());
    expect(result.ok, isTrue, reason: result.message);
    expect(
      File('${store.home}/user/custom-personas/hero.skill.zip').existsSync(),
      isTrue,
    );
    expect(File('${store.kernelRoot}/hero.skill.zip').existsSync(), isFalse);
  });

  test('并发初次 load/import 仍等待内置清单，不能绕过内置保护', () async {
    final path = await archive(slug: 'built-in');
    final client = PersonaClient(
      home: store.home,
      bundle: _Bundle(),
      configWriter: (_, _, _) => true,
    );
    addTearDown(client.dispose);
    final loading = client.load();
    final result = await client.importPack(archivePath: path);
    await loading;
    expect(result.ok, isFalse);
    expect(result.message, contains('内置包'));
    expect(store.installedSlugs(), isEmpty);
  });

  test('内核 root 中另一个文件的同 ID 不会静默遮蔽新包', () async {
    await install(await archive(skill: 'old skill'));
    final old = File('${store.kernelRoot}/hero.skill.zip');
    final residue = old.copySync('${store.kernelRoot}/aaa.skill.zip');
    final before = residue.readAsBytesSync();
    final result = await install(await archive(skill: 'new skill'));
    expect(result.ok, isFalse);
    expect(result.message, contains('aaa.skill.zip'));
    expect(File('${store.root}/hero/SKILL.md').readAsStringSync(), 'old skill');
    expect(residue.readAsBytesSync(), before);
    expect(old.readAsBytesSync(), before);
  });

  test('内核 ID 推导与 meta.js 规则一致，历史点号 slug 保留', () {
    expect(
      resolvePersonaId({'slug': 'My.Hero', 'name': 'Hero-ID'}, 'My.Hero'),
      'hero-id',
    );
    expect(resolvePersonaId({'slug': 'Hero'}, 'anything'), 'hero');
    expect(resolvePersonaId({'name': '中文'}, 'My.Hero'), 'my-hero');
    expect(resolvePersonaId({'name': '中文'}, '123'), isNull);
  });
}
