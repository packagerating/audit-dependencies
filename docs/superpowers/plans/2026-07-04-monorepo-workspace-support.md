# Monorepo Workspace Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically discover every workspace member in an npm/yarn/pnpm monorepo and score the deduplicated union of their dependencies in one run, instead of only ever auditing the root `package.json`.

**Architecture:** A new `src/workspaces.ts` module detects workspace configuration (npm/yarn's `package.json` `"workspaces"` field, or pnpm's `pnpm-workspace.yaml`) and expands its glob patterns (via `fast-glob`) into member directories. `src/discover.ts` is restructured to read every member's own `package.json` (in addition to the root's), resolving each member's dependency versions with the correct workspace scoping. `resolveNpmVersions` and `resolvePnpmVersions` gain an optional `memberPath` parameter for that scoping; Yarn's parsers are untouched since `yarn.lock` has no per-member structure.

**Tech Stack:** TypeScript, Vitest. New dependency: `fast-glob`.

## Global Constraints

- Behavior is completely unchanged when no workspace configuration is found at the root — only the root `package.json` is read, exactly as today.
- `resolveNpmVersions` tries `packages["node_modules/<name>"]` (root-hoisted) first; falls back to `packages["<memberPath>/node_modules/<name>"]` only if the root entry is absent (the real npm workspace hoisting-conflict case).
- `resolvePnpmVersions` uses `importers[memberPath ?? '.']` instead of the hardcoded `importers['.']`.
- Yarn's parsers (`src/lockfiles/yarn.ts`, `src/lockfiles/yarnBerry.ts`) are not modified — `yarn.lock` has no per-workspace-member structure, so `memberPath` is meaningless to them.
- Dedup the final package list by the `(name, version)` pair — two members resolving the same package to the same version collapse into one entry; two members resolving the same package to genuinely different versions both survive as distinct entries. Never silently drop one.
- The `packages` input (explicit comma-separated override) always stays root-scoped, regardless of `audit-workspaces` — it is an escape hatch for auditing arbitrary names, not part of workspace discovery.
- New `audit-workspaces` input defaults to `'true'`; since workspace detection itself gates on the root actually declaring workspaces, this default is a no-op for any non-monorepo project.

---

## Task 1: Workspace detection and member discovery

**Files:**
- Create: `src/workspaces.ts`
- Modify: `package.json` (add `fast-glob`)
- Test: `tests/workspaces.test.ts`, `tests/workspaces-members.test.ts`

**Interfaces:**
- Produces: `getWorkspaceGlobs(rootDir: string): string[] | null`
- Produces: `discoverWorkspaceMembers(rootDir: string, globs: string[]): string[]`

Two separate test files are used here because `discoverWorkspaceMembers` needs `fast-glob` to do
real filesystem directory traversal — mocking `fs` globally (as the rest of this codebase's tests
do) would interfere with that. `getWorkspaceGlobs` only reads two specific files and can use the
same `vi.mock('fs')` convention as every other test in this repo.

- [ ] **Step 1: Add the `fast-glob` dependency**

Run: `npm install fast-glob`

Confirm `package.json`'s `dependencies` gained `"fast-glob": "^3.3.2"` (or whatever version `npm install` resolves — don't hand-edit it).

- [ ] **Step 2: Write the failing test for `getWorkspaceGlobs`**

