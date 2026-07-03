import * as core from '@actions/core'
import * as github from '@actions/github'
import type { PackageScore, Thresholds } from './types'

const COMMENT_MARKER = '<!-- packagerating-audit -->'

function scoreCell(value: number | null, threshold: number | null, direction: 'higher-is-better' | 'lower-is-better' = 'higher-is-better'): string {
  if (value === null) return '—'
  const rounded = Math.round(value)
  if (threshold === null) return String(rounded)
  const passes = direction === 'higher-is-better' ? value >= threshold : value <= threshold
  return passes ? `${rounded} ✅` : `${rounded} ⚠️`
}

function noteCell(pkg: PackageScore): string {
  if (pkg.status === 'unscored') return 'Crawl timed out'
  if (pkg.status === 'crawl-error') return 'Crawl error'
  return ''
}

export function buildMarkdownTable(scores: PackageScore[], thresholds: Thresholds): string {
  const sorted = [...scores].sort((a, b) => {
    if (a.generalScore === null && b.generalScore === null) return 0
    if (a.generalScore === null) return 1
    if (b.generalScore === null) return -1
    return a.generalScore - b.generalScore
  })

  const rows = sorted.map(pkg =>
    `| ${pkg.name} | ${pkg.version ?? '—'} | ${scoreCell(pkg.generalScore, thresholds.general)} | ${scoreCell(pkg.automationScore, thresholds.automation)} | ${scoreCell(pkg.riskScore, thresholds.risk, 'lower-is-better')} | ${noteCell(pkg)} |`,
  )

  return [
    '| Package | Version | General | Automation | Risk | Note |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

export async function writeJobSummary(scores: PackageScore[], thresholds: Thresholds): Promise<void> {
  const table = buildMarkdownTable(scores, thresholds)
  await core.summary
    .addHeading('Package Rating Audit', 2)
    .addRaw(table)
    .addEOL()
    .write()
}

export async function upsertPrComment(scores: PackageScore[], thresholds: Thresholds, token: string): Promise<void> {
  const { eventName, payload } = github.context
  if (eventName !== 'pull_request' || !payload.pull_request) return

  if (!token) return

  try {
    const octokit = github.getOctokit(token)
    const { owner, repo } = github.context.repo
    const prNumber = (payload.pull_request as { number: number }).number

    const table = buildMarkdownTable(scores, thresholds)
    const body = [
      COMMENT_MARKER,
      '## Package Rating Audit',
      '',
      table,
      '',
      '_Updated by [packagerating/audit-dependencies](https://github.com/packagerating/audit-dependencies) · [packagerating.com](https://packagerating.com)_',
    ].join('\n')

    const comments = await octokit.rest.issues.listComments({ owner, repo, issue_number: prNumber })
    const existing = comments.data.find(c => c.body?.includes(COMMENT_MARKER))

    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body })
    }
  } catch (err) {
    core.warning(`Failed to post PR comment: ${err instanceof Error ? err.message : String(err)}`)
  }
}
