/**
 * 「开发者模式」设置区。
 *
 * 这一区收纳只对折腾代码的人有用、普通人不必看见的条目。它现在还是空的
 * ——原先放在这里的「显示代码工作视图」和「打开配置文件」都已从产品下架，
 * 这一区保留下来，作为后续开发者工具的落点。
 *
 * 它仍然是一个普通的 `settings.section`，与「通用设置」并列，因此导航栏会
 * 自动多出一行，图标沿用默认的设置齿轮。
 */
import type { PropsRenderSlots, PropsRuntime } from '@ntars/ondra-client-ui-slots'
import css from './GeneralSection.module.css'

/** 组件属性：section 宿主位 + 区内条目插槽。 */
export type DeveloperSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.developer.item'>

/**
 * 渲染「开发者模式」区的内容列。
 * @param props - 由槽位组合出的属性。
 * @returns 该区的元素树。
 */
export function DeveloperSection({ renderSlot }: DeveloperSectionComponentProps) {
  return (
    <div className={css.section}>
      {renderSlot('settings.developer.item', {})}
    </div>
  )
}