`tests/workspaces.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { getWorkspaceGlobs } from '../src/workspaces'

vi.mock('fs')

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false)
})

describe('getWorkspaceGlobs', () => {
  it('returns globs from package.json workspaces array form', () => {
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ workspaces: ['packages/*'] }))
    expect(getWorkspaceGlobs('/repo')).toEqual(['packages/*'])
  })

  it('returns globs from package.json workspaces object form', () => {
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ workspaces: { packages: ['apps/*', 'libs/*'] } }))
    expect(getWorkspaceGlobs('/repo')).toEqual(['apps/*', 'libs/*'])
  })

  it('returns globs from pnpm-workspace.yaml, taking priority over package.json', () => {
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).endsWith('pnpm-workspace.yaml') || String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockImplementation(p => {
      if (String(p).endsWith('pnpm-workspace.yaml')) return 'packages:\n  - packages/*\n'
      return JSON.stringify({ workspaces: ['should-not-be-used/*'] })
    })
    expect(getWorkspaceGlobs('/repo')).toEqual(['packages/*'])
  })

  it('returns null when no workspace config exists', () => {
    expect(getWorkspaceGlobs('/repo')).toBeNull()
  })

  it('returns null when package.json exists but has no workspaces field', () => {
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'not-a-monorepo' }))
    expect(getWorkspaceGlobs('/repo')).toBeNull()
  })
})
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run tests/workspaces.test.ts`
Expected: FAIL — `Cannot find module '../src/workspaces'`

- [ ] **Step 4: Implement `getWorkspaceGlobs` in `src/workspaces.ts`**

```typescript
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'

interface PackageJsonWithWorkspaces {
  workspaces?: string[] | { packages?: string[] }
}

interface PnpmWorkspaceYaml {
  packages?: string[]
}

export function getWorkspaceGlobs(rootDir: string): string[] | null {
  const pnpmWorkspacePath = path.join(rootDir, 'pnpm-workspace.yaml')
  if (fs.existsSync(pnpmWorkspacePath)) {
    const parsed = yaml.load(fs.readFileSync(pnpmWorkspacePath, 'utf8')) as PnpmWorkspaceYaml
    return parsed.packages && parsed.packages.length > 0 ? parsed.packages : null
  }

  const packageJsonPath = path.join(rootDir, 'package.json')
  if (!fs.existsSync(packageJsonPath)) return null

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8') as string) as PackageJsonWithWorkspaces
  if (!pkg.workspaces) return null

  const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages
  return globs && globs.length > 0 ? globs : null
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run tests/workspaces.test.ts`
Expected: PASS (5/5)

- [ ] **Step 6: Write the failing test for `discoverWorkspaceMembers`**

`tests/workspaces-members.test.ts` — uses real temporary directories, not mocked `fs`, since `fast-glob` needs to do real filesystem traversal:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { discoverWorkspaceMembers } from '../src/workspaces'

let rootDir: string

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspaces-test-'))
})

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true })
})

function makePackage(relativeDir: string, name: string): void {
  const dir = path.join(rootDir, relativeDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }))
}

describe('discoverWorkspaceMembers', () => {
  it('finds member directories matching a glob pattern', () => {
    makePackage('packages/foo', 'foo')
    makePackage('packages/bar', 'bar')
    const result = discoverWorkspaceMembers(rootDir, ['packages/*'])
    expect(result.sort()).toEqual(['packages/bar', 'packages/foo'])
  })

  it('skips a matched directory that has no package.json', () => {
    makePackage('packages/foo', 'foo')
    fs.mkdirSync(path.join(rootDir, 'packages', 'README-only'), { recursive: true })
    const result = discoverWorkspaceMembers(rootDir, ['packages/*'])
    expect(result).toEqual(['packages/foo'])
  })

  it('supports multiple glob patterns', () => {
    makePackage('packages/foo', 'foo')
    makePackage('apps/web', 'web')
    const result = discoverWorkspaceMembers(rootDir, ['packages/*', 'apps/*'])
    expect(result.sort()).toEqual(['apps/web', 'packages/foo'])
  })

  it('returns an empty array when nothing matches', () => {
    const result = discoverWorkspaceMembers(rootDir, ['packages/*'])
    expect(result).toEqual([])
  })
})
```

- [ ] **Step 7: Run the test to confirm it fails**

Run: `npx vitest run tests/workspaces-members.test.ts`
Expected: FAIL — `discoverWorkspaceMembers` is not exported yet

- [ ] **Step 8: Implement `discoverWorkspaceMembers` in `src/workspaces.ts`**

Append to the same file (after `getWorkspaceGlobs`):

```typescript
import fg from 'fast-glob'

