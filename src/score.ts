import type { PackageScore } from './types'

const API_BASE = 'https://api.packagerating.com'

interface ApiPackageResponse {
  general_score?: number | null
  automation_score?: number | null
  risk_score?: number | null
}

interface CrawlResponse {
  job_id: string
  queued: number
}

interface CrawlJobResponse {
  status: string
  processed?: number
  total?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchScoreOnce(name: string, apiKey: string): Promise<PackageScore | null> {
  const res = await fetch(`${API_BASE}/packages/${encodeURIComponent(name)}`, {
    headers: { 'x-api-key': apiKey },
  })

  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /packages/${name} returned ${res.status}`)

  const data = await res.json() as ApiPackageResponse
  if (data.general_score == null && data.automation_score == null && data.risk_score == null) {
    return null
  }

  return {
    name,
    generalScore: data.general_score ?? null,
    automationScore: data.automation_score ?? null,
    riskScore: data.risk_score ?? null,
    status: 'scored',
  }
}

async function crawlAndWait(
  name: string,
  apiKey: string,
  timeoutMs: number,
): Promise<PackageScore> {
  try {
    const crawlRes = await fetch(`${API_BASE}/packages/crawl`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ packages: [name], language: 'javascript', maxDepth: 0 }),
    })

    if (!crawlRes.ok) {
      return { name, generalScore: null, automationScore: null, riskScore: null, status: 'crawl-error' }
    }

    let jobId: string
    try {
      const { job_id } = await crawlRes.json() as CrawlResponse
      jobId = job_id
    } catch {
      return { name, generalScore: null, automationScore: null, riskScore: null, status: 'crawl-error' }
    }

    const deadline = Date.now() + timeoutMs

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
        (typeof job.processed === 'number' &&
          typeof job.total === 'number' &&
          job.processed >= job.total)

      if (done) {
        try {
          const scored = await fetchScoreOnce(name, apiKey)
          if (scored) return scored
        } catch {
          return { name, generalScore: null, automationScore: null, riskScore: null, status: 'crawl-error' }
        }
      }
    }

    return { name, generalScore: null, automationScore: null, riskScore: null, status: 'unscored' }
  } catch {
    return { name, generalScore: null, automationScore: null, riskScore: null, status: 'crawl-error' }
  }
}

export async function scorePackages(
  names: string[],
  apiKey: string,
  crawlTimeoutSeconds: number,
): Promise<PackageScore[]> {
  const timeoutMs = crawlTimeoutSeconds * 1000
  return Promise.all(
    names.map(async name => {
      try {
        const scored = await fetchScoreOnce(name, apiKey)
        if (scored) return scored
        return await crawlAndWait(name, apiKey, timeoutMs)
      } catch {
        return { name, generalScore: null, automationScore: null, riskScore: null, status: 'crawl-error' }
      }
    }),
  )
}
