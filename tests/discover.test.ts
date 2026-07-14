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
    const result = discoverPackages('package.json', ['react', 'vue'], false, false, false, false, false, 3, [])
    expect(result).toEqual([
      { name: 'react', version: null },
      { name: 'vue', version: null },
    ])
  })

  it('deduplicates explicit packages', () => {
    const result = discoverPackages('package.json', ['react', 'react'], false, false, false, false, false, 3, [])
    expect(result).toEqual([{ name: 'react', version: null }])
  })

  it('returns dependencies only by default', () => {
    const result = discoverPackages('package.json', [], false, false, false, false, false, 3, [])
    const names = result.map(p => p.name)
    expect(names).toContain('axios')
    expect(names).toContain('lodash')
    expect(names).not.toContain('vitest')
    expect(names).not.toContain('fsevents')
  })

  it('includes devDependencies when includeDev is true', () => {
    const result = discoverPackages('package.json', [], true, false, false, false, false, 3, [])
    const names = result.map(p => p.name)
    expect(names).toContain('vitest')
    expect(names).not.toContain('fsevents')
  })

  it('includes optionalDependencies when includeOptional is true', () => {
    const result = discoverPackages('package.json', [], false, true, false, false, false, 3, [])
    const names = result.map(p => p.name)
    expect(names).toContain('fsevents')
    expect(names).not.toContain('vitest')
  })

  it('deduplicates across dependency types', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      dependencies: { shared: '^1.0.0' },
      devDependencies: { shared: '^1.0.0' },
    }))
    const result = discoverPackages('package.json', [], true, false, false, false, false, 3, [])
    expect(result.filter(p => p.name === 'shared').length).toBe(1)
  })

  it('every entry has version: null when useLockfile is false, even if a lockfile is present', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true) // pretend a lockfile exists
    const result = discoverPackages('package.json', [], false, false, false, false, false, 3, [])
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
    const result = discoverPackages('package.json', [], false, false, true, false, false, 3, [])
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
    const result = discoverPackages('package.json', [], false, false, true, false, false, 3, [])
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
    const result = discoverPackages('package.json', ['axios'], false, false, true, false, false, 3, [])
    expect(result).toEqual([{ name: 'axios', version: '1.7.4' }])
  })

  it('does not throw when package.json is unreadable and explicit packages are provided', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const result = discoverPackages('package.json', ['some-pkg'], false, false, true, false, false, 3, [])
    expect(result).toEqual([{ name: 'some-pkg', version: null }])
  })

  it('throws when package.json is unreadable and no explicit packages are provided', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    expect(() => discoverPackages('package.json', [], false, false, false, false, false, 3, [])).toThrow()
  })

  it('does not discover workspace members when auditWorkspaces is false, even if workspaces are declared', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ...mockPkg, workspaces: ['packages/*'] }))
    const result = discoverPackages('package.json', [], false, false, false, false, false, 3, [])
    const names = result.map(p => p.name)
    expect(names).toEqual(['axios', 'lodash'])
  })

  it('does not discover workspace members when no workspace config is found, even if auditWorkspaces is true', () => {
    const result = discoverPackages('package.json', [], false, false, false, true, false, 3, [])
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
      const result = freshDiscoverPackages('package.json', [], false, false, false, true, false, 3, [])
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
      const result = freshDiscoverPackages('package.json', [], false, false, true, true, false, 3, [])
      expect(result.filter(p => p.name === 'axios')).toEqual([{ name: 'axios', version: '1.7.4' }])
    })
  })

  it('keeps both entries distinct when the root and a workspace member resolve genuinely different versions of the same package', () => {
    vi.doMock('../src/workspaces', () => ({
      getWorkspaceGlobs: () => ['packages/*'],
      discoverWorkspaceMembers: () => ['packages/foo'],
    }))
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) =>
      String(p).endsWith('package.json') || String(p).endsWith('package-lock.json')
    )
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('package-lock.json')) {
        // Root's hoisted node_modules/axios entry and the member's own conflicting nested entry
        // both exist in the same packages map. The root lookup (no memberPath) resolves to the
        // root-hoisted version; the member lookup (memberPath set) prefers its own nested entry
        // over the root-hoisted one (Task 2 fix), so the two lookups genuinely diverge.
        return JSON.stringify({
          lockfileVersion: 3,
          packages: {
            'node_modules/axios': { version: '1.7.4' },
            'packages/foo/node_modules/axios': { version: '2.0.0' },
          },
        })
      }
      if (String(p).endsWith('packages/foo/package.json')) {
        return JSON.stringify({ dependencies: { axios: '^2.0.0' } })
      }
      return JSON.stringify({ ...mockPkg, workspaces: ['packages/*'] }) // root declares axios: '^1.0.0'
    })
    return import('../src/discover').then(({ discoverPackages: freshDiscoverPackages }) => {
      const result = freshDiscoverPackages('package.json', [], false, false, true, true, false, 3, [])
      const axiosEntries = result.filter(p => p.name === 'axios')
      expect(axiosEntries).toHaveLength(2)
      expect(axiosEntries).toEqual(expect.arrayContaining([
        { name: 'axios', version: '1.7.4' },
        { name: 'axios', version: '2.0.0' },
      ]))
    })
  })

  it('never triggers workspace discovery when explicitPackages is non-empty, even if auditWorkspaces is true and a workspace config exists', () => {
    vi.doMock('../src/workspaces', () => ({
      getWorkspaceGlobs: () => ['packages/*'],
      discoverWorkspaceMembers: () => ['packages/bait'],
    }))
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('packages/bait/package.json')) {
        return JSON.stringify({ dependencies: { 'workspace-only-pkg': '^1.0.0' } })
      }
      return JSON.stringify({ ...mockPkg, workspaces: ['packages/*'] })
    })
    return import('../src/discover').then(({ discoverPackages: freshDiscoverPackages }) => {
      const result = freshDiscoverPackages('package.json', ['react'], false, false, false, true, false, 3, [])
      expect(result).toEqual([{ name: 'react', version: null }])
      expect(result.map(p => p.name)).not.toContain('workspace-only-pkg')
    })
  })

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
})