export function discoverWorkspaceMembers(rootDir: string, globs: string[]): string[] {
  const matches = fg.sync(globs, { cwd: rootDir, onlyDirectories: true })
  return matches.filter(memberPath => fs.existsSync(path.join(rootDir, memberPath, 'package.json')))
}
```

Move the `import fg from 'fast-glob'` line to the top of the file alongside the other imports (shown separately here only to make clear which step introduces it).

- [ ] **Step 9: Run the test to confirm it passes**

Run: `npx vitest run tests/workspaces-members.test.ts`
Expected: PASS (4/4)

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json src/workspaces.ts tests/workspaces.test.ts tests/workspaces-members.test.ts
git commit -m "feat: add workspace detection and member discovery"
```

---

## Task 2: Thread `memberPath` through npm/pnpm resolution and the dispatcher

**Files:**
- Modify: `src/lockfiles/npm.ts`
- Modify: `src/lockfiles/pnpm.ts`
- Modify: `src/lockfiles/index.ts`
- Test: `tests/lockfiles/npm.test.ts`, `tests/lockfiles/pnpm.test.ts`, `tests/lockfiles/index.test.ts`

**Interfaces:**
- Produces: `resolveNpmVersions(lockfileContent: string, packages: NamedRange[], memberPath?: string): Map<string, string>`
- Produces: `resolvePnpmVersions(lockfileContent: string, packages: NamedRange[], memberPath?: string): Map<string, string>`
- Produces: `resolveLockfileVersions(lockfileDir: string, packages: NamedRange[], memberPath?: string): Map<string, string>`

**Strict scope:** do not modify `src/lockfiles/yarn.ts` or `src/lockfiles/yarnBerry.ts` — they don't accept or need `memberPath`.

- [ ] **Step 1: Add the failing test for npm's nested-fallback lookup**

Add to `tests/lockfiles/npm.test.ts`, inside the existing `describe('resolveNpmVersions', ...)` block:

```typescript
  it('falls back to a nested workspace-member path when the root packages map lacks the entry', () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root' },
        'packages/foo/node_modules/conflicted-pkg': { version: '2.0.0' },
      },
    })
    const result = resolveNpmVersions(lockfile, [{ name: 'conflicted-pkg', range: '^2.0.0' }], 'packages/foo')
    expect(result.get('conflicted-pkg')).toBe('2.0.0')
  })

  it('prefers the root-hoisted entry over the nested member path when both exist', () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/axios': { version: '1.7.4' },
        'packages/foo/node_modules/axios': { version: '1.6.0' },
      },
    })
    const result = resolveNpmVersions(lockfile, [{ name: 'axios', range: '^1.0.0' }], 'packages/foo')
    expect(result.get('axios')).toBe('1.7.4')
  })

  it('does not use nested-member fallback when memberPath is not provided', () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'packages/foo/node_modules/conflicted-pkg': { version: '2.0.0' },
      },
    })
    const result = resolveNpmVersions(lockfile, [{ name: 'conflicted-pkg', range: '^2.0.0' }])
    expect(result.has('conflicted-pkg')).toBe(false)
  })
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run tests/lockfiles/npm.test.ts`
Expected: FAIL — `resolveNpmVersions` doesn't accept a 3rd argument, nested lookup never attempted

- [ ] **Step 3: Update `src/lockfiles/npm.ts`**

Change:

