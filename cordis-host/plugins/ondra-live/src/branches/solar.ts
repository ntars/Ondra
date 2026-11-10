/**
 * 分支 C：**只有公历**（`solar-only`）。
 *
 * 这是默认底座（§14.2「默认最稳」）：不依赖任何外部包、不会因为升级而错效、
 * 也不存在「装不上」的失败形态。它的农历方法是「我没有」——返回 `null` 与空串，
 * 而不是编一个值。
 *
 * 把它单列一个文件（而不是在 `service.ts` 里 `if (provider === 'solar-only')`）是
 * §14.2 的「文件隔离」：三个分支各自一个文件、各自实现同一个接口，
 * 分支之间不共享缓存、不共享定时器、不共享可变状态。
 */

import type { CalendarProvider, LunarSnapshot } from '../types.js'

/** 造一条「只有公历」的分支。 */
export function createSolarBranch(): CalendarProvider {
  return {
    name: 'solar-only',
    lunarOf(_dayKey: string): LunarSnapshot | null {
      return null
    },
    jieQiOf(_dayKey: string): string {
      return ''
    },
  }
}
