# Independent Subproject Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the action discover and score `package.json` files in subdirectories that are NOT
declared as formal workspace members — e.g. `admin/package.json` in a repo whose root has no
`"workspaces"` field — each resolved against its own, independent lockfile.

**Architecture:** A new `src/subprojects.ts` module glob-scans the repo for `package.json` files
not already covered by root or workspace-member discovery, bounded by a configurable max depth and
exclude list. `discover.ts`'s internal `ScopedRange` gains an `ownLockfile` flag; the existing
version-resolution loop splits into two groups — shared-lockfile (today's exact behavior, unchanged)
and own-lockfile (new: each subproject's dependencies resolve against a lockfile in its own
directory, with no `memberPath` involved). Both groups feed the same final dedup step unchanged.
Three new action inputs (`audit-subprojects`, `subproject-max-depth`, `subproject-exclude`) control
it, independent of `audit-workspaces`.

**Tech Stack:** TypeScript, Vitest, `fast-glob` (already a dependency), `@actions/core`.

## Global Constraints

- `discoverSubprojects(rootDir, maxDepth, extraExcludeGlobs, alreadyDiscovered)` returns paths
  relative to `rootDir`, exactly like `discoverWorkspaceMembers`.
- `node_modules` is excluded from subproject scanning unconditionally — never overridable by
  `extraExcludeGlobs`.
- Fixed default excludes, always applied regardless of `extraExcludeGlobs`: `node_modules`, `.git`,
  `dist`, `build`, `coverage`, `vendor`.
- A path already present in `alreadyDiscovered` (formal workspace members) must never also be
  returned by `discoverSubprojects` — avoids double-resolving the same directory two different ways.
- The root's own `package.json` (depth 0) is never included in `discoverSubprojects`'s result.
- `discoverPackages`'s new positional parameters, in order, appended after the existing 6:
  `auditSubprojects: boolean`, `subprojectMaxDepth: number`, `subprojectExcludeGlobs: string[]`.
- New action inputs and exact defaults: `audit-subprojects` (default `'true'`),
  `subproject-max-depth` (default `'3'`), `subproject-exclude` (default `''`).
- Every existing test in `tests/discover.test.ts`, `tests/workspaces.test.ts`,
  `tests/workspaces-members.test.ts`, and `tests/index.test.ts` must continue passing with no
  behavior change — achieved by passing `auditSubprojects: false` (a no-op) from every call site
  that doesn't specifically test subproject behavior.
- Subproject entries never trigger when `explicitPackages.length > 0`, mirroring workspace-member
  discovery's identical existing rule.

---

### Task 1: `discoverSubprojects` in `src/subprojects.ts`

**Files:**
- Create: `src/subprojects.ts`
- Test: `tests/subprojects.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export function discoverSubprojects(
    rootDir: string,
    maxDepth: number,
    extraExcludeGlobs: string[],
    alreadyDiscovered: string[],
  ): string[]
  ```
  Returns relative (POSIX-style, `/`-separated) directory paths from `rootDir`, one per discovered
  independent `package.json`, excluding the root's own and anything in `alreadyDiscovered`.

- [ ] **Step 1: Write the failing tests**

Create `tests/subprojects.test.ts`, mirroring the real-temp-directory pattern already used in
`tests/workspaces-members.test.ts` (glob-based discovery does real filesystem traversal via
`fast-glob`, which a blanket `vi.mock('fs')` would break):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { discoverSubprojects } from '../src/subprojects'

let rootDir: string

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subprojects-test-'))
})

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true })
})

function makePackage(relativeDir: string, name: string): void {
  const dir = path.join(rootDir, relativeDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }))
}

