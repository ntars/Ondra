/**
 * 图标层。
 *
 * ## 为什么换掉手写 SVG
 *
 * 原来每个图标是手画的 20 行 SVG，问题是：
 * - 一套图标要自己保证线条粗细、端点圆角、视觉重心一致，稍有偏差就显手工痕迹；
 * - 无法做状态形变（比如播放 → 停止、菜单 → 关闭）。
 *
 * 现在用 morphicons + lucide 图标数据：
 * - lucide 保证 24×24 网格、1.6 描边、圆角端点的一致性；
 * - morphicons 让同一个位置换图标时走弹簧插值，形状真的"变过去"，
 *   而不是淡出淡入。这是原生控件才有的一种质感。
 *
 * ## 为什么保留这层语义化封装
 *
 * 组件里应当写 `<SendIcon />` 而不是 `<MorphIcon icon={Play} />`。
 * 图标来源将来若再换（比如整体改用 Phosphor 的圆润风格），
 * 只改这一个文件，不必搜遍所有组件。
 */

import { MorphIcon } from 'morphicons/react'
import {
  ArrowLeft,
  Cat,
  ChevronDown,
  CircleUser,
  Database,
  Gauge,
  Info,
  List,
  Lock,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Paperclip,
  Plus,
  PlusCircle,
  Play,
  Send,
  SendHorizonal,
  Settings,
  Shield,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from 'lucide'

/**
 * 统一的图标属性。
 *
 * `reducedMotion="user"` 尊重系统的「减弱动态效果」：
 * 开了该设置的用户对形变会不适，此时降级为瞬间切换。
 */
const shared = {
  reducedMotion: 'user',
  strokeWidth: 1.6,
} as const

/** 图标尺寸。 */
interface IconProps {
  size?: number
}

/** 锁（闭合）。设置面板里的权限图标。 */
export function LockIcon({ size = 13 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Lock} size={size} {...shared} />
}

/** 盾牌。输入框的权限档位与权限说明。 */
export function ShieldIcon({ size = 13 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Shield} size={size} {...shared} />
}

/** 向下箭头。下拉指示。 */
export function ChevronDownIcon({ size = 11 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={ChevronDown} size={size} {...shared} strokeWidth={2} />
}

/** 向左箭头。返回。 */
export function ArrowLeftIcon({ size = 17 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={ArrowLeft} size={size} {...shared} />
}

/** 播放三角。发送。 */
export function PlayIcon({ size = 14 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Play} size={size} {...shared} />
}

/**
 * 纸飞机。发送键的主图标。
 *
 * 我此前用的是向上箭头，并给自己找了理由（"对话是即时往返，
 * 箭头比机翼清楚"）。那是拿审美判断替掉事实——原版发送键用的
 * 就是纸飞机，实测截图里是一个指向右上的实心三角带一道折痕。
 *
 * 在 34px 的圆里纸飞机反而比箭头更容易认：箭头只有一个方向信息，
 * 纸飞机有"投递"的形状，一眼就知道按下去会发生什么。
 */
export function SendArrowIcon({ size = 15 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Send} size={size} {...shared} strokeWidth={1.8} />
}

/**
 * 停止方块。
 *
 * 与 {@link PlayIcon} 成对使用：两者在同一位置切换时，
 * morphicons 会把三角形插值成方块——这是最直观的"正在生成"反馈。
 */
export function StopIcon({ size = 13 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Square} size={size} {...shared} />
}

/** 更多（水平三点）。 */
export function EllipsisIcon({ size = 15 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={MoreHorizontal} size={size} {...shared} />
}

/** 关闭。 */
export function CloseIcon({ size = 15 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={X} size={size} {...shared} strokeWidth={1.8} />
}

/** 圆圈加号。附加文件。 */
export function PlusCircleIcon({ size = 17 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={PlusCircle} size={size} {...shared} />
}

/** 加号。新建会话。 */
export function PlusIcon({ size = 15 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Plus} size={size} {...shared} strokeWidth={1.8} />
}

/** 麦克风。语音输入。 */
export function MicIcon({ size = 16 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Mic} size={size} {...shared} />
}

/** 回形针。附件提示。 */
export function PaperclipIcon({ size = 13 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Paperclip} size={size} {...shared} />
}

/** 数据库。token 用量。 */
export function DatabaseIcon({ size = 11 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Database} size={size} {...shared} />
}

/** 仪表。上下文占用。 */
export function GaugeIcon({ size = 12 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Gauge} size={size} {...shared} />
}

/** 对话气泡。左栏「对话」标签。 */
export function ChatIcon({ size = 13 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={MessageSquare} size={size} {...shared} />
}

/** 列表。左栏「日志」标签。 */
export function ListIcon({ size = 13 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={List} size={size} {...shared} />
}

/** 星点。"想起"类动作。 */
export function SparklesIcon({ size = 13 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Sparkles} size={size} {...shared} />
}

/**
 * 猫。右栏桌宠卡片的图标。
 *
 * 不能换成星点或任何更"精致"的图形：原版这里是猫，
 * 形状就是 lucide 的 `Cat`（24 网格、1.8 描边），
 * 连两只眼睛那两个短划都在。桌宠的形态就是一只趴着的猫，
 * 用星点会把这个含义整个丢掉。
 */
export function CatIcon({ size = 26 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Cat} size={size} {...shared} strokeWidth={1.8} />
}

/**
 * 三角警告。顶部提示条的图标。
 *
 * 原版那条「新建会话失败」的提示就是三角警告，不是对勾也不是惊叹号圈：
 * 失败是一种"需要你看一眼"的状态，三角形在视觉上比圆形更有中断感。
 */
export function AlertIcon({ size = 16 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={TriangleAlert} size={size} {...shared} strokeWidth={1.8} />
}

/** 信息圆圈。成功类提示。 */
export function InfoIcon({ size = 16 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Info} size={size} {...shared} strokeWidth={1.8} />
}

/**
 * 齿轮。账号菜单「设置」项。
 *
 * 与 {@link SettingsIcon} 是同一个 lucide 图标，保留两个名字是因为
 * 用途不同：这个是菜单项，那个是侧栏入口，将来若分开换形状不必改调用点。
 */
export function GearIcon({ size = 14 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={Settings} size={size} {...shared} strokeWidth={1.7} />
}

/** 纸飞机（水平）。账号菜单「意见反馈」项。 */
export function FeedbackIcon({ size = 14 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={SendHorizonal} size={size} {...shared} strokeWidth={1.7} />
}

/** 人像。账号菜单「关于」项。 */
export function AboutIcon({ size = 14 }: IconProps): React.JSX.Element {
  return <MorphIcon icon={CircleUser} size={size} {...shared} strokeWidth={1.7} />
}
