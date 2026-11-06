/**
 * 纯判定层：**一个动作该不该做、要不要人点头**。
 *
 * 本文件不碰 IO、不碰时间戳、不碰计数——给同样的输入永远给同样的结论，
 * 因此「面板上看到的判定」与「真的执行时的判定」不可能不一致
 * （`plan()` 与 `act()` 复查都调这里，不各自写一份）。
 *
 * ## 判定顺序（顺序本身是设计，不许随意调）
 *
 * ```
 * 1 开关关着            → blocked / disabled
 * 2 后端不在            → blocked / no-runner
 * 3 观察过期            → blocked / stale-observation
 * 4 动作不认识          → blocked / unknown-action
 * 5 观察动作            → readonly / ok（到此为止，不碰后面任何闸）
 * 6 参数形状不对        → blocked / bad-target 或 text-too-long
 * 7 App 不在白名单      → blocked / app-not-allowed
 * 8 落在危险区          → blocked / danger-zone
 * 9 表单红线            → blocked / form-red-line
 * 10 超过风险上限       → blocked / risk-over-ceiling
 * 11 达到确认阈值       → need-confirm（允许，但要票）
 * ```
 *
 * 为什么「观察动作」排在第 5 位就返回：观察不改变屏幕，把它也塞进
 * 白名单与危险区判定，等于「想看一眼还得先配好 App 白名单」——
 * 而 §9.11 记着的旧实现正是这种「只看也要过闸」，用户很快就把整套闸门关了。
 *
 * ## 表单红线里那个 `unknown`（本轮最需要解释的一条）
 *
 * 手册只有一句「检测到已填表单立即收手」。检测不到的时候怎么处理，手册没说。
 * 三种做法各有代价：
 *
 * - 当成 `filled` → 绝大多数机器永远拿不到表单状态，功能全废（假开关）；
 * - 当成 `none`   → 真的填了一半时继续打字，可能覆盖或提交；
 * - **本包取法**：`filled` 直接拦；`unknown` 时**只把 `type` 按 high 处理并要求确认**，
 *   `click` 不受影响。理由是不对称的：点击错一下通常可撤销，
 *   而「在一个填了一半的表单里再打一段字」是不可逆的（可能直接提交）。
 *
 * `key` 恒为 `high`：`cmd-q`（退出）、`cmd-w`（关窗）、`cmd-enter`（提交）都是按键，
 * 「按键只是个小动作」这个直觉在这里是错的。
 */

import type {
  ActionKind,
  DecideInput,
  Observation,
  Point,
  RiskLevel,
  ScreenBox,
  StepDecision,
  ZoneSpec,
} from './types.js'
import { KEY_RE, TEXT_MAX } from './types.js'

/**
 * 风险等级的名次（越大越严重）。
 * @param level 等级。
 */
export function riskRankOf(level: RiskLevel): number {
  switch (level) {
    case 'readonly':
      return 0
    case 'low':
      return 1
    case 'high':
      return 2
    default:
      return 3
  }
}

/**
 * 动作的基础风险。
 * @param action 动作。
 */
export function baseRiskOf(action: ActionKind): RiskLevel {
  if (action === 'observe') return 'readonly'
  if (action === 'click') return 'low'
  // type 与 key 都是 high：打字可能覆盖已有内容，按键可能触发退出/提交。
  return 'high'
}

/**
 * 屏幕坐标是否落在某个危险区里。
 *
 * 归一化比较，且对「屏幕尺寸为 0」的情况直接返回 `undefined`（判不出来就不判，
 * 但 `decide()` 会在更前面把尺寸不合法的观察判成过期，不会走到这里）。
 * @param point 像素坐标。
 * @param screen 屏幕尺寸。
 * @param zones 危险区。
 */
export function zoneAt(point: Point, screen: ScreenBox, zones: readonly ZoneSpec[]): string | undefined {
  if (screen.width <= 0 || screen.height <= 0) return undefined
  const nx = point.x / screen.width
  const ny = point.y / screen.height
  for (const zone of zones) {
    if (nx >= zone.x && nx <= zone.x + zone.w && ny >= zone.y && ny <= zone.y + zone.h) return zone.id
  }
  return undefined
}

