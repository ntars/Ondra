/**
 * 最小 ZIP 读取器：只做「读中央目录 → 按名取一个文件 → 解压进内存」。
 *
 * 为什么自写而不引依赖：
 * - 上游 `@ntars/ondra-skill-filesystem` 只发现「目录包 + 扁平 md」，
 *   它走 `readdir` + frontmatter 解析，**没有 `.skill.zip` 的读取路径**（已读源码确认）；
 * - 本仓禁止 `pnpm install`，引不了 `yauzl` / `adm-zip`；
 * - 解压本身是 `node:zlib` 的内建能力，本文件做的只是**读目录结构**这件机械活。
 *   这是格式解码，不是机制重造（§1.8 的复用档讲的是记忆/通道/语音那类机制）。
 *
 * 刻意只实现「够用且能报错」的那一档：
 * - 支持 `stored(0)` 与 `deflate(8)` 两种方法——这两个包就是这两种；
 * - **不支持 ZIP64**（`0xFFFFFFFF` / `0xFFFF` 哨兵一律报 `zip64`），
 *   支持它要处理三处扩展字段，收益只有「大于 4GB 的人设包」，而那种包已被
 *   `maxArchiveBytes` 挡住；
 * - **不支持加密**（flag bit 0）与 `deflate64(9)` / `bzip2(12)` / `lzma(14)`；
 * - **不校验 CRC32**：解压后比对长度，长度对不上就报 `size-mismatch`。
 *   校验 CRC 要带一张 256 项查表，而长度比对已经能抓住「解压出错」这一大类；
 *   真正的完整性由上层「能不能解析出 meta.json」兜住。
 *
 * 三条实现要点（都是踩过才知道的）：
 * 1. **只信中央目录，不信本地头。** 本地头的 `csize` 在「流式写入」的包里常为 0，
 *    真正的长度写在中央目录里；本地头只用来算数据起点（`30 + nameLen + extraLen`）。
 * 2. **数据起点必须用本地头的 nameLen/extraLen 重算。** 中央目录里的
 *    `extraLen` 与本地头里的**不相等**（前者是扩展字段，后者是 padding），
 *    混用会整体偏移几个字节，解压出来是一堆乱码而不是报错。
 * 3. **文件名解码按 UTF-8 走，不看 flag bit 11。** 这两个包的中文目录名在
 *    flag 上并没有置位，但字节确实是 UTF-8；按 CP437 解会得到乱码目录名，
 *    而目录名只用于剥壳，剥不掉也不影响按 basename 找文件。
 */

import { inflateRawSync } from 'node:zlib'

/** 中央目录结束标记（End Of Central Directory）。 */
const SIG_EOCD = 0x06054b50

/** 中央目录条目。 */
const SIG_CD = 0x02014b50

/** 本地文件头。 */
const SIG_LFH = 0x04034b50

/** EOCD 最小长度。 */
const EOCD_MIN_BYTES = 22

/** EOCD 之后可能有注释，最长 65535 字节；多留一点余量。 */
const EOCD_SCAN_BYTES = 66_000

/** 未压缩长度 / 压缩长度 / 偏移的 ZIP64 哨兵。 */
const ZIP64_SENTINEL = 0xffffffff

/** 条目总数的 ZIP64 哨兵。 */
const ZIP64_COUNT_SENTINEL = 0xffff

/** 压缩方法：不压缩。 */
const METHOD_STORED = 0

/** 压缩方法：deflate。 */
const METHOD_DEFLATE = 8

/** 错误码。 */
export type ZipErrorCode =
  /** 文件被截断（长度不够放下 EOCD）。 */
  | 'truncated'
  /** 找不到 EOCD，不是 ZIP。 */
  | 'not-zip'
  /** ZIP64，本读取器不支持。 */
  | 'zip64'
  /** 条目被加密。 */
  | 'encrypted'
  /** 不支持的压缩方法。 */
  | 'unsupported-method'
  /** 中央目录或本地头结构异常。 */
  | 'bad-entry'
  /** 解压后长度与声明不符。 */
  | 'size-mismatch'
  /** 包里没有这个条目。 */
  | 'no-entry'

/** ZIP 读取错误。带稳定错误码。 */
export class ZipError extends Error {
  /** 错误码。 */
  readonly code: ZipErrorCode
  /** 补充说明（含包标签，便于在日志里定位是哪个包坏了）。 */
  readonly detail: string

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: ZipErrorCode, message: string, detail: string) {
    super(message)
    this.name = 'ZipError'
    this.code = code
    this.detail = detail
  }
}

/** 一个条目的元信息（不含内容）。 */
export interface ZipEntryInfo {
  /** 包内完整路径（含外壳目录）。 */
  readonly name: string
  /** 剥掉外壳目录之后的相对路径。 */
  readonly path: string
  /** 解压后字节数。 */
  readonly bytes: number
  /** 压缩后字节数。 */
  readonly compressedBytes: number
  /** 压缩方法。 */
  readonly method: number
}

