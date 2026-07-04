# Lockfile Version Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve exact installed package versions from the project's lockfile (npm, yarn Classic, or pnpm) and thread them into packagerating API calls, so the action audits what's actually running instead of whatever the API considers "latest."

**Architecture:** A new `src/lockfiles/` directory holds one parser per ecosystem behind a single auto-detecting dispatcher. `discover.ts` resolves each discovered package's version through that dispatcher. `score.ts` collapses its old two-call (`fetchScoreOnce` → `crawlAndWait` via `POST /packages/crawl`) flow into one `fetchOrCrawl` function that threads `?version=` into `GET /packages/:name` and relies entirely on that endpoint's own auto-crawl-on-miss behavior — `POST /packages/crawl` has no version concept and is dropped from this action's code path entirely.

**Tech Stack:** TypeScript, Vitest, `@actions/core`, `@actions/github`, new dependency: `js-yaml` (for pnpm-lock.yaml parsing).

## Global Constraints

- npm: support `lockfileVersion` 1 (nested `dependencies` tree) and 2/3 (flat `packages` map, npm 7+).
- yarn: Classic (v1) format only. Yarn Berry (v2+) and PnP mode are explicitly out of scope — unsupported lockfiles fall back to unversioned, never a hard failure.
- pnpm: support the `importers['.']` structure (newer lockfileVersions) and the legacy root-level `dependencies`/`devDependencies`/`optionalDependencies` structure (older lockfileVersions).
- Auto-detection order next to `package.json`: `package-lock.json` → `yarn.lock` → `pnpm-lock.yaml` → none found. npm wins if multiple are present.
- A name/version that can't be resolved (no lockfile, unsupported format, missing entry) always falls back to unversioned scoring — never throws, never fails the action.
- `package.json` is always read for ranges, even when the `packages` input overrides discovery (yarn's parser needs the range to disambiguate). If `package.json` can't be read AND `packages` was explicitly provided, proceed with empty ranges rather than failing (preserves today's behavior of `packages` working standalone).
- `POST /packages/crawl` has no version parameter and never will — this plan removes all use of it from this action.
- New action input: `use-lockfile` (default `'true'`) — set to `'false'` to fully revert to unversioned scoring regardless of lockfile presence.

---

## Task 1: `NamedRange` type + npm lockfile parser

**Files:**
- Create: `src/lockfiles/types.ts`
- Create: `src/lockfiles/npm.ts`
- Test: `tests/lockfiles/npm.test.ts`

**Interfaces:**
- Produces: `NamedRange { name: string; range: string | undefined }` (in `src/lockfiles/types.ts`)
- Produces: `resolveNpmVersions(lockfileContent: string, packages: NamedRange[]): Map<string, string>`

- [ ] **Step 1: Create the shared type**

`src/lockfiles/types.ts`:

```typescript
export interface NamedRange {
  name: string
  range: string | undefined
}
```

- [ ] **Step 2: Write the failing test**

`tests/lockfiles/npm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveNpmVersions } from '../../src/lockfiles/npm'

describe('resolveNpmVersions', () => {
  it('resolves from the v2/v3 flat packages map', () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root' },
        'node_modules/axios': { version: '1.7.4' },
        'node_modules/@scope/pkg': { version: '2.1.0' },
      },
    })
    const result = resolveNpmVersions(lockfile, [
      { name: 'axios', range: '^1.0.0' },
      { name: '@scope/pkg', range: '^2.0.0' },
    ])
    expect(result.get('axios')).toBe('1.7.4')
    expect(result.get('@scope/pkg')).toBe('2.1.0')
  })

  it('resolves from the v1 nested dependencies tree', () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: '4.17.21' },
      },
    })
    const result = resolveNpmVersions(lockfile, [{ name: 'lodash', range: '^4.0.0' }])
    expect(result.get('lodash')).toBe('4.17.21')
  })

  it('omits a name that is not found in either structure', () => {
    const lockfile = JSON.stringify({ lockfileVersion: 3, packages: {} })
    const result = resolveNpmVersions(lockfile, [{ name: 'missing-pkg', range: '^1.0.0' }])
    expect(result.has('missing-pkg')).toBe(false)
  })

  it('falls back to the legacy dependencies tree if packages map lacks the entry', () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'root' } },
      dependencies: { fallback-pkg: { version: '9.9.9' } },
    })
    const result = resolveNpmVersions(lockfile, [{ name: 'fallback-pkg', range: '^9.0.0' }])
    expect(result.get('fallback-pkg')).toBe('9.9.9')
  })
})
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run tests/lockfiles/npm.test.ts`
Expected: FAIL — `Cannot find module '../../src/lockfiles/npm'`

- [ ] **Step 4: Implement `src/lockfiles/npm.ts`**

```typescript
import type { NamedRange } from './types'

interface NpmLockfile {
  packages?: Record<string, { version?: string }>
  dependencies?: Record<string, { version?: string }>
}

export function resolveNpmVersions(
  lockfileContent: string,
  packages: NamedRange[],
): Map<string, string> {
  const lockfile = JSON.parse(lockfileContent) as NpmLockfile
  const resolved = new Map<string, string>()

  for (const { name } of packages) {
    const fromPackagesMap = lockfile.packages?.[`node_modules/${name}`]?.version
    const fromLegacyTree = lockfile.dependencies?.[name]?.version
    const version = fromPackagesMap ?? fromLegacyTree
    if (version) resolved.set(name, version)
  }

  return resolved
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run tests/lockfiles/npm.test.ts`
Expected: PASS (4/4)

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/lockfiles/types.ts src/lockfiles/npm.ts tests/lockfiles/npm.test.ts
git commit -m "feat: add npm package-lock.json version resolution"
```

---

## Task 2: yarn Classic lockfile parser

**Files:**
- Create: `src/lockfiles/yarn.ts`
- Test: `tests/lockfiles/yarn.test.ts`

**Interfaces:**
- Consumes: `NamedRange` (Task 1, `src/lockfiles/types.ts`)
- Produces: `resolveYarnVersions(lockfileContent: string, packages: NamedRange[]): Map<string, string>`

- [ ] **Step 1: Write the failing test**

`tests/lockfiles/yarn.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveYarnVersions } from '../../src/lockfiles/yarn'

const FIXTURE = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"lodash@^4.17.15", "lodash@^4.17.21":
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#679591c564c3bffaae8454cf0b3df370c3d6911c"
  integrity sha512-v2kDEe57lecTulaDIuNTPy3Ry4//eyISDlrMK/AIWSMBanIrhfrsxrDPD9WwOzcpVDdIC4qKdSchTFq6Sc9m2A==

axios@^1.0.0:
  version "1.7.4"
  resolved "https://registry.yarnpkg.com/axios/-/axios-1.7.4.tgz#uuid"
  integrity sha512-uuid
`

describe('resolveYarnVersions', () => {
  it('resolves a single-descriptor block', () => {
    const result = resolveYarnVersions(FIXTURE, [{ name: 'axios', range: '^1.0.0' }])
    expect(result.get('axios')).toBe('1.7.4')
  })

  it('resolves a multi-descriptor block by exact range match', () => {
    const result = resolveYarnVersions(FIXTURE, [{ name: 'lodash', range: '^4.17.21' }])
    expect(result.get('lodash')).toBe('4.17.21')
  })

  it('resolves a different range sharing the same multi-descriptor block', () => {
    const result = resolveYarnVersions(FIXTURE, [{ name: 'lodash', range: '^4.17.15' }])
    expect(result.get('lodash')).toBe('4.17.21')
  })

  it('omits a name whose range has no matching descriptor', () => {
    const result = resolveYarnVersions(FIXTURE, [{ name: 'lodash', range: '^3.0.0' }])
    expect(result.has('lodash')).toBe(false)
  })

  it('skips a name with an undefined range (no way to disambiguate)', () => {
    const result = resolveYarnVersions(FIXTURE, [{ name: 'axios', range: undefined }])
    expect(result.has('axios')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run tests/lockfiles/yarn.test.ts`
Expected: FAIL — `Cannot find module '../../src/lockfiles/yarn'`

- [ ] **Step 3: Implement `src/lockfiles/yarn.ts`**

```typescript
import type { NamedRange } from './types'

function parseDescriptors(headerLine: string): string[] {
  return headerLine
    .replace(/:$/, '')
    .split(', ')
    .map(d => d.trim().replace(/^"|"$/g, ''))
}

export function resolveYarnVersions(
  lockfileContent: string,
  packages: NamedRange[],
): Map<string, string> {
  const descriptorToVersion = new Map<string, string>()
  const lines = lockfileContent.split('\n')

  let currentDescriptors: string[] = []
  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue

    if (!line.startsWith(' ')) {
      currentDescriptors = parseDescriptors(line)
      continue
    }

    const versionMatch = line.match(/^\s*version\s+"([^"]+)"/)
    if (versionMatch && currentDescriptors.length > 0) {
      for (const descriptor of currentDescriptors) {
        descriptorToVersion.set(descriptor, versionMatch[1]!)
      }
      currentDescriptors = []
    }
  }

  const resolved = new Map<string, string>()
  for (const { name, range } of packages) {
    if (!range) continue
    const version = descriptorToVersion.get(`${name}@${range}`)
    if (version) resolved.set(name, version)
  }

  return resolved
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/lockfiles/yarn.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/lockfiles/yarn.ts tests/lockfiles/yarn.test.ts
git commit -m "feat: add yarn Classic (v1) lockfile version resolution"
```

---

## Task 3: pnpm lockfile parser

**Files:**
- Modify: `package.json` (add `js-yaml` + `@types/js-yaml`)
- Create: `src/lockfiles/pnpm.ts`
- Test: `tests/lockfiles/pnpm.test.ts`

**Interfaces:**
- Consumes: `NamedRange` (Task 1, `src/lockfiles/types.ts`)
- Produces: `resolvePnpmVersions(lockfileContent: string, packages: NamedRange[]): Map<string, string>`

- [ ] **Step 1: Add the new dependency**

Run: `npm install js-yaml && npm install --save-dev @types/js-yaml`

Confirm `package.json`'s `dependencies` gained `"js-yaml": "^4.1.0"` (or whatever current version `npm install` resolves) and `devDependencies` gained `"@types/js-yaml": "^4.0.9"` (or current resolved version) — exact version strings are whatever `npm install` writes; don't hand-edit them.

- [ ] **Step 2: Write the failing test**

`tests/lockfiles/pnpm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolvePnpmVersions } from '../../src/lockfiles/pnpm'

const NEWER_FIXTURE = `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      axios:
        specifier: ^1.0.0
        version: 1.7.4
    devDependencies:
      vitest:
        specifier: ^1.0.0
        version: 1.0.0

packages:
  axios@1.7.4: {}
`

const OLDER_FIXTURE = `
lockfileVersion: '6.0'

dependencies:
  lodash:
    specifier: ^4.17.21
    version: 4.17.21

packages:
  /lodash@4.17.21: {}
`

const PEER_SUFFIX_FIXTURE = `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      some-hook-lib:
        specifier: ^2.0.0
        version: 2.0.0(react@18.0.0)
`

describe('resolvePnpmVersions', () => {
  it('resolves from the newer importers[.] structure', () => {
    const result = resolvePnpmVersions(NEWER_FIXTURE, [{ name: 'axios', range: '^1.0.0' }])
    expect(result.get('axios')).toBe('1.7.4')
  })

  it('resolves devDependencies from importers[.]', () => {
    const result = resolvePnpmVersions(NEWER_FIXTURE, [{ name: 'vitest', range: '^1.0.0' }])
    expect(result.get('vitest')).toBe('1.0.0')
  })

  it('resolves from the older root-level structure', () => {
    const result = resolvePnpmVersions(OLDER_FIXTURE, [{ name: 'lodash', range: '^4.17.21' }])
    expect(result.get('lodash')).toBe('4.17.21')
  })

  it('strips a peer-dependency suffix from the resolved version', () => {
    const result = resolvePnpmVersions(PEER_SUFFIX_FIXTURE, [{ name: 'some-hook-lib', range: '^2.0.0' }])
    expect(result.get('some-hook-lib')).toBe('2.0.0')
  })

  it('omits a name not present in the lockfile', () => {
    const result = resolvePnpmVersions(NEWER_FIXTURE, [{ name: 'missing-pkg', range: '^1.0.0' }])
    expect(result.has('missing-pkg')).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run tests/lockfiles/pnpm.test.ts`
Expected: FAIL — `Cannot find module '../../src/lockfiles/pnpm'`

- [ ] **Step 4: Implement `src/lockfiles/pnpm.ts`**

```typescript
import * as yaml from 'js-yaml'
import type { NamedRange } from './types'

interface PnpmDepEntry {
  specifier?: string
  version?: string
}

interface PnpmScope {
  dependencies?: Record<string, PnpmDepEntry>
  devDependencies?: Record<string, PnpmDepEntry>
  optionalDependencies?: Record<string, PnpmDepEntry>
}

interface PnpmLockfile extends PnpmScope {
  importers?: Record<string, PnpmScope>
}

function extractVersion(entry: PnpmDepEntry | undefined): string | undefined {
  if (!entry?.version) return undefined
  // pnpm suffixes peer-dependency-affected versions, e.g. "2.0.0(react@18.0.0)"
  return entry.version.split('(')[0]
}

export function resolvePnpmVersions(
  lockfileContent: string,
  packages: NamedRange[],
): Map<string, string> {
  const lockfile = yaml.load(lockfileContent) as PnpmLockfile
  const scope: PnpmScope = lockfile.importers?.['.'] ?? lockfile

  const resolved = new Map<string, string>()
  for (const { name } of packages) {
    const version =
      extractVersion(scope.dependencies?.[name]) ??
      extractVersion(scope.devDependencies?.[name]) ??
      extractVersion(scope.optionalDependencies?.[name])
    if (version) resolved.set(name, version)
  }

  return resolved
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run tests/lockfiles/pnpm.test.ts`
Expected: PASS (5/5)

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lockfiles/pnpm.ts tests/lockfiles/pnpm.test.ts
git commit -m "feat: add pnpm-lock.yaml version resolution"
```

---

## Task 4: Auto-detecting lockfile dispatcher

**Files:**
- Create: `src/lockfiles/index.ts`
- Test: `tests/lockfiles/index.test.ts`

**Interfaces:**
- Consumes: `resolveNpmVersions` (Task 1), `resolveYarnVersions` (Task 2), `resolvePnpmVersions` (Task 3), `NamedRange` (Task 1)
- Produces: `resolveLockfileVersions(lockfileDir: string, packages: NamedRange[]): Map<string, string>`, re-exports `NamedRange`

- [ ] **Step 1: Write the failing test**

`tests/lockfiles/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { resolveLockfileVersions } from '../../src/lockfiles'

vi.mock('fs')

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false)
})

