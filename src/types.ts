export interface PackageScore {
  name: string
  version: string | null
  generalScore: number | null
  automationScore: number | null
  riskScore: number | null
  status: 'scored' | 'unscored' | 'crawl-error'
}

export interface Thresholds {
  general: number | null
  automation: number | null
  risk: number | null
}
