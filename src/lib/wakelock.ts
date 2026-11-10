/**
 * 生成中保持屏幕常亮（§10.7.3 第三条硬要求）。
 *
 * ## 为什么手机端必需
 *
 * 一次长回答可能 40 秒。手机默认 30 秒熄屏，用户看到一半屏幕黑了，
 * 会以为应用卡死。桌面上没有这个问题（桌面的熄屏由系统空闲判定，
 * 与网页无关），所以这条只在支持 `wakeLock` 的环境里起作用。
 *
 * ## 为什么在这里而不是在 Timeline 里
 *
 * 「谁在生成」这个事实在 `useAppState`（`busy`），而申请/释放锁是
 * 一次性的副作用。放在 `App` 里一个 effect 就够；放组件里会出现
 * 「消息流卸载但生成还在继续」时锁被提前释放。
 *
 * ## 三个必须处理的状态
 *
 * | 情况 | 处理 |
 * | --- | --- |
 * | 浏览器不支持 | 静默跳过，不提示（用户无法为此做什么） |
 * | 申请被拒（电量低、省电模式） | 静默跳过，下次生成再试 |
 * | 切到后台被系统自动释放 | 回到前台且仍在生成时重新申请 |
 *
 * 第三种最容易被漏：`WakeLockSentinel` 在页面隐藏时会自动释放，
 * 不重新申请的话，用户切回来看到一半就熄屏了。
 */

/** 最小的 WakeLock 形状。不引 `lib.dom` 的新版类型，避免 tsconfig 追版本。 */
interface Sentinel {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', handler: () => void): void
}

/** 浏览器暴露的接口。不存在时整个模块降级为空操作。 */
interface WakeLockApi {
  request(type: 'screen'): Promise<Sentinel>
}

/** 取接口。Safari 16.4+ 与 Chrome 84+ 有，其余返回 undefined。 */
function api(): WakeLockApi | undefined {
  return (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock
}

/** 当前持有的哨兵。 */
let sentinel: Sentinel | undefined

/** 请求过常亮但还没成功——避免并发重复申请。 */
let pending = false

/**
 * 申请常亮。
 *
 * 重复调用是安全的：已持有时直接返回。
 */
async function acquire(): Promise<void> {
  const lock = api()
  if (lock === undefined || sentinel !== undefined || pending) return
  pending = true
  try {
    const next = await lock.request('screen')
    sentinel = next
    /*
     * 系统可能在页面隐藏、电量过低时主动释放。监听它把本地状态清掉，
     * 否则这里会一直认为「已经持有了」，下次生成不再申请。
     */
    next.addEventListener('release', () => {
      if (sentinel === next) sentinel = undefined
    })
  } catch {
    /* 被拒（低电量、省电模式、权限策略）。静默：用户无法为此做什么。 */
  } finally {
    pending = false
  }
}

/** 释放常亮。生成结束或组件卸载时调用。 */
async function release(): Promise<void> {
  const current = sentinel
  sentinel = undefined
  if (current === undefined) return
  try {
    await current.release()
  } catch {
    /* 已经失效。目标状态（不持有）已经达成。 */
  }
}

/**
 * 跟随 `active` 申请与释放。
 *
 * @param active 是否正在生成。
 * @returns 清理函数。
 */
export function keepAwake(active: boolean): () => void {
  if (!active) {
    void release()
    return () => {}
  }
  void acquire()

  /*
   * 回到前台时补一次。`visibilitychange` 是唯一可靠的判据——
   * `wakeLock` 的自动释放在页面隐藏时就发生了，而我们那时
   * 不该抢着重新申请（会立刻被再释放一次）。
   */
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void acquire()
  }
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    void release()
  }
}