describe('resolveLockfileVersions', () => {
  it('uses the npm parser when package-lock.json is present', () => {
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).endsWith('package-lock.json'))
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/axios': { version: '1.7.4' } },
    }))
    const result = resolveLockfileVersions('/repo', [{ name: 'axios', range: '^1.0.0' }])
    expect(result.get('axios')).toBe('1.7.4')
  })

  it('uses the yarn parser when yarn.lock is present and package-lock.json is not', () => {
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).endsWith('yarn.lock'))
    vi.mocked(fs.readFileSync).mockReturnValue('axios@^1.0.0:\n  version "1.7.4"\n')
    const result = resolveLockfileVersions('/repo', [{ name: 'axios', range: '^1.0.0' }])
    expect(result.get('axios')).toBe('1.7.4')
  })

  it('uses the pnpm parser when pnpm-lock.yaml is present and the others are not', () => {
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).endsWith('pnpm-lock.yaml'))
    vi.mocked(fs.readFileSync).mockReturnValue(
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      axios:\n        specifier: ^1.0.0\n        version: 1.7.4\n"
    )
    const result = resolveLockfileVersions('/repo', [{ name: 'axios', range: '^1.0.0' }])
    expect(result.get('axios')).toBe('1.7.4')
  })

  it('prefers npm when multiple lockfiles are present', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/axios': { version: '1.7.4' } },
    }))
    const result = resolveLockfileVersions('/repo', [{ name: 'axios', range: '^1.0.0' }])
    expect(result.get('axios')).toBe('1.7.4')
  })

  it('returns an empty map when no lockfile is found', () => {
    const result = resolveLockfileVersions('/repo', [{ name: 'axios', range: '^1.0.0' }])
    expect(result.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run tests/lockfiles/index.test.ts`
Expected: FAIL — `Cannot find module '../../src/lockfiles'`

- [ ] **Step 3: Implement `src/lockfiles/index.ts`**

```typescript
import * as fs from 'fs'
import * as path from 'path'
import { resolveNpmVersions } from './npm'
import { resolveYarnVersions } from './yarn'
import { resolvePnpmVersions } from './pnpm'
import type { NamedRange } from './types'

export type { NamedRange } from './types'

export function resolveLockfileVersions(
  lockfileDir: string,
  packages: NamedRange[],
): Map<string, string> {
  const npmPath = path.join(lockfileDir, 'package-lock.json')
  if (fs.existsSync(npmPath)) {
    return resolveNpmVersions(fs.readFileSync(npmPath, 'utf8'), packages)
  }

  const yarnPath = path.join(lockfileDir, 'yarn.lock')
  if (fs.existsSync(yarnPath)) {
    return resolveYarnVersions(fs.readFileSync(yarnPath, 'utf8'), packages)
  }

  const pnpmPath = path.join(lockfileDir, 'pnpm-lock.yaml')
  if (fs.existsSync(pnpmPath)) {
    return resolvePnpmVersions(fs.readFileSync(pnpmPath, 'utf8'), packages)
  }

  return new Map()
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/lockfiles/index.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/lockfiles/index.ts tests/lockfiles/index.test.ts
git commit -m "feat: add auto-detecting lockfile dispatcher"
```

---

## Task 5: `discover.ts` integration

**Files:**
- Modify: `src/discover.ts`
- Test: `tests/discover.test.ts`

**Interfaces:**
- Consumes: `resolveLockfileVersions`, `NamedRange` (Task 4, `src/lockfiles/index.ts`)
- Produces: `DiscoveredPackage { name: string; version: string | null }`; `discoverPackages` gains a 5th `useLockfile: boolean` parameter and returns `DiscoveredPackage[]` instead of `string[]`

This changes `discoverPackages`'s return type — every current caller (`src/index.ts`, Task 7) and every current test in `tests/discover.test.ts` needs updating. This task updates `tests/discover.test.ts` fully; Task 7 updates `src/index.ts`'s call site.

- [ ] **Step 1: Replace `tests/discover.test.ts` with the new shape**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { discoverPackages } from '../src/discover'

vi.mock('fs')

const mockPkg = {
  dependencies: { axios: '^1.0.0', lodash: '^4.0.0' },
  devDependencies: { vitest: '^1.0.0' },
  optionalDependencies: { fsevents: '^2.0.0' },
}

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
    if (String(p).endsWith('package.json')) return JSON.stringify(mockPkg)
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  vi.mocked(fs.existsSync).mockReturnValue(false) // no lockfile by default
})

describe('discoverPackages', () => {
  it('returns explicit packages when provided, ignoring package.json for names', () => {
    const result = discoverPackages('package.json', ['react', 'vue'], false, false, false)
    expect(result).toEqual([
      { name: 'react', version: null },
      { name: 'vue', version: null },
    ])
  })

  it('deduplicates explicit packages', () => {
    const result = discoverPackages('package.json', ['react', 'react'], false, false, false)
    expect(result).toEqual([{ name: 'react', version: null }])
  })

  it('returns dependencies only by default', () => {
    const result = discoverPackages('package.json', [], false, false, false)
    const names = result.map(p => p.name)
    expect(names).toContain('axios')
    expect(names).toContain('lodash')
    expect(names).not.toContain('vitest')
    expect(names).not.toContain('fsevents')
  })

  it('includes devDependencies when includeDev is true', () => {
    const result = discoverPackages('package.json', [], true, false, false)
    const names = result.map(p => p.name)
    expect(names).toContain('vitest')
    expect(names).not.toContain('fsevents')
  })

  it('includes optionalDependencies when includeOptional is true', () => {
    const result = discoverPackages('package.json', [], false, true, false)
    const names = result.map(p => p.name)
    expect(names).toContain('fsevents')
    expect(names).not.toContain('vitest')
  })

  it('deduplicates across dependency types', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      dependencies: { shared: '^1.0.0' },
      devDependencies: { shared: '^1.0.0' },
    }))
    const result = discoverPackages('package.json', [], true, false, false)
    expect(result.filter(p => p.name === 'shared').length).toBe(1)
  })

  it('every entry has version: null when useLockfile is false, even if a lockfile is present', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true) // pretend a lockfile exists
    const result = discoverPackages('package.json', [], false, false, false)
    expect(result.every(p => p.version === null)).toBe(true)
  })

  it('resolves versions from the lockfile when useLockfile is true', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith('package-lock.json') || String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('package-lock.json')) {
        return JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/axios': { version: '1.7.4' } } })
      }
      return JSON.stringify(mockPkg)
    })
    const result = discoverPackages('package.json', [], false, false, true)
    expect(result.find(p => p.name === 'axios')!.version).toBe('1.7.4')
  })

  it('falls back to version: null for a package.json entry missing from the lockfile', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith('package-lock.json') || String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('package-lock.json')) {
        return JSON.stringify({ lockfileVersion: 3, packages: {} }) // axios not in lockfile
      }
      return JSON.stringify(mockPkg)
    })
    const result = discoverPackages('package.json', [], false, false, true)
    expect(result.find(p => p.name === 'axios')!.version).toBeNull()
  })

  it('resolves explicit packages against the lockfile too', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith('package-lock.json') || String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('package-lock.json')) {
        return JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/axios': { version: '1.7.4' } } })
      }
      return JSON.stringify(mockPkg)
    })
    const result = discoverPackages('package.json', ['axios'], false, false, true)
    expect(result).toEqual([{ name: 'axios', version: '1.7.4' }])
  })

  it('does not throw when package.json is unreadable and explicit packages are provided', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const result = discoverPackages('package.json', ['some-pkg'], false, false, true)
    expect(result).toEqual([{ name: 'some-pkg', version: null }])
  })

  it('throws when package.json is unreadable and no explicit packages are provided', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    expect(() => discoverPackages('package.json', [], false, false, false)).toThrow()
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run tests/discover.test.ts`
Expected: FAIL — `discoverPackages` doesn't accept a 5th argument yet, and returns `string[]` not `DiscoveredPackage[]`

- [ ] **Step 3: Update `src/discover.ts`**

```typescript
import * as fs from 'fs'
import * as path from 'path'
import { resolveLockfileVersions } from './lockfiles'
import type { NamedRange } from './lockfiles'

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

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
): DiscoveredPackage[] {
  const absPath = path.resolve(
    process.env['GITHUB_WORKSPACE'] ?? process.cwd(),
    packageJsonPath,
  )

  let pkg: PackageJson = {}
  try {
    pkg = JSON.parse(fs.readFileSync(absPath, 'utf8') as string) as PackageJson
  } catch (err) {
    if (explicitPackages.length === 0) throw err
    // packages input is a deliberate override that works standalone —
    // package.json is optional in that case, so ranges just stay empty.
  }

  const ranges = new Map<string, string>()
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) ranges.set(name, range)
  if (includeDev) {
    for (const [name, range] of Object.entries(pkg.devDependencies ?? {})) ranges.set(name, range)
  }
  if (includeOptional) {
    for (const [name, range] of Object.entries(pkg.optionalDependencies ?? {})) ranges.set(name, range)
  }

  const names = explicitPackages.length > 0 ? [...new Set(explicitPackages)] : [...ranges.keys()]

  if (!useLockfile) {
    return names.map(name => ({ name, version: null }))
  }

  const namedRanges: NamedRange[] = names.map(name => ({ name, range: ranges.get(name) }))
  const resolved = resolveLockfileVersions(path.dirname(absPath), namedRanges)

  return names.map(name => ({ name, version: resolved.get(name) ?? null }))
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/discover.test.ts`
Expected: PASS (12/12)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — `src/index.ts` and `src/score.ts` still call `discoverPackages`/`scorePackages` with the old signature/shape. Expected at this point in the plan; resolved by Tasks 6-7.

- [ ] **Step 6: Commit**

```bash
git add src/discover.ts tests/discover.test.ts
git commit -m "feat: resolve lockfile versions in discoverPackages"
```

---

## Task 6: `score.ts` refactor — version threading, drop `POST /packages/crawl`

**Files:**
- Modify: `src/score.ts`
- Test: `tests/score.test.ts`

**Interfaces:**
- Consumes: `DiscoveredPackage` (Task 5, `src/discover.ts`)
- Produces: `scorePackages(packages: DiscoveredPackage[], apiKey: string, crawlTimeoutSeconds: number): Promise<PackageScore[]>` (same exported name, new parameter type — `PackageScore`'s own shape, from `src/types.ts`, is unchanged)

**Design note:** The old flow was `fetchScoreOnce` (a single unversioned `GET`) → on a miss, `crawlAndWait` (`POST /packages/crawl`, then poll the job, then re-`GET`). `POST /packages/crawl` has no version parameter and never will. The single-package `GET /packages/:name?version=X` endpoint already does everything needed in one call: on a miss it auto-triggers a crawl (scoped to the version, if given), waits internally (~20s), and returns `200` (scored), `202 {status, job_id, retry_after_seconds}` if still pending, or `404` if the crawl determined the package/version doesn't exist. This task collapses both old functions into one `fetchOrCrawl`, which calls `GET` once and, on `202`, takes `job_id` directly from that response to poll — no second trigger call of any kind.

- [ ] **Step 1: Replace `tests/score.test.ts` with the new shape**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scorePackages } from '../src/score'
import type { DiscoveredPackage } from '../src/discover'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function ok(body: unknown, status = 200) {
  return Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) })
}
function notFound() {
  return Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({ error: 'not found' }) })
}
function serverError() {
  return Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({}) })
}

