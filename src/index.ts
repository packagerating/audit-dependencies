import * as core from '@actions/core'
import { discoverPackages } from './discover'
import { scorePackages } from './score'
import { writeJobSummary, upsertPrComment } from './report'
import type { PackageScore, Thresholds } from './types'

function parseThreshold(value: string): number | null {
  if (!value.trim()) return null
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 0 || n > 100) throw new Error(`Invalid threshold: "${value}" — must be 0–100`)
  return n
}

export function checkThresholds(scores: PackageScore[], thresholds: Thresholds): string[] {
  const failures: string[] = []
  for (const pkg of scores.filter(s => s.status === 'scored')) {
    const reasons: string[] = []
    if (thresholds.general !== null && (pkg.generalScore ?? 0) < thresholds.general) {
      reasons.push(`general: ${pkg.generalScore} < ${thresholds.general}`)
    }
    if (thresholds.automation !== null && (pkg.automationScore ?? 0) < thresholds.automation) {
      reasons.push(`automation: ${pkg.automationScore} < ${thresholds.automation}`)
    }
    if (thresholds.risk !== null && (pkg.riskScore ?? 0) < thresholds.risk) {
      reasons.push(`risk: ${pkg.riskScore} < ${thresholds.risk}`)
    }
    if (reasons.length > 0) {
      failures.push(`${pkg.name} (${reasons.join(', ')})`)
    }
  }
  return failures
}

async function run(): Promise<void> {
  const thresholds: Thresholds = {
    general: parseThreshold(core.getInput('fail-on-general')),
    automation: parseThreshold(core.getInput('fail-on-automation')),
    risk: parseThreshold(core.getInput('fail-on-risk')),
  }

  const explicitPackages = core.getInput('packages')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const names = discoverPackages(
    core.getInput('package-json-path') || 'package.json',
    explicitPackages,
    core.getInput('include-dev') === 'true',
    core.getInput('include-optional') === 'true',
  )

  core.info(`Scoring ${names.length} package(s)...`)
  const scores = await scorePackages(
    names,
    core.getInput('api-key', { required: true }),
    parseInt(core.getInput('crawl-timeout') || '120', 10),
  )

  // Write report before gating so the summary is always visible
  await writeJobSummary(scores, thresholds)
  if (core.getInput('pr-comment') !== 'false') {
    await upsertPrComment(scores, thresholds)
  }

  const scored = scores.filter(s => s.status === 'scored')
  core.setOutput('packages-scored', String(scored.length))

  const failures = checkThresholds(scores, thresholds)
  const belowThreshold = failures.map(f => f.split(' ')[0]!)
  core.setOutput('packages-below-threshold', belowThreshold.join(','))

  if (failures.length > 0) {
    core.setFailed(`${failures.length} package(s) below threshold: ${failures.join('; ')}`)
  }
}

run().catch(err => core.setFailed(err instanceof Error ? err.message : String(err)))
