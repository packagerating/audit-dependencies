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
