/**
 * 粘贴的两件事：图片转附件、超长文本先问一句（§12.14）。
 *
 * ## 为什么富文本这条不需要写代码
 *
 * §12.14 要求「粘贴富文本只取纯文本，保留换行，丢弃样式」。这条在
 * `<textarea>` 里**天然成立**：浏览器往 textarea 粘贴时只写 `text/plain`，
 * 从不注入 HTML 或样式。所以这一条的正确落地方式是「什么都不做」——
 * 真去监听 `paste` 再自己 `insertText`，反而会在输入法、撤销栈、
 * 选区替换上各踩一次坑，而收益是零。
 *
 * 只有挡在默认行为前面才有意义的两件事才写在这里：图片、超长。
 *
 * ## 为什么缩略图要当场缩小，而不是留着原图
 *
 * 一张手机照片是 4000 × 3000。把它整个读成 data URL 塞进附件对象，
 * 内存里就躺着一份几十兆的字符串；六个附件就够让窗口卡顿。
 * 缩略图只需要 48 × 48——在**读进来之前**就按显示尺寸画一次，
 * 之后任何环节都只碰这一个小字符串。
 */

/**
 * 单条的字数上限（§5.6 计数提示、§12.14 超长确认共用这一个数）。
 *
 * ## 为什么只留一个数
 *
 * 原来 `Composer.tsx` 里有两个 8000：`SOFT_LIMIT` 管「底部出现计数」，
 * `CONFIRM_LIMIT` 管「发送前问一句」。两个常量同值时看不出问题，
 * 但它们是同一件事的两面——「多少字算长」。一旦有人只改其中一个，
 * 就会出现「计数已经跳出来了，却不问」或者「还没见到计数就被拦下」，
 * 而两种都很难在测试里被抓到，因为界面各自看起来都正常。
 *
 * 用一个数表达：**到了这个字数，就该被提醒**。提醒的形式分两档
 * （底部计数、发送前确认），档位不改变阈值。
 */
export const CONFIRM_LIMIT = 8000

/** 缩略图边长（§12.14：48 × 48）。 */
export const THUMB_SIZE = 48

/** 一张粘贴进来的图片。 */
export interface PastedImage {
  /** 展示用文件名，形如 `粘贴的图片-14:30:05`。 */
  name: string
  /** 48 × 48 的 data URL。 */
  thumb: string
}

/**
 * 从剪贴板事件里挑出图片文件。
 *
 * ## 为什么要按 `type` 过滤而不是按 `kind`
 *
 * 截图工具常常同时塞进 `image/png` 与一小段 `text/plain`（图片的 alt 或
 * 路径）。只判 `kind === 'file'` 会漏掉某些把图片作为「文件项」上报的实现，
 * 只判 `type.startsWith('image/')` 又会把 `imageType` 的字符串项也带进来。
 * 两条一起判，拿到的才是「既能解码又确实是文件」的那一份。
 *
 * @param data 剪贴板的 `DataTransfer`。可能为 `null`（某些 WebView 不给）。
 * @returns 图片文件，顺序与剪贴板一致。
 */
export function imagesOf(data: DataTransfer | null): File[] {
  if (data === null) return []
  return Array.from(data.files).filter(
    (file) => typeof file.type === 'string' && file.type.startsWith('image/'),
  )
}

/**
 * 从剪贴板里取纯文本。
 *
 * ## 为什么最终没有用到它
 *
 * 剪贴板里同时有图片与文字时（从网页复制一张图，系统会附上图片地址或
 * alt 文字），**文字不是用户想说的话**，而是那份图片的元数据。把它一起
 * 落进输入框，用户会看到「一个附件 + 一段莫名其妙的话」，还得先删掉
 * 才能写自己的句子。
 *
 * 所以 `Composer` 的粘贴处理在发现图片后直接 `preventDefault`，
 * 文字一并不收。用户若真要那个地址，单独复制一次即可——那时剪贴板里
 * 没有图片，走的是浏览器默认粘贴。
 *
 * 这个函数留着是因为它是「图上带字」这个事实的**可复现判据**：
 * 检查脚本用它构造剪贴板内容，验证「有图时文字确实没有被插进输入框」。
 *
 * @param data 剪贴板的 `DataTransfer`。
 */
