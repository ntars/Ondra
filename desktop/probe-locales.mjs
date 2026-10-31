/** 找出所有 UI 文案文件并统计品牌字样，判定 dsh 是否只出现在字符串内。 */
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

/** 判断 dsh 是否落在字符串内部（粗略但够用：统计引号内出现数 vs 总出现数） */
function analyze(text) {
  const total = (text.match(/\bdsh\b/g) || []).length
  let inside = 0
  const literals = text.match(/'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|`[^`\\$]*(?:\\.[^`\\]*)*`/g) || []
  for (const lit of literals) inside += (lit.match(/\bdsh\b/g) || []).length
  return { total, inside }
}

const files = walk(ROOT)
const rows = []
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const prod = (text.match(/DeepSeek\s+Harness/g) || []).length
  const upper = (text.match(/\bDSH\b/g) || []).length
  const { total, inside } = analyze(text)
  if (prod + upper + total === 0) continue
  rows.push({ p: relative(ROOT, f), prod, upper, total, inside })
}
rows.sort((a, b) => b.prod + b.upper - (a.prod + a.upper))

console.log('文案文件'.padEnd(70), '产品名', 'DSH', 'dsh总', 'dsh在字符串内')
console.log('-'.repeat(104))
for (const r of rows) {
  console.log(r.p.padEnd(70), String(r.prod).padStart(5), String(r.upper).padStart(4), String(r.total).padStart(5), String(r.inside).padStart(11))
}
console.log('-'.repeat(104))
const t = rows.reduce((s, r) => ({ prod: s.prod + r.prod, upper: s.upper + r.upper, total: s.total + r.total, inside: s.inside + r.inside }), { prod: 0, upper: 0, total: 0, inside: 0 })
console.log(`合计：${rows.length} 个文件 / 产品名 ${t.prod} / DSH ${t.upper} / dsh ${t.total}（其中字符串内 ${t.inside}）`)
