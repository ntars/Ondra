/// 浏览器里没有子进程，也就没有 profile 要铺。
library;

enum RuntimeSeedOutcome { noBundledRuntime, alreadyPresent, seeded, failed }

class RuntimeSeedResult {
  const RuntimeSeedResult(this.outcome, {this.targetPath, this.error});

  final RuntimeSeedOutcome outcome;
  final String? targetPath;
  final String? error;

  @override
  String toString() => 'RuntimeSeedResult(${outcome.name})';
}

const String ondraRuntimeProfileName = 'ondra';

RuntimeSeedResult seedRuntimeProfile({String? dshHome}) =>
    const RuntimeSeedResult(RuntimeSeedOutcome.noBundledRuntime);