/** 只读压缩包。 */
export interface ZipArchive {
  /** 包标签（通常是文件名），用于错误信息。 */
  readonly label: string
  /** 条目清单（已排除目录项，按路径排序）。 */
  readonly entries: readonly ZipEntryInfo[]
  /** 外壳目录名；没有外壳时为空串。 */
  readonly wrapper: string
  /**
   * 按相对路径取一个条目的原始字节。
   * @param relPath 相对包根的路径（大小写不敏感、允许省略外壳目录）。
   */
  read(relPath: string): Buffer
  /**
   * 有没有这个相对路径。
   * @param relPath 相对包根的路径。
   */
  has(relPath: string): boolean
}

/** 读 16 位小端。 */
function u16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset)
}

/** 读 32 位小端。 */
function u32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset)
}

/** 判空字符串。 */
function isBlank(value: string): boolean {
  return value.trim() === ''
}

/**
 * 归一化一个相对路径：统一分隔符、去前导 `./` 与 `/`、折叠重复斜杠。
 * @param value 原始路径。
 */
export function normalizeRelPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
    .trim()
}

/**
 * 探测外壳目录：所有条目都以同一个首段开头时，它就是外壳。
 *
 * 两个人设包的结构都是 `<名字>.skill/...`，多这一层会让「`SKILL.md` 在哪」
 * 变成一个需要特判的问题；剥掉之后所有消费方都按相对路径说话。
 * @param names 全部条目名。
 */
export function detectWrapper(names: readonly string[]): string {
  if (names.length === 0) return ''
  const firstSegments = new Set<string>()
  for (const name of names) {
    const slash = name.indexOf('/')
    if (slash <= 0) return ''
    firstSegments.add(name.slice(0, slash))
    if (firstSegments.size > 1) return ''
  }
  const [wrapper] = firstSegments
  return wrapper === undefined ? '' : wrapper
}

/** 从条目名里剥掉外壳。 */
function stripWrapper(name: string, wrapper: string): string {
  if (wrapper === '' || !name.startsWith(wrapper + '/')) return name
  return name.slice(wrapper.length + 1)
}

/**
 * 打开一个内存里的 ZIP。
 * @param buffer 整个包文件的内容。
 * @param label 包标签（文件名），只用于错误信息。
 */
