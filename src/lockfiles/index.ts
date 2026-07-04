import * as fs from 'fs'
import * as path from 'path'
import { resolveNpmVersions } from './npm'
import { resolveYarnVersions } from './yarn'
import { resolveYarnBerryVersions } from './yarnBerry'
import { resolvePnpmVersions } from './pnpm'
import type { NamedRange } from './types'

export type { NamedRange } from './types'

export function resolveLockfileVersions(
  lockfileDir: string,
  packages: NamedRange[],
  memberPath?: string,
): Map<string, string> {
  const npmPath = path.join(lockfileDir, 'package-lock.json')
  if (fs.existsSync(npmPath)) {
    return resolveNpmVersions(fs.readFileSync(npmPath, 'utf8'), packages, memberPath)
  }

  const yarnPath = path.join(lockfileDir, 'yarn.lock')
  if (fs.existsSync(yarnPath)) {
    const yarnContent = fs.readFileSync(yarnPath, 'utf8')
    return yarnContent.includes('__metadata:')
      ? resolveYarnBerryVersions(yarnContent, packages)
      : resolveYarnVersions(yarnContent, packages)
  }

  const pnpmPath = path.join(lockfileDir, 'pnpm-lock.yaml')
  if (fs.existsSync(pnpmPath)) {
    return resolvePnpmVersions(fs.readFileSync(pnpmPath, 'utf8'), packages, memberPath)
  }

  return new Map()
}
