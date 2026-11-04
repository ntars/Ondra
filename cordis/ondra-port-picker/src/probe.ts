/**
 * 绑定探测：**探完立刻释放**，一个字节都不留在自己手里。
 *
 * ## 为什么不用 `net.connect()` 试连
 *
 * 试连回答的是「有没有人在**听**」，不是「我能不能**绑**」。两者在三种情况下分叉：
 * 端口被一个不监听的 socket 占着（`SO_REUSEADDR` 场景）、端口在 `TIME_WAIT`、
 * 以及本机防火墙拦了回连。绑定测试回答的正是我们要问的那个问题。
 *
 * ## 为什么 `assign()` 单独一个方法
 *
 * 「让内核分配」不是「探测端口 0」——`listen(0)` 一定成功，成功之后必须把
 * **内核挑中的那个号**读出来。混进 `probe()` 会让「端口 0 永远可用」这种荒谬结果
 * 流进调用方。
 *
 * ## 为什么不 `keepAlive`、不设 `maxConnections`
 *
 * 这个 socket 只活几十毫秒，没有连接会进来。多设一个参数就多一个「它会不会影响
 * 绑定结果」的疑问，而绑定结果正是本文件唯一要保证的东西。
 */

import { createServer } from 'node:net'
import type { ProbePort } from './types.js'

/**
 * 给定时器挂 `unref`（浏览器/Worker 返回数字，没有这个方法）。
 * @param timer 定时器句柄。
 */
function unrefTimer(timer: unknown): void {
  const candidate = timer as { unref?: () => void }
  if (typeof candidate.unref === 'function') candidate.unref()
}

/** 基于 `node:net` 的探测实现。 */
export class TcpProbe implements ProbePort {
  /**
   * 试绑一个具体端口，成功即释放。
   *
   * 三种结局都折成布尔：绑上 → `true`；`EADDRINUSE` / `EACCES` / 超时 / 地址非法 → `false`。
   * **不区分错误类型**是刻意的：调用方要的是「能不能用」，而错误类型只该进日志。
   * @param port 端口号。
   * @param host 绑定地址。
   * @param timeoutMs 超时。
   */
  async probe(port: number, host: string, timeoutMs: number): Promise<boolean> {
    const server = createServer()
    return new Promise<boolean>((resolve) => {
      let settled = false
      let listening = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(ok)
      }

      // 只有真的在 listen 的 server 才能 close；对没起来的 server 调 close 会再抛一次。
      const closeQuietly = (): void => {
        if (!listening) return
        listening = false
        try {
          server.close()
        } catch {
          // 已经关了：不算错。
        }
      }

      timer = setTimeout(() => {
        closeQuietly()
        settle(false)
      }, timeoutMs)
      unrefTimer(timer)

      server.once('error', () => {
        settle(false)
      })

      server.listen({ port, host, exclusive: true }, () => {
        if (settled) {
          // 超时之后才绑上：立刻还回去，否则这个号被本包攥着。
          listening = true
          closeQuietly()
          return
        }
        listening = true
        server.close(() => {
          settle(true)
        })
      })
    })
  }

  /**
   * 让内核分配一个空闲端口并读出来，随后立刻释放。
   * @param host 绑定地址。
   * @param timeoutMs 超时。
   */
  async assign(host: string, timeoutMs: number): Promise<number | null> {
    const server = createServer()
    return new Promise<number | null>((resolve) => {
      let settled = false
      let listening = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const settle = (port: number | null): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(port)
      }

      const closeQuietly = (): void => {
        if (!listening) return
        listening = false
        try {
          server.close()
        } catch {
          // 已经关了：不算错。
        }
      }

      timer = setTimeout(() => {
        closeQuietly()
        settle(null)
      }, timeoutMs)
      unrefTimer(timer)

      server.once('error', () => {
        settle(null)
      })

      server.listen({ port: 0, host, exclusive: true }, () => {
        listening = true
        if (settled) {
          closeQuietly()
          return
        }
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : null
        server.close(() => {
          settle(typeof port === 'number' && port > 0 ? port : null)
        })
      })
    })
  }
}
