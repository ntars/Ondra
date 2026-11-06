/**
 * `endpoint` 意图：读出**宿主已经绑着**的号。
 *
 * ## 它为什么不是「另一个分支」
 *
 * 分支是在「同一个问题上选不同的解法」；这里根本不是同一个问题。`listener` 问
 * 「哪个号空着」，`endpoint` 问「界面在哪个号上」。前者要空，后者要占用。
 *
 * ## 判不了就说判不了
 *
 * 宿主 `webServer` 还没 `listen` 时，本包**不**去猜一个号、也**不**等待——
 * 猜出来的地址打不开，等待会把一次查询变成一次挂起。直接 `no-endpoint`。
 *
 * ## 地址不一致也算拿不到
 *
 * `webServer` 可能绑在 `::1`，请求却要 `127.0.0.1`。号是同一个，可达性不是。
 * 把它当「界面地址」会得到一个打不开的链接，而链接打不开时没人会想到是地址族的问题。
 */

import type { PickOutcome, PortSource } from './types.js'

/** `endpoint` 意图需要的依赖。 */
export interface EndpointDeps {
  /** 宿主已绑的号（且地址一致）；拿不到为 `null`。 */
  readonly bound: number | null
  /** 发号出口。 */
  readonly accept: (port: number, host: string, source: PortSource) => PickOutcome
  /** 失败出口。 */
  readonly fail: (reason: 'no-endpoint', detail?: string) => PickOutcome
}

/**
 * 取宿主已绑定的号。
 * @param deps 依赖。
 * @param host 请求的地址。
 */
export function pickEndpoint(deps: EndpointDeps, host: string): PickOutcome {
  if (deps.bound === null) {
    return deps.fail('no-endpoint', `宿主 \`webServer\` 在 ${host} 上没有已绑定的端口`)
  }
  return deps.accept(deps.bound, host, 'web-server')
}