```typescript
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

to:

```typescript
export function resolveNpmVersions(
  lockfileContent: string,
  packages: NamedRange[],
  memberPath?: string,
): Map<string, string> {
  const lockfile = JSON.parse(lockfileContent) as NpmLockfile
  const resolved = new Map<string, string>()

  for (const { name } of packages) {
    const fromPackagesMap = lockfile.packages?.[`node_modules/${name}`]?.version
    const fromNestedMember = memberPath
      ? lockfile.packages?.[`${memberPath}/node_modules/${name}`]?.version
      : undefined
    const fromLegacyTree = lockfile.dependencies?.[name]?.version
    const version = fromPackagesMap ?? fromNestedMember ?? fromLegacyTree
    if (version) resolved.set(name, version)
  }

  return resolved
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/lockfiles/npm.test.ts`
Expected: PASS (all tests, 7/7 — 4 existing + 3 new)

- [ ] **Step 5: Add the failing test for pnpm's per-member `importers` lookup**

Add to `tests/lockfiles/pnpm.test.ts`, inside the existing `describe('resolvePnpmVersions', ...)` block:

```typescript
  it('resolves from a non-root importers entry when memberPath is given', () => {
    const lockfile = `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      root-only-pkg:
        specifier: ^1.0.0
        version: 1.0.0
  packages/foo:
    dependencies:
      axios:
        specifier: ^1.7.4
        version: 1.7.4
`
    const result = resolvePnpmVersions(lockfile, [{ name: 'axios', range: '^1.7.4' }], 'packages/foo')
    expect(result.get('axios')).toBe('1.7.4')
  })

  it('does not resolve a non-root member package from the root importer', () => {
    const lockfile = `
lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      root-only-pkg:
        specifier: ^1.0.0
        version: 1.0.0
  packages/foo:
    dependencies:
      axios:
        specifier: ^1.7.4
        version: 1.7.4
`
    const result = resolvePnpmVersions(lockfile, [{ name: 'axios', range: '^1.7.4' }])
    expect(result.has('axios')).toBe(false)
  })
```

- [ ] **Step 6: Run the test to confirm it fails**

Run: `npx vitest run tests/lockfiles/pnpm.test.ts`
Expected: FAIL — `resolvePnpmVersions` doesn't accept a 3rd argument, always reads `importers['.']`

- [ ] **Step 7: Update `src/lockfiles/pnpm.ts`**

Change:

```typescript
export function resolvePnpmVersions(
  lockfileContent: string,
  packages: NamedRange[],
): Map<string, string> {
  const lockfile = yaml.load(lockfileContent) as PnpmLockfile
  const scope: PnpmScope = lockfile.importers?.['.'] ?? lockfile
```

to:

```typescript
export function resolvePnpmVersions(
  lockfileContent: string,
  packages: NamedRange[],
  memberPath?: string,
): Map<string, string> {
  const lockfile = yaml.load(lockfileContent) as PnpmLockfile
  const scope: PnpmScope = lockfile.importers?.[memberPath ?? '.'] ?? lockfile
```

The rest of the function body is unchanged.

- [ ] **Step 8: Run the test to confirm it passes**

Run: `npx vitest run tests/lockfiles/pnpm.test.ts`
Expected: PASS (all tests, 7/7 — 5 existing + 2 new)

- [ ] **Step 9: Add the failing test for the dispatcher threading `memberPath`**

Add to `tests/lockfiles/index.test.ts`, inside the existing `describe('resolveLockfileVersions', ...)` block:

```typescript
  it('threads memberPath through to the npm parser', () => {
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).endsWith('package-lock.json'))
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      lockfileVersion: 3,
      packages: { 'packages/foo/node_modules/axios': { version: '1.7.4' } },
    }))
    const result = resolveLockfileVersions('/repo', [{ name: 'axios', range: '^1.0.0' }], 'packages/foo')
    expect(result.get('axios')).toBe('1.7.4')
  })

  it('threads memberPath through to the pnpm parser', () => {
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).endsWith('pnpm-lock.yaml'))
    vi.mocked(fs.readFileSync).mockReturnValue(
      "lockfileVersion: '9.0'\nimporters:\n  packages/foo:\n    dependencies:\n      axios:\n        specifier: ^1.0.0\n        version: 1.7.4\n"
    )
    const result = resolveLockfileVersions('/repo', [{ name: 'axios', range: '^1.0.0' }], 'packages/foo')
    expect(result.get('axios')).toBe('1.7.4')
  })
