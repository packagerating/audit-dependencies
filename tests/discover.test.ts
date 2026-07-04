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