/**
 * 把坐标量化到网格（审计用）。
 *
 * 审计要能对账「大概点了哪儿」，但不需要精确到像素——
 * 精确坐标配上时间戳足以还原用户的操作轨迹，那是监控不是审计。
 * @param point 像素坐标。
 * @param grid 网格大小（像素）。
 */
export function quantize(point: Point, grid: number): Point {
  const step = grid > 0 ? grid : 1
  return {
    x: Math.round(point.x / step) * step,
    y: Math.round(point.y / step) * step,
  }
}

/**
 * 按键名是否合法（形状白名单，不做转义）。
 * @param key 键名。
 */
export function keyOk(key: string): boolean {
  return KEY_RE.test(key)
}

/**
 * 文本是否可接受。
 * @param text 文本。
 * @param max 上限。
 */
export function textOk(text: string, max: number): boolean {
  if (text === '') return false
  if (text.length > max) return false
  // NUL 字符会在多数后端被截断成半句，与其静默截断不如直接拒。
  return !text.includes('\u0000')
}

/**
 * App 是否在白名单里（不区分大小写，**不做通配**）。
 * @param app 前台应用名。
 * @param list 白名单。
 */
export function appAllowed(app: string, list: readonly string[]): boolean {
  const target = app.trim().toLowerCase()
  if (target === '') return false
  return list.some(item => item.trim().toLowerCase() === target)
}

/**
 * 判一次。
 * @param input 判定输入。
 */
