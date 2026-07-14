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
