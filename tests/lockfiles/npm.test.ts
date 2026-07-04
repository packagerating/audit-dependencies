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
      dependencies: { 'fallback-pkg': { version: '9.9.9' } },
    })
    const result = resolveNpmVersions(lockfile, [{ name: 'fallback-pkg', range: '^9.0.0' }])
    expect(result.get('fallback-pkg')).toBe('9.9.9')
  })

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
})
