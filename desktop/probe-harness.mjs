/** 扫描 locale 文件里「裸 Harness」（前面不是 DeepSeek）的出现。 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const ROOT = import.meta.dirname
const SKIP = new Set(['node_modules', '.git', '.desktop-build', '.tmp', 'dist', 'lib', 'tests', 'coverage'])

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue
    const full = join(dir, n)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (['.ts', '.tsx'].includes(extname(n)) && /locale/i.test(n)) out.push(full)
  }
  return out
}

let total = 0
for (const f of walk(ROOT)) {
  const text = readFileSync(f, 'utf8')
  // 先把 "DeepSeek Harness" 整体抠掉，剩下的 Harness 就是裸用
  const stripped = text.replace(/DeepSeek\s+Harness/g, '')
  const hits = [...stripped.matchAll(/\bHarness\b/g)]
  if (hits.length === 0) continue
  total += hits.length
  const lines = stripped.split('\n')
  const samples = []
  lines.forEach((l, i) => { if (/\bHarness\b/.test(l)) samples.push(`    L${i + 1}: ${l.trim().slice(0, 110)}`) })
  console.log(`${relative(ROOT, f)} → ${hits.length} 处`)
  samples.slice(0, 3).forEach((s) => console.log(s))
}
console.log(`\n裸 Harness 合计：${total} 处`)
