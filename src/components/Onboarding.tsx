/**
 * 首次启动引导。
 *
 * ## 为什么是一个覆盖层而不是独立页
 *
 * 引导只出现一次，目的是把"这是个什么、要填什么"讲清楚，然后立刻进入主界面。
 * 做成覆盖层，结束引导后背后的主界面已经在位，不用再跳转一次。
 *
 * ## 内容取舍
 *
 * 只讲三件事：它是什么、要配模型才能对话、权限是什么意思。
 * 不在这时逼用户填密钥——引导结束进主界面，模型供应商入口就在设置里。
 * 给一个"稍后再说"让怕麻烦的用户也能直接进。
 */

import { useState } from 'react'
import logoUrl from '../../icon.svg'

/** 引导步骤。 */
const STEPS = [
  '欢迎',
  '模型',
  '权限',
] as const

/** 组件属性。 */
export interface OnboardingProps {
  /** 引导结束（完成或跳过）。 */
  onDone(): void
}

/**
 * 渲染引导。
 */
export function Onboarding(props: OnboardingProps): React.JSX.Element {
  const [step, setStep] = useState(0)
  const isLast = step === STEPS.length - 1

  const next = (): void => {
    if (isLast) props.onDone()
    else setStep((value) => value + 1)
  }

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-label="初始引导">
      <div className="onboarding__card">
        <img className="onboarding__logo" src={logoUrl} alt="" draggable={false} />

        {step === 0 ? (
          <section className="onboarding__step">
            <h2 className="onboarding__title">空谷<em>Ondra</em></h2>
            <p className="onboarding__lead">
              一个安静的对话伙伴。在这里书写，于无声处，听见共鸣。
            </p>
            <p className="onboarding__sub">
              On No sound's Depth , Resonance Arises.
            </p>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="onboarding__step">
            <h2 className="onboarding__heading">先接一个模型</h2>
            <p className="onboarding__lead">
              空谷本身不内置模型。要开始对话，需要接入一个 OpenAI 兼容的接口——
              比如 DeepSeek、智谱、Moonshot，或本地的 Ollama / LM Studio。
            </p>
            <p className="onboarding__sub">
              密钥只保存在本机，不会上传。随时能在「设置」里添加或修改。
            </p>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="onboarding__step">
            <h2 className="onboarding__heading">关于权限</h2>
            <p className="onboarding__lead">
              输入框左下角的「完全访问」表示当前档位。它决定空谷能否读写文件、
              执行命令。
            </p>
            <p className="onboarding__sub">
              本版本工具尚未接入，三档行为一致；档位会保留，待功能上线后按此执行。
              你随时可以在「设置」里调整。
            </p>
          </section>
        ) : null}

        <div className="onboarding__foot">
          <div className="onboarding__dots" aria-hidden>
            {STEPS.map((label, index) => (
              <span
                key={label}
                className={`onboarding__dot${index === step ? ' is-active' : ''}`}
              />
            ))}
          </div>
          <div className="onboarding__actions">
            <button type="button" className="button button--ghost" onClick={props.onDone}>
              稍后再说
            </button>
            <button type="button" className="button" onClick={next}>
              {isLast ? '进入空谷' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
