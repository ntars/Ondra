import 'package:material_ui/material_ui.dart';

/// 记忆点的类别。四档**黑度**，不是四种颜色：单色界面里靠明度分层次，
/// 再淡就要和连线抢注意力，再深四档就分不开了。
enum MemoryKind { fact, preference, event, self }

extension MemoryKindSpec on MemoryKind {
  String get label => switch (this) {
    MemoryKind.fact => '事实',
    MemoryKind.preference => '偏好',
    MemoryKind.event => '事件',
    MemoryKind.self => '自我',
  };

  Color get color => switch (this) {
    MemoryKind.fact => const Color(0xFF1C1F28),
    MemoryKind.preference => const Color(0xFF6E7379),
    MemoryKind.event => const Color(0xFFA6ABB1),
    MemoryKind.self => const Color(0xFF3D4249),
  };
}

/// 一个记忆点：坐标是归一化的（0–1），画布怎么变都按比例铺。
///
/// [strength] 是这条记忆的强度，决定节点大小、连线深浅与连线上脉冲的亮度。
/// [links] 存的是「和哪几个记忆点连着」，是同一份列表里的下标。
///
/// 形状来自 `ondra-memory` 插件（`MemoryPoint { id, text, kind, createdAt,
/// lastUsedAt, hits, links }`）；这里只保留画图需要的那些字段，
/// 免得界面替插件改数据结构。
class MemoryPoint {
  const MemoryPoint({
    required this.label,
    required this.kind,
    required this.x,
    required this.y,
    required this.strength,
    this.links = const [],
    this.recalledAt = '—',
  });

  final String label;
  final MemoryKind kind;
  final double x;
  final double y;
  final double strength;
  final List<int> links;
  final String recalledAt;
}