describe('discoverSubprojects', () => {
  it('finds an independent package.json one directory deep', () => {
    makePackage('admin', 'admin')
    const result = discoverSubprojects(rootDir, 3, [], [])
    expect(result).toEqual(['admin'])
  })

  it('never includes the root\'s own package.json', () => {
    makePackage('.', 'root')
    makePackage('admin', 'admin')
    const result = discoverSubprojects(rootDir, 3, [], [])
    expect(result).toEqual(['admin'])
  })

  it('finds package.json files at multiple depths up to maxDepth', () => {
    makePackage('admin', 'admin')
    makePackage('apps/web', 'web')
    const result = discoverSubprojects(rootDir, 3, [], [])
    expect(result.sort()).toEqual(['admin', 'apps/web'])
  })

  it('stops at maxDepth and does not return deeper matches', () => {
    makePackage('a/b/c', 'deep')
    const result = discoverSubprojects(rootDir, 2, [], [])
    expect(result).toEqual([])
  })

  it('includes a match exactly at maxDepth', () => {
    makePackage('a/b', 'atDepth')
    const result = discoverSubprojects(rootDir, 2, [], [])
    expect(result).toEqual(['a/b'])
  })

  it('always excludes node_modules even when not listed in extraExcludeGlobs', () => {
    makePackage('admin', 'admin')
    makePackage('node_modules/some-dep', 'some-dep')
    const result = discoverSubprojects(rootDir, 3, [], [])
    expect(result).toEqual(['admin'])
  })

  it('always excludes the fixed default directories (.git, dist, build, coverage, vendor)', () => {
    makePackage('admin', 'admin')
    makePackage('dist/leftover', 'leftover')
    makePackage('build/leftover', 'leftover')
    makePackage('coverage/leftover', 'leftover')
    makePackage('vendor/leftover', 'leftover')
    const result = discoverSubprojects(rootDir, 3, [], [])
    expect(result).toEqual(['admin'])
  })

  it('does not return a path already present in alreadyDiscovered', () => {
    makePackage('packages/foo', 'foo')
    makePackage('admin', 'admin')
    const result = discoverSubprojects(rootDir, 3, [], ['packages/foo'])
    expect(result).toEqual(['admin'])
  })

  it('suppresses an otherwise-matching directory via extraExcludeGlobs', () => {
    makePackage('admin', 'admin')
    makePackage('fixtures/fake-project', 'fake')
    const result = discoverSubprojects(rootDir, 3, ['fixtures/**'], [])
    expect(result).toEqual(['admin'])
  })

  it('returns an empty array when no independent package.json exists', () => {
    const result = discoverSubprojects(rootDir, 3, [], [])
    expect(result).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/subprojects.test.ts`
Expected: FAIL — `Cannot find module '../src/subprojects'` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/subprojects.ts`:

```typescript
import * as path from 'path'
import fg from 'fast-glob'

const MANDATORY_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/vendor/**',
]

export function discoverSubprojects(
  rootDir: string,
  maxDepth: number,
  extraExcludeGlobs: string[],
  alreadyDiscovered: string[],
): string[] {
  const matches = fg.sync('**/package.json', {
    cwd: rootDir,
    ignore: [...MANDATORY_EXCLUDE_GLOBS, ...extraExcludeGlobs],
    dot: false,
  })

  const alreadyDiscoveredSet = new Set(alreadyDiscovered)
  const result: string[] = []

  for (const match of matches) {
    const dir = path.posix.dirname(match)
    if (dir === '.') continue // the root's own package.json
    const depth = dir.split('/').length
    if (depth > maxDepth) continue
    if (alreadyDiscoveredSet.has(dir)) continue
    result.push(dir)
  }

  return result
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/subprojects.test.ts`
Expected: PASS (10 tests, 0 failures).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/subprojects.ts tests/subprojects.test.ts
git commit -m "feat: add discoverSubprojects for independent monorepo package.json discovery"
```

---

### Task 2: Wire `ownLockfile` and subproject discovery into `discover.ts`

**Files:**
- Modify: `src/discover.ts`
- Test: `tests/discover.test.ts` (all existing calls updated; new tests added)

**Interfaces:**
- Consumes: `discoverSubprojects(rootDir, maxDepth, extraExcludeGlobs, alreadyDiscovered): string[]`
  from Task 1 (`src/subprojects.ts`).
- Produces:
  ```typescript
  export function discoverPackages(
    packageJsonPath: string,
    explicitPackages: string[],
    includeDev: boolean,
    includeOptional: boolean,
    useLockfile: boolean,
    auditWorkspaces: boolean,
    auditSubprojects: boolean,
    subprojectMaxDepth: number,
    subprojectExcludeGlobs: string[],
  ): DiscoveredPackage[]
  ```
  Same behavior as today for every existing caller when `auditSubprojects` is `false`.

- [ ] **Step 1: Update `src/discover.ts`**

Replace the full file content:

```typescript
import * as fs from 'fs'
import * as path from 'path'
import { resolveLockfileVersions } from './lockfiles'
import type { NamedRange } from './lockfiles'
import { getWorkspaceGlobs, discoverWorkspaceMembers } from './workspaces'
import { discoverSubprojects } from './subprojects'

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export interface DiscoveredPackage {
  name: string
  version: string | null
}

interface ScopedRange {
  name: string
  range: string | undefined
  memberPath: string | undefined
  ownLockfile: boolean
}

function readPackageRanges(
  packageJsonPath: string,
  explicitPackages: string[],
  includeDev: boolean,
  includeOptional: boolean,
): Map<string, string> {
  let pkg: PackageJson = {}
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8') as string) as PackageJson
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
  return ranges
}

export function discoverPackages(
  packageJsonPath: string,
  explicitPackages: string[],
  includeDev: boolean,
  includeOptional: boolean,
  useLockfile: boolean,
  auditWorkspaces: boolean,
  auditSubprojects: boolean,
  subprojectMaxDepth: number,
  subprojectExcludeGlobs: string[],
): DiscoveredPackage[] {
  const absPath = path.resolve(
    process.env['GITHUB_WORKSPACE'] ?? process.cwd(),
    packageJsonPath,
  )
  const lockfileDir = path.dirname(absPath)

  const rootRanges = readPackageRanges(absPath, explicitPackages, includeDev, includeOptional)

  const scoped: ScopedRange[] = []

  if (explicitPackages.length > 0) {
    for (const name of new Set(explicitPackages)) {
      scoped.push({ name, range: rootRanges.get(name), memberPath: undefined, ownLockfile: false })
    }
  } else {
    for (const name of rootRanges.keys()) {
      scoped.push({ name, range: rootRanges.get(name), memberPath: undefined, ownLockfile: false })
    }

    const workspaceMemberPaths: string[] = []

    if (auditWorkspaces) {
      const globs = getWorkspaceGlobs(lockfileDir)
      if (globs) {
        for (const memberPath of discoverWorkspaceMembers(lockfileDir, globs)) {
          workspaceMemberPaths.push(memberPath)
          const memberPackageJsonPath = path.join(lockfileDir, memberPath, 'package.json')
          const memberRanges = readPackageRanges(memberPackageJsonPath, [], includeDev, includeOptional)
          for (const name of memberRanges.keys()) {
            scoped.push({ name, range: memberRanges.get(name), memberPath, ownLockfile: false })
          }
        }
      }
    }

    if (auditSubprojects) {
      const subprojectPaths = discoverSubprojects(
        lockfileDir,
        subprojectMaxDepth,
        subprojectExcludeGlobs,
        workspaceMemberPaths,
      )
      for (const memberPath of subprojectPaths) {
        const subprojectPackageJsonPath = path.join(lockfileDir, memberPath, 'package.json')
        const subprojectRanges = readPackageRanges(subprojectPackageJsonPath, [], includeDev, includeOptional)
        for (const name of subprojectRanges.keys()) {
          scoped.push({ name, range: subprojectRanges.get(name), memberPath, ownLockfile: true })
        }
      }
    }
  }

  if (!useLockfile) {
    const deduped = new Map<string, DiscoveredPackage>()
    for (const { name } of scoped) deduped.set(name, { name, version: null })
    return [...deduped.values()]
  }

  const resolvedByMember = new Map<string | undefined, Map<string, string>>()

  const byMember = new Map<string | undefined, NamedRange[]>()
  for (const { name, range, memberPath, ownLockfile } of scoped) {
    if (ownLockfile) continue
    if (!byMember.has(memberPath)) byMember.set(memberPath, [])
    byMember.get(memberPath)!.push({ name, range })
  }
  for (const [memberPath, namedRanges] of byMember) {
    resolvedByMember.set(memberPath, resolveLockfileVersions(lockfileDir, namedRanges, memberPath))
  }

  const byOwnMember = new Map<string, NamedRange[]>()
  for (const { name, range, memberPath, ownLockfile } of scoped) {
    if (!ownLockfile) continue
    const mp = memberPath! // always defined for ownLockfile entries — see the push above
    if (!byOwnMember.has(mp)) byOwnMember.set(mp, [])
    byOwnMember.get(mp)!.push({ name, range })
  }
  for (const [memberPath, namedRanges] of byOwnMember) {
    resolvedByMember.set(memberPath, resolveLockfileVersions(path.join(lockfileDir, memberPath), namedRanges))
  }

  const deduped = new Map<string, DiscoveredPackage>()
  for (const { name, memberPath } of scoped) {
    const version = resolvedByMember.get(memberPath)!.get(name) ?? null
    deduped.set(`${name}@${version ?? ''}`, { name, version })
  }
  return [...deduped.values()]
}
```

- [ ] **Step 2: Update every existing call site in `tests/discover.test.ts`**

Every existing `discoverPackages(...)` and `freshDiscoverPackages(...)` call gains three trailing
arguments: `false, 3, []` — disabling subproject discovery, a no-op, so every existing test's
behavior is unchanged. Apply these exact replacements (old → new), each unique in the file:

```
discoverPackages('package.json', ['react', 'vue'], false, false, false, false)
  → discoverPackages('package.json', ['react', 'vue'], false, false, false, false, false, 3, [])

discoverPackages('package.json', ['react', 'react'], false, false, false, false)
  → discoverPackages('package.json', ['react', 'react'], false, false, false, false, false, 3, [])
```

Line 39 (`'returns dependencies only by default'`) and line 72
(`'every entry has version: null when useLockfile is false...'`) share the identical text
`discoverPackages('package.json', [], false, false, false, false)` — replace **both** occurrences
with `discoverPackages('package.json', [], false, false, false, false, false, 3, [])`.

```
discoverPackages('package.json', [], true, false, false, false)
  → discoverPackages('package.json', [], true, false, false, false, false, 3, [])
```
(appears twice — line 48 and line 66 — replace both)

```
discoverPackages('package.json', [], false, true, false, false)
  → discoverPackages('package.json', [], false, true, false, false, false, 3, [])

discoverPackages('package.json', [], false, false, true, false)
  → discoverPackages('package.json', [], false, false, true, false, false, 3, [])
```
(appears three times — lines 84, 96, 116 — replace all three)

```
discoverPackages('package.json', ['axios'], false, false, true, false)
  → discoverPackages('package.json', ['axios'], false, false, true, false, false, 3, [])

discoverPackages('package.json', ['some-pkg'], false, false, true, false)
  → discoverPackages('package.json', ['some-pkg'], false, false, true, false, false, 3, [])

discoverPackages('package.json', [], false, false, false, false)).toThrow()
  → discoverPackages('package.json', [], false, false, false, false, false, 3, [])).toThrow()

discoverPackages('package.json', [], false, false, false, false)
  → discoverPackages('package.json', [], false, false, false, false, false, 3, [])
```
(line 130, the `auditWorkspaces is false` test — this text form also matches line 39/72 above;
by the time you're done every bare `discoverPackages('package.json', [], false, false, false, false)`
in the file — 3 occurrences total — must read `..., false, 3, [])`)

```
discoverPackages('package.json', [], false, false, false, true)
  → discoverPackages('package.json', [], false, false, false, true, false, 3, [])
```

```
freshDiscoverPackages('package.json', [], false, false, false, true)
  → freshDiscoverPackages('package.json', [], false, false, false, true, false, 3, [])
```
(line 162)

```
freshDiscoverPackages('package.json', [], false, false, true, true)
  → freshDiscoverPackages('package.json', [], false, false, true, true, false, 3, [])
```
(appears twice — line 187 and line 220 — replace both)

```
freshDiscoverPackages('package.json', ['react'], false, false, false, true)
  → freshDiscoverPackages('package.json', ['react'], false, false, false, true, false, 3, [])
```
(line 243)

After this step, run a verification grep to confirm no 6-argument call remains:

```bash
grep -n "discoverPackages('package.json'" tests/discover.test.ts | grep -v ", false, 3, \[\])\|, true, 3, \[\])"
```
Expected: no output (every call now ends in a 3-element subproject-args tail).

- [ ] **Step 3: Add new subproject-specific tests to `tests/discover.test.ts`**

Append these `it` blocks inside the existing `describe('discoverPackages', ...)` block, before its
closing `})`:

```typescript
  it('resolves an independent subproject\'s dependencies from its own lockfile, not the root\'s', () => {
    vi.doMock('../src/subprojects', () => ({
      discoverSubprojects: () => ['admin'],
    }))
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).endsWith('package.json') || String(p).endsWith('package-lock.json')
    )
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('admin/package-lock.json')) {
        return JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/react': { version: '18.3.1' } } })
      }
      if (String(p).endsWith('admin/package.json')) {
        return JSON.stringify({ dependencies: { react: '^18.0.0' } })
      }
      if (String(p).endsWith('package-lock.json')) {
        return JSON.stringify({ lockfileVersion: 3, packages: {} }) // root's own lockfile, no react
      }
      return JSON.stringify(mockPkg) // root package.json — axios, lodash
    })
    return import('../src/discover').then(({ discoverPackages: freshDiscoverPackages }) => {
      const result = freshDiscoverPackages('package.json', [], false, false, true, false, true, 3, [])
      const names = result.map(p => p.name)
      expect(names).toContain('axios')
      expect(result.find(p => p.name === 'react')!.version).toBe('18.3.1')
    })
  })

  it('resolves a workspace member and an independent subproject together without double-counting the member', () => {
    vi.doMock('../src/workspaces', () => ({
      getWorkspaceGlobs: () => ['packages/*'],
      discoverWorkspaceMembers: () => ['packages/foo'],
    }))
    vi.doMock('../src/subprojects', () => ({
      discoverSubprojects: (_root: string, _depth: number, _exclude: string[], alreadyDiscovered: string[]) => {
        expect(alreadyDiscovered).toEqual(['packages/foo'])
        return ['admin']
      },
    }))
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('packages/foo/package.json')) {
        return JSON.stringify({ dependencies: { 'member-only-pkg': '^1.0.0' } })
      }
      if (String(p).endsWith('admin/package.json')) {
        return JSON.stringify({ dependencies: { 'subproject-only-pkg': '^1.0.0' } })
      }
      return JSON.stringify({ ...mockPkg, workspaces: ['packages/*'] })
    })
    return import('../src/discover').then(({ discoverPackages: freshDiscoverPackages }) => {
      const result = freshDiscoverPackages('package.json', [], false, false, false, true, true, 3, [])
      const names = result.map(p => p.name)
      expect(names).toContain('member-only-pkg')
      expect(names).toContain('subproject-only-pkg')
    })
  })

  it('does not discover subprojects when auditSubprojects is false, even if independent subprojects exist', async () => {
    vi.doMock('../src/subprojects', () => ({
      discoverSubprojects: () => ['admin'],
    }))
    const { discoverPackages: freshDiscoverPackages } = await import('../src/discover')
    const result = freshDiscoverPackages('package.json', [], false, false, false, false, false, 3, [])
    const names = result.map((p: { name: string }) => p.name)
    expect(names).toEqual(['axios', 'lodash'])
  })

  it('falls back to version: null for a subproject with no lockfile present', () => {
    vi.doMock('../src/subprojects', () => ({
      discoverSubprojects: () => ['admin'],
    }))
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('admin/package.json')) {
        return JSON.stringify({ dependencies: { react: '^18.0.0' } })
      }
      return JSON.stringify(mockPkg)
    })
    return import('../src/discover').then(({ discoverPackages: freshDiscoverPackages }) => {
      const result = freshDiscoverPackages('package.json', [], false, false, true, false, true, 3, [])
      expect(result.find(p => p.name === 'react')!.version).toBeNull()
    })
  })

  it('never triggers subproject discovery when explicitPackages is non-empty', () => {
    vi.doMock('../src/subprojects', () => ({
      discoverSubprojects: () => ['admin'],
    }))
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('admin/package.json')) {
        return JSON.stringify({ dependencies: { 'subproject-only-pkg': '^1.0.0' } })
      }
      return JSON.stringify(mockPkg)
    })
    return import('../src/discover').then(({ discoverPackages: freshDiscoverPackages }) => {
      const result = freshDiscoverPackages('package.json', ['react'], false, false, false, false, true, 3, [])
      expect(result).toEqual([{ name: 'react', version: null }])
      expect(result.map(p => p.name)).not.toContain('subproject-only-pkg')
    })
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/discover.test.ts`
Expected: PASS — 23 tests, 0 failures (18 pre-existing + 5 new).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/discover.ts tests/discover.test.ts
git commit -m "feat: resolve independent subprojects against their own lockfile in discoverPackages"
```

