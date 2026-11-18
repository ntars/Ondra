/// 版本号比较：纯逻辑，不碰平台。
///
/// 抽出来是因为 `UpdateChecker` 是条件导出（桌面走 HTTP、浏览器走空实现），
/// 但「哪个版本更新」与有没有网络无关。放在两个实现里各写一遍，
/// 迟早会出现「桌面端说已是最新、网页端说有新版」这种自相矛盾。
library;

/// 比较两个版本号，返回 >0 表示 [a] 更新。
///
/// 规则与语义版本一致，但**容错**：构建号（`+1`）不参与比较；
/// 缺段补 0（`2.0` 视作 `2.0.0`）；预发布标识按 `alpha < beta < rc < 正式`
/// 排序，同标识再比序号（`alpha2 < alpha10`）。
///
/// 容错的理由：版本号是人手写在 `pubspec.yaml` 与 git tag 里的，
/// 严格解析会让「tag 写了 v2.0 而 pubspec 是 2.0.0」这种常见情况直接报错，
/// 而这个函数只用来回答「要不要提示升级」，不值得为此让检查更新整个失败。
int versionCompare(String a, String b) {
  final pa = _parse(a);
  final pb = _parse(b);
  for (var i = 0; i < 3; i++) {
    final d = pa.numbers[i].compareTo(pb.numbers[i]);
    if (d != 0) return d;
  }
  // 正式版（无预发布标识）比任何预发布都新。
  if (pa.pre == null && pb.pre == null) return 0;
  if (pa.pre == null) return 1;
  if (pb.pre == null) return -1;
  final rank = _preRank(pa.pre!).compareTo(_preRank(pb.pre!));
  if (rank != 0) return rank;
  return (pa.preNum ?? 0).compareTo(pb.preNum ?? 0);
}

({List<int> numbers, String? pre, int? preNum}) _parse(String raw) {
  // 构建号不参与排序：`2.0.0-alpha+1` 与 `2.0.0-alpha+2` 是同一个版本。
  final noBuild = raw.split('+').first;
  final dash = noBuild.indexOf('-');
  final core = dash < 0 ? noBuild : noBuild.substring(0, dash);
  final pre = dash < 0 ? null : noBuild.substring(dash + 1);
  final parts = core.split('.');
  final numbers = <int>[
    for (var i = 0; i < 3; i++)
      i < parts.length ? (int.tryParse(parts[i]) ?? 0) : 0,
  ];
  final m = pre == null ? null : RegExp(r'(\d+)$').firstMatch(pre);
  return (numbers: numbers, pre: pre, preNum: m == null ? null : int.parse(m[1]!));
}

int _preRank(String pre) {
  final lower = pre.toLowerCase();
  if (lower.startsWith('alpha')) return 0;
  if (lower.startsWith('beta')) return 1;
  if (lower.startsWith('rc')) return 2;
  // 不认识的预发布标识排在正式版之前、已知标识之后。
  return 3;
}