export function openZip(buffer: Buffer, label: string): ZipArchive {
  if (buffer.length < EOCD_MIN_BYTES) {
    throw new ZipError('truncated', '人设包太短，连 ZIP 结尾标记都放不下', label)
  }
  const eocd = findEocd(buffer)
  if (eocd < 0) {
    throw new ZipError('not-zip', '人设包不是 ZIP 格式（找不到中央目录结尾标记）', label)
  }
  const entryCount = u16(buffer, eocd + 10)
  const cdSize = u32(buffer, eocd + 12)
  const cdOffset = u32(buffer, eocd + 16)
  if (entryCount === ZIP64_COUNT_SENTINEL || cdOffset === ZIP64_SENTINEL || cdSize === ZIP64_SENTINEL) {
    throw new ZipError('zip64', '人设包是 ZIP64 格式，本读取器不支持（请重新打包成普通 ZIP）', label)
  }
  if (cdOffset + cdSize > buffer.length) {
    throw new ZipError('truncated', '人设包被截断：中央目录超出了文件末尾', label)
  }

  const raws: { name: string; method: number; compressedBytes: number; bytes: number; localOffset: number }[] = []
  let cursor = cdOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buffer.length) {
      throw new ZipError('bad-entry', '人设包的中央目录被截断', label)
    }
    if (u32(buffer, cursor) !== SIG_CD) {
      throw new ZipError('bad-entry', '人设包的中央目录条目签名不对（第 ' + String(i + 1) + ' 条）', label)
    }
    const flags = u16(buffer, cursor + 8)
    const method = u16(buffer, cursor + 10)
    const compressedBytes = u32(buffer, cursor + 20)
    const bytes = u32(buffer, cursor + 24)
    const nameLen = u16(buffer, cursor + 28)
    const extraLen = u16(buffer, cursor + 30)
    const commentLen = u16(buffer, cursor + 32)
    const localOffset = u32(buffer, cursor + 42)
    if ((flags & 0x1) !== 0) {
      throw new ZipError('encrypted', '人设包是加密的，本读取器不支持', label)
    }
    if (compressedBytes === ZIP64_SENTINEL || bytes === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      throw new ZipError('zip64', '人设包里有 ZIP64 条目，本读取器不支持', label)
    }
    const nameStart = cursor + 46
    const name = buffer.toString('utf8', nameStart, nameStart + nameLen)
    cursor = nameStart + nameLen + extraLen + commentLen
    // 目录项：名字以 `/` 结尾。它们没有内容，留着只会让文件清单里多一堆空行。
    if (name.endsWith('/')) continue
    if (isBlank(name)) {
      throw new ZipError('bad-entry', '人设包里有空文件名条目', label)
    }
    raws.push({ name, method, compressedBytes, bytes, localOffset })
  }

  const wrapper = detectWrapper(raws.map(entry => entry.name))
  // **元信息与原始条目必须一起排序**：分成两个数组各排一次，
  // 下标就会错位，「按路径找到的条目」与「读到的字节」是两回事——
  // 而且不会报错，只会读出一段别的文件的内容。这是本文件最容易犯的错。
  const paired = raws.map(raw => {
    const info: ZipEntryInfo = {
      name: raw.name,
      path: stripWrapper(raw.name, wrapper),
      bytes: raw.bytes,
      compressedBytes: raw.compressedBytes,
      method: raw.method,
    }
    return { raw, info }
  })
  paired.sort((left, right) => (left.info.path < right.info.path ? -1 : left.info.path > right.info.path ? 1 : 0))
  const entries: readonly ZipEntryInfo[] = Object.freeze(paired.map(item => item.info))

  /** 按相对路径找原始条目。 */
  const locate = (relPath: string): (typeof paired)[number] | undefined => {
    const wanted = normalizeRelPath(relPath).toLowerCase()
    if (wanted === '') return undefined
    for (const item of paired) {
      if (item.info.path.toLowerCase() === wanted) return item
    }
    // 退化：允许调用方带外壳目录（`xxx.skill/SKILL.md`），也允许只给 basename。
    for (const item of paired) {
      const lowerName = item.info.name.toLowerCase()
      if (lowerName === wanted || lowerName.endsWith('/' + wanted)) return item
    }
    return undefined
  }

  const read = (relPath: string): Buffer => {
    const found = locate(relPath)
    if (found === undefined) {
      throw new ZipError('no-entry', '人设包里没有「' + relPath + '」', label)
    }
    const { raw } = found
    // 本地头只用来算数据起点：nameLen/extraLen 必须取本地头自己那份（见文件头第 2 条）。
    const header = raw.localOffset
    if (header + 30 > buffer.length || u32(buffer, header) !== SIG_LFH) {
      throw new ZipError('bad-entry', '「' + relPath + '」的本地文件头损坏', label)
    }
    const localNameLen = u16(buffer, header + 26)
    const localExtraLen = u16(buffer, header + 28)
    const start = header + 30 + localNameLen + localExtraLen
    const end = start + raw.compressedBytes
    if (end > buffer.length) {
      throw new ZipError('truncated', '「' + relPath + '」的数据段被截断', label)
    }
    const slice = buffer.subarray(start, end)
    let out: Buffer
    if (raw.method === METHOD_STORED) {
      out = Buffer.from(slice)
    } else if (raw.method === METHOD_DEFLATE) {
      try {
        out = inflateRawSync(slice)
      } catch (error) {
        throw new ZipError(
          'bad-entry',
          '「' + relPath + '」解压失败：' + (error instanceof Error ? error.message : String(error)),
          label,
        )
      }
    } else {
      throw new ZipError('unsupported-method', '「' + relPath + '」用了不支持的压缩方法 ' + String(raw.method), label)
    }
    if (out.length !== raw.bytes) {
      throw new ZipError(
        'size-mismatch',
        '「' + relPath + '」解压后 ' + String(out.length) + ' 字节，与声明的 ' + String(raw.bytes) + ' 字节不符',
        label,
      )
    }
    return out
  }

  return {
    label,
    entries,
    wrapper,
    read,
    has: (relPath: string): boolean => locate(relPath) !== undefined,
  }
}

/**
 * 从文件末尾往前找 EOCD。
 *
 * 不能只看最后 22 字节：EOCD 后面可以跟一段最长 65535 字节的注释，
 * 而「打包工具加了注释」这件事在 Windows 上很常见。
 * @param buffer 整个包。
 */
function findEocd(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - EOCD_SCAN_BYTES)
  for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) return offset
  }
  return -1
}

/**
 * 从压缩包里取一个条目的文本。
 *
 * 不是 UTF-8 就返回 `undefined` 而不是乱码：人设包里出现二进制文件
 * （图片、字体）是正常的，把它们当文本交给上层会在提示词里变成一堆 `\ufffd`。
 * @param archive 压缩包。
 * @param relPath 相对路径。
 * @returns 文本；不存在或不是文本时 `undefined`。
 */
export function readTextEntry(archive: ZipArchive, relPath: string): string | undefined {
  if (!archive.has(relPath)) return undefined
  const bytes = archive.read(relPath)
  if (bytes.includes(0)) return undefined
  const text = bytes.toString('utf8')
  return text.includes('\ufffd') ? undefined : text
}
