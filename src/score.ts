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
  const res = await fetch(buildUrl(name, version), { headers: { 'x-api-key': apiKey } })
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
    const res = await fetch(buildUrl(name, version), { headers: { 'x-api-key': apiKey } })

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
  } catch {
    return emptyScore(name, 'crawl-error')
  }
}

export async function scorePackages(
  packages: DiscoveredPackage[],
  apiKey: string,
  crawlTimeoutSeconds: number,
): Promise<PackageScore[]> {
  const timeoutMs = crawlTimeoutSeconds * 1000
  return Promise.all(
    packages.map(({ name, version }) => fetchOrCrawl(name, version, apiKey, timeoutMs)),
  )
}
