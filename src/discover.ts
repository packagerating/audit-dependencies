import * as fs from 'fs'
import * as path from 'path'

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export function discoverPackages(
  packageJsonPath: string,
  explicitPackages: string[],
  includeDev: boolean,
  includeOptional: boolean,
): string[] {
  if (explicitPackages.length > 0) {
    return [...new Set(explicitPackages)]
  }

  const absPath = path.resolve(
    process.env['GITHUB_WORKSPACE'] ?? process.cwd(),
    packageJsonPath,
  )
  const pkg = JSON.parse(fs.readFileSync(absPath, 'utf8') as string) as PackageJson

  const names = new Set<string>()
  for (const name of Object.keys(pkg.dependencies ?? {})) names.add(name)
  if (includeDev) {
    for (const name of Object.keys(pkg.devDependencies ?? {})) names.add(name)
  }
  if (includeOptional) {
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) names.add(name)
  }
  return [...names]
}