```

- [ ] **Step 10: Run the test to confirm it fails**

Run: `npx vitest run tests/lockfiles/index.test.ts`
Expected: FAIL — `resolveLockfileVersions` doesn't accept a 3rd argument, never passes it through

- [ ] **Step 11: Update `src/lockfiles/index.ts`**

Change:

```typescript
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
    const yarnContent = fs.readFileSync(yarnPath, 'utf8')
    return yarnContent.includes('__metadata:')
      ? resolveYarnBerryVersions(yarnContent, packages)
      : resolveYarnVersions(yarnContent, packages)
  }

  const pnpmPath = path.join(lockfileDir, 'pnpm-lock.yaml')
  if (fs.existsSync(pnpmPath)) {
    return resolvePnpmVersions(fs.readFileSync(pnpmPath, 'utf8'), packages)
  }

  return new Map()
}
```

to:

```typescript
export function resolveLockfileVersions(
  lockfileDir: string,
  packages: NamedRange[],
  memberPath?: string,
): Map<string, string> {
  const npmPath = path.join(lockfileDir, 'package-lock.json')
  if (fs.existsSync(npmPath)) {
    return resolveNpmVersions(fs.readFileSync(npmPath, 'utf8'), packages, memberPath)
  }

  const yarnPath = path.join(lockfileDir, 'yarn.lock')
  if (fs.existsSync(yarnPath)) {
    const yarnContent = fs.readFileSync(yarnPath, 'utf8')
    return yarnContent.includes('__metadata:')
      ? resolveYarnBerryVersions(yarnContent, packages)
      : resolveYarnVersions(yarnContent, packages)
  }

  const pnpmPath = path.join(lockfileDir, 'pnpm-lock.yaml')
  if (fs.existsSync(pnpmPath)) {
    return resolvePnpmVersions(fs.readFileSync(pnpmPath, 'utf8'), packages, memberPath)
  }

  return new Map()
}
```

Note: `memberPath` is intentionally NOT passed to `resolveYarnVersions`/`resolveYarnBerryVersions` — their signatures stay exactly as they are, untouched.

- [ ] **Step 12: Run the test to confirm it passes**

Run: `npx vitest run tests/lockfiles/index.test.ts`
Expected: PASS (all tests, 8/8 — 6 existing + 2 new)

- [ ] **Step 13: Full lockfiles suite and typecheck**

Run: `npx vitest run tests/lockfiles/`
Expected: all pass

Run: `npx tsc --noEmit`
Expected: no errors. `src/discover.ts` still calls `resolveLockfileVersions` with only 2 arguments today, and that's fine — `memberPath` is optional, so the existing call site remains valid. If this fails, the error must be inside `src/discover.ts`, which this task doesn't touch — investigate before proceeding rather than assuming it's expected.

- [ ] **Step 14: Commit**

```bash
git add src/lockfiles/npm.ts src/lockfiles/pnpm.ts src/lockfiles/index.ts tests/lockfiles/npm.test.ts tests/lockfiles/pnpm.test.ts tests/lockfiles/index.test.ts
git commit -m "feat: thread memberPath through npm/pnpm resolution for workspace support"
```

---

## Task 3: `discover.ts` workspace-aware restructuring

**Files:**
- Modify: `src/discover.ts`
- Test: `tests/discover.test.ts`

**Interfaces:**
- Consumes: `getWorkspaceGlobs`, `discoverWorkspaceMembers` (Task 1, `src/workspaces.ts`); `resolveLockfileVersions` with `memberPath` (Task 2, `src/lockfiles/index.ts`)
- Produces: `discoverPackages` gains a 6th `auditWorkspaces: boolean` parameter; return type `DiscoveredPackage[]` is unchanged

This is the task that ties everything together. `discoverPackages` is restructured internally
around a list of "scoped ranges" — each entry is a `{name, range, memberPath}` tuple, where
`memberPath` is `undefined` for the root project and a workspace-relative path for everything
else. This lets one unified code path handle root-only, workspace-wide, and lockfile-disabled
cases without special-casing each combination separately.

- [ ] **Step 1: Replace `tests/discover.test.ts` with the new shape**

The existing 12 tests are unchanged in behavior — every existing call site passes `false` (or
omits, but this parameter is required, so tests are updated to pass `false` explicitly) as the new
6th argument, since none of them declare workspaces in their `mockPkg` fixture. New tests are
appended for the workspace-aware behavior.

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
  vi.resetModules() // ensures the two per-test vi.doMock('../src/workspaces', ...) calls near
  // the end of this file always apply to a fresh dynamic import(), not a stale cached module
  // instance from an earlier test's mock
  vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
    if (String(p).endsWith('package.json')) return JSON.stringify(mockPkg)
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  vi.mocked(fs.existsSync).mockReturnValue(false) // no lockfile, no workspace config by default
})

describe('discoverPackages', () => {
  it('returns explicit packages when provided, ignoring package.json for names', () => {
    const result = discoverPackages('package.json', ['react', 'vue'], false, false, false, false)
    expect(result).toEqual([
      { name: 'react', version: null },
      { name: 'vue', version: null },
    ])
  })

  it('deduplicates explicit packages', () => {
    const result = discoverPackages('package.json', ['react', 'react'], false, false, false, false)
    expect(result).toEqual([{ name: 'react', version: null }])
  })

  it('returns dependencies only by default', () => {
    const result = discoverPackages('package.json', [], false, false, false, false)
    const names = result.map(p => p.name)
    expect(names).toContain('axios')
    expect(names).toContain('lodash')
    expect(names).not.toContain('vitest')
    expect(names).not.toContain('fsevents')
  })

  it('includes devDependencies when includeDev is true', () => {
    const result = discoverPackages('package.json', [], true, false, false, false)
    const names = result.map(p => p.name)
    expect(names).toContain('vitest')
    expect(names).not.toContain('fsevents')
  })

  it('includes optionalDependencies when includeOptional is true', () => {
    const result = discoverPackages('package.json', [], false, true, false, false)
    const names = result.map(p => p.name)
    expect(names).toContain('fsevents')
    expect(names).not.toContain('vitest')
  })

  it('deduplicates across dependency types', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      dependencies: { shared: '^1.0.0' },
      devDependencies: { shared: '^1.0.0' },
    }))
    const result = discoverPackages('package.json', [], true, false, false, false)
    expect(result.filter(p => p.name === 'shared').length).toBe(1)
  })

  it('every entry has version: null when useLockfile is false, even if a lockfile is present', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true) // pretend a lockfile exists
    const result = discoverPackages('package.json', [], false, false, false, false)
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
    const result = discoverPackages('package.json', [], false, false, true, false)
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
    const result = discoverPackages('package.json', [], false, false, true, false)
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
    const result = discoverPackages('package.json', ['axios'], false, false, true, false)
    expect(result).toEqual([{ name: 'axios', version: '1.7.4' }])
  })

  it('does not throw when package.json is unreadable and explicit packages are provided', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const result = discoverPackages('package.json', ['some-pkg'], false, false, true, false)
    expect(result).toEqual([{ name: 'some-pkg', version: null }])
  })

  it('throws when package.json is unreadable and no explicit packages are provided', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    expect(() => discoverPackages('package.json', [], false, false, false, false)).toThrow()
  })

  it('does not discover workspace members when auditWorkspaces is false, even if workspaces are declared', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ...mockPkg, workspaces: ['packages/*'] }))
    const result = discoverPackages('package.json', [], false, false, false, false)
    const names = result.map(p => p.name)
    expect(names).toEqual(['axios', 'lodash'])
  })

  it('does not discover workspace members when no workspace config is found, even if auditWorkspaces is true', () => {
    const result = discoverPackages('package.json', [], false, false, false, true)
    const names = result.map(p => p.name)
    expect(names).toEqual(['axios', 'lodash'])
  })

  it('aggregates a workspace member package alongside the root when auditWorkspaces is true', () => {
    // discoverPackages calls the REAL fs module for reads/existsSync checks, but must go through
    // a mocked src/workspaces module for glob-based member discovery, since fast-glob does real
    // filesystem traversal that a blanket vi.mock('fs') would break (Task 1 tests this file's
    // own two functions directly, against real temp directories, for that reason). Mocking
    // src/workspaces per-test with vi.doMock + a fresh dynamic import isolates discover.ts's own
    // aggregation logic from workspaces.ts's actual glob mechanics.
    vi.doMock('../src/workspaces', () => ({
      getWorkspaceGlobs: () => ['packages/*'],
      discoverWorkspaceMembers: () => ['packages/foo'],
    }))
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      // Check the more specific (member) path before the generic root check, since both paths
      // end in "package.json" — order matters here.
      if (String(p).endsWith('packages/foo/package.json')) {
        return JSON.stringify({ dependencies: { 'member-only-pkg': '^1.0.0' } })
      }
      if (String(p).endsWith('package.json')) return JSON.stringify({ ...mockPkg, workspaces: ['packages/*'] })
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    return import('../src/discover').then(({ discoverPackages: freshDiscoverPackages }) => {
      const result = freshDiscoverPackages('package.json', [], false, false, false, true)
      const names = result.map(p => p.name)
      expect(names).toContain('axios')
      expect(names).toContain('member-only-pkg')
    })
  })

  it('dedupes a package resolved to the same version by both the root and a workspace member', () => {
    vi.doMock('../src/workspaces', () => ({
      getWorkspaceGlobs: () => ['packages/*'],
      discoverWorkspaceMembers: () => ['packages/foo'],
    }))
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).endsWith('package.json') || String(p).endsWith('package-lock.json')
    )
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('package-lock.json')) {
        return JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/axios': { version: '1.7.4' } } })
      }
      if (String(p).endsWith('packages/foo/package.json')) {
        return JSON.stringify({ dependencies: { axios: '^1.0.0' } })
      }
      return JSON.stringify({ ...mockPkg, workspaces: ['packages/*'] })
    })
    return import('../src/discover').then(({ discoverPackages: freshDiscoverPackages }) => {
      const result = freshDiscoverPackages('package.json', [], false, false, true, true)
      expect(result.filter(p => p.name === 'axios')).toEqual([{ name: 'axios', version: '1.7.4' }])
    })
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run tests/discover.test.ts`
Expected: FAIL — `discoverPackages` only accepts 5 arguments today; the two new workspace tests
fail since there's no workspace logic yet

