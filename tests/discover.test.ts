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
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockPkg))
})

describe('discoverPackages', () => {
  it('returns explicit packages when provided, ignoring package.json', () => {
    const result = discoverPackages('package.json', ['react', 'vue'], false, false)
    expect(result).toEqual(['react', 'vue'])
  })

  it('deduplicates explicit packages', () => {
    const result = discoverPackages('package.json', ['react', 'react'], false, false)
    expect(result).toEqual(['react'])
  })

  it('returns dependencies only by default', () => {
    const result = discoverPackages('package.json', [], false, false)
    expect(result).toContain('axios')
    expect(result).toContain('lodash')
    expect(result).not.toContain('vitest')
    expect(result).not.toContain('fsevents')
  })

  it('includes devDependencies when includeDev is true', () => {
    const result = discoverPackages('package.json', [], true, false)
    expect(result).toContain('vitest')
    expect(result).not.toContain('fsevents')
  })

  it('includes optionalDependencies when includeOptional is true', () => {
    const result = discoverPackages('package.json', [], false, true)
    expect(result).toContain('fsevents')
    expect(result).not.toContain('vitest')
  })

  it('deduplicates across dependency types', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      dependencies: { shared: '^1.0.0' },
      devDependencies: { shared: '^1.0.0' },
    }))
    const result = discoverPackages('package.json', [], true, false)
    expect(result.filter(n => n === 'shared').length).toBe(1)
  })
})
