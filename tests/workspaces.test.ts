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
