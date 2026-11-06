/**
 * 主密钥的本地生成与读取。
 *
 * ## 为什么密钥必须落盘而不是每次启动随机
 *
 * 每次启动重生成会让**已经打开的入口页在重启后集体失效**。用户点了「去注册」
 * 去泡了杯茶，应用正好自动更新重启，回来只看到 410——这类失败看起来像 bug，
 * 实际是密钥策略错了。
 *
 * ## 为什么用 `user` 区域而不是 `cache`
 *
 * `cache` 会被清理工具与「清缓存」动作删掉，密钥丢了同样会让在途入口失效。
 * `user` 区域是用户数据，不会被动清理。
 *
 * ## 权限
 *
 * 文件 0600、目录 0700，全部经 O-002 的 `prepareFile()` 处理——**不自己 chmod**。
 * 理由见 `ondra-path-layout` 的 README：对非自建目录动手会把 `~` 一起锁死。
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BeichenError } from './types.js'

/** 密钥长度（字节）。32 字节 = 256 位，与边缘版要求「32 字节以上」一致。 */
const SECRET_BYTES = 32

/** 密钥文件名。 */
const SECRET_FILE = 'master-secret'

/**
 * O-002 路径服务的**结构对位**子集。
 *
 * 不 `import` O-002 源码：那会让两个插件编译期互相绑定（手册 §15.5）。
 */
export interface PathLayoutLike {
  fileIn(area: 'user', ...segments: string[]): string
  prepareFile(filePath: string): string
}

/**
 * 计算密钥文件路径。
 * @param layout O-002 服务；缺席时回退到 `~/.ondra/user/beichen/master-secret`。
 * @returns 绝对路径。
 */
function secretPath(layout: PathLayoutLike | undefined): string {
  if (layout !== undefined) return layout.fileIn('user', 'beichen', SECRET_FILE)
  return join(homedir(), '.ondra', 'user', 'beichen', SECRET_FILE)
}

/**
 * 读取已有密钥；不存在则以 0600 新建。
 *
 * @param layout O-002 服务（可缺席）。
 * @returns 主密钥原文（base64 的 32 字节）。
 * @throws BeichenError 读写失败时抛出，**不静默生成新密钥**——静默换密钥
 *   会让在途令牌无声失效，比直接报错难查得多。
 */
export function loadOrCreateSecret(layout: PathLayoutLike | undefined): string {
  const file = secretPath(layout)

  let existing: string
  try {
    existing = readFileSync(file, 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new BeichenError(`读取入口密钥失败：${file}`, 'io')
    }
    existing = ''
  }

  if (existing.length >= 32) return existing

  const fresh = randomBytes(SECRET_BYTES).toString('base64')
  try {
    if (layout !== undefined) {
      // prepareFile 负责建父目录（0700）并把文件收紧到 0600。
      layout.prepareFile(file)
      writeFileSync(file, fresh, { encoding: 'utf8', mode: 0o600 })
    } else {
      // 回退路径：自己建目录，权限位仅在 POSIX 有意义。
      mkdirSync(join(homedir(), '.ondra', 'user', 'beichen'), { recursive: true, mode: 0o700 })
      writeFileSync(file, fresh, { encoding: 'utf8', mode: 0o600 })
    }
  } catch (error) {
    throw new BeichenError(`写入入口密钥失败：${file}（${(error as Error).message}）`, 'io')
  }
  return fresh
}

/**
 * 密钥指纹：`sha256(secret)` 的前 16 个十六进制字符。
 *
 * 用途只有一个——让用户在设置里核对「本地这枚」与「EdgeOne 环境变量那枚」
 * 是不是同一个值，而不必把密钥明文贴在屏幕上。
 * @param secret 主密钥原文。
 * @returns 16 位指纹。
 */
export function fingerprintOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16)
}
