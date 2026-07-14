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
| `audit-workspaces` | no | `true` | Discover and score every workspace member in a monorepo |
| `audit-subprojects` | no | `true` | Discover and score independent `package.json` directories not covered by the workspace protocol |
| `subproject-max-depth` | no | `3` | Maximum directory depth below repo root to scan for independent `package.json` files |
| `subproject-exclude` | no | — | Comma-separated additional glob patterns to exclude from subproject discovery |
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

Supported: npm (`package-lock.json`, all lockfile versions), yarn — both
Classic (v1) and Berry (v2+), auto-detected from the lockfile content — and
pnpm (`pnpm-lock.yaml`). Berry's PnP linker mode needs no special handling,
since only the lockfile is read, never `node_modules`.

Set `use-lockfile: false` to always score latest, regardless of what
lockfile is present.

## Monorepo / workspace support

If the root `package.json` declares a `"workspaces"` field (npm/yarn) or a `pnpm-workspace.yaml`
file exists, this action automatically discovers every workspace member and scores the
deduplicated union of all their dependencies — not just the root project's. Two members
depending on the exact same resolved version of a package produce one row in the report; two
members resolving to genuinely different versions of the same package both appear.

If no workspace configuration is found, behavior is unchanged — only the root `package.json` is
audited, same as a non-monorepo project.

Set `audit-workspaces: false` to only audit the root `package.json`, even in a real monorepo.

## Independent subprojects

Many monorepos aren't declared as a formal workspace at all — they're just several
independently-managed Node projects living in one git repo, each with its own `package.json`
**and its own separate lockfile**, with no `"workspaces"` field or `pnpm-workspace.yaml` linking
them. A repo with a root `package.json` and a separate `admin/package.json` (its own dependencies,
its own lockfile) is a common example.

By default, this action also discovers these independent subprojects and scores each one's
dependencies resolved against *its own* lockfile — not the root's. A directory that's already a
formal workspace member (see above) is never rescanned here, so nothing is double-counted.

Scanning excludes `node_modules` (always, not configurable), and by default also excludes `.git`,
`dist`, `build`, `coverage`, and `vendor`. Use `subproject-exclude` to add further comma-separated
glob patterns, and `subproject-max-depth` to control how many directory levels below the repo root
are scanned (default `3`).

Set `audit-subprojects: false` to disable this discovery entirely and only audit the root
`package.json` (and, if enabled, formal workspace members).

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
