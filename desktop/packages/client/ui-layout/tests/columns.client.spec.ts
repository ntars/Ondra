import { describe, expect, it } from 'vitest'
import { computeColumns, RIGHTBAR_RATIO, SIDEBAR_RATIO } from '../src/client/columns.ts'

describe('computeColumns', () => {
  it('cuts the frame into quarters: 1/4 left, 2/4 centre, 1/4 right', () => {
    expect(computeColumns(1200)).toEqual({ sidebar: 300, center: 600, rightbar: 300 })
    expect(computeColumns(1920)).toEqual({ sidebar: 480, center: 960, rightbar: 480 })
  })

  it('holds the same split at every frame width', () => {
    expect(computeColumns(900)).toEqual({ sidebar: 225, center: 450, rightbar: 225 })
    expect(computeColumns(2400)).toEqual({ sidebar: 600, center: 1200, rightbar: 600 })
  })

  it('rounds the side tracks and lets the centre absorb the remainder', () => {
    const cols = computeColumns(1001)
    expect(cols.sidebar).toBe(250)
    expect(cols.rightbar).toBe(250)
    expect(cols.center).toBe(501)
  })

  it('never lets the centre go negative', () => {
    expect(computeColumns(0)).toEqual({ sidebar: 0, center: 0, rightbar: 0 })
  })

  it('states the split as ratios, not pixels', () => {
    expect(SIDEBAR_RATIO + RIGHTBAR_RATIO).toBe(0.5)
  })
})