export function decide(input: DecideInput): StepDecision {
  const { settings, request, observation, now, runnerReady } = input
  const app = observation.foreground.app

  const deny = (
    code: StepDecision['code'],
    risk: RiskLevel,
    reason: string,
    hint?: string,
    zone?: string,
  ): StepDecision => {
    const base: StepDecision = {
      allowed: false,
      risk,
      requiresConfirm: false,
      code,
      reason,
      app,
      at: now,
    }
    if (hint === undefined && zone === undefined) return base
    return {
      ...base,
      ...(hint === undefined ? {} : { hint }),
      ...(zone === undefined ? {} : { zone }),
    }
  }

  if (!settings.enable) {
    return deny('disabled', 'blocked', '图形界面自动化是关着的。', '打开 enable 之后会先只允许观察。')
  }
  if (!runnerReady) {
    return deny(
      'no-runner',
      'blocked',
      '没有任何后端能看屏幕或合成事件，所以这一步做不了。',
      '装一个实现 GuiRunner 的端口（截屏 + 合成事件）并 useRunner() 接进来；在那之前本包只做判定。',
    )
  }

  const ttl = settings.observationTtlMs
  if (!Number.isFinite(observation.at) || observation.screen.width <= 0 || observation.screen.height <= 0) {
    return deny(
      'stale-observation',
      'blocked',
      '这次观察没有可用的屏幕尺寸，坐标无从换算。',
      '重新 observe 一次再决定；不要拿手工编的观察结果来规划。',
    )
  }
  if (ttl > 0 && now - observation.at > ttl) {
    return deny(
      'stale-observation',
      'blocked',
      `这次观察是 ${Math.round((now - observation.at) / 1000)} 秒前的，已经过期。`,
      '重新 observe 一次：旧截图里的按钮可能已经不在原位，按坐标点会点到别处。',
    )
  }

  const action = request.action
  if (action !== 'observe' && action !== 'click' && action !== 'type' && action !== 'key') {
    return deny('unknown-action', 'blocked', `不认识的动作 ${String(action)}。`, '只支持 observe / click / type / key。')
  }

  // 5. 观察到此为止：不碰白名单、不碰危险区。
  if (action === 'observe') {
    return {
      allowed: true,
      risk: 'readonly',
      requiresConfirm: false,
      code: 'ok',
      reason: '观察是只读动作，不需要确认。',
      app,
      at: now,
    }
  }

  // 6. 参数形状。
  if (action === 'click') {
    const clickPoint = request.point
    if (clickPoint === undefined || !Number.isFinite(clickPoint.x) || !Number.isFinite(clickPoint.y)) {
      return deny('bad-target', 'blocked', '点击没有给出有效坐标。', '先 observe 拿到屏幕尺寸，再按截图里的位置给 point。')
    }
    if (
      clickPoint.x < 0 ||
      clickPoint.y < 0 ||
      clickPoint.x > observation.screen.width ||
      clickPoint.y > observation.screen.height
    ) {
      return deny(
        'bad-target',
        'blocked',
        '坐标落在屏幕之外。',
        `屏幕是 ${observation.screen.width}×${observation.screen.height}，坐标必须在 0 到宽高之间。`,
      )
    }
  }
  if (action === 'type') {
    const text = request.text
    if (typeof text !== 'string' || !textOk(text, Math.min(settings.textMax, TEXT_MAX))) {
      const given = typeof text === 'string' ? text.length : 0
      return deny(
        'text-too-long',
        'blocked',
        given === 0 ? '没有给出要输入的文本。' : `文本 ${given} 字，超过上限 ${Math.min(settings.textMax, TEXT_MAX)} 字。`,
        '短内容直接输入；长内容走粘贴或让用户自己贴——一个字一个字敲既慢又容易错。',
      )
    }
  }
  if (action === 'key') {
    const key = request.key
    if (typeof key !== 'string' || !keyOk(key)) {
      return deny(
        'bad-target',
        'blocked',
        '按键名不合法。',
        '键名只能是「小写字母开头 + 小写字母/数字/连字符」，例如 enter、escape、cmd-s。',
      )
    }
  }

  // 7. App 白名单。
  if (!appAllowed(app, settings.appAllowList)) {
    const name = app.trim() === '' ? '（未知应用）' : app
    return deny(
      'app-not-allowed',
      'blocked',
      `「${name}」不在 App 白名单里，所以不许在它上面操作。`,
      '把要操作的 App 名加进 app-allow-list（不区分大小写、不支持通配）；名单为空时一个都不许。',
    )
  }

  // 8. 危险区。
  const point = request.point
  if (point !== undefined) {
    const zone = zoneAt(point, observation.screen, settings.dangerZones)
    if (zone !== undefined) {
      return deny(
        'danger-zone',
        'blocked',
        `这个位置落在危险区「${zone}」里。`,
        '危险区是菜单栏、窗口按钮、Dock 这类「点错就关窗/退出/切走」的地方；换个位置，或按自己的布局改 danger-zones。',
        zone,
      )
    }
  }

  // 9. 表单红线。
  if (settings.formRedLine) {
    if (observation.formState === 'filled') {
      return deny(
        'form-red-line',
        'blocked',
        '画面上有一个已经填了内容的表单，按红线立即收手。',
        '把已填的表单交回给用户：继续操作可能覆盖他已经写好的内容，或直接提交出去。',
      )
    }
    if (observation.formState === 'unknown' && action === 'type') {
      return deny(
        'form-red-line',
        'high',
        '表单状态未知，而这一步要往里打字。',
        '先让观察方给出 formState（none / filled）；不确定时请用户自己输入，或改成点击这类可撤销的动作。',
      )
    }
  }

  // 10/11. 风险上限与确认阈值。
  const risk = baseRiskOf(action)
  if (riskRankOf(risk) > riskRankOf(settings.maxRisk)) {
    return deny(
      'risk-over-ceiling',
      'blocked',
      `这一步的风险是 ${risk}，超过你设的上限 ${settings.maxRisk}。`,
      '要放开就调 max-risk；不想放开就把这一步交回给用户。',
    )
  }
  const requiresConfirm = riskRankOf(risk) >= riskRankOf(settings.confirmThreshold)
  if (requiresConfirm) {
    return {
      allowed: true,
      risk,
      requiresConfirm: true,
      code: 'need-confirm',
      reason: `这一步的风险是 ${risk}，需要有人点头才执行。`,
      hint: '把票号交给界面，等用户确认；模型自己没有批准通道。',
      app,
      at: now,
    }
  }
  return {
    allowed: true,
    risk,
    requiresConfirm: false,
    code: 'ok',
    reason: `这一步的风险是 ${risk}，在白名单应用里、不在危险区，可以直接执行。`,
    app,
    at: now,
  }
}

/**
 * 观察是否还新鲜（服务层与判定层共用同一个判据，避免两处阈值打架）。
 * @param observation 观察。
 * @param now 现在。
 * @param ttl 有效期（毫秒）；`<= 0` 表示不过期。
 */
export function isStale(observation: Observation, now: number, ttl: number): boolean {
  if (ttl <= 0) return false
  if (!Number.isFinite(observation.at)) return true
  return now - observation.at > ttl
}
