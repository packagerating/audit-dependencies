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
