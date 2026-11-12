/**
 * 设置 · 外观。
 *
 * 主题、字号、语言三件放在同一页：它们回答的是同一个问题——
 * **「这个界面看起来是什么样」**。分成三页会让「想调大一点字」的人
 * 先点一次「字号」再点一次「主题」才发现两者挨着。
 *
 * 语言只有一档，但仍然列出来：藏起来的话，用户找不到语言选项会怀疑
 * 是没装全。列一档并说明原因，比留白诚实。
 */

import { usePreferences, setPreferences } from '../lib/preferences.ts'
import type { FontScale } from '../lib/preferences.ts'
import type { ThemeMode } from '../lib/api.ts'
import { Choices, Heading, Note } from './settingsUi.tsx'

export function SettingsAppearance(): React.JSX.Element {
  const prefs = usePreferences()

  return (
    <section className="pref__section">
      <Heading>主题</Heading>
      <Choices<ThemeMode>
        name="主题"
        value={prefs.theme}
        onChange={(next) => { setPreferences({ theme: next }) }}
        options={[
          { value: 'system', label: '跟随系统', hint: '随系统外观同步切换' },
          { value: 'light', label: '浅色', hint: '纸白' },
          { value: 'dark', label: '深色', hint: '墨夜' },
        ]}
      />
      <Note>
        跟随系统时，主题随系统外观同步切换。选择浅色或深色后，将固定使用所选主题，不再随系统变化。
      </Note>

      <Heading>字号</Heading>
      <Choices<FontScale>
        name="字号"
        value={prefs.fontScale}
        onChange={(next) => { setPreferences({ fontScale: next }) }}
        options={[
          { value: 'small', label: '小', hint: '15px' },
          { value: 'standard', label: '标准', hint: '16px' },
          { value: 'large', label: '大', hint: '18px' },
        ]}
      />
      {/*
        预演：拖动后下方示例句按新字号重排。
        它用的是真实的正文字号令牌，所以不是"画一个大概"。
      */}
      <div className="pref__sample">
        <p className="pref__sample-text">于无声处，听见共鸣。这句话按当前字号排出来。</p>
        <span className="pref__sample-meta">
          示例用正文字号（--text-body），不是缩放整个示例块
        </span>
      </div>
      <Note>
        这里改的是全局比例，会在系统字号的基础上再放大或缩小。系统里已经调大过的人，
        用「标准」不会把他调回小字。
      </Note>

      <Heading>语言</Heading>
      <Choices<'zh-CN'>
        name="语言"
        value="zh-CN"
        onChange={() => { /* 只有一档，无从切换 */ }}
        options={[{ value: 'zh-CN', label: '简体中文', hint: '当前唯一语言' }]}
      />
      <Note>
        界面文案、错误提示、日期格式与人格语料都是简体中文写死的，没有可切换的第二套。
        这一页保留一个不可选的原因是：让它明确地只有一档，比藏起来好——
        用户找不到语言选项时会怀疑是没装全。
      </Note>
    </section>
  )
}
