import * as path from 'path'
import fg from 'fast-glob'

const MANDATORY_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/examples/**',
  '**/fixtures/**',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/e2e/**',
]

export function discoverSubprojects(
  rootDir: string,
  maxDepth: number,
  extraExcludeGlobs: string[],
  alreadyDiscovered: string[],
): string[] {
  const matches = fg.sync('**/package.json', {
    cwd: rootDir,
    ignore: [...MANDATORY_EXCLUDE_GLOBS, ...extraExcludeGlobs],
    dot: false,
    deep: maxDepth + 1,
  })

  const alreadyDiscoveredSet = new Set(alreadyDiscovered)
  const result: string[] = []

  for (const match of matches) {
    const dir = path.posix.dirname(match)
    if (dir === '.') continue // the root's own package.json
    const depth = dir.split('/').length
    if (depth > maxDepth) continue
    if (alreadyDiscoveredSet.has(dir)) continue
    result.push(dir)
  }

  return result
}
