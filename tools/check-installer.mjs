#!/usr/bin/env node
// NSIS 安装脚本语法检查（§10.13）。
//
// 为什么需要它：`src-tauri/installer/installer.nsi` 只能在 Windows 上被
// Tauri 打包器真正吃进去。在此之前它有 1000 多行、含 Handlebars 占位符，
// 任何一处写错（顶层写指令、宏名打错、变量未声明）都要等到 Windows CI
// 上才暴露。这个脚本在本机就把语法问题拦下来。
//
// 它做四件事：
//   1. 把 `{{...}}` 按 Tauri 的默认值渲染成字面量（剥掉 `{{#if}}` 块）；
//   2. 补两份桩：`utils.nsh` / `FileAssociation.nsh` 由 tauri-bundler 生成，
//      本机没有；`nsis_tauri_utils::*` 是二进制插件，同样无法在本机加载；
//   3. 用 makensis 真编译一遍，产物丢弃；
//   4. 断言产物是合法 PE（MZ 头），避免「零 error 但没出文件」。
//
// 退出码 0 = 通过。makensis 不存在时退出码 2，调用方据此跳过（不是失败）。

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TEMPLATE = join(ROOT, 'src-tauri/installer/installer.nsi')

// Tauri 默认值。变量名与官方模板里的占位符一一对应；新增占位符时这里要补。
const VARS = {
  compression: 'lzma',
  manufacturer: 'Ntarstudio',
  product_name: 'Ondra',
  version: '0.0.0',
  // VIProductVersion 必须是 X.X.X.X，Tauri 传的是含 build 号的四段。
  version_with_build: '0.0.0.0',
  homepage: 'https://example.invalid/',
  install_mode: 'currentUser',
  license: '',
  installer_icon: 'icons/icon.ico',
  sidebar_image: 'installer/sidebar.bmp',
  header_image: 'installer/header.bmp',
  uninstaller_icon: 'icons/icon.ico',
  uninstaller_header_image: 'installer/header.bmp',
  main_binary_name: 'Ondra.exe',
  main_binary_path: 'Ondra.exe',
  bundle_id: 'com.example.ondra',
  copyright: '(c) 2026 Ntarstudio',
  out_file: 'Ondra-setup.exe',
  arch: 'x64',
  additional_plugins_path: 'plugins',
  allow_downgrades: 'false',
  display_language_selector: 'false',
  install_webview2_mode: 'downloadBootstrapper',
  webview2_installer_args: '',
  webview2_bootstrapper_path: '',
  webview2_installer_path: '',
  minimum_webview2_version: '96.0.1054.43',
  uninstaller_sign_cmd: '',
  estimated_size: '120000',
  start_menu_folder: 'Ondra',
}

const STUB_UTILS = `; [check-installer 桩] 由 tauri-bundler 生成，本机没有。
!macro SetContext
!macroend
!macro CheckIfAppIsRunning ARG1 ARG2
!macroend
!macro DeleteAppUserModelId
!macroend
!macro IsShortcutTarget ARG1 ARG2
  StrCpy $0 0
!macroend
!macro SetShortcutTarget ARG1 ARG2
!macroend
!macro UnpinShortcut ARG1
!macroend
!macro SetLnkAppUserModelId ARG1
!macroend
`

const STUB_ASSOC = `; [check-installer 桩] 由 tauri-bundler 生成，本机没有。
!macro APP_ASSOCIATE EXT NAME DESC CMD ICON DESC2 CMD2
!macroend
!macro APP_UNASSOCIATE EXT NAME
!macroend
`