---

### Task 3: Action inputs and `index.ts` wiring

**Files:**
- Modify: `action.yml`
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

**Interfaces:**
- Consumes: `discoverPackages(...)` from Task 2, now requiring 3 additional trailing arguments.

- [ ] **Step 1: Add the three new inputs to `action.yml`**

In `action.yml`, insert immediately after the existing `audit-workspaces` input block (after its
`default: 'true'` line, before `fail-on-general:`):

```yaml
  audit-subprojects:
    description: 'Discover and score independent package.json directories not covered by workspace protocol (npm/yarn "workspaces" or pnpm-workspace.yaml). Set to false to disable.'
    required: false
    default: 'true'
  subproject-max-depth:
    description: 'Maximum directory depth (below repo root) to scan for independent package.json files'
    required: false
    default: '3'
  subproject-exclude:
    description: 'Comma-separated additional glob patterns to exclude from subproject discovery (node_modules, .git, dist, build, coverage, and vendor are always excluded regardless of this input)'
    required: false
    default: ''
```

- [ ] **Step 2: Read the new inputs in `src/index.ts` and pass them to `discoverPackages`**

In `src/index.ts`, replace:

```typescript
  const names = discoverPackages(
    core.getInput('package-json-path') || 'package.json',
    explicitPackages,
    core.getInput('include-dev') === 'true',
    core.getInput('include-optional') === 'true',
    core.getInput('use-lockfile') !== 'false',
    core.getInput('audit-workspaces') !== 'false',
  )
```

