import type { PackageScore } from './types'
import type { DiscoveredPackage } from './discover'

const API_BASE = 'https://api.packagerating.com'

interface ApiPackageResponse {
  version?: string | null
  general_score?: number | null
  automation_score?: number | null
  risk_score?: number | null
}

interface CrawlTriggerResponse {
  job_id?: string
}

interface CrawlJobResponse {
  status: string
  processed?: number
  total?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const RETRYABLE_ATTEMPTS = 3

// Thrown by fetchWithRetry instead of the generic Error when the retry-exhausting failure was
// itself a 429 -- lets callers distinguish "rate limited, resolves on its own" from a genuine
// backend failure, instead of bucketing both into 'crawl-error'.
export class RateLimitedError extends Error {}

// Promise.all fires every dependency's request fully concurrently with no backpressure — a
// single transient network blip or a momentary 429/5xx on any one request previously produced
// a permanent "Crawl error" for that package, indistinguishable from a real backend problem.
// Retries transient failures (network exceptions, 429, 5xx); returns immediately for anything
// else (404, other 4xx) since those are legitimate signals the caller already handles.
async function fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
  let lastErr: unknown
  let lastWasRateLimit = false
  for (let attempt = 0; attempt < RETRYABLE_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, options)
      if (res.status !== 429 && res.status < 500) return res
      lastWasRateLimit = res.status === 429
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastWasRateLimit = false
      lastErr = err
    }
    if (attempt < RETRYABLE_ATTEMPTS - 1) await sleep(300 * Math.pow(2, attempt))
  }
  if (lastWasRateLimit) throw new RateLimitedError(lastErr instanceof Error ? lastErr.message : String(lastErr))
  throw lastErr
}

function buildUrl(name: string, version: string | null): string {
  const base = `${API_BASE}/packages/${encodeURIComponent(name)}`
  return version ? `${base}?version=${encodeURIComponent(version)}` : base
}

function emptyScore(name: string, status: PackageScore['status']): PackageScore {
  return { name, version: null, generalScore: null, automationScore: null, riskScore: null, status }
}

function parseApiResponse(name: string, data: ApiPackageResponse): PackageScore | 'not-found' {
  if (data.general_score == null && data.automation_score == null && data.risk_score == null) {
    return 'not-found'
  }

  return {
    name,
    version: data.version ?? null,
    generalScore: data.general_score ?? null,
    automationScore: data.automation_score ?? null,
    riskScore: data.risk_score ?? null,
    status: 'scored',
  }
}

async function fetchScore(name: string, version: string | null, apiKey: string): Promise<PackageScore | 'not-found'> {
  const res = await fetchWithRetry(buildUrl(name, version), { headers: { 'x-api-key': apiKey } })
  if (res.status === 404) return 'not-found'
  if (!res.ok) throw new Error(`GET /packages/${name} returned ${res.status}`)

  const data = await res.json() as ApiPackageResponse
  return parseApiResponse(name, data)
}

async function pollJob(
  name: string,
  version: string | null,
  jobId: string,
  apiKey: string,
  deadline: number,
): Promise<PackageScore> {
  while (Date.now() < deadline) {
    await sleep(5000)
    const pollRes = await fetch(`${API_BASE}/packages/crawl/${jobId}`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!pollRes.ok) continue

    let job: CrawlJobResponse
    try {
      job = await pollRes.json() as CrawlJobResponse
    } catch {
      continue
    }

    const done =
      job.status === 'done' ||
      (typeof job.processed === 'number' && typeof job.total === 'number' && job.processed >= job.total)

    if (done) {
      const result = await fetchScore(name, version, apiKey)
      return result === 'not-found' ? emptyScore(name, 'unscored') : result
    }
  }

  return emptyScore(name, 'unscored')
}

async function fetchOrCrawl(
  name: string,
  version: string | null,
  apiKey: string,
  timeoutMs: number,
): Promise<PackageScore> {
  try {
    const res = await fetchWithRetry(buildUrl(name, version), { headers: { 'x-api-key': apiKey } })

    if (res.status === 404) return emptyScore(name, 'unscored')

    if (res.status === 202) {
      const body = await res.json() as CrawlTriggerResponse
      if (!body.job_id) return emptyScore(name, 'crawl-error')
      return await pollJob(name, version, body.job_id, apiKey, Date.now() + timeoutMs)
    }

    if (!res.ok) return emptyScore(name, 'crawl-error')

    const data = await res.json() as ApiPackageResponse
    const result = parseApiResponse(name, data)
    return result === 'not-found' ? emptyScore(name, 'unscored') : result
  } catch (err) {
    if (err instanceof RateLimitedError) return emptyScore(name, 'rate-limited')
    return emptyScore(name, 'crawl-error')
  }
}

export const MAX_CONCURRENT_REQUESTS = 5

// Caps concurrent in-flight requests instead of firing all of a repo's dependencies at once — a
// repo with more direct dependencies than the caller's API-key usage-plan burst limit otherwise
// trips it on every single run. Preserves input order in the result array (each index is written
// by whichever worker claims it, not by completion order).
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++
      results[i] = await fn(items[i]!)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  )
  return results
}

export async function scorePackages(
  packages: DiscoveredPackage[],
  apiKey: string,
  crawlTimeoutSeconds: number,
): Promise<PackageScore[]> {
  const timeoutMs = crawlTimeoutSeconds * 1000
  return mapWithConcurrency(
    packages,
    MAX_CONCURRENT_REQUESTS,
    ({ name, version }) => fetchOrCrawl(name, version, apiKey, timeoutMs),
  )
}
