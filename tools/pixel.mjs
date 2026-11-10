/**
 * 截图上取点读色。
 *
 * ## 为什么需要它
 *
 * 判断「两脊是不是真的比纸面暗」时，肉眼在 Retina 截图上是不可靠的：
 * `#ececef` 与 `#ffffff` 并排时，中间那条 8% 的 hairline 会让人误以为
 * 整块都变白了。而把截图丢进肉眼审查，得到的结论只能是"看起来像"。
 *
 * 这个脚本把「看起来」换成「是」：给一组坐标，直接读那个像素的 RGB。
 *
 * ## 用法
 *
 *   node tools/pixel.mjs <png> <x,y> [<x,y> ...]
 *   node tools/pixel.mjs .shots/session-v5.png 30,300 540,300 1050,300
 *
 * 输出每点的十六进制色值与坐标。坐标按**图片像素**计，不是 CSS 像素——
 * 截图是 2 倍图时，CSS 坐标要乘 2。
 *
 * ## 为什么不引第三方库
 *
 * 只读 8 位 RGB/RGBA 非隔行 PNG 的单个像素，用 `zlib.inflateSync` 加
 * 一遍反过滤不到 80 行。为了这个装 sharp 或 pngjs，等于为一把螺丝刀
 * 搬一套工具房。
 */

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

/** 读 PNG 头部，返回宽高与色彩类型。只支持 8 位的 2（RGB）与 6（RGBA）。 */
function readHeader(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')
  let offset = 8
  const chunks = []
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('不支持隔行扫描的 PNG')
    } else if (type === 'IDAT') {
      chunks.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`只支持 8 位 RGB/RGBA，实际 bitDepth=${String(bitDepth)} colorType=${String(colorType)}`)
  }
  return { width, height, channels: colorType === 6 ? 4 : 3, raw: inflateSync(Buffer.concat(chunks)) }
}

/**
 * 反过滤。
 *
 * PNG 每行开头有一个过滤类型字节，行内每个字节是「与左/上/左上像素的差」。
 * 五种类型（0 无、1 Sub、2 Up、3 Average、4 Paeth）必须逐行还原，
 * 因为下一行的 Up 依赖这一行还原后的结果。
 */
function unfilter(image) {
  const { width, height, channels, raw } = image
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]
    source += 1
    const rowStart = y * stride
    const prevStart = (y - 1) * stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x]
      const left = x >= channels ? out[rowStart + x - channels] : 0
      const up = y > 0 ? out[prevStart + x] : 0
      const upLeft = y > 0 && x >= channels ? out[prevStart + x - channels] : 0
      let restored
      if (filter === 0) restored = value
      else if (filter === 1) restored = value + left
      else if (filter === 2) restored = value + up
      else if (filter === 3) restored = value + ((left + up) >> 1)
      else if (filter === 4) {
        /* Paeth：取三个邻居里与预测值最接近的那个。 */
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        restored = value + predictor
      } else throw new Error(`未知的过滤类型 ${String(filter)}`)
      out[rowStart + x] = restored & 0xff
    }
    source += stride
  }
  return out
}

const [, , file, ...points] = process.argv
if (file === undefined || points.length === 0) {
  console.error('用法：node tools/pixel.mjs <png> <x,y> [<x,y> ...]')
  process.exit(1)
}

const image = readHeader(readFileSync(file))
const pixels = unfilter(image)

for (const point of points) {
  const [x, y] = point.split(',').map(Number)
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= image.width || y >= image.height) {
    console.log(`  ${point}  越界（图片 ${String(image.width)}×${String(image.height)}）`)
    continue
  }
  const at = (y * image.width + x) * image.channels
  const hex = [pixels[at], pixels[at + 1], pixels[at + 2]]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')
  console.log(`  #${hex}  (${String(x)}, ${String(y)})`)
}
