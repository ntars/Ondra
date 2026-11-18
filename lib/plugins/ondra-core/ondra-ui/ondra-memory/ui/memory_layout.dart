import 'dart:math' as math;

import 'memory_model.dart';
import 'memory_types.dart';

/// 节点上最多显示几个字。超出部分截断，全文留给详情条——
/// 星图上摆一句二十字的话，节点会被文字盖住，图就散了。
const int _labelMaxChars = 14;

/// 把一次读取结果排成星图坐标。
///
/// 三条约束，缺一条图就不好看或不可信：
///
/// 1. **确定性**。坐标只能由 `id` 和排序位置算出来，不能每帧 `Random()`。
///    否则重绘一次节点就跳一次，看着像在抽搐；而且详情条选中的那条会在
///    下一次重排后指向别的事实。
/// 2. **按面积均分**。半径用 `sqrt(t)` 而不是 `t`——`t` 会让节点挤在圆心，
///    外圈大片空白；按面积均分才让每个节点占地一样。
/// 3. **同类相邻**。角度按显著度排序后的顺序走黄金角，同一类别天然聚成
///    一段弧，扫一眼就能看出「最近记的都是关于人的事」。
List<MemoryPoint> layoutMemoryPoints(MemorySnapshot snapshot) {
  final facts = [...snapshot.facts]
    ..sort((a, b) => b.salience.compareTo(a.salience));

  final indexOf = <String, int>{
    for (var i = 0; i < facts.length; i++) facts[i].id: i,
  };

  // 关联是无向的：从 A 到 B 的线，B 的邻居里也该有 A。
  final neighbours = <int, List<int>>{};
  for (final link in snapshot.links) {
    final a = indexOf[link.from];
    final b = indexOf[link.to];
    if (a == null || b == null || a == b) continue;
    (neighbours[a] ??= <int>[]).add(b);
    (neighbours[b] ??= <int>[]).add(a);
  }

  final n = facts.length;
  return [
    for (var i = 0; i < n; i++)
      _pointAt(facts[i], i, n, neighbours[i] ?? const <int>[]),
  ];
}

MemoryPoint _pointAt(MemoryRecord fact, int index, int total, List<int> links) {
  // 第一个节点放正上方而不是右侧：圆心附近是视觉焦点，
  // 从 12 点开始铺，重心才在正中。
  const goldenAngle = 2.399963229728653;
  var angle = index * goldenAngle - math.pi / 2;
  angle += (_jitter(fact.id, 1) - 0.5) * 0.28;

  final t = total <= 1 ? 0.0 : index / (total - 1);
  var radius = 0.09 + 0.41 * math.sqrt(t);
  radius += (_jitter(fact.id, 2) - 0.5) * 0.05;
  // 上限 0.44：再往外平移到 0.5±0.44 会贴到框上，节点圆本身还有半径，
  // 视觉上就成「被裁掉一半」。
  radius = radius.clamp(0.05, 0.44);

  // 纵向压到 0.86：内容槽是横的，等比铺会让上下先撞边。
  final x = (0.5 + radius * math.cos(angle)).clamp(0.08, 0.92);
  final y = (0.5 + radius * math.sin(angle) * 0.86).clamp(0.09, 0.91);

  return MemoryPoint(
    label: _shorten(fact.text),
    kind: _kindOf(fact.category),
    x: x,
    y: y,
    // 强度参与节点大小与连线深浅，留一个下限：显著度 0 的记忆
    // 也得看得见，否则「她记得但想不起来」这件事在图上消失了。
    strength: (0.24 + 0.76 * (fact.salience / 100)).clamp(0.2, 1.0),
    links: links,
    recalledAt: _recalledAt(fact.lastHitAt ?? fact.createdAt),
  );
}

/// `category` → 四档黑度。库里的值是内核定的，不认识的归到「事实」，
/// 不往下猜——猜错类别比不分类更误导。
MemoryKind _kindOf(String category) => switch (category) {
  'preference' => MemoryKind.preference,
  'event' => MemoryKind.event,
  'self' => MemoryKind.self,
  _ => MemoryKind.fact,
};

/// 确定性伪随机：FNV-1a 再混一个盐。
///
/// 用哈希而不是 `Random(seed)`：同一个 id 在任何运行、任何设备上
/// 都落在同一个位置，导出截图与桌面看到的才是同一张图。
double _jitter(String id, int salt) {
  var hash = 0x811c9dc5;
  for (final unit in id.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0xFFFFFFFF;
  }
  hash ^= salt * 0x9E3779B9;
  hash = (hash * 0x01000193) & 0xFFFFFFFF;
  return (hash & 0xFFFF) / 0xFFFF;
}

String _shorten(String text) {
  final clean = text.replaceAll(RegExp(r'[。\s]+$'), '');
  if (clean.length <= _labelMaxChars) return clean;
  return '${clean.substring(0, _labelMaxChars)}…';
}

/// 相对时间。只到「天」为止：再精确对这条记忆没有意义。
String _recalledAt(DateTime? at) {
  if (at == null) return '未回想';
  final delta = DateTime.now().difference(at);
  if (delta.inMinutes < 1) return '刚刚';
  if (delta.inMinutes < 60) return '${delta.inMinutes} 分钟前';
  if (delta.inHours < 24) return '${delta.inHours} 小时前';
  if (delta.inDays < 30) return '${delta.inDays} 天前';
  if (delta.inDays < 365) return '${delta.inDays ~/ 30} 个月前';
  return '${delta.inDays ~/ 365} 年前';
}
