/**
 * 设置 · 隐私中心（G10）。
 *
 * ## 这一页只做一件事：把「您的数据去哪了」讲清楚
 *
 * 它不提供开关——本应用没有可关闭的联网行为需要在这里收口。
 * 它的存在本身就是一份承诺：数据落在哪、什么会出网、离线能不能用，
 * 都写在明面上，不藏在条款链接背后。
 */

import { useEffect, useState } from 'react'
import { invokeShell } from '../lib/shell.ts'
import { Heading, Note, Row } from './settingsUi.tsx'

/** 取数据目录并「在访达中显示」。 */
async function showDataDir(): Promise<void> {
  try {
    const path = await invokeShell<string>('app_data_path')
    await invokeShell<void>('reveal_in_folder', { path })
  } catch (caught) {
    console.error('打开数据目录失败', caught)
  }
}

export function SettingsPrivacy(): React.JSX.Element {
  const [path, setPath] = useState<string | undefined>(undefined)
  useEffect(() => {
    void (async () => {
      try {
        setPath(await invokeShell<string>('app_data_path'))
      } catch {
        /* 浏览器开发态取不到路径：页面其余内容照常显示 */
      }
    })()
  }, [])

  return (
    <section className="pref__section">
      <Heading>数据存放位置</Heading>
      <Note>
        所有会话、记忆、世界书、知识库、模型配置与备份都保存在本机的「应用支持目录」中，
        不强制上云。您可随时在文件管理器中查看这一目录。
      </Note>
      <Row label="数据目录" hint={path === undefined ? '正在读取…' : path}>
        <button type="button" className="button button--ghost" onClick={() => { void showDataDir() }}>
          在访达中显示
        </button>
      </Row>

      <Heading>联网范围</Heading>
      <Note>
        联网仅发生在向您所选的模型服务发起对话请求时。选择本地推理或免费模型时，
        对话可完全离线进行。内置浏览器仅加载已批准地址，不会在后台访问任意站点。
      </Note>

      <Heading>离线能力</Heading>
      <Note>
        使用本地或免费模型时，对话、记忆、世界书、知识库与备份均在本机完成，无需网络。
        此时即使断开网络，全部既有功能仍可使用。
      </Note>

      <Heading>我们如何处理您的数据</Heading>
      <Note>
        对话与记忆用于让陪伴体更理解您，它们不用于训练任何第三方模型，也不会离开本机——
        除非您主动导出或恢复。除您选定的模型服务提供商会收到您发送的内容外，
        我们不向其他第三方共享您的数据。
      </Note>
    </section>
  )
}
