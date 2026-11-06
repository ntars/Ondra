/**
 * 空状态（首页）。
 *
 * 严格按设计图布局：logo、标题、输入框、双语 slogan 四件东西竖直排列，
 * 左下角一个设置入口。除此之外什么都不放——这一页的价值就在于留白。
 */

import { Composer } from './Composer.tsx'
import type { Attachment } from './Composer.tsx'
import { EllipsisIcon } from './icons.tsx'
import type { ModelDescriptor, PermissionLevel } from '../lib/api.ts'
// logo 通过 import 引入而不是写 `/icon.svg`：后者在构建产物里是个指向
// 站点根的绝对路径，打包后那个位置并没有这个文件，会变成一个破图。
// import 让构建工具把它当资产处理（小文件自动内联成 data URI），
// 同时保证仓库根那份 icon.svg 仍是唯一真源。
import logoUrl from '../../icon.svg'

/** 组件属性。 */
export interface WelcomeProps {
  value: string
  onChange(value: string): void
  onSend(): void
  permission: PermissionLevel
  onPermissionClick(): void
  onOpenSettings(): void
  /** 正在生成。首页也可能处于生成中（用户打第一句后立刻切换视图前）。 */
  busy?: boolean
  autoFocus?: boolean

  models: ModelDescriptor[]
  modelId: string | undefined
  onModelChange(id: string): void
  onAddFile?(): void
  attachments: Attachment[]
  onRemoveAttachment(id: string): void
  onVoice?(): void
  voiceActive?: boolean
  /** 上报一条顶部提示。首页第一句话失败时，这是唯一的出错通道。 */
  onNotify?(text: string, tone?: 'error' | 'info'): void
}

/**
 * 渲染首页。
 */
export function Welcome(props: WelcomeProps): React.JSX.Element {
  return (
    <>
      <div className="welcome scroller">
        {/* logo 与托盘、安装包共用仓库根的那一份 icon.svg，不在这里重画。 */}
        <img className="welcome__logo" src={logoUrl} alt="" draggable={false} />

        <h1 className="welcome__title">
          空谷<em>Ondra</em>
        </h1>

        <Composer
          value={props.value}
          onChange={props.onChange}
          onSend={props.onSend}
          permission={props.permission}
          onPermissionClick={props.onPermissionClick}
          models={props.models}
          modelId={props.modelId}
          onModelChange={props.onModelChange}
          {...(props.onAddFile === undefined ? {} : { onAddFile: props.onAddFile })}
          attachments={props.attachments}
          onRemoveAttachment={props.onRemoveAttachment}
          {...(props.onVoice === undefined ? {} : { onVoice: props.onVoice })}
          {...(props.voiceActive === undefined ? {} : { voiceActive: props.voiceActive })}
          {...(props.busy === undefined ? {} : { busy: props.busy })}
          {...(props.autoFocus === undefined ? {} : { autoFocus: props.autoFocus })}
        />

        <div className="welcome__slogan">
          {/* 英文原样照抄设计图，包含 sound's 前后的空格与逗号前的空格。
              这不是排版失误——设计图里就是这样写的，改写会偏离原设计。 */}
          <p>On No sound's Depth , Resonance Arises.</p>
          <p>于无声处，听见共鸣</p>
        </div>
      </div>

      <div className="dock">
        <button type="button" className="dock-button" onClick={props.onOpenSettings}>
          <EllipsisIcon />
          <span>设置</span>
        </button>
      </div>
    </>
  )
}