- [ ] **Step 3: Replace `src/discover.ts`**

```typescript
import * as fs from 'fs'
import * as path from 'path'
import { resolveLockfileVersions } from './lockfiles'
import type { NamedRange } from './lockfiles'
import { getWorkspaceGlobs, discoverWorkspaceMembers } from './workspaces'

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
      scoped.push({ name, range: rootRanges.get(name), memberPath: undefined })
    }
  } else {
    for (const name of rootRanges.keys()) {
      scoped.push({ name, range: rootRanges.get(name), memberPath: undefined })
    }

    if (auditWorkspaces) {
      const globs = getWorkspaceGlobs(lockfileDir)
      if (globs) {
        for (const memberPath of discoverWorkspaceMembers(lockfileDir, globs)) {
          const memberPackageJsonPath = path.join(lockfileDir, memberPath, 'package.json')
          const memberRanges = readPackageRanges(memberPackageJsonPath, [], includeDev, includeOptional)
          for (const name of memberRanges.keys()) {
            scoped.push({ name, range: memberRanges.get(name), memberPath })
          }
        }
      }
    }
  }

  if (!useLockfile) {
    const deduped = new Map<string, DiscoveredPackage>()
    for (const { name } of scoped) deduped.set(name, { name, version: null })
    return [...deduped.values()]
  }

  const byMember = new Map<string | undefined, NamedRange[]>()
  for (const { name, range, memberPath } of scoped) {
    if (!byMember.has(memberPath)) byMember.set(memberPath, [])
    byMember.get(memberPath)!.push({ name, range })
  }

  const resolvedByMember = new Map<string | undefined, Map<string, string>>()
  for (const [memberPath, namedRanges] of byMember) {
    resolvedByMember.set(memberPath, resolveLockfileVersions(lockfileDir, namedRanges, memberPath))
  }

  const deduped = new Map<string, DiscoveredPackage>()
  for (const { name, memberPath } of scoped) {
    const version = resolvedByMember.get(memberPath)!.get(name) ?? null
    deduped.set(`${name} ${version ?? ''}`, { name, version })
  }
  return [...deduped.values()]
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/discover.test.ts`
Expected: PASS (16/16 — 12 existing + 4 new)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL — `src/index.ts` still calls `discoverPackages` with only 5 arguments. Expected at
this point in the plan; resolved by Task 4.

