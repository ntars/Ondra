/**
 * dsh 内核进程入口。
 *
 * ## 这个文件只做一件事
 *
 * 把标准输入接到内核、把内核输出接到标准输出，并在收到 EOF 或 SIGTERM 时干净退出。
 * 所有业务逻辑都在 `kernel/` 里，入口保持极薄——这样内核可以在测试里
 * 直接 `createKernel()` 而完全不碰进程对象。
 *
 * ## 数据目录从哪来
 *
 * 由宿主通过环境变量 `ONDRA_DATA_DIR` 指定。内核不自己推导目录：
 * 推导规则一旦写在这里，宿主想改位置就得同时改两处；而环境变量是
 * 唯一的、显式的来源，测试里也能随便指一个临时目录。
 */

import { createKernel } from './kernel/index.js'
import { EventName } from './protocol.js'

async function main(): Promise<void> {
  // 没有数据目录时退化为内存存储：这是有意保留的能力，
  // 让"只想验证协议"的调用方不必先准备目录。
  const dataDir = process.env.ONDRA_DATA_DIR?.trim()

  const kernel = await createKernel(dataDir === undefined || dataDir === '' ? {} : { dataDir })
  const { dispatcher } = kernel

  kernel.markReady()

  let stopping = false
  const stop = (reason: string): void => {
    if (stopping) return
    stopping = true
    process.stderr.write(`[dsh] 正在关闭：${reason}\n`)
    dispatcher.markShuttingDown()
    dispatcher.notify(EventName.ShuttingDown)
    // 给 stdout 一个刷写的机会，再退出。不等的话最后一条事件可能丢失。
    process.stdout.write('', () => { process.exit(0) })
  }

  process.stdin.on('data', (chunk: Buffer) => {
    void dispatcher.feed(chunk)
  })

  // 父进程退出或管道关闭时收到 EOF。这是子进程退出的正常路径，
  // 必须处理——否则会变成孤儿进程继续占内存。
  process.stdin.on('end', () => { stop('父进程关闭了管道') })

  process.on('SIGTERM', () => { stop('收到 SIGTERM') })
  process.on('SIGINT', () => { stop('收到 SIGINT') })

  // 未捕获异常不能让内核静默死掉：写清原因再退出，宿主才能给出可读的提示。
  process.on('uncaughtException', (error) => {
    process.stderr.write(`[dsh] 未捕获异常：${error.stack ?? error.message}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[dsh] 未处理的 Promise 拒绝：${String(reason)}\n`)
    process.exit(1)
  })
}

void main()