function pkg(name: string, version: string | null = null): DiscoveredPackage {
  return { name, version }
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('scorePackages', () => {
  it('returns scored package on a direct 200', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 79, version: '1.7.4' }))
    const result = await scorePackages([pkg('axios')], 'key', 10)
    expect(result).toEqual([{
      name: 'axios', version: '1.7.4', generalScore: 84, automationScore: 88, riskScore: 79, status: 'scored',
    }])
  })

  it('includes ?version= in the request URL when a version is given', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 79, version: '5.9.0' }))
    await scorePackages([pkg('fastify', '5.9.0')], 'key', 10)
    const [url] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.packagerating.com/packages/fastify?version=5.9.0')
  })

  it('omits ?version= from the request URL when no version was resolved', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 79 }))
    await scorePackages([pkg('axios')], 'key', 10)
    const [url] = mockFetch.mock.calls[0]!
    expect(url).toBe('https://api.packagerating.com/packages/axios')
  })

  it('returns version: null when the API response omits version', async () => {
    mockFetch.mockResolvedValue(ok({ general_score: 84, automation_score: 88, risk_score: 79 }))
    const result = await scorePackages([pkg('axios')], 'key', 10)
    expect(result[0]!.version).toBeNull()
  })

  it('returns unscored on a direct 404', async () => {
    mockFetch.mockResolvedValue(notFound())
    const result = await scorePackages([pkg('nonexistent')], 'key', 10)
    expect(result[0]!.status).toBe('unscored')
  })

  it('returns unscored on a 200 with no scores at all (defensive)', async () => {
    mockFetch.mockResolvedValue(ok({ name: 'stub-pkg' }))
    const result = await scorePackages([pkg('stub-pkg')], 'key', 10)
    expect(result[0]!.status).toBe('unscored')
  })

  it('polls the job from a 202 response and returns scored once done', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ status: 'crawling', job_id: 'job-1', retry_after_seconds: 5 }, 202)) // initial GET
      .mockResolvedValueOnce(ok({ status: 'queued', processed: 1, total: 1 })) // poll job — done
      .mockResolvedValueOnce(ok({ general_score: 72, automation_score: 80, risk_score: 65 })) // re-fetch score

    const result = await scorePackages([pkg('new-pkg')], 'key', 30)
    expect(result[0]!.status).toBe('scored')
    expect(result[0]!.generalScore).toBe(72)
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('returns unscored if the job finishes but the re-fetch is a 404', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ status: 'crawling', job_id: 'job-2', retry_after_seconds: 5 }, 202))
      .mockResolvedValueOnce(ok({ status: 'done', processed: 1, total: 1 }))
      .mockResolvedValueOnce(notFound())

    const result = await scorePackages([pkg('removed-pkg')], 'key', 30)
    expect(result[0]!.status).toBe('unscored')
  })

  it('returns unscored when the crawl times out (deadline already passed)', async () => {
    mockFetch.mockResolvedValueOnce(ok({ status: 'crawling', job_id: 'job-3', retry_after_seconds: 5 }, 202))
    const result = await scorePackages([pkg('slow-pkg')], 'key', 0)
    expect(result[0]!.status).toBe('unscored')
  })

  it('returns crawl-error when a 202 response is missing job_id', async () => {
    mockFetch.mockResolvedValueOnce(ok({ status: 'crawling' }, 202))
    const result = await scorePackages([pkg('bad-pkg')], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('returns crawl-error on a direct 500', async () => {
    mockFetch.mockResolvedValue(serverError())
    const result = await scorePackages([pkg('bad-pkg')], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('returns crawl-error on a fetch rejection', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    const result = await scorePackages([pkg('bad-pkg')], 'key', 10)
    expect(result[0]!.status).toBe('crawl-error')
  })

  it('scores multiple packages concurrently, isolating one failure from the rest', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/packages/good-pkg')) return ok({ general_score: 75, automation_score: 78, risk_score: 70 })
      if (url.includes('/packages/bad-pkg')) return serverError()
      return notFound()
    })
    const result = await scorePackages([pkg('bad-pkg'), pkg('good-pkg')], 'key', 10)
    expect(result).toHaveLength(2)
    expect(result.find(r => r.name === 'bad-pkg')!.status).toBe('crawl-error')
    expect(result.find(r => r.name === 'good-pkg')!.status).toBe('scored')
    expect(result.find(r => r.name === 'good-pkg')!.generalScore).toBe(75)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run tests/score.test.ts`
Expected: FAIL — old `score.ts` still expects `string[]`, has no `?version=` handling, and never reads `job_id` from a `202` body

- [ ] **Step 3: Replace `src/score.ts`**

```typescript
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

async function fetchScore(name: string, version: string | null, apiKey: string): Promise<PackageScore | 'not-found'> {
  const res = await fetch(buildUrl(name, version), { headers: { 'x-api-key': apiKey } })
  if (res.status === 404) return 'not-found'
  if (!res.ok) throw new Error(`GET /packages/${name} returned ${res.status}`)

  const data = await res.json() as ApiPackageResponse
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
    if (data.general_score == null && data.automation_score == null && data.risk_score == null) {
      return emptyScore(name, 'unscored')
    }

    return {
      name,
      version: data.version ?? null,
      generalScore: data.general_score ?? null,
      automationScore: data.automation_score ?? null,
      riskScore: data.risk_score ?? null,
      status: 'scored',
    }
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
```

Note: `fetchScore` is only used inside `pollJob` (the re-fetch after a job completes) — the initial attempt lives directly in `fetchOrCrawl` since it must additionally handle the `202` case, which `fetchScore` deliberately doesn't (a `202` from the re-fetch after a job is already "done" would be unexpected; treating it as `not-found` there would silently mask a bug, so keep the two call sites separate rather than force one function to cover both).

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/score.test.ts`
Expected: PASS (13/13)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — `src/index.ts` still calls `discoverPackages` with 4 args and passes its result straight to `scorePackages`. Expected at this point; resolved by Task 7.

- [ ] **Step 6: Commit**

```bash
git add src/score.ts tests/score.test.ts
git commit -m "feat: thread version into score requests, drop POST /packages/crawl"
```

---

## Task 7: Wire `use-lockfile` input through `index.ts`, document in `action.yml` and `README.md`

**Files:**
- Modify: `src/index.ts`
- Modify: `action.yml`
- Modify: `README.md`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `discoverPackages` (Task 5, new signature), `scorePackages` (Task 6, new parameter type)

- [ ] **Step 1: Update `tests/index.test.ts`**

Only the parts that need to change: the `discoverPackagesMock`'s resolved value shape (now `DiscoveredPackage[]`), and the new `use-lockfile` default input. Full updated file:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PackageScore } from '../src/types'

const scoredPkg = (name: string, g: number, a: number, r: number): PackageScore => ({
  name, version: '1.0.0', generalScore: g, automationScore: a, riskScore: r, status: 'scored',
})

describe('run() integration', () => {
  let getInputMock: ReturnType<typeof vi.fn>
  let setOutputMock: ReturnType<typeof vi.fn>
  let setFailedMock: ReturnType<typeof vi.fn>
  let discoverPackagesMock: ReturnType<typeof vi.fn>
  let scorePackagesMock: ReturnType<typeof vi.fn>
  let writeJobSummaryMock: ReturnType<typeof vi.fn>
  let upsertPrCommentMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    getInputMock = vi.fn()
    setOutputMock = vi.fn()
    setFailedMock = vi.fn()
    discoverPackagesMock = vi.fn().mockReturnValue([{ name: 'left-pad', version: null }])
    scorePackagesMock = vi.fn().mockResolvedValue([scoredPkg('left-pad', 80, 80, 80)])
    writeJobSummaryMock = vi.fn().mockResolvedValue(undefined)
    upsertPrCommentMock = vi.fn().mockResolvedValue(undefined)

    vi.doMock('@actions/core', () => ({
      getInput: (...args: unknown[]) => getInputMock(...args),
      setOutput: (...args: unknown[]) => setOutputMock(...args),
      setFailed: (...args: unknown[]) => setFailedMock(...args),
      info: vi.fn(),
      warning: vi.fn(),
      summary: {
        addHeading: vi.fn().mockReturnThis(),
        addRaw: vi.fn().mockReturnThis(),
        addEOL: vi.fn().mockReturnThis(),
        write: vi.fn().mockResolvedValue(undefined),
      },
    }))
    vi.doMock('../src/discover', () => ({
      discoverPackages: (...args: unknown[]) => discoverPackagesMock(...args),
    }))
    vi.doMock('../src/score', () => ({
      scorePackages: (...args: unknown[]) => scorePackagesMock(...args),
    }))
    vi.doMock('../src/report', () => ({
      writeJobSummary: (...args: unknown[]) => writeJobSummaryMock(...args),
      upsertPrComment: (...args: unknown[]) => upsertPrCommentMock(...args),
    }))
  })

  async function runWithInputs(inputs: Record<string, string>): Promise<void> {
    const defaults: Record<string, string> = {
      'api-key': 'k',
      'package-json-path': 'package.json',
      packages: '',
      'include-dev': 'false',
      'include-optional': 'false',
      'use-lockfile': 'true',
      'fail-on-general': '',
      'fail-on-automation': '',
      'fail-on-risk': '',
      'pr-comment': 'true',
      'github-token': 'gh-token-123',
      'crawl-timeout': '120',
    }
    const merged = { ...defaults, ...inputs }
    getInputMock.mockImplementation((name: string) => merged[name] ?? '')

    const { run } = await import('../src/index')
    await run()
  }

  it('reads the github-token input and passes it through to upsertPrComment', async () => {
    await runWithInputs({})
    expect(upsertPrCommentMock).toHaveBeenCalledTimes(1)
    const [, , token] = upsertPrCommentMock.mock.calls[0]!
    expect(token).toBe('gh-token-123')
  })

  it('passes useLockfile=true to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[4]).toBe(true)
  })

  it('passes useLockfile=false to discoverPackages when use-lockfile input is "false"', async () => {
    await runWithInputs({ 'use-lockfile': 'false' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[4]).toBe(false)
  })

  it('calls writeJobSummary before gating regardless of outcome', async () => {
    scorePackagesMock.mockResolvedValue([scoredPkg('left-pad', 10, 10, 10)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(writeJobSummaryMock).toHaveBeenCalledTimes(1)
    expect(setFailedMock).toHaveBeenCalled()
  })

  it('calls core.setFailed when a package fails a threshold', async () => {
    scorePackagesMock.mockResolvedValue([scoredPkg('left-pad', 10, 80, 80)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(setFailedMock).toHaveBeenCalledWith(expect.stringContaining('left-pad'))
  })

  it('does not call core.setFailed when no package fails a threshold', async () => {
    scorePackagesMock.mockResolvedValue([scoredPkg('left-pad', 80, 80, 80)])
    await runWithInputs({ 'fail-on-general': '50' })
    expect(writeJobSummaryMock).toHaveBeenCalledTimes(1)
    expect(setFailedMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run tests/index.test.ts`
Expected: FAIL — `discoverPackagesMock` is called with only 4 args today (no `use-lockfile` input read yet)

- [ ] **Step 3: Update `src/index.ts`**

Change the `discoverPackages` call (everything else in this file is unchanged):

```typescript
  const names = discoverPackages(
    core.getInput('package-json-path') || 'package.json',
    explicitPackages,
    core.getInput('include-dev') === 'true',
    core.getInput('include-optional') === 'true',
    core.getInput('use-lockfile') !== 'false',
  )
```

`!== 'false'` (rather than `=== 'true'`) so the input defaults to lockfile resolution being *on* even if `core.getInput('use-lockfile')` returns an empty string (GitHub Actions supplies the `default: 'true'` from `action.yml` at runtime, but this makes the code's own default explicit and matches the action.yml default below).

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/index.test.ts`
Expected: PASS (6/6)

- [ ] **Step 5: Full suite and typecheck**

Run: `npx vitest run`
Expected: all tests pass across every file (npm/yarn/pnpm/index lockfile tests, discover, score, index, report, gate)

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Update `action.yml`**

Add this input (alongside the existing `include-optional` input, before `fail-on-general`):

```yaml
  use-lockfile:
    description: 'Resolve exact installed versions from the lockfile (package-lock.json, yarn.lock, or pnpm-lock.yaml) instead of scoring latest'
    required: false
    default: 'true'
```

- [ ] **Step 7: Update `README.md`**

Add a row to the Inputs table (after `include-optional`):

```markdown
| `use-lockfile` | no | `true` | Resolve exact installed versions from the lockfile instead of scoring latest |
```

Add a new section after "## Inputs" table, before "## Outputs":

```markdown
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
```

- [ ] **Step 8: Commit**

```bash
git add src/index.ts action.yml README.md tests/index.test.ts
git commit -m "feat: add use-lockfile input, wire lockfile resolution into run()"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all tests pass (every file in `tests/`, including the 4 new `tests/lockfiles/*.test.ts` files)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds, produces `dist/index.js` (matches what CI's `ci.yml` already verifies on every push/PR — this step doesn't commit `dist/index.js`; that's handled separately by `release.yml` at tag time, per existing project convention)

- [ ] **Step 4: Push the branch**

```bash
git push -u origin <branch-name>
```
