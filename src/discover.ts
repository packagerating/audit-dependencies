import * as fs from 'fs'
import * as path from 'path'
import { resolveLockfileVersions } from './lockfiles'
import type { NamedRange } from './lockfiles'

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export interface DiscoveredPackage {
  name: string
  version: string | null
}

export function discoverPackages(
  packageJsonPath: string,
  explicitPackages: string[],
  includeDev: boolean,
  includeOptional: boolean,
  useLockfile: boolean,
): DiscoveredPackage[] {
  const absPath = path.resolve(
    process.env['GITHUB_WORKSPACE'] ?? process.cwd(),
    packageJsonPath,
  )

  let pkg: PackageJson = {}
  try {
    pkg = JSON.parse(fs.readFileSync(absPath, 'utf8') as string) as PackageJson
  } catch (err) {
    if (explicitPackages.length === 0) throw err
    // packages input is a deliberate override that works standalone —
    // package.json is optional in that case, so ranges just stay empty.
  }

  const ranges = new Map<string, string>()
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) ranges.set(name, range)
  if (includeDev) {
    for (const [name, range] of Object.entries(pkg.devDependencies ?? {})) ranges.set(name, range)
  }
  if (includeOptional) {
    for (const [name, range] of Object.entries(pkg.optionalDependencies ?? {})) ranges.set(name, range)
  }

  const names = explicitPackages.length > 0 ? [...new Set(explicitPackages)] : [...ranges.keys()]

  if (!useLockfile) {
    return names.map(name => ({ name, version: null }))
  }

  const namedRanges: NamedRange[] = names.map(name => ({ name, range: ranges.get(name) }))
  const resolved = resolveLockfileVersions(path.dirname(absPath), namedRanges)

  return names.map(name => ({ name, version: resolved.get(name) ?? null }))
}
