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
| `fail-on-general` | no | — | Fail if any package `general_score` is below this (0–100) |
| `fail-on-automation` | no | — | Fail if any package `automation_score` is below this (0–100) |
| `fail-on-risk` | no | — | Fail if any package `risk_score` is below this (0–100) |
| `pr-comment` | no | `true` | Post/update a PR comment with the score table |
| `github-token` | no | `${{ github.token }}` | Token used to post/update the PR comment |
| `crawl-timeout` | no | `120` | Seconds to wait for an on-demand crawl of unscored packages |

## Outputs

| Output | Description |
|---|---|
| `packages-scored` | Number of packages successfully scored |
| `packages-below-threshold` | Comma-separated packages that failed a threshold |

## With gating

```yaml
- uses: packagerating/audit-dependencies@v1
  with:
    api-key: ${{ secrets.PACKAGERATING_API_KEY }}
    fail-on-general: 50
    fail-on-risk: 40
```

The workflow fails if any package's `general_score` < 50 **or** `risk_score` < 40. The score table is always written to the job summary before the failure so you can see what triggered it.

## Scores

| Range | Interpretation |
|---|---|
| 90–100 | Excellent — safe to adopt or auto-update |
| 70–89 | Good — actively maintained |
| 50–69 | Fair — some maintenance concerns |
| 25–49 | Poor — significant concerns |
| 0–24 | Critical — abandoned or insecure |

Full score methodology: [packagerating.com/github-action](https://packagerating.com/github-action)
