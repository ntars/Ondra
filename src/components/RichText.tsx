/**
 * 正文排版渲染（§12.4）。
 *
 * ## 职责边界
 *
 * `lib/richText.ts` 只负责把文本解析成数据，这里只负责把数据变成 DOM。
 * 两者分开的理由：解析规则会被测试单独覆盖（纯函数，不碰 DOM），
 * 渲染的样式问题也不必读一遍词法分析才能改。
 *
 * ## 为什么没有一个 `dangerouslySetInnerHTML`
 *
 * 正文来自模型。模型输出里写 `<img src=x onerror=alert(1)>` 完全可能，
 * 只要有一处把字符串塞进 `innerHTML`，那条输出就成了可执行代码。
 * 这里每个节点都由 React 生成：文本走文本节点，链接走 `<a>`，
 * 图片走受控的 `<img>`。**注入面不是「消毒得够不够干净」，而是不存在。**
 *
 * ## 图片为什么要分两种
 *
 * `imageSource()` 把图片分成 `inline`（data URL，直接显示）与
 * 远程（渲染成一行链接交给系统浏览器）。理由写在那个函数上方：
 * 应用的 CSP 本就不允许远程图片，为一个「顺手显示」去开 `img-src https:`
 * 等于让每张图都成为一次向外的请求。
 */

import { memo, useCallback, useMemo } from 'react'
import { invokeShell } from '../lib/shell.ts'
import {
  parseMarkdown,
  plainText,
  type Block,
  type Inline,
} from '../lib/richText.ts'

/**
 * 用系统浏览器打开链接。
 *
 * 走壳的 opener 而不是 `window.open`：WebView 里的 `window.open` 会开一个
 * **没有地址栏**的新窗口，用户既看不到自己去了哪，也没法把链接复制走。
 *
 * 不在壳内（浏览器开发态）时退回当前页跳转——开发时点一下能看到目标就行，
 * 不值得为此再判断一次环境。
 */
function openExternal(url: string): void {
  void invokeShell<null>('plugin:opener|open_url', { url }).catch(() => {
    globalThis.open(url, '_blank', 'noopener,noreferrer')
  })
}

/** 渲染一段行内片段。 */
function InlineNodes({ nodes }: { nodes: Inline[] }): React.JSX.Element {
  return (
    <>
      {nodes.map((node, index) => {
        // key 用序号：同一个位置不会重排，内容变化时序号仍然稳定。
        // 用内容做 key 会让「同样的字出现两次」撞车。
        const key = `${String(index)}:${node.kind}`
        switch (node.kind) {
          case 'text':
            return <span key={key}>{node.text}</span>
          case 'code':
            return <code key={key} className="md__code">{node.text}</code>
          case 'strong':
            return <strong key={key}><InlineNodes nodes={node.children} /></strong>
          case 'em':
            return <em key={key}><InlineNodes nodes={node.children} /></em>
          case 'del':
            return <del key={key}><InlineNodes nodes={node.children} /></del>
          case 'link':
            return (
              <a
                key={key}
                className="md__link"
                href={node.href}
                title={node.href}
                onClick={(event) => {
                  /*
                   * 必须拦掉默认行为。不拦的话 WebView 会在应用窗口里
                   * 直接导航过去——用户就再也回不到对话了，只能重启应用。
                   * 这是「点了链接应用没了」的成因。
                   */
                  event.preventDefault()
                  openExternal(node.href)
                }}
              >
                <InlineNodes nodes={node.children} />
              </a>
            )
          case 'image':
            return node.src.startsWith('data:')
              ? (
                  <img
                    key={key}
                    className="md__image"
                    src={node.src}
                    alt={node.alt}
                    /*
                     * 不给远程图留口子：`src` 只可能是 data URL（见
                     * `imageSource`）。这里仍显式写 `referrerPolicy`，
                     * 是为了将来有人放宽 CSP 时，至少不会把来源带出去。
                     */
                    referrerPolicy="no-referrer"
                  />
                )
              : (
                  <a
                    key={key}
                    className="md__link"
                    href={node.src}
                    title={node.src}
                    onClick={(event) => {
                      event.preventDefault()
                      openExternal(node.src)
                    }}
                  >
                    {node.alt === '' ? '图片' : node.alt}
                  </a>
                )
        }
      })}
    </>
  )
}

