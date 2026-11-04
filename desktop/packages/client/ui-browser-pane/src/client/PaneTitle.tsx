/**
 * tab 标题（侧栏 chip 上的文字）。
 *
 * 单独一个 `.tsx` 文件，理由与同目录 `PaneBody.tsx` 一致：`index.ts` 是纯注册逻辑，
 * 不写 JSX；`.ts` 里出现 JSX 会直接是语法错误（`<` 被当成类型参数起点）。
 *
 * 这里只渲染登记时给的标题，不追加模型名或页数——chip 很窄，多一个字符就把
 * 后面的 tab 挤到溢出。
 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@ntars/ondra-client-ui-slots'

/**
 * 取当前 tab 的标题渲染。
 * @param props 运行时给的两个 hook 之一（`useTabInfo`）。
 * @returns 标题文本。
 */
export function PaneTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <>{tab.title}</>
}