with:

```typescript
  const subprojectExcludeGlobs = core.getInput('subproject-exclude')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const names = discoverPackages(
    core.getInput('package-json-path') || 'package.json',
    explicitPackages,
    core.getInput('include-dev') === 'true',
    core.getInput('include-optional') === 'true',
    core.getInput('use-lockfile') !== 'false',
    core.getInput('audit-workspaces') !== 'false',
    core.getInput('audit-subprojects') !== 'false',
    parseInt(core.getInput('subproject-max-depth') || '3', 10),
    subprojectExcludeGlobs,
  )
```

Place the `subprojectExcludeGlobs` block directly above the `const names = discoverPackages(` line,
mirroring the existing `explicitPackages` block's placement and style just above it.

- [ ] **Step 3: Write failing tests for the new wiring in `tests/index.test.ts`**

Add `'audit-subprojects': 'true'`, `'subproject-max-depth': '3'`, and `'subproject-exclude': ''` to
the `defaults` object inside `runWithInputs`:

```typescript
    const defaults: Record<string, string> = {
      'api-key': 'k',
      'package-json-path': 'package.json',
      packages: '',
      'include-dev': 'false',
      'include-optional': 'false',
      'use-lockfile': 'true',
      'audit-workspaces': 'true',
      'audit-subprojects': 'true',
      'subproject-max-depth': '3',
      'subproject-exclude': '',
      'fail-on-general': '',
      'fail-on-automation': '',
      'fail-on-risk': '',
      'pr-comment': 'true',
      'github-token': 'gh-token-123',
      'crawl-timeout': '120',
    }
```