export function plainTextOf(data: DataTransfer | null): string {
  if (data === null) return ''
  return data.getData('text/plain')
}

/** 两位补零。 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 粘贴时刻，形如 `14:30:05`。
 *
 * 用冒号而不是连字符：这是一个**展示名**，永远不会变成磁盘路径
 * （缩略图存在内存里）。冒号读起来更像时间，而 `14-30-05` 会被当成日期。
 *
 * @param at 时刻。默认现在，测试时可注入。
 */
export function stamp(at: number = Date.now()): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 把一张图片画成 48 × 48 的方形缩略图。
 *
 * ## 为什么要居中裁成正方形
 *
 * 缩略图框是方的。把长方形按比例塞进去会留出两条空白，六个附件排一排
 * 就会出现高度不一的空隙带；拉伸则会把人脸压扁。居中裁切是唯一
 * 「填满且不变形」的做法。
 *
 * ## 为什么失败时返回空串而不是抛
 *
 * 粘贴一张 WebView 解不开的图（损坏的 PNG、少见的 HEIC）不该让整次
 * 粘贴失败——文字部分还应该照常落进输入框。调用方拿到空串就退回
 * 不带缩略图的文字附件。
 *
 * @param file 剪贴板里的图片文件。
 * @returns data URL；解码失败时为空串。
 */
export async function makeThumb(file: File): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_SIZE
  canvas.height = THUMB_SIZE
  const context = canvas.getContext('2d')
  if (context === null) return ''

  try {
    const bitmap = await createImageBitmap(file)
    // 取短边作为裁切框，居中偏移。
    const side = Math.min(bitmap.width, bitmap.height)
    const x = (bitmap.width - side) / 2
    const y = (bitmap.height - side) / 2
    context.drawImage(bitmap, x, y, side, side, 0, 0, THUMB_SIZE, THUMB_SIZE)
    // 位图占的是原生内存，不解码释放会一直留到 GC——粘十张图就是十份原图。
    bitmap.close()
  } catch {
    return ''
  }

  /*
   * 用 `image/jpeg` 而不是 `png`：48 × 48 的缩略图里，PNG 无损编码
   * 反而比 JPEG 大（小尺寸下压缩收益抵不过头信息）。0.8 的质量在
   * 这个尺寸上看不出差别。
   */
  try {
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    // 画布被跨域内容污染时会抛。这里画的都是本地文件，理论上不会发生，
    // 但一旦发生不该让粘贴整体失败。
    return ''
  }
}

/**
 * 把剪贴板里的图片全部转成附件可用的形状。
 *
 * 串行而不是 `Promise.all`：每张图都要建一个位图 + 一块画布，
 * 六张同时解码在低配机上会明显卡一下，而串行的总耗时几乎一样。
 *
 * @param files 图片文件。
 * @param at 时刻，用于命名。同一批共用同一个时间戳，看起来才像「一次粘贴」。
 */
export async function toPastedImages(files: readonly File[], at: number = Date.now()): Promise<PastedImage[]> {
  const label = stamp(at)
  const result: PastedImage[] = []
  for (const [index, file] of files.entries()) {
    const thumb = await makeThumb(file)
    /*
     * 同一批多张时加序号：否则六个附件全叫「粘贴的图片-14:30:05」，
     * 用户在列表里无法区分该删哪一个。
     */
    const suffix = files.length > 1 ? `-${String(index + 1)}` : ''
    result.push({ name: `粘贴的图片-${label}${suffix}`, thumb })
  }
  return result
}
