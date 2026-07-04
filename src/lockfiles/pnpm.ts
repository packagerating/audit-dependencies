import * as yaml from 'js-yaml'
import type { NamedRange } from './types'

interface PnpmDepEntry {
  specifier?: string
  version?: string
}

interface PnpmScope {
  dependencies?: Record<string, PnpmDepEntry>
  devDependencies?: Record<string, PnpmDepEntry>
  optionalDependencies?: Record<string, PnpmDepEntry>
}

interface PnpmLockfile extends PnpmScope {
  importers?: Record<string, PnpmScope>
}

function extractVersion(entry: PnpmDepEntry | undefined): string | undefined {
  if (!entry?.version) return undefined
  // pnpm suffixes peer-dependency-affected versions, e.g. "2.0.0(react@18.0.0)"
  return entry.version.split('(')[0]
}

export function resolvePnpmVersions(
  lockfileContent: string,
  packages: NamedRange[],
): Map<string, string> {
  const lockfile = yaml.load(lockfileContent) as PnpmLockfile
  const scope: PnpmScope = lockfile.importers?.['.'] ?? lockfile

  const resolved = new Map<string, string>()
  for (const { name } of packages) {
    const version =
      extractVersion(scope.dependencies?.[name]) ??
      extractVersion(scope.devDependencies?.[name]) ??
      extractVersion(scope.optionalDependencies?.[name])
    if (version) resolved.set(name, version)
  }

  return resolved
}
