import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PackageScore } from '../src/types'

// Light integration test for run(): verifies the full pipeline wiring
// (input parsing -> discover -> score -> report -> outputs -> gating)
// without re-testing already-covered unit behavior (checkThresholds,
// buildMarkdownTable, discoverPackages, scorePackages all have their own tests).

const scoredPkg = (name: string, g: number, a: number, r: number): PackageScore => ({
  name, version: '1.0.0', generalScore: g, automationScore: a, riskScore: r, status: 'scored',
})

describe('run() integration', () => {
  let getInputMock: ReturnType<typeof vi.fn>
  let setOutputMock: ReturnType<typeof vi.fn>
  let setFailedMock: ReturnType<typeof vi.fn>
  let discoverPackagesMock: ReturnType<typeof vi.fn>
  let scorePackagesMock: ReturnType<typeof vi.fn>
  let writeJobSummaryMock: ReturnType<typeof vi.fn>
  let upsertPrCommentMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    getInputMock = vi.fn()
    setOutputMock = vi.fn()
    setFailedMock = vi.fn()
    discoverPackagesMock = vi.fn().mockReturnValue([{ name: 'left-pad', version: null }])
    scorePackagesMock = vi.fn().mockResolvedValue([scoredPkg('left-pad', 80, 80, 80)])
    writeJobSummaryMock = vi.fn().mockResolvedValue(undefined)
    upsertPrCommentMock = vi.fn().mockResolvedValue(undefined)

    vi.doMock('@actions/core', () => ({
      getInput: (...args: unknown[]) => getInputMock(...args),
      setOutput: (...args: unknown[]) => setOutputMock(...args),
      setFailed: (...args: unknown[]) => setFailedMock(...args),
      info: vi.fn(),
      warning: vi.fn(),
      summary: {
        addHeading: vi.fn().mockReturnThis(),
        addRaw: vi.fn().mockReturnThis(),
        addEOL: vi.fn().mockReturnThis(),
        write: vi.fn().mockResolvedValue(undefined),
      },
    }))
    vi.doMock('../src/discover', () => ({
      discoverPackages: (...args: unknown[]) => discoverPackagesMock(...args),
    }))
    vi.doMock('../src/score', () => ({
      scorePackages: (...args: unknown[]) => scorePackagesMock(...args),
    }))
    vi.doMock('../src/report', () => ({
      writeJobSummary: (...args: unknown[]) => writeJobSummaryMock(...args),
      upsertPrComment: (...args: unknown[]) => upsertPrCommentMock(...args),
    }))
  })

  async function runWithInputs(inputs: Record<string, string>): Promise<void> {
    const defaults: Record<string, string> = {
      'api-key': 'k',
      'package-json-path': 'package.json',
      packages: '',
      'include-dev': 'false',
      'include-optional': 'false',
      'use-lockfile': 'true',
      'fail-on-general': '',
      'fail-on-automation': '',
      'fail-on-risk': '',
      'pr-comment': 'true',
      'github-token': 'gh-token-123',
      'crawl-timeout': '120',
    }
    const merged = { ...defaults, ...inputs }
    getInputMock.mockImplementation((name: string) => merged[name] ?? '')

    const { run } = await import('../src/index')
    await run()
  }

  it('passes useLockfile=true to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[4]).toBe(true)
  })

  it('passes useLockfile=false to discoverPackages when use-lockfile input is "false"', async () => {
    await runWithInputs({ 'use-lockfile': 'false' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[4]).toBe(false)
  })

  it('reads the github-token input and passes it through to upsertPrComment', async () => {
    await runWithInputs({})
    expect(upsertPrCommentMock).toHaveBeenCalledTimes(1)
    const [, , token] = upsertPrCommentMock.mock.calls[0]!
    expect(token).toBe('gh-token-123')
  })

  it('calls writeJobSummary before gating regardless of outcome', async () => {
    scorePackagesMock.mockResolvedValue([scoredPkg('left-pad', 10, 10, 10)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(writeJobSummaryMock).toHaveBeenCalledTimes(1)
    expect(setFailedMock).toHaveBeenCalled()
  })

  it('calls core.setFailed when a package fails a threshold', async () => {
    scorePackagesMock.mockResolvedValue([scoredPkg('left-pad', 10, 80, 80)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringContaining('left-pad'))
  })

  it('does not call core.setFailed when no package fails a threshold', async () => {
    scorePackagesMock.mockResolvedValue([scoredPkg('left-pad', 80, 80, 80)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(writeJobSummaryMock).toHaveBeenCalledTimes(1)
    expect(setFailedMock).not.toHaveBeenCalled()
  })
})
