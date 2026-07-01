export interface PackageScore {
  name: string
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

export interface ActionInputs {
  apiKey: string
  packageJsonPath: string
  explicitPackages: string[]
  includeDev: boolean
  includeOptional: boolean
  thresholds: Thresholds
  prComment: boolean
  crawlTimeout: number
}
