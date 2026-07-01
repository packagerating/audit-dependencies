import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scorePackages } from '../src/score'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function ok(body: unknown) {
  return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(body) })
}
function notFound() {
  return Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({}) })
}
function serverError() {
  return Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({}) })
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('scorePackages', () => {
  it('returns scored package when API returns all three scores', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 79 }))
    const result = await scorePackages(['axios'], 'key', 10)
    expect(result).toEqual([{
      name: 'axios',
      generalScore: 84,
      automationScore: 88,
      riskScore: 79,
      status: 'scored',
    }])
  })

  it('triggers crawl on 404 and returns scored result after job completes', async () => {
    mockFetch
      .mockResolvedValueOnce(notFound())                                                  // GET /packages/new-pkg
      .mockResolvedValueOnce(ok({ job_id: 'job-1', queued: 1 }))                        // POST /packages/crawl
      .mockResolvedValueOnce(ok({ status: 'queued', processed: 1, total: 1 }))          // GET /packages/crawl/job-1
      .mockResolvedValueOnce(ok({ general_score: 72, automation_score: 80, risk_score: 65 })) // re-fetch score

    const result = await scorePackages(['new-pkg'], 'key', 30)
    expect(result[0]!.status).toBe('scored')
    expect(result[0]!.generalScore).toBe(72)
  })

  it('triggers crawl when 200 but all scores are null (stub package)', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ name: 'stub-pkg' }))                                  // 200 but no scores
      .mockResolvedValueOnce(ok({ job_id: 'job-2', queued: 1 }))
      .mockResolvedValueOnce(ok({ status: 'queued', processed: 1, total: 1 }))
      .mockResolvedValueOnce(ok({ general_score: 50, automation_score: 60, risk_score: 55 }))

    const result = await scorePackages(['stub-pkg'], 'key', 30)
    expect(result[0]!.status).toBe('scored')
  })

  it('returns unscored status when crawl times out (deadline already passed)', async () => {
    mockFetch
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(ok({ job_id: 'job-3', queued: 1 }))
      // deadline of 0ms expires before the poll loop runs
    const result = await scorePackages(['slow-pkg'], 'key', 0)
    expect(result[0]!.status).toBe('unscored')
  })

  it('returns crawl-error when POST /packages/crawl fails', async () => {
    mockFetch
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(serverError())
    const result = await scorePackages(['bad-pkg'], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('scores multiple packages concurrently', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ general_score: 80, automation_score: 85, risk_score: 75 }))
      .mockResolvedValueOnce(ok({ general_score: 60, automation_score: 65, risk_score: 55 }))
    const result = await scorePackages(['pkg-a', 'pkg-b'], 'key', 10)
    expect(result).toHaveLength(2)
    expect(result.find(r => r.name === 'pkg-a')!.generalScore).toBe(80)
    expect(result.find(r => r.name === 'pkg-b')!.generalScore).toBe(60)
  })

  it('handles API error for one package without crashing the batch', async () => {
    mockFetch
      .mockResolvedValueOnce(serverError()) // GET /packages/bad-pkg
      .mockResolvedValueOnce(ok({ general_score: 75, automation_score: 78, risk_score: 70 })) // GET /packages/good-pkg
    const result = await scorePackages(['bad-pkg', 'good-pkg'], 'key', 10)
    expect(result).toHaveLength(2)
    const badPkg = result.find(r => r.name === 'bad-pkg')!
    const goodPkg = result.find(r => r.name === 'good-pkg')!
    expect(badPkg.status).toBe('crawl-error')
    expect(badPkg.generalScore).toBeNull()
    expect(badPkg.automationScore).toBeNull()
    expect(badPkg.riskScore).toBeNull()
    expect(goodPkg.status).toBe('scored')
    expect(goodPkg.generalScore).toBe(75)
    expect(goodPkg.automationScore).toBe(78)
    expect(goodPkg.riskScore).toBe(70)
  })
})
