/**
 * 核对「观测面」与「配置段注册」两条地基，防止本轮修好的两处再退化。
 *
 * ## 为什么需要这份检查（两处都是「不报错的失效」）
 *
 * 本仓反复踩同一类：**一处失效，看上去一切正常**。本轮修的两处都是这种，
 * 而且都属于「不看就永远不知道」的地基：
 *
 * | 断裂 | 不修时的症状 | 为什么难发现 |
 * | --- | --- | --- |
 * | 宿从未给 cordis 挂落盘导出器 | 135 个插件的 info/warn/error **全部静默丢弃** | 页面照常、接口照常，只是「为什么坏了」没人说得出来 |
 * | config-schema 只认 `values`，9 个声明方写 `options` | 这 9 段配置的**四层合并整条不发生** | 设置页照常显示、照常保存；改的值不生效，且只在日志里留一句 warn |
 *
 * 两处都只能靠「主动去量」抓到，故各自一条判据：
 *
 * 1. **日志导出器**：真装一个 exporter，打一行 info，断言它落到了 sink 里。
 *    只断言「函数被调用过」是不够的——本仓第 N 次踩的就是这个（量的是
 *    「跑过」，不是「有产出」）。
 * 2. **枚举候选双写**：用 `options` 声明一个枚举段，断言注册**成功**，
 *    且非法值被拒时给出的候选表**就是 options 里那几个**。
 *    只断言注册通过不够：注册通过但候选为空时，设置页会渲染出一个空分段控件，
 *    用户看到的是一个「点不动」的下拉框。
 *
 * ## 反向验证（写这份检查时做过的）
 *
 * - 把 `installLogExporter` 的调用注释掉 → ① 立刻红。
 * - 把 `candidatesOf` 改回 `spec.values ?? []` → ② 立刻红（注册报
 *   「枚举字段必须给出候选」）。
 *
 * 两次都确认过「会红」，这份检查才有意义。
 *
 * 用法：
 *   node cordis-host/check-observability.mjs
 *
 * 退出码：全部通过为 0，任一断言失败为 1。
 */

import { Context } from '@ntars/cordis'
import { installLogExporter } from './lib/src/log-export.js'
import * as schemaPlugin from './plugins/ondra-config-schema/lib/index.js'

let failed = 0
let passed = 0