- [ ] **Step 6: Commit**

```bash
git add src/discover.ts tests/discover.test.ts
git commit -m "feat: aggregate workspace member dependencies in discoverPackages"
```

---

## Task 4: Wire `audit-workspaces` input, document in `action.yml` and `README.md`

**Files:**
- Modify: `src/index.ts`
- Modify: `action.yml`
- Modify: `README.md`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `discoverPackages` (Task 3, new 6th `auditWorkspaces` parameter)

- [ ] **Step 1: Update `tests/index.test.ts`**

Only the parts that need to change: the test harness's input defaults gain `audit-workspaces`, and
two new tests confirm the boolean threading. Full updated file:

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
      'audit-workspaces': 'true',
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

  it('passes auditWorkspaces=true to discoverPackages by default', async () => {
    await runWithInputs({})
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[5]).toBe(true)
  })

  it('passes auditWorkspaces=false to discoverPackages when audit-workspaces input is "false"', async () => {
    await runWithInputs({ 'audit-workspaces': 'false' })
    const args = discoverPackagesMock.mock.calls[0]!
    expect(args[5]).toBe(false)
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
Expected: FAIL — `discoverPackagesMock` is called with only 5 args today (no `audit-workspaces`
input read yet)

- [ ] **Step 3: Update `src/index.ts`**

Change the `discoverPackages` call (everything else in this file is unchanged):

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

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run tests/index.test.ts`
Expected: PASS (7/7)

- [ ] **Step 5: Full suite and typecheck**

Run: `npx vitest run`
Expected: all tests pass across every file

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Update `action.yml`**

Add this input (alongside the existing `use-lockfile` input, before `fail-on-general`):

```yaml
  audit-workspaces:
    description: 'Discover and score every workspace member (npm/yarn "workspaces" field, or pnpm-workspace.yaml). Set to false to only audit the root package.json.'
    required: false
    default: 'true'
```

- [ ] **Step 7: Update `README.md`**

Add a row to the Inputs table (after `use-lockfile`):

```markdown
| `audit-workspaces` | no | `true` | Discover and score every workspace member in a monorepo |
```

Add a new section after "## Version resolution", before "## Outputs":

```markdown
## Monorepo / workspace support

If the root `package.json` declares a `"workspaces"` field (npm/yarn) or a `pnpm-workspace.yaml`
file exists, this action automatically discovers every workspace member and scores the
deduplicated union of all their dependencies — not just the root project's. Two members
depending on the exact same resolved version of a package produce one row in the report; two
members resolving to genuinely different versions of the same package both appear.

If no workspace configuration is found, behavior is unchanged — only the root `package.json` is
audited, same as a non-monorepo project.

Set `audit-workspaces: false` to only audit the root `package.json`, even in a real monorepo.
```

- [ ] **Step 8: Commit**

```bash
git add src/index.ts action.yml README.md tests/index.test.ts
git commit -m "feat: add audit-workspaces input, wire workspace discovery into run()"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all tests pass (every file in `tests/`, including the 2 new workspace test files)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds, produces `dist/index.js`. Do not commit the resulting `dist/index.js` change —
dist regeneration happens separately at release-tag time via `release.yml`. Revert it after
confirming the build succeeds:

```bash
git checkout -- dist/index.js
```

- [ ] **Step 4: Push the branch**

```bash
git push -u origin <branch-name>
```
