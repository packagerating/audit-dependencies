import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildMarkdownTable } from '../src/report'
import type { PackageScore, Thresholds } from '../src/types'

// Mock @actions/core and @actions/github — only used by writeJobSummary / upsertPrComment
vi.mock('@actions/core', () => ({
  summary: { addHeading: vi.fn().mockReturnThis(), addRaw: vi.fn().mockReturnThis(), addEOL: vi.fn().mockReturnThis(), write: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('@actions/github', () => ({
  context: { eventName: 'push', payload: {}, repo: { owner: 'o', repo: 'r' } },
  getOctokit: vi.fn(),
}))

const none: Thresholds = { general: null, automation: null, risk: null }

describe('buildMarkdownTable', () => {
  it('sorts ascending by generalScore — lowest first', () => {
    const scores: PackageScore[] = [
      { name: 'good', generalScore: 90, automationScore: 85, riskScore: 80, status: 'scored' },
      { name: 'bad',  generalScore: 30, automationScore: 40, riskScore: 35, status: 'scored' },
      { name: 'mid',  generalScore: 60, automationScore: 65, riskScore: 55, status: 'scored' },
    ]
    const lines = buildMarkdownTable(scores, none).split('\n')
    // lines[0] = header, lines[1] = separator, lines[2..] = data rows
    expect(lines[2]).toContain('bad')
    expect(lines[3]).toContain('mid')
    expect(lines[4]).toContain('good')
  })

  it('places unscored packages at the bottom regardless of other scores', () => {
    const scores: PackageScore[] = [
      { name: 'scored',   generalScore: 50, automationScore: 60, riskScore: 55, status: 'scored' },
      { name: 'unscored', generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const lines = buildMarkdownTable(scores, none).split('\n')
    expect(lines[2]).toContain('scored')
    expect(lines[3]).toContain('unscored')
  })

  it('shows ✅ when score meets threshold', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', generalScore: 75, automationScore: 80, riskScore: 70, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: 50, risk: 50 })
    expect(table).toContain('✅')
    expect(table).not.toContain('⚠️')
  })

  it('shows ⚠️ when score is below threshold', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', generalScore: 30, automationScore: 40, riskScore: 35, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: 50, risk: 50 })
    expect(table).toContain('⚠️')
  })

  it('shows plain number when no threshold is configured for that dimension', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', generalScore: 75, automationScore: 80, riskScore: 70, status: 'scored' },
    ]
    // Only general threshold set — automation and risk should show plain numbers
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toMatch(/75.*✅/)   // general: passes threshold
    expect(table).toContain('80')     // automation: plain number
    expect(table).toContain('70')     // risk: plain number
  })

  it('shows — for null scores', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const table = buildMarkdownTable(scores, none)
    expect(table).toContain('—')
  })

  it('shows "Crawl timed out" note for unscored status', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    expect(buildMarkdownTable(scores, none)).toContain('Crawl timed out')
  })

  it('shows "Crawl error" note for crawl-error status', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', generalScore: null, automationScore: null, riskScore: null, status: 'crawl-error' },
    ]
    expect(buildMarkdownTable(scores, none)).toContain('Crawl error')
  })
})