Add these `it` blocks after the existing `'passes auditWorkspaces=false...'` test (after line 103,
before the `'reads the github-token input...'` test):

```typescript
  it('passes auditSubprojects=true to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[6]).toBe(true)
  })

  it('passes auditSubprojects=false to discoverPackages when audit-subprojects input is "false"', async () => {
    await runWithInputs({ 'audit-subprojects': 'false' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[6]).toBe(false)
  })

  it('passes subprojectMaxDepth=3 to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[7]).toBe(3)
  })

  it('passes a custom subprojectMaxDepth to discoverPackages when subproject-max-depth is set', async () => {
    await runWithInputs({ 'subproject-max-depth': '5' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[7]).toBe(5)
  })

  it('passes an empty subprojectExcludeGlobs array to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[8]).toEqual([])
  })

  it('parses subproject-exclude into a trimmed array of globs', async () => {
    await runWithInputs({ 'subproject-exclude': 'fixtures/**, examples/** ' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[8]).toEqual(['fixtures/**', 'examples/**'])
  })
```

- [ ] **Step 4: Run tests to verify the new ones fail, then pass**

Run: `npm test -- tests/index.test.ts`
Expected before Step 2's edit lands: FAIL (`args[6]` etc. undefined). After Step 2's edit: PASS —
13 tests, 0 failures (7 pre-existing + 6 new).

