import * as fs from 'fs'
import * as path from 'path'
import { resolveLockfileVersions } from './lockfiles'
import type { NamedRange } from './lockfiles'
import { getWorkspaceGlobs, discoverWorkspaceMembers } from './workspaces'
import { discoverSubprojects } from './subprojects'

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export interface DiscoveredPackage {
  name: string
  version: string | null
}

interface ScopedRange {
  name: string
  range: string | undefined
  memberPath: string | undefined
  ownLockfile: boolean
}

function readPackageRanges(
  packageJsonPath: string,
  explicitPackages: string[],
  includeDev: boolean,
  includeOptional: boolean,
): Map<string, string> {
  let pkg: PackageJson = {}
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8') as string) as PackageJson
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
  return ranges
}

export function discoverPackages(
  packageJsonPath: string,
  explicitPackages: string[],
  includeDev: boolean,
  includeOptional: boolean,
  useLockfile: boolean,
  auditWorkspaces: boolean,
  auditSubprojects: boolean,
  subprojectMaxDepth: number,
  subprojectExcludeGlobs: string[],
): DiscoveredPackage[] {
  const absPath = path.resolve(
    process.env['GITHUB_WORKSPACE'] ?? process.cwd(),
    packageJsonPath,
  )
  const lockfileDir = path.dirname(absPath)

  const rootRanges = readPackageRanges(absPath, explicitPackages, includeDev, includeOptional)

  const scoped: ScopedRange[] = []

  if (explicitPackages.length > 0) {
    for (const name of new Set(explicitPackages)) {
      scoped.push({ name, range: rootRanges.get(name), memberPath: undefined, ownLockfile: false })
    }
  } else {
    for (const name of rootRanges.keys()) {
      scoped.push({ name, range: rootRanges.get(name), memberPath: undefined, ownLockfile: false })
    }

    const workspaceMemberPaths: string[] = []

    if (auditWorkspaces) {
      const globs = getWorkspaceGlobs(lockfileDir)
      if (globs) {
        for (const memberPath of discoverWorkspaceMembers(lockfileDir, globs)) {
          workspaceMemberPaths.push(memberPath)
          const memberPackageJsonPath = path.join(lockfileDir, memberPath, 'package.json')
          const memberRanges = readPackageRanges(memberPackageJsonPath, [], includeDev, includeOptional)
          for (const name of memberRanges.keys()) {
            scoped.push({ name, range: memberRanges.get(name), memberPath, ownLockfile: false })
          }
        }
      }
    }

    if (auditSubprojects) {
      const subprojectPaths = discoverSubprojects(
        lockfileDir,
        subprojectMaxDepth,
        subprojectExcludeGlobs,
        workspaceMemberPaths,
      )
      for (const memberPath of subprojectPaths) {
        const subprojectPackageJsonPath = path.join(lockfileDir, memberPath, 'package.json')
        const subprojectRanges = readPackageRanges(subprojectPackageJsonPath, [], includeDev, includeOptional)
        for (const name of subprojectRanges.keys()) {
          scoped.push({ name, range: subprojectRanges.get(name), memberPath, ownLockfile: true })
        }
      }
    }
  }

  if (!useLockfile) {
    const deduped = new Map<string, DiscoveredPackage>()
    for (const { name } of scoped) deduped.set(name, { name, version: null })
    return [...deduped.values()]
  }

  const resolvedByMember = new Map<string | undefined, Map<string, string>>()

  const byMember = new Map<string | undefined, NamedRange[]>()
  for (const { name, range, memberPath, ownLockfile } of scoped) {
    if (ownLockfile) continue
    if (!byMember.has(memberPath)) byMember.set(memberPath, [])
    byMember.get(memberPath)!.push({ name, range })
  }
  for (const [memberPath, namedRanges] of byMember) {
    resolvedByMember.set(memberPath, resolveLockfileVersions(lockfileDir, namedRanges, memberPath))
  }

  const byOwnMember = new Map<string, NamedRange[]>()
  for (const { name, range, memberPath, ownLockfile } of scoped) {
    if (!ownLockfile) continue
    const mp = memberPath! // always defined for ownLockfile entries — see the push above
    if (!byOwnMember.has(mp)) byOwnMember.set(mp, [])
    byOwnMember.get(mp)!.push({ name, range })
  }
  for (const [memberPath, namedRanges] of byOwnMember) {
    resolvedByMember.set(memberPath, resolveLockfileVersions(path.join(lockfileDir, memberPath), namedRanges))
  }

  const deduped = new Map<string, DiscoveredPackage>()
  for (const { name, memberPath } of scoped) {
    const version = resolvedByMember.get(memberPath)!.get(name) ?? null
    deduped.set(`${name}@${version ?? ''}`, { name, version })
  }
  return [...deduped.values()]
}
