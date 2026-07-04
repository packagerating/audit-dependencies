# Lockfile Version Resolution

## Problem

`discoverPackages` (`src/discover.ts`) reads package names from `package.json`'s
`dependencies`/`devDependencies`/`optionalDependencies`, but only names — never
resolved versions. `score.ts` then calls `GET /packages/:name` with no version
parameter at all, so the packagerating API scores whatever it considers
"latest" for that name.

This means the action audits "the newest version on npm today" rather than
the version actually installed in the consumer's project. Two versions of the
same dependency can score very differently (a supply-chain CVE fixed in a
patch release, a maintenance cliff at a specific major version), so an audit
that ignores the installed version can both miss real risk and flag risk that
doesn't apply to what's actually running.

The packagerating API's `GET /packages/:name?version=X` already supports
targeting a specific version end-to-end (crawl-trigger, dedup, and the
worker's version-specific crawl path) — this action just never asks for one.

## Design

### Lockfile parsers

New `src/lockfiles/` directory, one parser module per package-manager
ecosystem, isolated behind a single auto-detecting entry point:

- `src/lockfiles/npm.ts` — parses `package-lock.json`
- `src/lockfiles/yarn.ts` — parses `yarn.lock` (Classic v1 only — see Out of
  Scope)
- `src/lockfiles/pnpm.ts` — parses `pnpm-lock.yaml`
- `src/lockfiles/index.ts` — auto-detects and dispatches

Each parser has the same shape:

```typescript
export interface NamedRange {
  name: string
  range: string | undefined
}

export function resolveVersions(
  lockfileContent: string,
  packages: NamedRange[],
): Map<string, string>
```

Returns only the names it successfully resolved — callers treat a missing
entry as "not found," never an error.

**npm (`package-lock.json`)**
- `lockfileVersion` 2/3: read `packages["node_modules/<name>"].version`.
  Direct dependencies of the root project are always hoisted to this
  top-level path by npm's own resolution algorithm — reliable without
  needing `range`.
- `lockfileVersion` 1: read `dependencies[name].version` from the root-level
  nested tree.
- `range` is accepted for interface consistency but unused by this parser.

**yarn (`yarn.lock`, Classic v1 only)**
- Parse the custom text format into blocks, each keyed by one or more
  comma-separated descriptor strings, e.g.:
  ```
  "lodash@^4.17.15", "lodash@^4.17.21":
    version "4.17.21"
  ```
- For a given `{name, range}`, find the block whose descriptor list contains
  the exact string `` `${name}@${range}` `` and read its `version` field.
- If `range` is `undefined` for a name, that name is skipped entirely by this
  parser (no way to disambiguate which block applies).

**pnpm (`pnpm-lock.yaml`)**
- Requires a YAML parser — add `js-yaml` as a new dependency (nothing in
  this repo parses YAML today).
- Newer lockfileVersions (v6+) nest per-project dependency info under
  `importers['.']` (the `.` key is the workspace root, used by non-workspace
  projects too). Older versions have `dependencies`/`devDependencies`/
  `optionalDependencies` directly at the document root. Parser checks
  `importers['.']` first, falls back to root-level keys if absent.
- Each entry is `{specifier, version}` — read `.version` directly.
  `specifier` (the range) is redundant here; `range` is accepted for
  interface consistency but unused by this parser.

### Auto-detection (`src/lockfiles/index.ts`)

```typescript
export function resolveLockfileVersions(
  lockfileDir: string,
  packages: NamedRange[],
): Map<string, string>
```

Checks, in this order, for a file in `lockfileDir` (the directory containing
`package.json`):

1. `package-lock.json` → npm parser
2. `yarn.lock` → yarn parser
3. `pnpm-lock.yaml` → pnpm parser
4. none found → returns an empty `Map`

npm wins if multiple lockfiles happen to be present (a messy repo with
leftover lockfiles from a prior tool switch), since npm is the default
package manager.

### `discover.ts` changes

`discoverPackages` returns resolved packages with their version (`null` when
unresolved) instead of bare names:

```typescript
export interface DiscoveredPackage {
  name: string
  version: string | null
}

export function discoverPackages(
  packageJsonPath: string,
  explicitPackages: string[],
  includeDev: boolean,
  includeOptional: boolean,
  useLockfile: boolean,
): DiscoveredPackage[]
```

Behavior:

- `package.json` is always read first — even when the `packages` input
  overrides discovery — because yarn's parser needs each name's declared
  range. Names from `package.json` get their range from
  `dependencies`/`devDependencies`/`optionalDependencies`; names from the
  `packages` input that aren't in `package.json` at all get `range:
  undefined` (yarn resolution skipped for those; npm/pnpm can still resolve
  them by name, since their lockfiles list every installed package, not
  just direct ones).
- When `useLockfile` is `false`, or no lockfile is found, or a name isn't in
  the lockfile: `version: null` — scored the old unversioned way. Never a
  hard failure.

### `score.ts` changes

`POST /packages/crawl` (the batch endpoint `crawlAndWait` currently uses to
trigger a crawl) has no version parameter and never will — it's a
multi-package batch endpoint; per-version targeting is intentionally scoped
to the single-package `GET /packages/:name?version=X` path only.

That endpoint already does everything the current two-step
`fetchScoreOnce` → `crawlAndWait` flow needs, in one call: on a miss it
auto-triggers a crawl (scoped to the specific version, if one is given in
the query string), waits internally (~20s), and returns `200` (scored),
`202 {status: "crawling", job_id, retry_after_seconds}` if still pending, or
`404` if the crawl determined the package/version doesn't exist.

`fetchScoreOnce` and `crawlAndWait` collapse into one function,
`fetchOrCrawl(name, version, apiKey, timeoutMs)`:

1. Call `GET /packages/:name(?version=X)` once.
2. `200` → return the scored result immediately.
3. `404` → return `{status: 'unscored'}` (package/version doesn't exist).
4. `202` → take `job_id` directly from *this* response (no second GET needed
   just to obtain it) and poll `GET /packages/crawl/:job_id` exactly as
   today's `crawlAndWait` does, until done or `crawl-timeout` elapses, then
   fetch the score once more via the same `GET` call.

This removes a redundant round trip the original two-function design would
have had (an initial unversioned/versioned `GET` via `fetchScoreOnce`,
immediately followed by `crawlAndWait` re-issuing the *same* `GET` just to
read `job_id` off the `202` body) and applies uniformly whether or not a
version was resolved — unversioned lookups already work identically today
via this same endpoint.

`scorePackages` takes `DiscoveredPackage[]` instead of `string[]` and threads
`version` (when non-null) into `fetchOrCrawl`'s `?version=` query parameter.

### New action input

```yaml
use-lockfile:
  description: 'Resolve exact installed versions from the lockfile (package-lock.json, yarn.lock, or pnpm-lock.yaml) instead of scoring latest'
  required: false
  default: 'true'
```

`use-lockfile: false` fully reverts to today's behavior — every package
scored unversioned — regardless of what lockfile is present.

## Out of Scope (backlog)

- **Yarn Berry (v2+) and PnP mode.** Different lockfile format, and under PnP
  there is no traditional `node_modules` tree at all. Not supported by this
  design — falls back to unversioned, same as "no lockfile found." A
  candidate for a future spec if demand shows up.
- **npm/pnpm workspaces (monorepos).** This action audits one `package.json`'s
  direct dependencies; no special handling for workspace-hoisted lockfiles
  beyond whatever the root-level lockfile entries happen to contain.
- **Transitive dependency version auditing.** Still root/direct dependencies
  only, matching `discover.ts`'s existing scope. A lockfile's resolved
  version for a *nested* dependency is never surfaced unless explicitly
  named via the `packages` input (and even then, only npm/pnpm can resolve
  it — yarn needs a range that a non-package.json name won't have).
- **Other language ecosystems.** This action is npm/Node-only, but the
  packagerating API itself already scores Python (PyPI), Rust (crates.io),
  and Ruby (RubyGems) packages too, each with their own lockfile-equivalent
  (`poetry.lock`/`Pipfile.lock`, `Cargo.lock`, `Gemfile.lock`). If an
  equivalent audit action is ever built for those ecosystems, it would need
  the same "resolve what's actually installed" treatment this spec gives
  npm/yarn/pnpm — worth evaluating whether that same manifest-vs-lockfile
  gap exists there before building one, rather than assuming the npm-shaped
  fix generalizes as-is.

## Testing

- `tests/lockfiles/npm.test.ts` — `lockfileVersion` 1 (nested tree) and 2/3
  (flat `packages` map) fixtures, including a scoped package
  (`@scope/name`).
- `tests/lockfiles/yarn.test.ts` — single-descriptor entries, multi-descriptor
  entries (two ranges sharing one resolved block), a name/range with no
  match, a name with `range: undefined`.
- `tests/lockfiles/pnpm.test.ts` — `importers['.']` structure and legacy
  root-level structure.
- `tests/discover.test.ts` — extended for the new `DiscoveredPackage[]`
  return shape, `useLockfile: false` opt-out, missing-lockfile-entry
  fallback, no-lockfile-present fallback, explicit `packages` input names
  not present in `package.json`.
- `tests/score.test.ts` — rewritten around the collapsed `fetchOrCrawl`:
  `?version=` threading into the `GET` call, the `200`/`404`/`202` branches,
  and the `202` path polling using `job_id` from that same response (no
  `POST /packages/crawl` call anywhere anymore).
- `tests/index.test.ts` — new `use-lockfile` input wiring.

## Files Touched

| File | Change |
|---|---|
| `src/lockfiles/npm.ts`, `src/lockfiles/yarn.ts`, `src/lockfiles/pnpm.ts` | New — per-ecosystem lockfile parsers |
| `src/lockfiles/index.ts` | New — auto-detection and dispatch |
| `src/discover.ts` | `discoverPackages` returns `DiscoveredPackage[]`, resolves via `src/lockfiles/` |
| `src/score.ts` | `scorePackages` takes `DiscoveredPackage[]`; `fetchScoreOnce`/`crawlAndWait` collapse into `fetchOrCrawl`; `?version=` threading; no more `POST /packages/crawl` |
| `src/index.ts` | Reads new `use-lockfile` input |
| `action.yml` | Documents `use-lockfile` input |
| `README.md` | Documents lockfile resolution behavior and the new input |
| `package.json` | New `js-yaml` dependency |
