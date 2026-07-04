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
})
