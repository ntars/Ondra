import 'package:flutter/foundation.dart';

class DataMaintenance extends ChangeNotifier {
  Future<void> Function()? pause;
  Future<void> Function()? resume;
  Future<void> Function()? reload;
  bool _locked = false;
  bool _offline = false;

  bool get locked => _locked;
  bool get offline => _offline;

  Future<T> run<T>(Future<T> Function() action, {bool refresh = false}) async {
    if (_locked) throw StateError('另一项数据维护正在进行，请稍后再试。');
    final stop = pause;
    final restart = resume;
    if (stop == null || restart == null) {
      throw StateError('当前环境未接入内核停机协调，未操作用户数据。');
    }
    _locked = true;
    notifyListeners();
    var stopped = false;
    try {
      await stop();
      stopped = true;
      _offline = true;
      try {
        return await action();
      } finally {
        if (refresh) await reload?.call();
      }
    } finally {
      _offline = false;
      try {
        if (stopped) await restart();
      } finally {
        _locked = false;
        notifyListeners();
      }
    }
  }
}

final dataMaintenance = DataMaintenance();
