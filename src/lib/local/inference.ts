/**
 * 手机端的推理。
 *
 * ## 与桌面版的差别：没有内核，只有一次 HTTP 调用
 *
 * 桌面版的推理走 `dsh-sidecar` 内核：它管多轮工具调用、会话落盘、超时与
 * 中断。手机端没有内核进程，所以这里直接按 OpenAI 兼容协议调用户选的
 * 端点——**这也正是桌面版内核最终做的事**，只是少了工具循环。
 *
 * 砍掉工具调用是这次精简的核心取舍（用户明确说「agent 不重要」）。
 * 保留的是：多轮对话、流式输出、中断、记忆注入、情绪状态。
 *
 * ## 为什么要自己解析 SSE
 *
 * `fetch` 拿到的是原始字节流。桌面版用 Node 的 `ReadableStream`，浏览器
 * 侧 API 形状相同但细节不同（`TextDecoder` 的 `stream` 选项、块边界可能
 * 切在一个汉字中间）。这里逐字节解码、按空行切帧，与内核的 `readSseData`
 * 同一套逻辑。
 */

/** 模型配置。 */
export interface ModelConfig {
  /** 端点基址，例如 `https://api.deepseek.com/v1`。 */
  baseUrl: string
  /** 模型名。 */
  model: string
  /** 密钥。本机端点可以为空。 */
  apiKey: string
}

/** 一条对话消息。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 流式回调。 */
export interface StreamHandlers {
  /** 收到一段正文。 */
  onDelta(text: string): void
  /** 整轮结束。 */
  onDone(full: string): void
  /** 出错。 */
  onError(message: string): void
}

/**
 * 把供应商返回的错误体翻成一句人话。
 *
 * ## 为什么只取 `error.message`
 *
 * 直接把整个 JSON 摊给用户时，会看到
 * `{"error":{"message":"Authentication Fails (governor) (request_id: ...)"}}`
 * ——`request_id`、`governor` 这些词对用户没有意义。桌面版为此专门写了
 * `upstreamMessage()`，这里做同一件事，规则也一致：
 *
 * - 只取 `error.message` 或顶层 `message`；
 * - 剥掉 `(request_id: ...)` 这类排障尾巴；
 * - HTML 错误页一律不显示（那是网关的 502 页面，不是供应商的话）。
 */
export function explainUpstream(raw: string, status: number): string {
  const text = raw.trim()
  if (text === '') return `供应商返回 ${String(status)}`
  let message = ''
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as { error?: unknown }).error
      if (typeof error === 'object' && error !== null) {
        const inner = (error as { message?: unknown }).message
        if (typeof inner === 'string') message = inner
      }
      if (message === '') {
        const top = (parsed as { message?: unknown }).message
        if (typeof top === 'string') message = top
      }
    }
  } catch {
    /* 不是 JSON：多半是 HTML 错误页，不把原文给用户看 */
    return `供应商返回 ${String(status)}`
  }
  if (message === '') return `供应商返回 ${String(status)}`
  /* 剥掉排障尾巴：`(request_id: xxx)`、`[trace: xxx]`。真原因保留。 */
  const cleaned = message.replace(/\s*[（(\[](?:request_?id|trace_?id|req_?id)[^）)\]]*[）)\]]/gi, '').trim()
  return `供应商返回 ${String(status)}：${cleaned.slice(0, 200)}`
}

/** 拼 chat/completions 地址。基址已带 `/v1` 时不重复拼。 */
export function chatUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith('/chat/completions')) return base
  return `${base}/chat/completions`
}

/**
 * 跑一轮流式推理。
 *
 * @param config 模型配置。
 * @param messages 完整对话（含 system）。
 * @param handlers 回调。
 * @param signal 中断信号。
 */
export async function streamChat(
  config: ModelConfig,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(chatUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey.trim() === '' ? {} : { authorization: `Bearer ${config.apiKey}` }),
      },
      body: JSON.stringify({ model: config.model, messages, stream: true }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (caught) {
    /*
     * 中断与网络错误分开报。
     *
     * 用户点了停止却收到「网络错误」会以为是自己网断了，然后去重启路由。
     * 中断是我们自己发起的，不该报错。
     */
    if (caught instanceof DOMException && caught.name === 'AbortError') return
    /*
     * 把真实原因带出来。
     *
     * 一句「连不上模型服务」在三种情况下都会出现，而用户要做的事完全不同：
     *
     * | 原因 | 用户该做什么 |
     * | --- | --- |
     * | CORS 被拦 | 换一个允许浏览器直连的端点，或改用桌面版 |
     * | DNS / 断网 | 检查网络 |
     * | 地址写错 | 改配置 |
     *
     * 分不清时用户只能挨个试。所以带上 `caught.message`——
     * 它对普通用户不友好，但比"什么都没说"有用得多，而且能直接搜索。
     */
    const detail = caught instanceof Error ? caught.message : String(caught)
    /*
     * 浏览器直连第三方端点最常见的失败是 CORS：请求已经发出（上游日志里
     * 有记录），但响应被浏览器拦下，前端只看到一个笼统的 TypeError。
     * 这种情况要说清楚，否则用户会以为是密钥或地址错了。
     */
    const isCors = /failed to fetch|networkerror|load failed/i.test(detail)
    handlers.onError(
      isCors
        ? `连不上模型服务。若端点地址正确，多半是它不允许浏览器直连（CORS）。桌面版没有这个限制。\n（${detail.slice(0, 120)}）`
        : `连不上模型服务：${detail.slice(0, 160)}`,
    )
    return
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    handlers.onError(explainUpstream(raw, response.status))
    return
  }

  if (response.body === null) {
    handlers.onError('模型服务返回了空响应')
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  try {
    while (true) {
      if (signal?.aborted === true) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      /*
       * 按空行切帧。
       *
       * SSE 的一帧以空行结束，而一个 TCP 块里可能有多帧、也可能半帧。
       * 所以只在看到 `\n\n` 时才处理，剩下的留到下一块。
       */
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        split = buffer.indexOf('\n\n')

        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '' || payload === '[DONE]') continue
          try {
            const frame = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: unknown } }>
            }
            const text = frame.choices?.[0]?.delta?.content
            if (typeof text === 'string' && text !== '') {
              full += text
              handlers.onDelta(text)
            }
          } catch {
            /* 单帧解不开就跳过：整轮不该因为一帧坏掉而失败 */
          }
        }
      }
    }
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === 'AbortError') {
      /* 中断：把已收到的交出去，不报错 */
    } else {
      handlers.onError('读取响应时中断了')
      return
    }
  } finally {
    /* 释放读锁：不释放会让同一条连接无法复用，长会话里会累积。 */
    try {
      reader.releaseLock()
    } catch {
      /* 已经释放过 */
    }
  }

  handlers.onDone(full)
}