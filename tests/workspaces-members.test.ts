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
