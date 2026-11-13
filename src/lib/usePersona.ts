/**
 * 人设与在场状态。
 *
 * ## 为什么这两件事在同一个文件
 *
 * 它们回答的是同一个问题：**标题栏那一行该写什么**。人设给出名字与脸，
 * 在场状态给出「在线 / 在想 / 离线」。两者都要在启动时读一次宿主，
 * 分到两个文件里就会出现两次各自的重试与各自的错误态，而标题栏只有
 * 一个位置显示它们。
 *
 * ## 为什么人设是一份模块级单例，不是每个组件一份 state
 *
 * 人设有两个消费方：标题栏的切换浮层，与设置·人物设定页的列表。两处
 * 各持一份 `useState` 时，在设置里换完人设，标题栏还是旧名字——直到
 * 刷新页面。这正是「设置没生效」的经典形态，而它唯一的修法是让两份
 * 状态变成一份。
 *
 * 做法与 `preferences.ts` 同构：模块级变量 + `useSyncExternalStore`。
 * 不引状态库：这一个值的订阅者只有两个。
 *
 * ## 为什么状态必须由真实链路推导
 *
 * 上一版只有两档：正在生成 → 「在想」，其余一律「在线」。那个「在线」
 * 从来没有检查过任何东西——宿主没起来、没配模型、机器断网，它都写「在线」。
 * 用户看到的是一个永远在线的绿点，而这个绿点唯一的作用是让人**不再怀疑
 * 哪里出了问题**。
 *
 * 现在的判据是三条同时成立才叫在线：
 *
 * | 判据 | 读法 | 不成立时 |
 * | --- | --- | --- |
 * | `navigator.onLine` | 系统说有网卡连着 | 离线 |
 * | `GET /api/health` | 宿主进程活着 | 离线 |
 * | `GET /api/models` 非空 | 至少接了一个模型 | 离线 |
 *
 * 第三条是「接入大模型」这句话的字面实现：没配 key 的机器能连上宿主，
 * 但它一句话也说不出来，写「在线」就是骗人。
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  activatePersona,
  fetchHealth,
  listModels,
  listPersonas,
  type PersonaSummary,
} from './api.ts'
import type { Presence } from './persona.ts'

/** 人设清单的模块级快照。 */
interface Snapshot {
  personas: PersonaSummary[]
  activeId: string | null
  available: boolean
  reason: string | null
  fault: string | undefined
  switching: string | undefined
}

/** 初始快照：全空，但 `available: false` 明确表示「还没读到」。 */
let store: Snapshot = {
  personas: [],
  activeId: null,
  available: false,
  reason: null,
  fault: undefined,
  switching: undefined,
}

const listeners = new Set<() => void>()

/** 写一次快照并通知订阅者。 */
function patch(next: Partial<Snapshot>): void {
  store = { ...store, ...next }
  for (const listener of listeners) listener()
}

/**
 * 是否已经发起过加载。
 *
 * 用模块级布尔而不是每个组件自己的 `useRef`：两个组件同时挂载时，
 * 它们会各自发一次 `GET /api/personas`，而结果是同一份。
 */
let started = false

/** 已经重试了几次。宿主冷启动时第一次请求可能刚好撞上「还没监听」。 */
let attempts = 0

/** 最多重试 5 次，间隔 3 秒——足够覆盖冷启动，又不会在真失败时空转。 */
const MAX_ATTEMPTS = 5

/**
 * 读一次人设清单。失败且还没到上限时自己排一次重试。
 *
 * ## 为什么要重试
 *
 * 页面脚本可能在宿主注册好路由之前就执行完。那条请求会拿到连接错误，
 * 而人设清单**没有第二个触发点**——用户不切页、不重开面板，它就一直是
 * 空的。三次重试的代价是零，收益是「第一次启动就能看到人设」。
 */
function load(): void {
  void listPersonas().then(
    (list) => {
      attempts = 0
      patch({
        personas: list.items,
        activeId: list.activeId,
        available: list.available,
        reason: list.reason,
        fault: undefined,
      })
    },
    (caught: unknown) => {
      attempts += 1
      patch({ fault: caught instanceof Error ? caught.message : '读不到人设清单' })
      if (attempts <= MAX_ATTEMPTS) {
        globalThis.setTimeout(() => { load() }, 3_000)
      }
    },
  )
}

