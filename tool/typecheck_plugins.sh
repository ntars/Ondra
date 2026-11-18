#!/usr/bin/env bash
# 插件源码的类型自检。
#
# 它检查的是**我们自己代码的自洽性**（导入、参数、空值），不检查上游 cordis 的
# API 签名——那需要 dsh-base 工作区 `pnpm install` 后才有真实类型。
# 之所以还要跑：stub 里少一个方法名，编译期就能发现，不必等到运行时加载失败。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/cordis.d.ts" <<'TS'
// 最小声明：只覆盖插件用到的 cordis 表面。
declare module '@deepseek-ai/cordis' {
  export interface Context {
    effect(fn: () => (() => void) | void, label?: string): void
  }
  export class Service {
    protected readonly ctx: Context
    constructor(ctx: Context, key: string)
  }
}
TS

cat > "$WORK/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["cordis.d.ts", "$ROOT/lib/plugins/ondra-core/**/src/**/*.ts"]
}
JSON

cd "$WORK"
npm install --silent --no-audit --no-fund typescript@5.6 @types/node >/dev/null 2>&1
./node_modules/.bin/tsc -p tsconfig.json
echo "插件类型自检通过"
