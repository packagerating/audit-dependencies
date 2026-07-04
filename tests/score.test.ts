import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scorePackages } from '../src/score'
import type { DiscoveredPackage } from '../src/discover'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function ok(body: unknown, status = 200) {
  return Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) })
}
function notFound() {
  return Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({ error: 'not found' }) })
}
function serverError() {
  return Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({}) })
}

function pkg(name: string, version: string | null = null): DiscoveredPackage {
  return { name, version }
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('scorePackages', () => {
  it('returns scored package on a direct 200', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 79, version: '1.7.4' }))
    const result = await scorePackages([pkg('axios')], 'key', 10)
    expect(result).toEqual([{
      name: 'axios', version: '1.7.4', generalScore: 84, automationScore: 88, riskScore: 79, status: 'scored',
    }])
  })

  it('includes ?version= in the request URL when a version is given', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 79, version: '5.9.0' }))
    await scorePackages([pkg('fastify', '5.9.0')], 'key', 10)
    const [url] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.packagerating.com/packages/fastify?version=5.9.0')
  })

  it('omits ?version= from the request URL when no version was resolved', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 79 }))
    await scorePackages([pkg('axios')], 'key', 10)
    const [url] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.packagerating.com/packages/axios')
  })

  it('returns version: null when the API response omits version', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 79 }))
    const result = await scorePackages([pkg('axios')], 'key', 10)
    expect(result[0]!.version).toBeNull()
  })

  it('returns unscored on a direct 404', async () => {
    mockFetch.mockResolvedValue(notFound())
    const result = await scorePackages([pkg('nonexistent')], 'key', 10)
    expect(result[0]!.status).toBe('unscored')
  })

  it('returns unscored on a 200 with no scores at all (defensive)', async () => {
    mockFetch.mockResolvedValue(ok({ name: 'stub-pkg' }))
    const result = await scorePackages([pkg('stub-pkg')], 'key', 10)
    expect(result[0]!.status).toBe('unscored')
  })

  it('polls the job from a 202 response and returns scored once done', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ status: 'crawling', job_id: 'job-1', retry_after_seconds: 5 }, 202)) // initial GET
      .mockResolvedValueOnce(ok({ status: 'queued', processed: 1, total: 1 })) // poll job — done
      .mockResolvedValueOnce(ok({ general_score: 72, automation_score: 80, risk_score: 65 })) // re-fetch score

    const result = await scorePackages([pkg('new-pkg')], 'key', 30)
    expect(result[0]!.status).toBe('scored')
    expect(result[0]!.generalScore).toBe(72)
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('returns unscored if the job finishes but the re-fetch is a 404', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ status: 'crawling', job_id: 'job-2', retry_after_seconds: 5 }, 202))
      .mockResolvedValueOnce(ok({ status: 'done', processed: 1, total: 1 }))
      .mockResolvedValueOnce(notFound())

    const result = await scorePackages([pkg('removed-pkg')], 'key', 30)
    expect(result[0]!.status).toBe('unscored')
  })

  it('returns unscored when the crawl times out (deadline already passed)', async () => {
    mockFetch.mockResolvedValueOnce(ok({ status: 'crawling', job_id: 'job-3', retry_after_seconds: 5 }, 202))
    const result = await scorePackages([pkg('slow-pkg')], 'key', 0)
    expect(result[0]!.status).toBe('unscored')
  })

  it('returns crawl-error when a 202 response is missing job_id', async () => {
    mockFetch.mockResolvedValueOnce(ok({ status: 'crawling' }, 202))
    const result = await scorePackages([pkg('bad-pkg')], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('returns crawl-error on a direct 500', async () => {
    mockFetch.mockResolvedValue(serverError())
    const result = await scorePackages([pkg('bad-pkg')], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('returns crawl-error on a fetch rejection', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    const result = await scorePackages([pkg('bad-pkg')], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('scores multiple packages concurrently, isolating one failure from the rest', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/packages/good-pkg')) return ok({ general_score: 75, automation_score: 78, risk_score: 70 })
      if (url.includes('/packages/bad-pkg')) return serverError()
      return notFound()
    })
    const result = await scorePackages([pkg('bad-pkg'), pkg('good-pkg')], 'key', 10)
    expect(result).toHaveLength(2)
    expect(result.find(r => r.name === 'bad-pkg')!.status).toBe('crawl-error')
    expect(result.find(r => r.name === 'good-pkg')!.status).toBe('scored')
    expect(result.find(r => r.name === 'good-pkg')!.generalScore).toBe(75)
  })
})