/** 确保清单已被读过（幂等）。 */
function ensureLoaded(): void {
  if (started) return
  started = true
  load()
}

/** 订阅（`useSyncExternalStore` 的要求：引用必须稳定）。 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 读快照。 */
function getSnapshot(): Snapshot {
  return store
}

/**
 * 切人设。
 *
 * 返回一句可显示的话：成功时是「已切换到…」，`persisted: false` 时
 * 补一句「重启后会退回」。失败时是宿主给的原因，或一句兜底。
 */
async function switchTo(id: string): Promise<{ ok: boolean; message?: string }> {
  if (store.switching !== undefined) return { ok: false }
  patch({ switching: id })
  try {
    const result = await activatePersona(id)
    patch({ activeId: result.activeId })
    return result.persisted
      ? { ok: true }
      : { ok: true, message: '已切换，但没写进配置文件：重启后会退回原来那位' }
  } catch (caught) {
    return { ok: false, message: caught instanceof Error ? caught.message : '切换失败' }
  } finally {
    patch({ switching: undefined })
  }
}

/** 人设清单与切换。 */
export interface PersonaState extends Snapshot {
  /** 当前人设。用于标题栏的名字；undefined 时上层回落到「空谷」。 */
  active: PersonaSummary | undefined
  /** 切换人设。返回是否成功与一句可显示的原因。 */
  switchTo(id: string): Promise<{ ok: boolean; message?: string }>
}

/**
 * 读人设清单并暴露切换能力。
 *
 * 两个消费方（标题栏、人物设定页）都调它，拿到的是**同一份快照**。
 */
export function usePersona(): PersonaState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => { ensureLoaded() }, [])
  return {
    ...snapshot,
    active: snapshot.personas.find((item) => item.id === snapshot.activeId),
    switchTo,
  }
}

/** 链路状态。三个布尔量分开存，是为了让「哪一段断了」可读。 */
interface Link {
  network: boolean
  host: boolean
  model: boolean
}

/** 轮询间隔。20 秒是「用户能接受的最长误报时间」。 */
const PRESENCE_INTERVAL_MS = 20_000

/**
 * 推导在场状态。
 *
 * @param busy 是否正在生成。true 且链路通时为「在想」。
 */
export function usePresence(busy: boolean): Presence {
  const [link, setLink] = useState<Link>({ network: true, host: false, model: false })

  useEffect(() => {
    let alive = true

    const probe = async (): Promise<void> => {
      const network = globalThis.navigator?.onLine !== false
      let host = false
      let model = false
      if (network) {
        try {
          host = (await fetchHealth()).ok
        } catch {
          host = false
        }
        if (host) {
          try {
            model = (await listModels()).length > 0
          } catch {
            model = false
          }
        }
      }
      if (alive) setLink({ network, host, model })
    }

    void probe()
    const timer = globalThis.setInterval(() => { void probe() }, PRESENCE_INTERVAL_MS)
    /*
     * 系统网络事件立即重测。
     *
     * 拔网线那一刻 `onLine` 就变了，但轮询可能还要等十几秒——而用户在
     * 断网后第一件做的事就是看屏幕。等一轮的状态是「明明断了还写着在线」。
     */
    const onChange = (): void => { void probe() }
    globalThis.addEventListener?.('online', onChange)
    globalThis.addEventListener?.('offline', onChange)

    return () => {
      alive = false
      globalThis.clearInterval(timer)
      globalThis.removeEventListener?.('online', onChange)
      globalThis.removeEventListener?.('offline', onChange)
    }
  }, [])

  const reachable = link.network && link.host && link.model
  if (busy && reachable) return 'thinking'
  return reachable ? 'online' : 'offline'
}

/**
 * 强制重读人设清单。
 *
 * 只有一个调用方：人物设定页的「重新扫描」。用户把新的 `.skill.zip`
 * 放进目录之后，得有个按钮让它被看见——否则只能重启应用。
 */
export function reloadPersonas(): void {
  started = true
  attempts = 0
  load()
}

/** 供设置页复用：一个「重新扫描」的按钮回调。 */
export function useReloadPersonas(): () => void {
  return useCallback(() => { reloadPersonas() }, [])
}
