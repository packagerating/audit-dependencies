# packagerating/audit-dependencies

Score your npm dependencies with [packagerating.com](https://packagerating.com) directly in your GitHub Actions workflow. Results appear in the job summary and as a PR comment. Optionally fail the build if any package falls below your quality thresholds.

## Usage

```yaml
permissions:
  pull-requests: write   # required for PR comments

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: packagerating/audit-dependencies@v1
        with:
          api-key: ${{ secrets.PACKAGERATING_API_KEY }}
```

Get a free API key at [packagerating.com](https://packagerating.com).

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | yes | — | Your packagerating.com API key |
| `package-json-path` | no | `package.json` | Path to `package.json` relative to repo root |
| `packages` | no | — | Comma-separated package list (overrides `package.json` discovery) |
| `include-dev` | no | `false` | Include `devDependencies` |
| `include-optional` | no | `false` | Include `optionalDependencies` |
| `use-lockfile` | no | `true` | Resolve exact installed versions from the lockfile instead of scoring latest |
| `fail-on-general` | no | — | Fail if any package `general_score` is below this (0–100) |
| `fail-on-automation` | no | — | Fail if any package `automation_score` is below this (0–100) |
| `fail-on-risk` | no | — | Fail if any package `risk_score` is above this (0–100) — higher risk_score means riskier |
| `pr-comment` | no | `true` | Post/update a PR comment with the score table |
| `github-token` | no | `${{ github.token }}` | Token used to post/update the PR comment |
| `crawl-timeout` | no | `120` | Seconds to wait for an on-demand crawl of unscored packages |

## Version resolution

By default, this action resolves each package's exact installed version from
your lockfile (`package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml` — checked
in that order) and scores that specific version, rather than whatever
packagerating.com considers "latest." A package not found in the lockfile
(or no lockfile present at all) falls back to scoring latest for that package
only — never a hard failure.

Supported: npm (`package-lock.json`, all lockfile versions), yarn Classic
(`yarn.lock` v1), and pnpm (`pnpm-lock.yaml`). Not supported: Yarn Berry
(v2+) and PnP mode — falls back to latest, same as no lockfile found.

Set `use-lockfile: false` to always score latest, regardless of what
lockfile is present.

## Outputs

| Output | Description |
|---|---|
| `packages-scored` | Number of packages successfully scored |
| `packages-below-threshold` | Comma-separated packages that failed a threshold |

## Report table

The job summary and PR comment show one row per package with General, Automation, and Risk
scores, plus a `Note` column. `Note` is blank for normally-scored packages — it's only populated
when a score is missing: `Crawl timed out` (the on-demand crawl didn't finish within
`crawl-timeout`) or `Crawl error` (the crawl failed).

## With gating

```yaml
- uses: packagerating/audit-dependencies@v1
  with:
    api-key: ${{ secrets.PACKAGERATING_API_KEY }}
    fail-on-general: 50
    fail-on-risk: 60
```

The workflow fails if any package's `general_score` < 50 **or** `risk_score` > 60. The score table is always written to the job summary before the failure so you can see what triggered it.

## Scores

General and Automation: higher is better.

| Range | Interpretation |
|---|---|
| 90–100 | Excellent — safe to adopt or auto-update |
| 70–89 | Good — actively maintained |
| 50–69 | Fair — some maintenance concerns |
| 25–49 | Poor — significant concerns |
| 0–24 | Critical — abandoned or insecure |

Risk: inverted — lower is better.

| Range | Interpretation |
|---|---|
| 0–10 | Minimal risk — actively maintained and secure |
| 11–30 | Low risk — minor concerns |
| 31–50 | Moderate risk — some maintenance or security signals |
| 51–75 | High risk — significant maintenance or security concerns |
| 76–100 | Critical risk — abandoned or insecure |

Full score methodology: [packagerating.com/github-action](https://packagerating.com/github-action)
