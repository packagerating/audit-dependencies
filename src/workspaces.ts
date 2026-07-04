import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import fg from 'fast-glob'

interface PackageJsonWithWorkspaces {
  workspaces?: string[] | { packages?: string[] }
}

interface PnpmWorkspaceYaml {
  packages?: string[]
}

export function getWorkspaceGlobs(rootDir: string): string[] | null {
  const pnpmWorkspacePath = path.join(rootDir, 'pnpm-workspace.yaml')
  if (fs.existsSync(pnpmWorkspacePath)) {
    const parsed = yaml.load(fs.readFileSync(pnpmWorkspacePath, 'utf8')) as PnpmWorkspaceYaml
    return parsed.packages && parsed.packages.length > 0 ? parsed.packages : null
  }

  const packageJsonPath = path.join(rootDir, 'package.json')
  if (!fs.existsSync(packageJsonPath)) return null

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8') as string) as PackageJsonWithWorkspaces
  if (!pkg.workspaces) return null

  const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages
  return globs && globs.length > 0 ? globs : null
}

export function discoverWorkspaceMembers(rootDir: string, globs: string[]): string[] {
  const matches = fg.sync(globs, { cwd: rootDir, onlyDirectories: true })
  return matches.filter(memberPath => fs.existsSync(path.join(rootDir, memberPath, 'package.json')))
}