If Steps 2 and 3 were applied together (as written above), just run once and expect PASS.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add action.yml src/index.ts tests/index.test.ts
git commit -m "feat: add audit-subprojects, subproject-max-depth, subproject-exclude action inputs"
```

---

### Task 4: README documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Add the three new inputs to the Inputs table**

In `README.md`, in the `## Inputs` table, insert these three rows immediately after the
`audit-workspaces` row:

```markdown
| `audit-subprojects` | no | `true` | Discover and score independent `package.json` directories not covered by the workspace protocol |
| `subproject-max-depth` | no | `3` | Maximum directory depth below repo root to scan for independent `package.json` files |
| `subproject-exclude` | no | — | Comma-separated additional glob patterns to exclude from subproject discovery |
```

- [ ] **Step 2: Add a new documentation section**

In `README.md`, insert a new section immediately after the existing `## Monorepo / workspace
support` section (after its final paragraph, `Set audit-workspaces: false to only audit the root
package.json, even in a real monorepo.`, and before `## Outputs`):

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document independent subproject discovery"
```

---

## Self-Review Notes

- **Spec coverage:** `discoverSubprojects` (Task 1), `ScopedRange.ownLockfile` + split resolution
  loop (Task 2), three new action inputs + `index.ts` wiring (Task 3), README (Task 4) — all five
  "Files Touched" rows from the spec are covered. The spec's Testing section items (max-depth
  boundary, `node_modules` exclusion, `alreadyDiscovered` dedup, `extraExcludeGlobs`, workspace +
  subproject coexistence, `audit-subprojects: false` no-op, missing-lockfile fallback, regression on
  existing tests) each map to a specific test in Task 1 or Task 2.
- **Placeholder scan:** every step shows complete code — no TBDs. Task 2's call-site update step
  gives exact before/after string pairs for all 18 sites rather than a vague "update the calls"
  instruction, since the transformation is fully mechanical and deterministic.
- **Type consistency:** `discoverSubprojects`'s signature in Task 1 matches its only call site in
  Task 2's `discover.ts` exactly (`rootDir, maxDepth, extraExcludeGlobs, alreadyDiscovered`).
  `ScopedRange.ownLockfile` is set at both push sites in Task 2 (`false` for root/workspace members,
  `true` for subprojects) and read at both resolution-loop sites. `discoverPackages`'s 9-parameter
  signature is consistent between Task 2 (definition) and Task 3 (call site in `index.ts`).
- **No changes needed to `src/score.ts` or `src/report.ts`** — confirmed during design that both
  operate on the flat, deduplicated `DiscoveredPackage[]`/`PackageScore[]` with no member/subproject
  attribution surviving past `discover.ts`, so this feature requires no changes there. Not listed as
  a task.
- **Build step:** not included as a plan task. Per the existing project convention (see commit
  `3a506d3`, "chore: build dist for v1.5.0"), `npm run build` (regenerating `dist/`) and the version
  bump happen once, after all four tasks are merged — not per-task.
