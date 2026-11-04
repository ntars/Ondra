import { describe, expect, it } from 'vitest'
import { fileMediaUrl } from '../src/index.ts'

describe('fileMediaUrl', () => {
  it.each(['/work/测试 文件#100%.png', 'C:\\work\\测试 文件.png'])(
    'preserves the decoded native path %s under a mounted application', (path) => {
      const url = new URL(fileMediaUrl('https://host/tools/ondra/', path)!)
      expect(url.pathname).toBe('/tools/ondra/api/file')
      expect(url.searchParams.get('path')).toBe(path)
    },
  )
  it.each(['image.png', '//host/image.png', '\\\\host\\image.png', '/work/\u0000.png', '/work/\n.png'])(
    'rejects a non-local or invalid path %s', (path) => {
      expect(fileMediaUrl('https://host/', path)).toBeUndefined()
    },
  )
  it.each(['ondra-app://app/', 'ondra-app://app/index.html'])(
    'serves decoded native paths through the Desktop application %s', (base) => {
      for (const path of ['/work/测试 文件#100%.png', 'C:\\work\\测试 文件.png']) {
        const url = new URL(fileMediaUrl(base, path)!)
        expect(url.href.split('?')[0]).toBe('ondra-app://app/api/file')
        expect(url.searchParams.get('path')).toBe(path)
      }
    },
  )
  it.each(['file:///app/', 'ondra-app://shell/', 'ondra-app://app.example/', 'ondra-app://app:80/',
    'ondra-app://user@app/', 'ondra-app://app@other/', 'about:blank'])(
    'rejects an unsupported application base %s', (base) => {
      expect(fileMediaUrl(base, '/work/image.png')).toBeUndefined()
    },
  )
})
