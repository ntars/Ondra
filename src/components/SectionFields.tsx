/**
 * 专门页面里的「一段完整字段」。
 *
 * ## 它解决什么
 *
 * 人物设定页原先每张卡只有一个开关（`tts.enable`、`oral.enable`……），而
 * 那个段其余十几个字段躺在「扩展功能 · 模块」里。用户在「她怎么说话」这
 * 一页调她的口吻，调到一半被告知「剩下的去模块里找」——同一件事两个入口。
 *
 * 这个组件把那段字段**原地**展开在卡片下面：默认收起，点「展开」才铺开。
 * 收起是必要的：`tts` 18 项、`filter-chain` 20 项，全铺开会把一页撑成
 * 一条没有尽头的长卷，而日常要调的通常只是最上面那一两个。
 *
 * ## 为什么不直接用 `SectionBlock`
 *
 * `SectionBlock` 是模块层的行：它自带段名、段头、计数与「已改」标记，在
 * 扩展功能里正合适。但嵌到专门页时，段名与卡片标题重复（卡片标题已经是
 * 「朗读声音」，段名是「语音合成」），两个标题叠在一起只会让人犹豫
 * 「这是两个东西吗」。
 *
 * 所以这里只借 `SectionBlock` 的**字段渲染**，外壳自己给：一行摘要 + 展开
 * 按钮。字段控件本身仍然只有一份实现（`ModuleLayer` 里的 `FieldRow`），
 * 不复制。
 */

import type { SettingsSection } from '../lib/settingTypes.ts'
import type { SceneValues } from '../lib/scenes.ts'
import { SectionBlock } from './ModuleLayer.tsx'

/** 卡片上已有开关的字段：展开区里不再重复。 */
const OMIT: ReadonlySet<string> = new Set(['enable'])

export interface SectionFieldsProps {
  /** 要展开的配置段。undefined 表示这一段没装上（插件缺席）。 */
  section: SettingsSection | undefined
  /** 用户层取值。 */
  user: SceneValues
  /** 写一个字段。 */
  onWrite(section: string, key: string, value: unknown): Promise<void>
  /** 展开按钮上的文案。默认「更多设置」。 */
  label?: string
  /**
   * 开发者模式。普通视图只给非高级字段，与模块层同一口径。
   *
   * 专门页不自己记这个状态：它由设置页底部的开关统一控制，两处不一致
   * 会让用户以为「同一段在不同页面字段数不同」。
   */
  developerMode?: boolean
}

/**
 * 卡片下方的「更多设置」折叠区。
 *
 * 段缺席时整块不渲染——不是渲染成灰条。卡片本身已经用状态行说明了
 * 「正在读取」或「不可用」，再来一条空的折叠区只是噪音。
 */
export function SectionFields({
  section,
  user,
  onWrite,
  label = '更多设置',
  developerMode = false,
}: SectionFieldsProps): React.JSX.Element | null {
  /*
   * ## 为什么取消了折叠
   *
   * 上一版这里是一个「更多设置 12 项」的折叠头，点了才铺开字段。当时的
   * 理由是「`tts` 18 项、`filter-chain` 20 项，全铺开会把一页撑成长卷」。
   *
   * 但那个理由站不住：这一层存在的意义就是「在这一页把这件事调完」。
   * 折起来之后，用户看到一张卡只有一个开关，想调「语速」得先点一次
   * 「更多设置」——**多一次点击，且那一次点击不告诉他里面有什么**。
   * 用户的反馈是「应该是直达，而非用户点击展开后才能设置」。
   *
   * 长卷的问题用别的方式解决：字段按「常用在前」排（`FIELD_SPECS` 的
   * 声明顺序已经是这个顺序），且高级字段默认仍被 `advancedOnly` 挡住。
   * 真正需要深调的人才看得到那 20 项，而他们本来就要往下翻。
   */
  if (section === undefined) return null

  const changedCount = Object.keys(user[section.id] ?? {}).length
  const visible = developerMode ? section.fields : section.fields.filter((field) => !field.advancedOnly)
  /* 只有 `enable` 一个可见字段时不给字段区：那一项卡片上已经有开关了。 */
  const rest = visible.filter((field) => field.key !== 'enable')
  if (rest.length === 0) return null

  return (
    <div className="sec-fields">
      {/*
        保留一行摘要，但不再是按钮——它只说明「这一段有几项、改过几项」。
        没有可点的东西就不该长得像按钮：上一版的折叠头有 hover 变色，
        取消折叠后若留着那套样式，用户会去点一个没反应的东西。
      */}
      <p className="sec-fields__label">
        {label}
        <span className="sec-fields__count">
          {rest.length} 项
          {changedCount > 0 ? ` · 已改 ${String(changedCount)}` : ''}
        </span>
      </p>

      <div className="sec-fields__body">
        {/*
          复用模块层的段块，但只取它的字段区。

          `omitKeys` 排除 `enable`：卡片上已经有一个开关写着同一件事。
          不排除的话，第一行又是一个「总开关」，两个开关控同一个
          字段——用户会以为其中一个是「这一组的开关」而另一个是「总开关」，
          然后发现拨动任何一个另一个也跟着变。
        */}
        <SectionBlock
          section={section}
          user={user}
          onWrite={onWrite}
          expanded
          onToggle={() => {}}
          developerMode={developerMode}
          chrome="fields"
          omitKeys={OMIT}
        />
      </div>
    </div>
  )
}