/**
 * 插件设置的跨层类型。
 *
 * ## 为什么单独一个文件
 *
 * 这三个接口会被三处同时引用：宿主扫描出的形状、前端数据层、界面组件。
 * 若定义在 `settings.ts`（负责请求的模块）里，`scenes.ts`（场景定义）就得
 * 反过来 import 它，而 `settings.ts` 又要 import `scenes.ts` 的 `SettingsSection`
 * ——两边互相依赖，ESM 下会得到一个 `undefined` 的类型引用。
 *
 * 类型不携带逻辑，抽出来最安全。
 */

/** 一种字段的取值种类。与插件侧 `FieldSpecLike.kind` 同集合。 */
export type FieldKind = 'string' | 'number' | 'boolean' | 'enum' | 'json'

/** 一个插件声明的配置字段。 */
export interface SettingsField {
  /** 配置里的字段键（kebab，如 `archive-normal-days`）。 */
  key: string
  kind: FieldKind
  /** 出厂默认值。缺省表示「没有出厂默认」。 */
  default?: unknown
  min?: number
  max?: number
  /** `enum` 的候选值。插件侧的 `options` 已归一到这里。 */
  values?: string[]
  /** `string` 的形状正则源码（如 `HH:MM`）。 */
  pattern?: string
  /** 一句中文说明，来自插件的 `doc`。 */
  doc?: string
  /** 是否只在展开高级后显示。全仓 48% 的字段为真。 */
  advancedOnly: boolean
  /** 是否密钥字段。全仓为 0，界面不预留密码框（§5.13）。 */
  secret: boolean
}

/** 一个插件声明的配置段。 */
export interface SettingsSection {
  /** 段键（kebab）。写进配置文件的就是它。 */
  id: string
  /** 中文段名。 */
  title: string
  /** 插件目录名。用户报问题时说的是它，界面必须能对上。 */
  dir: string
  /** 声明方（插件名或服务键）。 */
  owner: string
  /** 是否已装载。false 时界面灰显并注明「插件已停用」（§6.7）。 */
  active: boolean
  /** 是否有 `CONFIG_SECTION`。false 即 §5.13 的「无段字段」。 */
  registered: boolean
  fields: SettingsField[]
}
