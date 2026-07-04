import type { NamedRange } from './types'

interface NpmLockfile {
  packages?: Record<string, { version?: string }>
  dependencies?: Record<string, { version?: string }>
}

export function resolveNpmVersions(
  lockfileContent: string,
  packages: NamedRange[],
): Map<string, string> {
  const lockfile = JSON.parse(lockfileContent) as NpmLockfile
  const resolved = new Map<string, string>()

  for (const { name } of packages) {
    const fromPackagesMap = lockfile.packages?.[`node_modules/${name}`]?.version
    const fromLegacyTree = lockfile.dependencies?.[name]?.version
    const version = fromPackagesMap ?? fromLegacyTree
    if (version) resolved.set(name, version)
  }

  return resolved
}
