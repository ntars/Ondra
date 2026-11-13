/**
 * 设置 · 隐私中心。
 *
 * ## 这一节只做一件事：把「您的数据去哪了」讲清楚
 *
 * 它不提供开关——本应用没有可关闭的联网行为需要在这里收口。
 * 它的存在本身就是一份承诺：数据落在哪、什么会出网、离线能不能用，
 * 都写在明面上，不藏在条款链接背后。
 */

import { useEffect, useState } from 'react'
import { invokeShell } from '../lib/shell.ts'
import { useT } from '../lib/i18n.ts'
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
  const t = useT()
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
      <Heading>{t('privacy.dataDir')}</Heading>
      <Note>{t('privacy.dataDirNote')}</Note>
      <Row label={t('privacy.dataRow')} hint={path === undefined ? t('privacy.pending') : path}>
        <button type="button" className="button button--ghost" onClick={() => { void showDataDir() }}>
          {t('privacy.reveal')}
        </button>
      </Row>

      <Heading>{t('privacy.network')}</Heading>
      <Note>{t('privacy.networkNote')}</Note>

      <Heading>{t('privacy.offline')}</Heading>
      <Note>{t('privacy.offlineNote')}</Note>

      <Heading>{t('privacy.data')}</Heading>
      <Note>{t('privacy.dataNote')}</Note>
    </section>
  )
}