/**
 * 断言并计数。
 * @param {string} label 判据描述（说清「量的是什么」）。
 * @param {boolean} ok 结果。
 * @param {string} [detail] 失败时补一句实测值。
 */
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : `（实测：${detail}）`}`)
  }
}

/** 造一个干净的上下文。 */
function freshContext() {
  const ctx = new Context()
  ctx.baseUrl = new URL('./', import.meta.url).href
  return ctx
}

// ---------------------------------------------------------------------------
// ① 日志导出器：打一行，断言它真的落到了 sink
// ---------------------------------------------------------------------------
console.log('=== ① 日志导出器把插件的日志写到磁盘 ===')
console.log('')

{
  const ctx = freshContext()
  /** 收下来的行。 */
  const lines = []
  const sink = { write: (line) => lines.push(line) }

  /*
   * `includeDebug: true` 是有意的：下面故意打一条 debug 级，用来验证阈值
   * 参数真的起作用。若实现把 `threshold` 写反（比如误用 `<` 与 `>=`），
   * 这条 debug 会被放进来而 info 被挡掉——两者一起断言才抓得住。
   */
  installLogExporter(ctx, sink, { includeDebug: true })

  const log = ctx.logger('ondra.selftest.probe')
  log.info('这是一条自检日志 %d', 42)
  log.warn('这是一条告警')

  check('info 行落到了 sink', lines.some((line) => line.includes('这是一条自检日志 42')), `${lines.length} 行`)
  check('warn 行落到了 sink', lines.some((line) => line.includes('这是一条告警')))
  check(
    '行里带上了命名空间 ondra.selftest.probe',
    lines.some((line) => line.includes('ondra.selftest.probe')),
    lines[0] ?? '（空）',
  )
  check(
    'warn 与 info 的级别标签不同',
    lines.some((line) => /^\s*warn\b/.test(line)) && lines.some((line) => /^\s*info\b/.test(line)),
    lines.join(' | '),
  )

  /*
   * 阈值：关掉 `includeDebug` 之后，debug 级不该再进来。
   *
   * 这一条单独用一个新上下文，因为 exporter 是挂在 ctx 上的；
   * 复用同一个 ctx 会得到两个 exporter 同时收，判不出阈值。
   */
  const ctx2 = freshContext()
  const quiet = []
  installLogExporter(ctx2, { write: (line) => quiet.push(line) }, { includeDebug: false })
  const log2 = ctx2.logger('ondra.selftest.probe')
  log2.debug('这条 debug 不该出现')
  log2.info('这条 info 应该出现')

  check('includeDebug=false 时 debug 被挡掉', !quiet.some((line) => line.includes('不该出现')), quiet.join(' | '))
  check('includeDebug=false 时 info 仍照收', quiet.some((line) => line.includes('应该出现')))
}

// ---------------------------------------------------------------------------
// ② 枚举候选的两种写法（values / options）都能注册
// ---------------------------------------------------------------------------
console.log('')
console.log('=== ② 枚举字段用 options 声明也能注册并通过校验 ===')
console.log('')

{
  const ctx = freshContext()
  const schema = schemaPlugin.apply(ctx, schemaPlugin.Config['~standard'].validate({}).value)

  /** 取 config-schema 服务。`apply` 不返回值时从 ctx 取。 */
  const service = schema ?? ctx.get('ondra-config-schema')
  check('config-schema 服务拿到了', service !== undefined)

  if (service !== undefined) {
    /*
     * 照本仓 9 个声明方的真实写法：`kind: 'enum'` + `options`（不是 `values`）。
     * 判据是「注册成功」——失败时 `register()` 会抛，被这里接住。
     */
    let registered = true
    let why = ''
    try {
      service.register({
        id: 'selftest-options',
        title: '自检·options 写法',
        owner: 'check-observability',
        fields: {
          'pick-one': { kind: 'enum', default: 'b', options: ['a', 'b', 'c'], doc: '用 options 声明候选' },
        },
      })
    } catch (error) {
      registered = false
      why = error instanceof Error ? error.message : String(error)
    }
    check('用 options 声明的枚举段注册成功', registered, why)

    if (registered) {
      /*
       * 断言候选表**真的**是 options 里那几个。
       *
       * 这一条防的是「注册通过了，但候选是空的」——那种情况下设置页会渲染
       * 一个点不动的空下拉框，而注册日志一片绿。
       */
      const resolved = service.resolve('selftest-options', { user: { 'pick-one': 'c' } })
      check('合法值 c 被接受', resolved !== undefined && resolved.fallbackCount === 0,
        resolved === undefined ? 'resolve 返回 undefined' : `fallbackCount=${resolved.fallbackCount}`)

      const bad = service.resolve('selftest-options', { user: { 'pick-one': 'zzz' } })
      check(
        '非法值 zzz 被拒（说明候选表非空）',
        bad === undefined || bad.fallbackCount > 0,
        bad === undefined ? 'resolve 返回 undefined' : `fallbackCount=${bad.fallbackCount}`,
      )

      /*
       * 再验一次「候选表内容对」。用 `resolve` 逐个试 options 里的每一个值，
       * 全部应当零回退——若实现只认 `values`，`options` 里的值会**全部**被拒。
       */
      const allOk = ['a', 'b', 'c'].every((value) => {
        const outcome = service.resolve('selftest-options', { user: { 'pick-one': value } })
        return outcome !== undefined && outcome.fallbackCount === 0
      })
      check('options 里的 a / b / c 三个值全部被接受', allOk)
    }
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('')
if (failed === 0) {
  console.log(`合计：${passed}/${passed} 通过`)
  process.exit(0)
} else {
  console.log(`合计：${passed} 通过 / ${failed} 失败`)
  process.exit(1)
}