/** 多行行内片段：段内的软换行要保留成真换行。 */
function Lines({ lines }: { lines: Inline[][] }): React.JSX.Element {
  return (
    <>
      {lines.map((line, index) => (
        <span key={String(index)}>
          <InlineNodes nodes={line} />
          {index < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </>
  )
}

/** 代码块。 */
function CodeBlock({ lang, text }: { lang: string; text: string }): React.JSX.Element {
  const copy = useCallback((): void => {
    void navigator.clipboard.writeText(text).catch(() => {
      /* 剪贴板不可用时静默放过：这块的按钮不该因为权限问题变成红色报错。 */
    })
  }, [text])

  return (
    <div className="md__pre">
      <button
        type="button"
        className="md__pre-copy"
        aria-label="复制代码"
        title="复制代码"
        onClick={copy}
      >
        复制
      </button>
      {/* 语言名不做语法高亮（§12.4 未要求），只作为右上角的一行小字。 */}
      {lang === '' ? null : <span className="md__pre-lang">{lang}</span>}
      <pre className="md__pre-body"><code>{text}</code></pre>
    </div>
  )
}

/** 表格。 */
function Table({ block }: { block: Extract<Block, { kind: 'table' }> }): React.JSX.Element {
  const columns = Math.max(
    block.head.length,
    ...block.rows.map((row) => row.length),
    1,
  )

  return (
    <div className="md__table-wrap">
      <table className="md__table">
        <thead>
          <tr>
            {Array.from({ length: columns }, (_, column) => (
              <th key={String(column)} style={{ textAlign: block.align[column] ?? 'left' }}>
                <InlineNodes nodes={block.head[column] ?? []} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, index) => (
            <tr key={String(index)}>
              {Array.from({ length: columns }, (_, column) => (
                <td key={String(column)} style={{ textAlign: block.align[column] ?? 'left' }}>
                  <InlineNodes nodes={row[column] ?? []} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 一个块。 */
function OneBlock({ block }: { block: Block }): React.JSX.Element | null {
  switch (block.kind) {
    case 'paragraph':
      return <p className="md__p"><Lines lines={block.lines} /></p>
    case 'heading': {
      // 正文里的标题不改变文档大纲：它们是消息内的分小段，
      // 用 `<h4>`–`<h6>` 一律降级不安全，这里统一渲染成带类的 `p`，
      // 靠字号区分层级。理由是消息不是文档，跳级标题会污染读屏的大纲树。
      const level = Math.min(3, Math.max(1, block.level))
      return <p className="md__h" data-level={level}><Lines lines={block.lines} /></p>
    }
    case 'code':
      return <CodeBlock lang={block.lang} text={block.text} />
    case 'quote':
      return (
        <blockquote className="md__quote">
          {block.body.map((inner, index) => <OneBlock key={String(index)} block={inner} />)}
        </blockquote>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag className="md__list" start={block.ordered ? block.start : undefined}>
          {block.items.map((item, index) => (
            <li key={String(index)}><InlineNodes nodes={item} /></li>
          ))}
        </Tag>
      )
    }
    case 'table':
      return <Table block={block} />
    case 'rule':
      return <hr className="md__rule" />
  }
}

export interface RichTextProps {
  /** 原始正文。 */
  source: string
}

/**
 * 渲染一条消息的正文。
 *
 * ## 两层记忆化，各挡一件事
 *
 * 1. **`useMemo` 挡解析**。时间轴的 `active` 状态（鼠标停在哪条消息上）
 *    一变，整个 `Timeline` 就重渲染，于是每条历史消息都会重跑一遍
 *    `parseMarkdown`。四十条消息、每条两百字，鼠标划过一遍就是四十次
 *    全量解析——而这四十次的输入一个字都没变。
 * 2. **`memo` 挡渲染**。流式输出期间只有最后一条的 `source` 在变，
 *    其余几十条的 props 完全一样，不该跟着走一遍 diff。
 *
 * 两者不能合成一层：`memo` 只在 props 变化时才进函数体，挡不住
 * 「函数体进来了但内容没变」的那一类，而 `useMemo` 反过来挡不住
 * 外部整棵树的重渲染。
 */
export const RichText = memo(function RichText({ source }: RichTextProps): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className="md">
      {blocks.map((block, index) => <OneBlock key={String(index)} block={block} />)}
    </div>
  )
})

/**
 * 取一条消息的纯文本形式。
 *
 * 「复制」与「引用」都走它——§5.4 要求复制不含 Markdown 记号，
 * §12.7 的引用把摘录插进输入框时同样不该带井号与星号。
 */
export function toPlainText(source: string): string {
  return plainText(parseMarkdown(source))
}
