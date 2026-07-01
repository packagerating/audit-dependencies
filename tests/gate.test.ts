import { describe, it, expect } from 'vitest'
import { checkThresholds } from '../src/index'
import type { PackageScore, Thresholds } from '../src/types'

const scored = (name: string, g: number, a: number, r: number): PackageScore => ({
  name, generalScore: g, automationScore: a, riskScore: r, status: 'scored',
})
const unscored = (name: string): PackageScore => ({
  name, generalScore: null, automationScore: null, riskScore: null, status: 'unscored',
})
const partiallyScored = (name: string, g: number | null, a: number | null, r: number | null): PackageScore => ({
  name, generalScore: g, automationScore: a, riskScore: r, status: 'scored',
})

describe('checkThresholds', () => {
  it('returns empty array when no thresholds are set', () => {
    const result = checkThresholds([scored('pkg', 30, 30, 30)], { general: null, automation: null, risk: null })
    expect(result).toEqual([])
  })

  it('returns failure when general score is below threshold', () => {
    const result = checkThresholds(
      [scored('pkg', 30, 80, 80)],
      { general: 50, automation: null, risk: null },
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('pkg')
    expect(result[0]).toContain('general: 30 < 50')
  })

  it('returns failure when automation score is below threshold', () => {
    const result = checkThresholds(
      [scored('pkg', 80, 30, 80)],
      { general: null, automation: 50, risk: null },
    )
    expect(result[0]).toContain('automation: 30 < 50')
  })

  it('returns failure when risk score is below threshold', () => {
    const result = checkThresholds(
      [scored('pkg', 80, 80, 30)],
      { general: null, automation: null, risk: 50 },
    )
    expect(result[0]).toContain('risk: 30 < 50')
  })

  it('includes all failing dimensions in one entry per package', () => {
    const result = checkThresholds(
      [scored('pkg', 20, 20, 20)],
      { general: 50, automation: 50, risk: 50 },
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('general')
    expect(result[0]).toContain('automation')
    expect(result[0]).toContain('risk')
  })

  it('skips unscored packages', () => {
    const result = checkThresholds(
      [unscored('pkg')],
      { general: 50, automation: 50, risk: 50 },
    )
    expect(result).toEqual([])
  })

  it('passes when score exactly equals threshold', () => {
    const result = checkThresholds(
      [scored('pkg', 50, 50, 50)],
      { general: 50, automation: 50, risk: 50 },
    )
    expect(result).toEqual([])
  })

  it('does not fail when null dimension has a threshold but other dimensions pass', () => {
    const result = checkThresholds(
      [partiallyScored('pkg', 80, null, 80)],
      { general: null, automation: 50, risk: null },
    )
    expect(result).toEqual([])
  })
})