/** 按 Tauri 的渲染规则把模板拍平成纯 NSIS：剥掉所有 `{{#...}}` 块，替换叶子占位符。 */
function render(source) {
  const out = []
  let depth = 0
  const unknown = new Set()

  for (const line of source.split('\n')) {
    const trimmed = line.trim()

    if (/^\{\{[#/]/.test(trimmed)) {
      depth += trimmed.startsWith('{{/') ? -1 : 1
      if (depth < 0) throw new Error(`多余的块结束标记：${trimmed}`)
      continue
    }
    if (/^\{\{else/.test(trimmed)) {
      if (depth === 0) throw new Error(`块外的 {{else}}：${trimmed}`)
      continue
    }
    if (depth > 0) continue

    out.push(
      line.replace(/\{\{\s*([A-Za-z0-9_.\[\]@ ]+?)\s*\}\}/g, (_, name) => {
        if (!(name in VARS)) {
          unknown.add(name)
          return ''
        }
        return VARS[name]
      }),
    )
  }

  if (depth !== 0) throw new Error(`块未闭合，剩余层级 ${depth}`)
  return { text: out.join('\n'), unknown }
}

/** 插件是 Windows 二进制，本机加载不了；把调用换成注释，只验它周围的语法。 */
function stubPluginCalls(text) {
  return text.replace(
    /nsis_tauri_utils::(\w+)([^\n]*)/g,
    (_, name, rest) => `; [check-installer 桩] 原指令：nsis_tauri_utils::${name}${rest}`,
  )
}

function main() {
  if (!existsSync(TEMPLATE)) {
    console.error(`✗ 找不到模板：${TEMPLATE}`)
    return 1
  }

  const probe = spawnSync('makensis', ['-VERSION'], { encoding: 'utf8' })
  if (probe.error) {
    console.log('· makensis 不在 PATH，跳过安装脚本语法检查')
    console.log('  macOS: brew install makensis   Debian: apt install nsis')
    return 2
  }

  const { text, unknown } = render(readFileSync(TEMPLATE, 'utf8'))
  const work = mkdtempSync(join(tmpdir(), 'ondra-nsi-'))

  try {
    // 图标与位图必须是真文件：makensis 会读它们的头，空文件直接报
    // “unable to read header from file”，那会把语法错误盖住。
    mkdirSync(join(work, 'icons'), { recursive: true })
    mkdirSync(join(work, 'installer'), { recursive: true })
    mkdirSync(join(work, 'plugins'), { recursive: true })

    const icon = join(ROOT, 'src-tauri/icons/icon.ico')
    if (existsSync(icon)) {
      writeFileSync(join(work, 'icons/icon.ico'), readFileSync(icon))
      writeFileSync(join(work, 'installer/bmp.ico'), readFileSync(icon))
    }
    // 150×57 与 164×314 是 MUI 的硬要求，尺寸不对会拒绝加载。
    writeFileSync(join(work, 'installer/header.bmp'), bmp(150, 57))
    writeFileSync(join(work, 'installer/sidebar.bmp'), bmp(164, 314))
    writeFileSync(join(work, 'Ondra.exe'), 'stub')

    writeFileSync(join(work, 'utils.nsh'), STUB_UTILS)
    writeFileSync(join(work, 'FileAssociation.nsh'), STUB_ASSOC)
    writeFileSync(join(work, 'setup.nsi'), stubPluginCalls(text))

    const build = spawnSync('makensis', ['-V2', 'setup.nsi'], {
      cwd: work,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    const log = `${build.stdout ?? ''}${build.stderr ?? ''}`

    // 桩带来的噪声：语言表只填了一种、MUI 内部变量未被引用。这些不是模板问题。
    // 只认 makensis 自己的错误行——不能按 "error" 子串匹配，因为
    // `webview2DownloadError` 这类 LangString 名字里也含 error。
    const fatal = log
      .split('\n')
      .filter((line) => /^\s*(Error|Error in |Invalid command|Usage:|aborting creation)/i.test(line))
      .filter((line) => !/^\s*warning/i.test(line))

    if (fatal.length > 0) {
      console.error('✗ 安装脚本语法检查未通过：')
      for (const line of fatal.slice(0, 20)) console.error(`  ${line.trim()}`)
      return 1
    }

    const artifact = join(work, 'Ondra-setup.exe')
    if (!existsSync(artifact)) {
      console.error('✗ 编译零 error 但没有产物，检查 OUTFILE 与文件权限')
      return 1
    }
    const head = readFileSync(artifact).subarray(0, 2).toString('latin1')
    if (head !== 'MZ') {
      console.error(`✗ 产物不是 PE 可执行文件（头两字节 ${JSON.stringify(head)}）`)
      return 1
    }

    if (unknown.size > 0) {
      console.error(`✗ 模板里有未登记的占位符：${[...unknown].join(', ')}`)
      return 1
    }

    const size = (readFileSync(artifact).length / 1024).toFixed(0)
    console.log(`✓ 安装脚本语法通过（makensis ${probe.stdout.trim()}，产物 ${size} KB）`)
    return 0
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** 生成一张纯色 BMP，只为满足 MUI 加载图片时的头校验。 */
function bmp(width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixels = Buffer.alloc(rowSize * height, 0xf5)
  const header = Buffer.alloc(54)
  header.write('BM', 0, 'latin1')
  header.writeUInt32LE(54 + pixels.length, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(width, 18)
  header.writeInt32LE(height, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  header.writeUInt32LE(pixels.length, 34)
  return Buffer.concat([header, pixels])
}

process.exitCode = main()
