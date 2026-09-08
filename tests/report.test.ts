import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildMarkdownTable } from '../src/report'
import { isBelowThreshold } from '../src/index'
import type { PackageScore, Thresholds } from '../src/types'

// Mock @actions/core and @actions/github — only used by writeJobSummary / upsertPrComment
vi.mock('@actions/core', () => ({
  summary: { addHeading: vi.fn().mockReturnThis(), addRaw: vi.fn().mockReturnThis(), addEOL: vi.fn().mockReturnThis(), write: vi.fn().mockResolvedValue(undefined) },
  warning: vi.fn(),
}))
vi.mock('@actions/github', () => ({
  context: { eventName: 'push', payload: {}, repo: { owner: 'o', repo: 'r' } },
  getOctokit: vi.fn(),
}))

const none: Thresholds = { general: null, automation: null, risk: null }

describe('buildMarkdownTable', () => {
  it('sorts ascending by generalScore — lowest first', () => {
    const scores: PackageScore[] = [
      { name: 'good', version: '1.0.0', generalScore: 90, automationScore: 85, riskScore: 80, status: 'scored' },
      { name: 'bad',  version: '1.0.0', generalScore: 30, automationScore: 40, riskScore: 35, status: 'scored' },
      { name: 'mid',  version: '1.0.0', generalScore: 60, automationScore: 65, riskScore: 55, status: 'scored' },
    ]
    const lines = buildMarkdownTable(scores, none).split('\n')
    // lines[0] = header, lines[1] = separator, lines[2..] = data rows
    expect(lines[2]).toContain('bad')
    expect(lines[3]).toContain('mid')
    expect(lines[4]).toContain('good')
  })

  it('places unscored packages at the bottom regardless of other scores', () => {
    const scores: PackageScore[] = [
      { name: 'scored',   version: '1.0.0', generalScore: 50, automationScore: 60, riskScore: 55, status: 'scored' },
      { name: 'unscored', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const lines = buildMarkdownTable(scores, none).split('\n')
    expect(lines[2]).toContain('scored')
    expect(lines[3]).toContain('unscored')
  })

  it('shows ✅ for general/automation when score meets threshold, and for risk when at or below threshold', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: '1.0.0', generalScore: 75, automationScore: 80, riskScore: 20, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: 50, risk: 50 })
    expect(table).toContain('✅')
    expect(table).not.toContain('⚠️')
  })

  it('shows ⚠️ for general/automation when score is below threshold', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: '1.0.0', generalScore: 30, automationScore: 40, riskScore: 20, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: 50, risk: 50 })
    expect(table).toContain('⚠️')
  })

  it('shows ⚠️ for risk when score is above threshold', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: '1.0.0', generalScore: 80, automationScore: 80, riskScore: 70, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: null, automation: null, risk: 50 })
    expect(table).toContain('⚠️')
  })

  it('shows ✅ for risk when score is at or below threshold', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: '1.0.0', generalScore: 80, automationScore: 80, riskScore: 50, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: null, automation: null, risk: 50 })
    expect(table).toContain('✅')
    expect(table).not.toContain('⚠️')
  })

  it('shows plain number when no threshold is configured for that dimension', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: '1.0.0', generalScore: 75, automationScore: 80, riskScore: 70, status: 'scored' },
    ]
    // Only general threshold set — automation and risk should show plain numbers
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toMatch(/75.*✅/)   // general: passes threshold
    expect(table).toContain('80')     // automation: plain number
    expect(table).toContain('70')     // risk: plain number
  })

  it('shows — for null scores', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const table = buildMarkdownTable(scores, none)
    expect(table).toContain('—')
  })

  it('shows "Crawl timed out" note for unscored status', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    expect(buildMarkdownTable(scores, none)).toContain('Crawl timed out')
  })

  it('shows "Crawl error" note for crawl-error status', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'crawl-error' },
    ]
    expect(buildMarkdownTable(scores, none)).toContain('Crawl error')
  })

  it('shows "Rate limited" note for rate-limited status', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'rate-limited' },
    ]
    expect(buildMarkdownTable(scores, none)).toContain('Rate limited')
  })

  it('shows the package version in its own column', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: '4.17.21', generalScore: 80, automationScore: 80, riskScore: 20, status: 'scored' },
    ]
    const lines = buildMarkdownTable(scores, none).split('\n')
    expect(lines[0]).toBe('| Package | Version | General | Automation | Risk | Note |')
    expect(lines[2]).toContain('4.17.21')
  })

  it('shows — for a null version', () => {
    const scores: PackageScore[] = [
      { name: 'pkg', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const lines = buildMarkdownTable(scores, none).split('\n')
    // header | separator | one data row — count the pipe-delimited cells in the data row
    const cells = lines[2]!.split('|').map(c => c.trim()).filter(c => c.length > 0)
    expect(cells[1]).toBe('—') // Version cell, second column
  })

  it('shows the below-threshold link for a scored package that fails a configured threshold', () => {
    const scores: PackageScore[] = [
      { name: 'risky-pkg', version: '1.0.0', generalScore: 30, automationScore: 80, riskScore: 20, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain('[Below threshold — see why →](https://packagerating.com/packages/risky-pkg)')
  })

  it('shows no link for a scored package that passes every configured threshold', () => {
    const scores: PackageScore[] = [
      { name: 'good-pkg', version: '1.0.0', generalScore: 90, automationScore: 90, riskScore: 10, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: 50, risk: 50 })
    expect(table).not.toContain('Below threshold')
  })

  it('shows no link when no threshold is configured at all', () => {
    const scores: PackageScore[] = [
      { name: 'low-pkg', version: '1.0.0', generalScore: 5, automationScore: 5, riskScore: 95, status: 'scored' },
    ]
    const table = buildMarkdownTable(scores, none)
    expect(table).not.toContain('Below threshold')
  })

  it('prioritizes the crawl-timed-out note over the below-threshold link', () => {
    const scores: PackageScore[] = [
      { name: 'timed-out-pkg', version: null, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain('Crawl timed out')
    expect(table).not.toContain('Below threshold')
  })

  it('prioritizes the rate-limited note over the below-threshold link', () => {
    const scores: PackageScore[] = [
      { name: 'rl-pkg', version: '1.0.0', generalScore: 10, automationScore: 10, riskScore: 90, status: 'rate-limited' },
    ]
    const table = buildMarkdownTable(scores, { general: 50, automation: null, risk: null })
    expect(table).toContain('Rate limited')
    expect(table).not.toContain('Below threshold')
  })
})

describe('upsertPrComment', () => {
  let warningMock: ReturnType<typeof vi.fn>
  let octokitError: Error

  beforeEach(() => {
    vi.resetModules()

    warningMock = vi.fn()
    octokitError = new Error('Octokit error')

    vi.doMock('@actions/core', () => ({
      summary: { addHeading: vi.fn().mockReturnThis(), addRaw: vi.fn().mockReturnThis(), addEOL: vi.fn().mockReturnThis(), write: vi.fn().mockResolvedValue(undefined) },
      warning: warningMock,
    }))

    vi.doMock('@actions/github', () => ({
      context: {
        eventName: 'pull_request',
        payload: { pull_request: { number: 42 } },
        repo: { owner: 'test-owner', repo: 'test-repo' },
      },
      getOctokit: vi.fn(() => ({
        rest: {
          issues: {
            listComments: vi.fn().mockRejectedValue(octokitError),
          },
        },
      })),
    }))
  })

  it('catches Octokit errors and calls core.warning instead of throwing', async () => {
    const { upsertPrComment } = await import('../src/report')
    const scores: PackageScore[] = [
      { name: 'pkg', version: '1.0.0', generalScore: 75, automationScore: 80, riskScore: 70, status: 'scored' },
    ]

    // Should not throw
    await upsertPrComment(scores, { general: null, automation: null, risk: null }, 'test-token')

    // Should call core.warning
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('Failed to post PR comment'))
  })
})

describe('isBelowThreshold', () => {
  it('returns true when generalScore is below the general threshold', () => {
    expect(isBelowThreshold(
      { name: 'p', version: '1.0.0', generalScore: 40, automationScore: null, riskScore: null, status: 'scored' },
      { general: 50, automation: null, risk: null },
    )).toBe(true)
  })

  it('returns true when riskScore is above the risk threshold', () => {
    expect(isBelowThreshold(
      { name: 'p', version: '1.0.0', generalScore: null, automationScore: null, riskScore: 80, status: 'scored' },
      { general: null, automation: null, risk: 50 },
    )).toBe(true)
  })

  it('returns false when no threshold is configured', () => {
    expect(isBelowThreshold(
      { name: 'p', version: '1.0.0', generalScore: 1, automationScore: 1, riskScore: 99, status: 'scored' },
      { general: null, automation: null, risk: null },
    )).toBe(false)
  })

  it('returns false when all configured thresholds pass', () => {
    expect(isBelowThreshold(
      { name: 'p', version: '1.0.0', generalScore: 90, automationScore: 90, riskScore: 10, status: 'scored' },
      { general: 50, automation: 50, risk: 50 },
    )).toBe(false)
  })
})
