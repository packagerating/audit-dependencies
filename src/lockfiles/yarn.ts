import type { NamedRange } from './types'

function parseDescriptors(headerLine: string): string[] {
  return headerLine
    .replace(/:$/, '')
    .split(', ')
    .map(d => d.trim().replace(/^"|"$/g, ''))
}

export function resolveYarnVersions(
  lockfileContent: string,
  packages: NamedRange[],
): Map<string, string> {
  const descriptorToVersion = new Map<string, string>()
  const lines = lockfileContent.split('\n')

  let currentDescriptors: string[] = []
  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue

    if (!line.startsWith(' ')) {
      currentDescriptors = parseDescriptors(line)
      continue
    }

    const versionMatch = line.match(/^\s*version\s+"([^"]+)"/)
    if (versionMatch && currentDescriptors.length > 0) {
      for (const descriptor of currentDescriptors) {
        descriptorToVersion.set(descriptor, versionMatch[1]!)
      }
      currentDescriptors = []
    }
  }

  const resolved = new Map<string, string>()
  for (const { name, range } of packages) {
    if (!range) continue
    const version = descriptorToVersion.get(`${name}@${range}`)
    if (version) resolved.set(name, version)
  }

  return resolved
}
