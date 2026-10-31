/** 检查 locale.ts 中不属于产品名的 DeepSeek 出现，判断是否为模型供应商（不可改）。 */
import { readFileSync } from 'node:fs'

const files = [
  'apps/desktop/src/locale.ts',
  'packages/client/ui-plugin-manager/src/client/locales.ts',
  'packages/client/ui-settings-account/src/client/locales.ts',
  'packages/client/ui-settings-models/src/client/locales.ts',
  'packages/client/ui-sidebar-documentpreview/src/client/office/locales.ts',
]

for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const lines = text.split('\n')
  const out = []
  lines.forEach((line, i) => {
    if (!/DeepSeek/.test(line)) return
    if (/DeepSeek\s+Harness/.test(line)) {
      // 只报告「除了产品名还残留 DeepSeek」的行
      const stripped = line.replace(/DeepSeek\s+Harness/g, '')
      if (/DeepSeek/.test(stripped)) out.push(`  L${i + 1}: ${line.trim().slice(0, 130)}`)
    } else {
      out.push(`  L${i + 1}: ${line.trim().slice(0, 130)}`)
    }
  })
  console.log(`\n=== ${f} （非产品名 DeepSeek 共 ${out.length} 行）===`)
  out.slice(0, 12).forEach((l) => console.log(l))
}
